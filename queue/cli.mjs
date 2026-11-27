#!/usr/bin/env node
// The dotime-queue command. `run` waits for a slot and runs one job under a run limit; `status` shows slots, line
// and gate; `passed` looks up a pass stamp; `history` sums up the journal. queue/README.md describes each in full.
import { isMainModule, loadSettings, paths, timeZone } from "./settings.mjs";
import { minutesSince } from "./clock.mjs";
import { snapshot } from "./slots.mjs";
import { gateReason } from "./gate.mjs";
import { cachedHealth, healthVerdict, readHealth, savedCpuTimes } from "./health.mjs";
import { gitState, isRepository } from "./git.mjs";
import { findStamp, historyWindow, readLines, summarize } from "./journal.mjs";
import { notify } from "./notify.mjs";
import { markerOf } from "./nested.mjs";
import { folderProject } from "./project.mjs";
import { flagError, opt, USAGE } from "./args.mjs";
import { EXIT, jobFolder, realDeps, runCommand } from "./run.mjs";
import { afterMinutes } from "./timer.mjs";
import { MINUTE } from "./units.mjs";

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

/** One line of `history` for a project's totals. */
export function historyRow(name, t) {
    const gates = Object.entries(t.waitBy).map(([gate, min]) => `${gate} ${min} min`).join(", ") || "nothing";
    return `${name}: jobs ${t.jobs}, failed ${t.failed}, stopped ${t.stopped}, timed out ${t.timedOut}, `
        + `refused ${t.refused}, gave up ${t.gaveUp}; `
        + `waited: jobs ${t.waited}, sum ${t.waitMinTotal} min, clock ${t.waitWallMin} min, `
        + `clock with no job running ${t.blockedOnlyMin} min, `
        + `median ${t.waitMedian} min, p90 ${t.waitP90} min; held by: ${gates}`;
}

const say = (text) => process.stderr.write(`dotime-queue: ${text}\n`);

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
        say("--days: needs a whole number of days, 1 or more");
        return EXIT.usage;
    }
    const range = historyWindow({ day, days: daysText === undefined ? 7 : Number(daysText), tz });
    const { all, byProject } = summarize(readLines(files.journal), range.from, range.to);
    console.log(`history: ${range.title}, jobs ${all.jobs}`);
    if (!all.jobs) return 0;
    for (const [name, t] of [["all projects", all], ...Object.entries(byProject)]) console.log(historyRow(name, t));
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
    const badFlag = command === "run" ? null : flagError([command, ...args.slice(1)]);
    if (badFlag) {
        say(badFlag);
        return EXIT.usage;
    }
    // The settings, the state folder and the zone are read once here and handed to the command. The current folder
    // is read only by the commands that use it, so status and history still work in a folder that was removed, and
    // `run` reads it only after its arguments were found valid.
    const ctx = { settings: loadSettings(), files: paths(), tz: timeZone() };
    if (command === "status") return cmdStatus(ctx);
    if (command === "passed") return cmdPassed(args, ctx);
    if (command === "history") return cmdHistory(args, ctx);
    return runCommand(args, ctx, runDeps(ctx));
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
