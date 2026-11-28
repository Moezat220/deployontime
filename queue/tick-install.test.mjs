// Installing the tick: the LaunchAgent on macOS, the systemd user timer on Linux, the crontab line when systemd user
// timers do not work, and removing them again. Every test uses a made-up home folder and a stand-in for launchctl,
// systemctl and crontab, so nothing on this computer is installed, started or read.
import { isolateProcess, tempDir } from "./testkit.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

isolateProcess("tick-install");
const { AGENT_LABEL, cmdInstall, cmdUninstall, cronLine, installPlan, makeLog, stableNode, systemdUnits, tickEnv, tickInstalled, UNIT } =
    await import("./tick-install.mjs");

const WHERE = {
    node: "/opt/node/bin/node", cli: "/opt/deployontime/queue/cli.mjs", log: "/srv/agent/.dotime/schedule.log",
    env: tickEnv({ PATH: "/opt/node/bin:/usr/bin:/bin", DOTIME_TZ: "Europe/Paris", HOME: "/srv/agent", SECRET: "x" }, "/srv/agent/.dotime"),
};

/** deps for a platform, with a made-up home folder and every program call answered by answers[program] and kept. */
function stand(platform, answers = {}) {
    const calls = [], out = { printed: [], said: [] };
    const deps = {
        platform, userHome: tempDir("tick-install-user"), uid: 501,
        run: (program, args) => {
            calls.push([program, ...args].join(" "));
            return answers[`${program} ${args[0]}`] ?? answers[program] ?? { status: 0, stdout: "" };
        },
        print: (line) => out.printed.push(line), say: (line) => out.said.push(line),
    };
    return { deps, calls, out };
}

const PLIST = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">', "<dict>",
    "    <key>Label</key>", "    <string>com.deployontime.schedule-tick</string>",
    "    <key>ProgramArguments</key>", "    <array>",
    "        <string>/opt/node/bin/node</string>", "        <string>/opt/deployontime/queue/cli.mjs</string>",
    "        <string>schedule</string>", "        <string>tick</string>", "    </array>",
    "    <key>EnvironmentVariables</key>", "    <dict>",
    "        <key>PATH</key>", "        <string>/opt/node/bin:/usr/bin:/bin</string>",
    "        <key>DOTIME_TZ</key>", "        <string>Europe/Paris</string>",
    "        <key>DOTIME_HOME</key>", "        <string>/srv/agent/.dotime</string>", "    </dict>",
    "    <key>StartInterval</key>", "    <integer>60</integer>", "    <key>RunAtLoad</key>", "    <true/>",
    "    <key>AbandonProcessGroup</key>", "    <true/>",
    "    <key>StandardOutPath</key>", "    <string>/srv/agent/.dotime/schedule.log</string>",
    "    <key>StandardErrorPath</key>", "    <string>/srv/agent/.dotime/schedule.log</string>",
    "</dict>", "</plist>",
];

test("tickEnv: PATH, the DOTIME_ variables that are set, and always the state folder; nothing else", () => {
    assert.deepEqual(WHERE.env, { PATH: "/opt/node/bin:/usr/bin:/bin", DOTIME_TZ: "Europe/Paris", DOTIME_HOME: "/srv/agent/.dotime" });
});

test("install --dry on macOS: prints the LaunchAgent it would write and the launchctl call, and changes nothing", () => {
    const { deps, calls, out } = stand("darwin");
    assert.equal(cmdInstall(true, WHERE, deps), 0);
    const plist = join(deps.userHome, "Library", "LaunchAgents", `${AGENT_LABEL}.plist`);
    assert.deepEqual(out.printed, [
        `schedule install: would write ${plist}`, ...PLIST,
        `schedule install: would run launchctl bootstrap gui/501 ${plist}`,
        "dry run: nothing was changed; run it without --dry to install",
    ]);
    assert.deepEqual([calls, existsSync(plist), tickInstalled(WHERE, deps)], [[], false, false]);
});

test("install and uninstall on macOS: write the LaunchAgent and load it, then unload and remove it", () => {
    const { deps, calls, out } = stand("darwin");
    const plist = join(deps.userHome, "Library", "LaunchAgents", `${AGENT_LABEL}.plist`);
    assert.equal(cmdInstall(false, WHERE, deps), 0);
    assert.equal(readFileSync(plist, "utf8"), `${PLIST.join("\n")}\n`);
    assert.deepEqual(calls, [`launchctl bootout gui/501/${AGENT_LABEL}`, `launchctl bootstrap gui/501 ${plist}`]);
    assert.deepEqual(out.printed, [
        `schedule install: wrote ${plist}`, `schedule install: ran launchctl bootstrap gui/501 ${plist}`,
        "schedule install: the tick runs every minute; log /srv/agent/.dotime/schedule.log",
    ]);
    assert.equal(tickInstalled(WHERE, deps), true);
    out.printed.length = 0;
    calls.length = 0;
    assert.equal(cmdUninstall(true, WHERE, deps), 0);
    assert.deepEqual([calls, existsSync(plist)], [[], true], "--dry changes nothing");
    assert.deepEqual(out.printed, [
        `schedule uninstall: would run launchctl bootout gui/501/${AGENT_LABEL}`, `schedule uninstall: would remove ${plist}`,
        "dry run: nothing was changed; run it without --dry to uninstall",
    ]);
    out.printed.length = 0;
    assert.equal(cmdUninstall(false, WHERE, deps), 0);
    assert.deepEqual([calls, existsSync(plist)], [[`launchctl bootout gui/501/${AGENT_LABEL}`], false]);
    assert.deepEqual(out.printed, [`schedule uninstall: ran launchctl bootout gui/501/${AGENT_LABEL}`, `schedule uninstall: removed ${plist}`]);
    out.printed.length = 0;
    assert.equal(cmdUninstall(false, WHERE, deps), 0);
    assert.deepEqual(out.printed, [`schedule uninstall: nothing installed; no ${plist}`]);
});

test("install on macOS: a launchctl call that fails is reported with exit 1, and the LaunchAgent is removed again", () => {
    const { deps, out } = stand("darwin", { "launchctl bootstrap": { status: 5, stderr: "Bootstrap failed: 5: Input/output error\n" } });
    assert.equal(cmdInstall(false, WHERE, deps), 1);
    const plist = join(deps.userHome, "Library", "LaunchAgents", `${AGENT_LABEL}.plist`);
    assert.deepEqual(out.said, [
        `schedule install: launchctl bootstrap gui/501 ${plist} failed, exit 5; Bootstrap failed: 5: Input/output error`,
        `schedule install: removed ${plist} again; nothing is installed`,
    ]);
    assert.deepEqual([existsSync(plist), tickInstalled(WHERE, deps)], [false, false], "so add still gives its hint");
});

test("install on Linux: a systemctl enable that fails is reported with exit 1, and the unit files are removed again", () => {
    const { deps, calls, out } = stand("linux", { "systemctl --user": { status: 0 } });
    deps.run = (program, args) => {
        calls.push([program, ...args].join(" "));
        return args[1] === "enable" ? { status: 1, stderr: "Failed to enable unit\n" } : { status: 0, stdout: "" };
    };
    assert.equal(cmdInstall(false, WHERE, deps), 1);
    assert.deepEqual(calls.slice(1), ["systemctl --user daemon-reload", `systemctl --user enable --now ${UNIT}.timer`, "systemctl --user daemon-reload"],
        "and systemd forgets the removed units");
    const dir = join(deps.userHome, ".config", "systemd", "user");
    assert.equal(out.said[0], `schedule install: systemctl --user enable --now ${UNIT}.timer failed, exit 1; Failed to enable unit`);
    assert.deepEqual([existsSync(join(dir, `${UNIT}.service`)), existsSync(join(dir, `${UNIT}.timer`)), tickInstalled(WHERE, deps)], [false, false, false]);
});

test("makeLog: the tick's log is made for its owner alone, also when it was there before; install makes it first", () => {
    const log = join(tempDir("tick-install-log"), "state", "schedule.log");
    makeLog(log);
    assert.equal(statSync(log).mode & 0o777, 0o600);
    writeFileSync(log, "a line\n");
    chmodSync(log, 0o644);
    makeLog(log);
    assert.deepEqual([statSync(log).mode & 0o777, readFileSync(log, "utf8")], [0o600, "a line\n"], "kept, only its mode changed");
    const { deps } = stand("darwin");
    const made = [];
    cmdInstall(false, WHERE, { ...deps, makeLog: (file) => made.push(file) });
    assert.deepEqual(made, [WHERE.log]);
});

test("install: a % or $ in a path is escaped for systemd and for cron", () => {
    const odd = { ...WHERE, cli: "/opt/50%$off/cli.mjs", log: "/srv/100%/schedule.log", env: { PATH: "/opt/%h/bin", DOTIME_HOME: "/srv/$HOME" } };
    const { service } = systemdUnits(odd);
    assert.match(service, /^Environment="PATH=\/opt\/%%h\/bin"$/m);
    assert.match(service, /^Environment="DOTIME_HOME=\/srv\/\$HOME"$/m, "Environment= expands no variables");
    assert.match(service, /^ExecStart="\/opt\/node\/bin\/node" "\/opt\/50%%\$\$off\/cli\.mjs" "schedule" "tick"$/m);
    assert.match(service, /^StandardOutput=append:\/srv\/100%%\/schedule\.log$/m);
    const line = cronLine(odd);
    assert.equal(line.includes("%") && !/[^\\]%/.test(line), true, line);
    assert.equal(line, "* * * * * PATH=/opt/\\%h/bin DOTIME_HOME='/srv/$HOME' /opt/node/bin/node '/opt/50\\%$off/cli.mjs' schedule tick "
        + ">> /srv/100\\%/schedule.log 2>&1");
});

const SERVICE = [
    "[Unit]", "Description=dotime-queue schedule tick", "", "[Service]", "Type=oneshot", "KillMode=process",
    'Environment="PATH=/opt/node/bin:/usr/bin:/bin"', 'Environment="DOTIME_TZ=Europe/Paris"', 'Environment="DOTIME_HOME=/srv/agent/.dotime"',
    'ExecStart="/opt/node/bin/node" "/opt/deployontime/queue/cli.mjs" "schedule" "tick"',
    "StandardOutput=append:/srv/agent/.dotime/schedule.log", "StandardError=append:/srv/agent/.dotime/schedule.log",
];
const TIMER = [
    "[Unit]", "Description=dotime-queue schedule tick every minute", "", "[Timer]", "OnCalendar=*-*-* *:*:00", "AccuracySec=1s", "",
    "[Install]", "WantedBy=timers.target",
];

test("install --dry on Linux with systemd: prints the user service and timer and the systemctl calls", () => {
    const { deps, calls, out } = stand("linux");
    assert.equal(cmdInstall(true, WHERE, deps), 0);
    const dir = join(deps.userHome, ".config", "systemd", "user");
    assert.deepEqual(out.printed, [
        `schedule install: would write ${join(dir, `${UNIT}.service`)}`, ...SERVICE,
        `schedule install: would write ${join(dir, `${UNIT}.timer`)}`, ...TIMER,
        "schedule install: would run systemctl --user daemon-reload",
        `schedule install: would run systemctl --user enable --now ${UNIT}.timer`,
        "dry run: nothing was changed; run it without --dry to install",
    ]);
    assert.deepEqual(calls, ["systemctl --user show-environment"], "only the check that systemd user timers work");
    assert.equal(existsSync(dir), false);
});

test("install and uninstall on Linux with systemd: write, reload and enable the timer, then disable and remove it", () => {
    const { deps, calls } = stand("linux");
    const dir = join(deps.userHome, ".config", "systemd", "user");
    assert.equal(cmdInstall(false, WHERE, deps), 0);
    assert.equal(readFileSync(join(dir, `${UNIT}.service`), "utf8"), `${SERVICE.join("\n")}\n`);
    assert.equal(readFileSync(join(dir, `${UNIT}.timer`), "utf8"), `${TIMER.join("\n")}\n`);
    assert.deepEqual(calls.slice(1), ["systemctl --user daemon-reload", `systemctl --user enable --now ${UNIT}.timer`]);
    assert.equal(tickInstalled(WHERE, deps), true);
    calls.length = 0;
    assert.equal(cmdUninstall(false, WHERE, deps), 0);
    assert.deepEqual(calls.slice(1), [`systemctl --user disable --now ${UNIT}.timer`, "systemctl --user daemon-reload"]);
    assert.deepEqual([existsSync(join(dir, `${UNIT}.service`)), existsSync(join(dir, `${UNIT}.timer`))], [false, false]);
});

test("install on Linux without systemd user timers: prints the crontab line, never edits the crontab, and exits 1", () => {
    const { deps, calls, out } = stand("linux", { systemctl: { status: 1 }, crontab: { status: 0, stdout: "0 3 * * * backup\n" } });
    const line = "* * * * * PATH=/opt/node/bin:/usr/bin:/bin DOTIME_TZ=Europe/Paris DOTIME_HOME=/srv/agent/.dotime /opt/node/bin/node "
        + "/opt/deployontime/queue/cli.mjs schedule tick >> /srv/agent/.dotime/schedule.log 2>&1";
    assert.equal(cronLine(WHERE), line);
    assert.equal(cmdInstall(false, WHERE, deps), 1);
    assert.deepEqual(out.printed, [
        "schedule install: systemctl --user does not work here, so nothing was installed; add this line with crontab -e:", line,
    ]);
    assert.equal(cmdInstall(true, WHERE, deps), 0, "--dry shows the same line and exits 0");
    assert.equal(calls.some((c) => c.startsWith("crontab")), false);
    assert.equal(tickInstalled(WHERE, deps), false);
    assert.deepEqual(calls.at(-1), "crontab -l", "only read to see whether the line is there");
    const listed = stand("linux", { systemctl: { status: 1 }, crontab: { status: 0, stdout: `${line}\n` } });
    assert.equal(tickInstalled(WHERE, listed.deps), true);
    assert.equal(cmdUninstall(false, WHERE, deps), 0);
    assert.equal(out.printed.at(-1), "schedule uninstall: no systemd user timer here; if you added the crontab line, remove it with crontab -e");
});

test("install on another platform: refused with a message and exit 1", () => {
    const { deps, out } = stand("win32");
    assert.equal(cmdInstall(true, WHERE, deps), 1);
    assert.deepEqual(out.said, ["schedule install: works on macOS and Linux only; win32 has neither launchd nor systemd user timers here"]);
    assert.equal(installPlan(WHERE, deps).error !== undefined, true);
    assert.equal(cmdUninstall(false, WHERE, deps), 1);
});

test("launchdPlist: values are escaped for XML", () => {
    const plan = installPlan({ ...WHERE, cli: "/opt/a&b/<cli>.mjs" }, stand("darwin").deps);
    assert.match(plan.files[0].text, /<string>\/opt\/a&amp;b\/&lt;cli&gt;\.mjs<\/string>/);
});

test("stableNode: the entry names a node on PATH that leads to the same file, as a package manager links it, so an upgrade keeps it working", () => {
    const box = tempDir("tick-install-node");
    const cellar = join(box, "Cellar", "node", "22.1.0", "bin");
    const bin = join(box, "bin"), other = join(box, "other");
    for (const dir of [cellar, bin, other]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(cellar, "node"), "");
    writeFileSync(join(other, "node"), "");
    symlinkSync(join(cellar, "node"), join(bin, "node"));
    const real = join(cellar, "node");
    assert.equal(stableNode(real, [other, "relative/bin", bin].join(":")), join(bin, "node"), "another node and a relative folder are passed over");
    assert.equal(stableNode(real, other), real, "no node on PATH leads to it: the file itself");
    assert.equal(stableNode(real, ""), real);
    assert.equal(stableNode(join(box, "gone", "node"), bin), join(box, "gone", "node"), "a path that does not resolve is kept as it is");
});
