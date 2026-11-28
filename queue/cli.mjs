#!/usr/bin/env node
// The dotime-queue command. `run` waits for a slot and runs one job under a run limit; `status` shows slots, line
// and gate; `passed` looks up a pass stamp; `history` sums up the journal; `flaky` lists the checks that passed and
// failed on one commit; `setup` puts the queue instruction into a project's agent files; `integrate`, `discard` and
// `worktrees` handle the worktrees of isolated runs; `schedule` adds, lists and changes scheduled jobs, starts the ones
// that are due on each tick, and installs that tick. queue/README.md describes each in full.
import { isMainModule, loadSettings, paths, timeZone } from "./settings.mjs";
import { minutesSince } from "./clock.mjs";
import { gateReason } from "./gate.mjs";
import { cachedHealth, healthVerdict, readHealth, savedCpuTimes } from "./health.mjs";
import { gitState, isRepository, repoTop } from "./git.mjs";
import { findStamp, historyWindow, readLines, summarize } from "./journal.mjs";
import { flakyChecks, flakyCounts, flakyLines } from "./flaky.mjs";
import { notify } from "./notify.mjs";
import { markerOf } from "./nested.mjs";
import { folderProject } from "./project.mjs";
import { flagError, opt, USAGE } from "./args.mjs";
import { applyPlan, blockText, mcpLines, planFolder } from "./setup.mjs";
import { EXIT, jobFolder, realDeps, runCommand } from "./run.mjs";
import { cmdDiscard, cmdIntegrate, cmdWorktrees } from "./integrate.mjs";
import { afterMinutes } from "./timer.mjs";
import { MINUTE } from "./units.mjs";
import { spawn as spawnProcess } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { localWall, localZone } from "./cron.mjs";
import { cmdSchedule, newId } from "./schedule.mjs";
import { BORN, processGone, snapshot } from "./slots.mjs";
import { makeLog, runProgram, tickEnv, tickInstalled } from "./tick-install.mjs";

const CLI_FILE = fileURLToPath(import.meta.url);

// A nested run belongs to a job only when it names that job's slot or note, pid and start time: a later job in the
// same slot is another job.
const insideOf = (entry, h) => !!h.file && entry.outer === markerOf(h.file) && entry.outerPid === h.pid
    && entry.outerBorn === h.born;

/** The lines `status` prints. gate: the reason the gate is shut, or "". nested: the nested runs, each shown under the
 *  job whose slot or note, pid and start time it names in outer, outerPid and outerBorn, so a nested run inside a
 *  nested run is shown one step further in; they hold no slot and are not counted. One that waits for a place under
 *  its parent says so; its minutes count from when it began to wait, and once it runs, from when it started. */
export function statusLines({ holders, queue, nested = [], gate, max, now = Date.now() }) {
    const lines = [`slots: ${holders.length} of ${max} taken, ${queue.length} waiting`];
    for (const h of holders) {
        const began = h.startedAt ?? h.at;
        const ranMin = (now - began) / MINUTE;
        const facts = [`pid ${h.pid}`];
        if (h.kind) facts.push(`kind ${h.kind}`);
        facts.push(`${minutesSince(began, now)} min so far`);
        if (h.limitMin == null) facts.push("limit unknown");
        else {
            facts.push(`limit ${h.limitMin} min`);
            if (h.priority) facts.push(`priority (warning at ${h.limitMin} min, stop at ${h.killMin} min)`);
            facts.push(`${Math.max(0, Math.round((h.killMin ?? h.limitMin) - ranMin))} min left`);
            if (h.longRunMin && ranMin > h.longRunMin) facts.push(`past the ${h.longRunMin} min long-run mark`);
        }
        lines.push(`running "${h.label}": ${facts.join(", ")}`);
        nestedLines(h, nested, now, 1, lines);
    }
    queue.forEach((q, i) => {
        const priority = q.priority ? ", priority" : "";
        lines.push(`waiting ${i + 1} "${q.label}": pid ${q.pid}, ${minutesSince(q.at, now)} min so far${priority}`);
    });
    lines.push(gate ? `gate: shut; ${gate}` : "gate: open");
    return lines;
}

// The nested runs inside parent, each followed by its own, depth steps in. A run is shown once at most.
function nestedLines(parent, nested, now, depth, lines, shown = new Set()) {
    for (const n of nested.filter((entry) => insideOf(entry, parent) && !shown.has(entry))) {
        shown.add(n);
        const ran = `${minutesSince(n.startedAt ?? n.at, now)} min so far`;
        const state = n.waiting ? `waiting for a nested place under "${parent.label}"` : "no slot of its own";
        lines.push(`${"  ".repeat(depth)}nested "${n.label}": pid ${n.pid}, ${ran}, ${state}`);
        nestedLines(n, nested, now, depth + 1, lines, shown);
    }
}

/** One line of `history` for a project's totals. Skipped jobs are named only when there are any, with the run time
 *  of the passing runs they relied on as the time saved. flaky: the number of flaky checks in the range. scheduled:
 *  the jobs the schedule tick started; the tick's missed and busy lines are named only when there are any. */
export function historyRow(name, t, flaky = 0) {
    const gates = Object.entries(t.waitBy).map(([gate, min]) => `${gate} ${min} min`).join(", ") || "nothing";
    const skipped = t.skipped ? `, skipped ${t.skipped} (saved ${t.savedMin} min)` : "";
    const tick = `${t.missed ? `, missed ${t.missed}` : ""}${t.busy ? `, busy ${t.busy}` : ""}`;
    return `${name}: jobs ${t.jobs}, failed ${t.failed}, stopped ${t.stopped}, timed out ${t.timedOut}, `
        + `refused ${t.refused}, gave up ${t.gaveUp}${skipped}, flaky ${flaky}, scheduled ${t.scheduled ?? 0}${tick}; `
        + `waited: jobs ${t.waited}, sum ${t.waitMinTotal} min, clock ${t.waitWallMin} min, `
        + `clock with no job running ${t.blockedOnlyMin} min, `
        + `median ${t.waitMedian} min, p90 ${t.waitP90} min; held by: ${gates}`;
}

/** The lines of `history` for journal lines over a range from historyWindow(): the title, then, when there were
 *  jobs, the all-projects row and one row per project. The flaky count of a row is the checks that passed and failed
 *  on one commit with runs ended in the range. */
export function historyLines(lines, range) {
    const { all, byProject } = summarize(lines, range.from, range.to);
    const flaky = flakyCounts(flakyChecks(lines, { from: range.from, now: range.to }));
    const out = [`history: ${range.title}, jobs ${all.jobs}`];
    if (!all.jobs && !all.missed && !all.busy) return { all, byProject, lines: out };
    out.push(historyRow("all projects", all, flaky.all));
    for (const [name, t] of Object.entries(byProject)) out.push(historyRow(name, t, flaky.byProject[name] ?? 0));
    return { all, byProject, lines: out };
}

const say = (text) => process.stderr.write(`dotime-queue: ${text}\n`);
const DAYS_ERROR = "--days: needs a whole number of days, 1 or more";

/** Prints `status` and returns 0. deps: { readHealth, print }; readHealth is handed { limits }, as for `run`, and
 *  the CPU times saved with the shared reading as cpuSince, which status reads but never writes. */
export function cmdStatus({ settings, files }, { readHealth: read = readHealth, print = console.log } = {}) {
    const { holders, queue, nested } = snapshot({ dirs: files });
    const cpuSince = savedCpuTimes(files.healthCache);
    const health = healthVerdict(read({ limits: settings.health, cpuSince }), settings.health);
    const gate = gateReason({ holders, health }, settings.slots);
    for (const line of statusLines({ holders, queue, nested, gate, max: settings.slots })) print(line);
    return 0;
}

/** Prints the pass stamp of the folder in --cwd, else of the current folder, and returns 0, or 1 when there is none.
 *  A current folder that was removed is a usage error, with a line that points to --cwd. */
function cmdPassed(args, { files, tz }) {
    const read = jobFolder({ cwd: opt(args, "--cwd") || undefined }, { cwd: () => process.cwd() });
    if (read.error) {
        say("the current folder was removed; run passed from a folder that exists, or name one with --cwd <dir>");
        return EXIT.usage;
    }
    const { cwd } = read;
    const commit = gitState(cwd);
    const folder = { project: folderProject(cwd), ...commit, repository: commit.head !== null || isRepository(cwd) };
    const found = findStamp(readLines(files.journal), folder, opt(args, "--match") || "", { tz });
    console.log(found.text);
    return found.stamp ? 0 : 1;
}

function cmdHistory(args, { files, tz }) {
    const day = opt(args, "--day");
    const daysText = opt(args, "--days");
    if (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        say("--day: needs a date as YYYY-MM-DD");
        return EXIT.usage;
    }
    if (daysText !== undefined && !/^[1-9]\d*$/.test(daysText)) {
        say(DAYS_ERROR);
        return EXIT.usage;
    }
    const range = historyWindow({ day, days: daysText === undefined ? 7 : Number(daysText), tz });
    for (const line of historyLines(readLines(files.journal), range).lines) console.log(line);
    return 0;
}

/** `flaky`: one line per check that passed and failed on one clean commit in the last --days days (by default the
 *  flakyWindowDays setting), newest first, or one line that there is none. Exits 0, or 2 for a bad --days. */
export function cmdFlaky(args, { settings, files }, { print = console.log, warn = say, now = Date.now() } = {}) {
    const daysText = opt(args, "--days");
    if (daysText !== undefined && !/^[1-9]\d*$/.test(daysText)) {
        warn(DAYS_ERROR);
        return EXIT.usage;
    }
    const windowDays = daysText === undefined ? settings.flakyWindowDays : Number(daysText);
    for (const line of flakyLines(readLines(files.journal), { now, windowDays })) print(line);
    return 0;
}

/** `setup`: shows, or with --write makes, the changes to the project's agent files, then with --mcp prints the MCP
 *  settings. Without --cwd the project folder is the top folder of the git repository the current folder is in, or
 *  the current folder outside git. Exits 0 when done, 1 when a file cannot be read or written (nothing is written
 *  then, unless a write itself fails part way, which it names), 2 when the folder in --cwd does not exist. */
export function cmdSetup(args, {
    cwd = () => process.cwd(), top = repoTop, print = console.log, warn = say, writeFile,
} = {}) {
    const write = args.includes("--write");
    const named = opt(args, "--cwd");
    let dir = named, where = "";
    if (dir === undefined) {
        try {
            dir = cwd();
        } catch {
            warn("the current folder was removed; run setup from a folder that exists, or name one with --cwd <dir>");
            return EXIT.usage;
        }
        const repo = top(dir);
        where = repo ? " (the top folder of the git repository)" : " (the current folder, which is not in git)";
        dir = repo ?? dir;
    }
    const plan = planFolder(dir);
    if (plan.error) {
        warn(`setup: ${plan.error}`);
        return plan.folder ? EXIT.usage : 1;
    }
    print(`setup: project folder ${plan.root}${where}`);
    const done = applyPlan(plan, { write, ...(writeFile ? { writeFile } : {}) });
    for (const line of done.lines) print(line);
    for (const line of plan.notes ?? []) print(line);
    if (done.error) {
        print(`changed: ${done.changed.join(", ") || "nothing"}`);
        warn(`setup: ${done.error}`);
        return 1;
    }
    if (write) print(`changed: ${done.changed.join(", ") || "nothing"}`);
    else {
        print("dry run: nothing was changed; add --write to make these changes. The block:");
        for (const line of blockText().split("\n")) print(line);
    }
    if (args.includes("--mcp")) for (const line of ["", ...mcpLines()]) print(line);
    return 0;
}

/** Runs one subcommand and resolves with its exit code. Nothing in here or below ends the process: the one call of
 *  process.exit() is at the end of this file. */
export async function main(args = process.argv.slice(2)) {
    if (args[0] === "help" || args[0] === "--help") {
        console.log(USAGE);
        return 0;
    }
    const command = args.length ? args[0] : "status";
    // integrate and discard take a job id first, and read their own flags.
    // schedule reads the flags of its own sub-commands.
    const ownFlags = ["run", "integrate", "discard", "schedule"].includes(command);
    const badFlag = ownFlags ? null : flagError([command, ...args.slice(1)]);
    if (badFlag) {
        say(badFlag);
        return EXIT.usage;
    }
    // setup reads no settings and never touches the state folder.
    if (command === "setup") return cmdSetup(args);
    // The settings, the state folder and the zone are read once here and handed to the command. The current folder
    // is read only by the commands that use it, so status and history still work in a folder that was removed, and
    // `run` reads it only after its arguments were found valid.
    const ctx = { settings: loadSettings(), files: paths(), tz: timeZone() };
    if (command === "status") return cmdStatus(ctx);
    if (command === "passed") return cmdPassed(args, ctx);
    if (command === "history") return cmdHistory(args, ctx);
    if (command === "flaky") return cmdFlaky(args, ctx);
    if (command === "worktrees") return cmdWorktrees(ctx);
    if (command === "schedule") return cmdSchedule(args.slice(1), ctx.files, scheduleDeps(ctx, localZone()));
    if (command === "discard") return cmdDiscard(args, ctx, { say });
    if (command === "integrate") {
        const read = jobFolder({}, { cwd: () => process.cwd() });
        if (read.error) {
            say("integrate: the current folder was removed; run integrate in a folder of the repository");
            return EXIT.usage;
        }
        const run = (runArgs, more) => runCommand(runArgs, { ...ctx, ...more, runIn: more.cwd }, runDeps(ctx));
        return cmdIntegrate(args, { ...ctx, cwd: read.cwd }, { say, run });
    }
    return runCommand(args, ctx, runDeps(ctx));
}

/** The deps of `schedule`: the real clock, the wall clock and zone of this computer, this process as the owner of
 *  the lock, the started runs as `node cli.mjs run`, and for install the user's home folder, launchctl and systemctl.
 *  env: the environment the runs and the tick get. */
export function scheduleDeps({ files }, zone, env = process.env) {
    const node = process.execPath;
    const install = {
        platform: process.platform, userHome: homedir(), uid: process.getuid?.(), run: runProgram, makeLog,
        where: { node, cli: CLI_FILE, env: tickEnv(env, files.home), log: files.tickLog },
    };
    return {
        now: Date.now, wall: localWall, zone, uid: process.getuid?.(), owner: { pid: process.pid, born: BORN },
        isGone: (entry) => processGone(entry),
        pause: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), newId,
        cwd: () => process.cwd(), print: console.log, say, spawn: spawnProcess, env, node, cli: CLI_FILE,
        notify: (title, message) => notify(title, message, { env, logFile: files.notifyLog }),
        installed: () => tickInstalled(install.where, install), install,
    };
}

/** The deps `run` uses. Its health reading is shared between jobs that wait at the same time, one per poll, and is
 *  taken with the gate limits, as for `status`. read: the reading behind the shared one. */
export function runDeps({ settings, files }, read = readHealth) {
    const readGateHealth = (options) => read({ ...options, limits: settings.health });
    return realDeps({
        readHealth: () => cachedHealth(files.healthCache, settings.pollMs, readGateHealth),
        notify: (title, message) => notify(title, message, { env: process.env, logFile: files.notifyLog }),
        after: afterMinutes,
    });
}

if (isMainModule(import.meta.url)) process.exit(await main());
