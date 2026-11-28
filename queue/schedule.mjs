// The `dotime-queue schedule` commands: add, list, remove, enable and disable change or show the jobs in
// schedule.json; tick starts the ones that are due (tick.mjs); install and uninstall set up or remove the one system
// entry that runs the tick every minute (tick-install.mjs). Not to be confused with the scheduled-job report in
// schedule-check.mjs, which only reads the user's own launchd jobs.
import { randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { flagError, opt, SCHEDULE_FLAGS, USAGE_EXIT } from "./args.mjs";
import { dateTime } from "./clock.mjs";
import { nextDue, parseCron, parseEvery, timesText } from "./cron.mjs";
import { parseLines, readLines } from "./journal.mjs";
import { UNLABELLED } from "./kinds.mjs";
import { cmdInstall, cmdUninstall } from "./tick-install.mjs";
import { runTick } from "./tick.mjs";
import { changeSchedule, readSchedule } from "./timetable.mjs";

const SUBS = Object.keys(SCHEDULE_FLAGS);
const BY_ID = ["remove", "enable", "disable"];

/** Reads the words of `schedule add` (args[0] is "add"). Returns { label, every | cron, isolate, noSkip, cwd, command }
 *  or { error }. cwd is the --cwd folder as given, or undefined. */
export function parseAdd(args) {
    const bad = flagError(args, SCHEDULE_FLAGS);
    if (bad) return { error: `schedule add: ${bad}` };
    const cut = args.indexOf("--");
    const command = cut < 0 ? [] : args.slice(cut + 1);
    const label = opt(args, "--label")?.trim();
    if (!label || label === UNLABELLED) return { error: 'schedule add: needs --label "<project>: <task>"' };
    const every = opt(args, "--every");
    const cron = opt(args, "--cron");
    if ((every === undefined) === (cron === undefined)) return { error: "schedule add: needs exactly one of --every <step> and --cron \"<expr>\"" };
    const times = every !== undefined ? parseEvery(every) : parseCron(cron);
    if (times.error) return { error: `schedule add: ${times.error}` };
    if (!command.length) return { error: "schedule add: needs the command after --, as for run" };
    const flags = cut < 0 ? args : args.slice(0, cut);
    return {
        label, ...(every !== undefined ? { every } : { cron: cron.trim().split(/\s+/).join(" ") }),
        isolate: flags.includes("--isolate"), noSkip: flags.includes("--no-skip"), cwd: opt(args, "--cwd"), command,
    };
}

/** The text of a job's last outcome in its journal lines: "ran, exit 0", "missed 3 runs", "none". */
export function lastText(rows, id) {
    const row = rows.findLast((r) => r.scheduled === id);
    if (!row) return "none";
    if (row.outcome === "missed") return `missed ${row.missed} ${row.missed === 1 ? "run" : "runs"}`;
    return row.exit == null ? row.outcome : `${row.outcome}, exit ${row.exit}`;
}

/** A job's times as add and list print them, with ", no-skip" for a job that runs also on a commit that passed. */
const jobTimes = (job) => `${timesText(job)}${job.noSkip ? ", no-skip" : ""}`;

/** One line of `schedule list`. */
export function jobLine(job, rows, now, { wall, zone }) {
    const next = job.enabled ? nextDue(job, now, wall) : null;
    const state = job.enabled ? "enabled" : "disabled";
    return `schedule ${job.id}: "${job.label}", ${jobTimes(job)}, ${state}; next: ${next === null ? "none" : dateTime(next, zone)}; `
        + `last: ${lastText(rows, job.id)}`;
}

const lockDeps = (deps) => ({ isGone: deps.isGone, now: deps.now(), pause: deps.pause });

/** Runs a change under the lock and turns its result into an exit code. */
function change(files, deps, fn) {
    let result;
    try {
        result = changeSchedule(files, deps.owner, fn, lockDeps(deps));
    } catch (e) {
        deps.say(`schedule: ${files.schedule} could not be written (${e.code ?? e.message})`);
        return { exit: 1 };
    }
    if (result.busy) {
        deps.say(`schedule: ${files.scheduleLock} stayed taken by another tick or change; try again`);
        return { exit: 1 };
    }
    if (result.error) {
        deps.say(result.unknown ? result.error : `schedule: ${result.error}`);
        return { exit: result.unknown ? USAGE_EXIT : 1 };
    }
    return { exit: 0, ...result };
}

function cmdAdd(args, files, deps) {
    const parsed = parseAdd(args);
    if (parsed.error) {
        deps.say(parsed.error);
        return USAGE_EXIT;
    }
    let cwd;
    try {
        // The real path, as `run` reads its folder: the journal lines of the tick and of the runs name the same one.
        cwd = realpathSync(resolve(parsed.cwd ?? deps.cwd()));
        if (!statSync(cwd).isDirectory()) throw new Error("not a folder");
    } catch {
        deps.say(parsed.cwd === undefined
            ? "schedule add: the current folder was removed; run it from a folder that exists, or name one with --cwd <dir>"
            : `schedule add: --cwd: ${parsed.cwd} is not a folder`);
        return USAGE_EXIT;
    }
    const now = deps.now();
    const done = change(files, deps, (jobs) => {
        let id;
        do id = deps.newId(); while (jobs.some((j) => j.id === id));
        const job = {
            id, label: parsed.label, cwd, command: parsed.command,
            ...(parsed.every ? { every: parsed.every } : { cron: parsed.cron }),
            enabled: true, ...(parsed.isolate ? { isolate: true } : {}), ...(parsed.noSkip ? { noSkip: true } : {}),
            createdAt: new Date(now).toISOString(),
        };
        return { jobs: [...jobs, job], job };
    });
    if (done.exit) return done.exit;
    const next = nextDue(done.job, now, deps.wall);
    deps.print(`schedule: added ${done.job.id}, "${done.job.label}", ${jobTimes(done.job)}; next: ${dateTime(next, deps.zone)}`);
    if (!deps.installed()) {
        deps.say("hint: nothing runs the tick yet; dotime-queue schedule install starts it every minute, "
            + "and schedule install --dry shows what it would write");
    }
    return 0;
}

function cmdList(files, deps) {
    const read = readSchedule(files.schedule);
    if (read.error) {
        deps.say(`schedule: ${read.error}`);
        return 1;
    }
    if (!read.jobs.length) {
        deps.print("schedule: none");
        return 0;
    }
    const rows = parseLines(readLines(files.journal));
    for (const job of read.jobs) deps.print(jobLine(job, rows, deps.now(), deps));
    return 0;
}

function cmdById(sub, id, files, deps) {
    const now = deps.now();
    const done = change(files, deps, (jobs) => {
        const job = jobs.find((j) => j.id === id);
        if (!job) return { error: `schedule ${sub}: no job ${id}; schedule list shows the ids`, unknown: true };
        if (sub === "remove") return { jobs: jobs.filter((j) => j !== job), job };
        // Due times while a job was disabled are not missed runs: they count from the moment it is enabled again.
        if (sub === "enable" && !job.enabled) job.lastDue = new Date(now).toISOString();
        job.enabled = sub === "enable";
        return { jobs, job };
    });
    if (done.exit) return done.exit;
    const { job } = done;
    const verb = { remove: "removed", enable: "enabled", disable: "disabled" }[sub];
    const next = sub === "enable" ? `; next: ${dateTime(nextDue(job, now, deps.wall), deps.zone)}` : "";
    deps.print(`schedule: ${verb} ${job.id}, "${job.label}"${next}`);
    return 0;
}

/** `dotime-queue schedule <sub> ...`; args start at the sub-command. Returns the exit code: 2 for words it does not
 *  understand and for an unknown id. deps: { now, wall, zone, owner, isGone, pause, newId, cwd, print, say,
 *  installed, install (where and the deps of tick-install.mjs), and the deps of runTick }. */
export function cmdSchedule(args, files, deps) {
    const sub = args[0];
    if (!SUBS.includes(sub)) {
        deps.say(`schedule: ${sub === undefined ? "needs" : `"${sub}" is not`} one of ${SUBS.join(", ")}; dotime-queue help shows each`);
        return USAGE_EXIT;
    }
    if (sub === "add") return cmdAdd(args, files, deps);
    if (BY_ID.includes(sub)) {
        const id = args[1];
        if (!id || id.startsWith("-")) {
            deps.say(`schedule ${sub}: needs the id of a job; schedule list shows the ids`);
            return USAGE_EXIT;
        }
        const bad = flagError([sub, ...args.slice(2)], SCHEDULE_FLAGS);
        if (bad) {
            deps.say(`schedule ${sub}: ${bad}`);
            return USAGE_EXIT;
        }
        return cmdById(sub, id, files, deps);
    }
    const bad = flagError(args, SCHEDULE_FLAGS);
    if (bad) {
        deps.say(`schedule ${sub}: ${bad}`);
        return USAGE_EXIT;
    }
    if (sub === "list") return cmdList(files, deps);
    if (sub === "tick") return runTick(files, deps);
    const dry = args.includes("--dry");
    const { where, ...installDeps } = deps.install;
    const withOutput = { ...installDeps, print: deps.print, say: deps.say };
    return sub === "install" ? cmdInstall(dry, where, withOutput) : cmdUninstall(dry, where, withOutput);
}

/** A new job id: 8 hex digits. */
export const newId = () => randomBytes(4).toString("hex");
