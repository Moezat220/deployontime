// `schedule install` and `schedule uninstall`: the one system entry that starts `dotime-queue schedule tick` every
// minute. On macOS a LaunchAgent, on Linux a systemd user timer when `systemctl --user` works; otherwise the line to
// add to the crontab by hand, which is never edited here. The texts are pure functions; files and commands go through
// deps, so tests use a made-up home folder and stand-ins for launchctl and systemctl.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { shellWord } from "./args.mjs";
import { OWNER_ONLY } from "./timetable.mjs";

export const AGENT_LABEL = "com.deployontime.schedule-tick";
export const UNIT = "dotime-schedule-tick";
// The variables the tick and the runs it starts need from the shell that installs it.
const PASSED_ON = ["PATH", "DOTIME_TZ", "DOTIME_NOTIFY", "DOTIME_NOTIFY_CMD"];

/** Runs a program with a time limit and gives { status, stdout, stderr }; status is null when it could not run. */
export function runProgram(program, args) {
    const ran = spawnSync(program, args, { encoding: "utf8", timeout: 10_000 });
    return { status: ran.error ? null : ran.status, stdout: ran.stdout ?? "", stderr: ran.stderr ?? ran.error?.message ?? "" };
}

/** The environment the tick gets: PATH and the DOTIME_ variables that are set, and always the state folder. */
export function tickEnv(env, home) {
    const out = {};
    for (const name of PASSED_ON) if (env[name]) out[name] = env[name];
    out.DOTIME_HOME = home;
    return out;
}

const xml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The LaunchAgent: tick every 60 seconds, also once when it is loaded, with its output in schedule.log.
 *  AbandonProcessGroup: launchd leaves the runs the tick started alone when the tick ends; each also runs in a process
 *  group of its own. */
export function launchdPlist({ node, cli, env, log }) {
    const strings = (items) => items.map((s) => `        <string>${xml(s)}</string>`);
    const vars = Object.entries(env).flatMap(([k, v]) => [`        <key>${xml(k)}</key>`, `        <string>${xml(v)}</string>`]);
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        "<dict>",
        "    <key>Label</key>",
        `    <string>${AGENT_LABEL}</string>`,
        "    <key>ProgramArguments</key>",
        "    <array>",
        ...strings([node, cli, "schedule", "tick"]),
        "    </array>",
        "    <key>EnvironmentVariables</key>",
        "    <dict>",
        ...vars,
        "    </dict>",
        "    <key>StartInterval</key>",
        "    <integer>60</integer>",
        "    <key>RunAtLoad</key>",
        "    <true/>",
        "    <key>AbandonProcessGroup</key>",
        "    <true/>",
        "    <key>StandardOutPath</key>",
        `    <string>${xml(log)}</string>`,
        "    <key>StandardErrorPath</key>",
        `    <string>${xml(log)}</string>`,
        "</dict>",
        "</plist>",
        "",
    ].join("\n");
}

const quoted = (text) => `"${String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
// systemd reads %x in a unit file as a specifier and $NAME in ExecStart= as a variable; doubled, each is itself.
const specifiers = (text) => String(text).replace(/%/g, "%%");
const execWord = (text) => quoted(specifiers(text).replace(/\$/g, "$$$$"));

/** The systemd user service and timer. KillMode=process: the runs the tick starts outlive it, as they must. */
export function systemdUnits({ node, cli, env, log }) {
    const service = [
        "[Unit]",
        "Description=dotime-queue schedule tick",
        "",
        "[Service]",
        "Type=oneshot",
        "KillMode=process",
        ...Object.entries(env).map(([k, v]) => `Environment=${quoted(specifiers(`${k}=${v}`))}`),
        `ExecStart=${[node, cli, "schedule", "tick"].map(execWord).join(" ")}`,
        `StandardOutput=append:${specifiers(log)}`,
        `StandardError=append:${specifiers(log)}`,
        "",
    ].join("\n");
    const timer = [
        "[Unit]",
        "Description=dotime-queue schedule tick every minute",
        "",
        "[Timer]",
        "OnCalendar=*-*-* *:*:00",
        "AccuracySec=1s",
        "",
        "[Install]",
        "WantedBy=timers.target",
        "",
    ].join("\n");
    return { service, timer };
}

/** The crontab line for a computer without systemd user timers. cron reads a bare % in the command as the end of
 *  it, so each is written as \\%. */
export function cronLine({ node, cli, env, log }) {
    const vars = Object.entries(env).map(([k, v]) => `${k}=${shellWord(v)}`).join(" ");
    const command = `${vars} ${shellWord(node)} ${shellWord(cli)} schedule tick >> ${shellWord(log)} 2>&1`;
    return `* * * * * ${command.replace(/%/g, "\\%")}`;
}

/** What install writes and runs on a platform: { kind, files: [{ path, text }], commands: [[program, ...args]] }, or
 *  { kind: "cron", line }, or { error }. deps: { platform, userHome, uid, run(program, args) } where run gives
 *  { status }. */
export function installPlan(where, deps) {
    if (deps.platform === "darwin") {
        const path = join(deps.userHome, "Library", "LaunchAgents", `${AGENT_LABEL}.plist`);
        const domain = `gui/${deps.uid}`;
        return {
            kind: "launchd", files: [{ path, text: launchdPlist(where) }],
            before: [["launchctl", "bootout", `${domain}/${AGENT_LABEL}`]],
            commands: [["launchctl", "bootstrap", domain, path]],
            remove: [["launchctl", "bootout", `${domain}/${AGENT_LABEL}`]],
        };
    }
    if (deps.platform === "linux") {
        if (deps.run("systemctl", ["--user", "show-environment"]).status !== 0) return { kind: "cron", line: cronLine(where) };
        const dir = join(deps.userHome, ".config", "systemd", "user");
        const units = systemdUnits(where);
        return {
            kind: "systemd",
            files: [{ path: join(dir, `${UNIT}.service`), text: units.service }, { path: join(dir, `${UNIT}.timer`), text: units.timer }],
            before: [],
            commands: [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", `${UNIT}.timer`]],
            remove: [["systemctl", "--user", "disable", "--now", `${UNIT}.timer`]],
            after: [["systemctl", "--user", "daemon-reload"]],
        };
    }
    return { error: `works on macOS and Linux only; ${deps.platform} has neither launchd nor systemd user timers here` };
}

/** Is the tick installed? The LaunchAgent or the timer file is there, or the crontab has a tick line. */
export function tickInstalled(where, deps) {
    const plan = installPlan(where, deps);
    if (plan.error) return false;
    if (plan.kind === "cron") {
        const listed = deps.run("crontab", ["-l"]);
        return listed.status === 0 && /schedule tick/.test(listed.stdout ?? "");
    }
    return plan.files.every((f) => existsSync(f.path));
}

const commandText = (words) => words.map(shellWord).join(" ");

/** Makes the tick's log for its owner alone, before the system entry writes to it: it names commands and folders. */
export function makeLog(file) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "", { flag: "a", mode: OWNER_ONLY });
    chmodSync(file, OWNER_ONLY);
}

/** `schedule install [--dry]`. Exits 0 once installed, also for --dry; 1 when it could not install, also when only
 *  the crontab line can be given; a launchctl or systemctl call that fails removes the files it wrote again. where:
 *  { node, cli, env, log }; deps as for installPlan, with print, say and makeLog(file) (makeLog above). */
export function cmdInstall(dry, where, deps) {
    const { print, say } = deps;
    const plan = installPlan(where, deps);
    if (plan.error) {
        say(`schedule install: ${plan.error}`);
        return 1;
    }
    if (plan.kind === "cron") {
        print("schedule install: systemctl --user does not work here, so nothing was installed; "
            + "add this line with crontab -e:");
        print(plan.line);
        return dry ? 0 : 1;
    }
    if (dry) {
        for (const file of plan.files) {
            print(`schedule install: would write ${file.path}`);
            for (const line of file.text.trimEnd().split("\n")) print(line);
        }
        for (const words of plan.commands) print(`schedule install: would run ${commandText(words)}`);
        print("dry run: nothing was changed; run it without --dry to install");
        return 0;
    }
    for (const words of plan.before) deps.run(words[0], words.slice(1));
    deps.makeLog?.(where.log);
    for (const file of plan.files) {
        mkdirSync(dirname(file.path), { recursive: true });
        writeFileSync(file.path, file.text);
        print(`schedule install: wrote ${file.path}`);
    }
    for (const words of plan.commands) {
        const ran = deps.run(words[0], words.slice(1));
        if (ran.status !== 0) {
            say(`schedule install: ${commandText(words)} failed, exit ${ran.status}; ${String(ran.stderr ?? "").trim() || "no message"}`);
            // Without the files, the tick does not count as installed, and add keeps giving its hint.
            for (const file of plan.files) {
                rmSync(file.path, { force: true });
                say(`schedule install: removed ${file.path} again; nothing is installed`);
            }
            for (const undo of plan.after ?? []) deps.run(undo[0], undo.slice(1));
            return 1;
        }
        print(`schedule install: ran ${commandText(words)}`);
    }
    print(`schedule install: the tick runs every minute; log ${where.log}`);
    return 0;
}

/** `schedule uninstall [--dry]`: stops and removes the entry install made. A crontab line is left to the user. */
export function cmdUninstall(dry, where, deps) {
    const { print, say } = deps;
    const plan = installPlan(where, deps);
    if (plan.error) {
        say(`schedule uninstall: ${plan.error}`);
        return 1;
    }
    if (plan.kind === "cron") {
        print("schedule uninstall: no systemd user timer here; if you added the crontab line, remove it with crontab -e");
        return 0;
    }
    const present = plan.files.filter((f) => existsSync(f.path));
    if (!present.length) {
        print(`schedule uninstall: nothing installed; no ${plan.files.map((f) => f.path).join(" or ")}`);
        return 0;
    }
    const steps = [...plan.remove, ...(plan.after ?? [])];
    if (dry) {
        print(`schedule uninstall: would run ${commandText(plan.remove[0])}`);
        for (const file of present) print(`schedule uninstall: would remove ${file.path}`);
        for (const words of plan.after ?? []) print(`schedule uninstall: would run ${commandText(words)}`);
        print("dry run: nothing was changed; run it without --dry to uninstall");
        return 0;
    }
    deps.run(plan.remove[0][0], plan.remove[0].slice(1));
    print(`schedule uninstall: ran ${commandText(plan.remove[0])}`);
    for (const file of present) {
        rmSync(file.path, { force: true });
        print(`schedule uninstall: removed ${file.path}`);
    }
    for (const words of steps.slice(plan.remove.length)) {
        deps.run(words[0], words.slice(1));
        print(`schedule uninstall: ran ${commandText(words)}`);
    }
    return 0;
}
