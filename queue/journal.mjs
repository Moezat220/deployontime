// The journal: one JSON line per job in $DOTIME_HOME/journal.jsonl, holding its label and project, waiting time per
// gate, run time, outcome, command and the commit it ran on. Run limits, the repeated-failure stop, pass stamps and
// `history` all read it. A failed write is reported by a return value and never interrupts a job. This module only
// reads and writes the journal file; the git facts in a line come from git.mjs.
import { readFileSync } from "node:fs";
import { dateTime, dayOf, dayStart, shiftDay } from "./clock.mjs";
import { jobProject } from "./project.mjs";
import { pctl } from "./stats.mjs";
import { appendLine } from "./files.mjs";
import { MINUTE, oneDecimal } from "./units.mjs";

const minutes = (ms) => oneDecimal(ms / MINUTE);

/** Journal lines as objects; text that is not JSON is skipped. */
export function parseLines(lines) {
    const rows = [];
    for (const line of lines) {
        if (typeof line !== "string") { if (line) rows.push(line); continue; }
        try { rows.push(JSON.parse(line)); } catch { /* skipped */ }
    }
    return rows;
}

/** Books waiting time to each gate named by the blocks ([{ gate }]). */
export function addWait(tally, blocks, ms) {
    for (const { gate } of blocks) tally[gate] = (tally[gate] ?? 0) + ms;
    return tally;
}

/** Joins arguments with spaces, JSON-quoting any that a shell would not read as one plain word. */
export function cmdString(args) {
    return (args ?? []).map((arg) => (arg === "" || /[^\w@%+=:,./-]/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
}

// Signals that mean someone stopped the job, and the exit codes (128 + number) that shells report for them.
const STOP_SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };
const STOP_EXITS = Object.fromEntries(Object.entries(STOP_SIGNALS).map(([name, number]) => [128 + number, name]));
/** A signal that reached the queue process during the run (received) settles it as stopped, whatever the exit code.
 *  Otherwise the job's own stop signal, or the exit code a shell gives for one, does. Everything else just ran. */
export function jobEnd({ code = null, signal = null, received = null }) {
    const stopper = received ?? (signal in STOP_SIGNALS ? signal : STOP_EXITS[code] ?? null);
    return stopper ? { outcome: "stopped", signal: stopper } : { outcome: "ran" };
}
export const isStopped = (row) => row.outcome === "stopped" || (row.outcome === "ran" && row.exit in STOP_EXITS);
export const isFailedRun = (row) => row.outcome === "ran" && row.exit !== 0 && !isStopped(row);

const isoOrNull = (ms) => (ms ? new Date(ms).toISOString() : null);
/** Builds a journal line. outcome: ran, stopped, timed-out, refused, gave-up, left or could-not-start. */
export function record(job) {
    const { label, project, cwd, priority, queuedAt, startedAt, endedAt, outcome, exit, tally } = job;
    const { cmd, head, clean, extra } = job;
    return {
        v: 1, label, project, projectKey: jobProject({ label, project, cwd }), cwd, priority: !!priority,
        queuedAt: isoOrNull(queuedAt), startedAt: isoOrNull(startedAt), endedAt: isoOrNull(endedAt),
        waitMin: minutes((startedAt ?? endedAt) - queuedAt), runMin: startedAt ? minutes(endedAt - startedAt) : 0,
        outcome, exit: exit ?? null,
        waitBy: Object.fromEntries(Object.entries(tally ?? {}).map(([gate, ms]) => [gate, minutes(ms)])),
        cmd: cmd ?? null, head: head ?? null, clean: clean ?? null, ...(extra ?? {}),
    };
}
export const lineProject = (row) => row.projectKey ?? jobProject(row);

export function append(row, file) {
    return appendLine(file, `${JSON.stringify(row)}\n`);
}
export function readLines(file) {
    try { return readFileSync(file, "utf8").split("\n").filter(Boolean); } catch { return []; }
}

const shortId = (commit) => String(commit).slice(0, 8);
/** Looks for a passing run on the commit a folder is at. folder = { project, head, clean, repository }, where
 *  repository says whether a folder without a head is a git repository that has no commits yet; match narrows the
 *  runs to those with the text in their label or command. Returns { stamp: the run or null, text: one line to print }. */
export function findStamp(lines, folder, match, { tz, at = Date.now() }) {
    const none = (why) => ({ stamp: null, text: `no stamp: ${why}` });
    const wanted = String(match).toLowerCase();
    if (!folder.head && folder.repository) return none("the current branch has no commits yet");
    if (!folder.head) return none("this folder is not a git checkout");
    if (folder.clean == null) return none("git status could not be read");
    if (!folder.clean) return none("the working tree has uncommitted changes");
    const runs = parseLines(lines)
        .filter((row) => row.project === folder.project && row.head && row.outcome === "ran" && !isStopped(row))
        .filter((row) => !wanted || `${row.label ?? ""}\n${row.cmd ?? ""}`.toLowerCase().includes(wanted))
        .sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt));
    const scope = `project ${folder.project}${wanted ? `, filter "${match}"` : ""}`;
    const ended = (row) => dateTime(Date.parse(row.endedAt), tz);
    if (!runs.length) return none(`no finished run on record, ${scope}`);
    const onCommit = runs.filter((row) => row.head === folder.head);
    if (!onCommit.length) {
        const newest = `newest run at ${shortId(runs[0].head)} (ended ${ended(runs[0])})`;
        return none(`commit differs, folder at ${shortId(folder.head)}, ${newest}, ${scope}`);
    }
    const run = onCommit.find((row) => row.clean === true);
    if (!run) return none(`every run at ${shortId(folder.head)} began with uncommitted changes, ${scope}`);
    if (run.exit !== 0) {
        const facts = `exit ${run.exit}, commit ${shortId(run.head)}, ended ${ended(run)}`;
        return none(`newest clean run failed, "${run.label}", ${facts}`);
    }
    const ago = Math.max(0, Math.round((at - Date.parse(run.endedAt)) / MINUTE));
    const text = `stamp: commit ${shortId(run.head)}, passed ${ago} min ago by "${run.label}", `
        + `command ${run.cmd ?? "not recorded"}, run time ${run.runMin} min, tree clean at start, `
        + `finished ${ended(run)}`;
    return { stamp: run, text };
}

/** The time range `history` covers. Returns { from, to, title }. day picks one calendar day; otherwise the range is the
 *  last `days` calendar days up to now, both counted in the zone. */
export function historyWindow({ day = null, days = 7, now = Date.now(), tz }) {
    if (day) {
        const nextDay = dayStart(shiftDay(day, 1), tz);
        return { from: dayStart(day, tz), to: Math.min(now, nextDay), title: `${day}, zone ${tz}` };
    }
    const count = Math.max(1, Math.ceil(days));
    const today = dayOf(now, tz);
    const first = shiftDay(today, 1 - count);
    const title = count === 1 ? `${today} so far, zone ${tz}` : `${first} through ${today} (${count} days), zone ${tz}`;
    return { from: dayStart(first, tz), to: now, title };
}

const interval = (from, to, cap) => (Number.isFinite(from) && Number.isFinite(to) ? [from, Math.min(to, cap)] : null);
function waitInterval(row, cap) {
    const from = Date.parse(row.queuedAt);
    const to = Date.parse(row.startedAt ?? row.endedAt);
    return interval(from, Number.isFinite(to) ? to : from + (row.waitMin ?? 0) * MINUTE, cap);
}
function runInterval(row, cap) {
    const from = Date.parse(row.startedAt);
    const to = Date.parse(row.endedAt);
    return interval(from, Number.isFinite(to) ? to : from + (row.runMin ?? 0) * MINUTE, cap);
}
/** A sweep over wait and run intervals. waitWallMin: time with one or more jobs waiting, overlaps merged.
 *  blockedOnlyMin: the share of that time in which nothing was running. */
export function clockMinutes(waits, runs = []) {
    const edges = [];
    for (const w of waits) if (w && w[1] > w[0]) edges.push([w[0], 1, 0], [w[1], -1, 0]);
    for (const r of runs) if (r && r[1] > r[0]) edges.push([r[0], 0, 1], [r[1], 0, -1]);
    edges.sort((a, b) => a[0] - b[0]);
    let waiting = 0;
    let running = 0;
    let previous = 0;
    let wall = 0;
    let blocked = 0;
    for (const [t, waitStep, runStep] of edges) {
        if (waiting > 0) { wall += t - previous; if (running === 0) blocked += t - previous; }
        waiting += waitStep; running += runStep; previous = t;
    }
    return { waitWallMin: minutes(wall), blockedOnlyMin: minutes(blocked) };
}

function totals(rows, until) {
    const waits = rows.map((row) => row.waitMin);
    const waitBy = {};
    for (const row of rows) {
        for (const [gate, min] of Object.entries(row.waitBy ?? {})) {
            waitBy[gate] = oneDecimal((waitBy[gate] ?? 0) + min);
        }
    }
    const count = (test) => rows.filter(test).length;
    return {
        jobs: rows.length,
        waited: count((row) => row.waitMin >= 1),
        waitMinTotal: oneDecimal(waits.reduce((a, b) => a + b, 0)),
        ...clockMinutes(rows.map((row) => waitInterval(row, until)), rows.map((row) => runInterval(row, until))),
        waitMedian: pctl(waits, 0.5) ?? 0,
        waitP90: pctl(waits, 0.9) ?? 0,
        runMinTotal: oneDecimal(rows.reduce((sum, row) => sum + (row.runMin ?? 0), 0)),
        gaveUp: count((row) => row.outcome === "gave-up"), failed: count(isFailedRun), stopped: count(isStopped),
        timedOut: count((row) => row.outcome === "timed-out"),
        refused: count((row) => row.outcome === "refused"),
        waitBy,
    };
}
/** Returns { all, byProject } for jobs whose queue time lies in [since, until); the project that waited longest
 *  comes first. */
export function summarize(lines, since = 0, until = Infinity) {
    const inRange = (row) => Date.parse(row.queuedAt) >= since && Date.parse(row.queuedAt) < until;
    const rows = parseLines(lines).filter(inRange);
    const groups = new Map();
    for (const row of rows) {
        const name = lineProject(row);
        (groups.get(name) ?? groups.set(name, []).get(name)).push(row);
    }
    const perProject = [...groups].map(([name, group]) => [name, totals(group, until)])
        .sort((a, b) => b[1].waitWallMin - a[1].waitWallMin || b[1].waitMinTotal - a[1].waitMinTotal);
    return { all: totals(rows, until), byProject: Object.fromEntries(perProject) };
}
