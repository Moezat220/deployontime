// The flaky flag: a check that both passed and failed on one commit, each time with a clean tree, got different
// results from the same code, so a failure of it may not come from the change at hand. It is advice only: nothing in
// here changes how a run ends, whether it is skipped or refused, or its exit code. Checks are told apart by the rule
// the repeated-failure stop uses (sameCheck in failstop.mjs).
import { ageText } from "./clock.mjs";
import { sameCheck } from "./failstop.mjs";
import { isFailedRun, isStopped, lineProject, parseLines } from "./journal.mjs";
import { UNLABELLED } from "./kinds.mjs";
import { DAY } from "./units.mjs";

export const FLAKY_WINDOW_DAYS = 14;

// Only a run that ended by itself, on a commit, from a clean tree, says something about the test. Timed-out, refused,
// skipped, gave-up, left, stopped and could-not-start lines are the machine or the user, and never count.
const counts = (row) => row.outcome === "ran" && row.clean === true && !!row.head && !isStopped(row);
const endOf = (row) => Date.parse(row.endedAt);

/** The rows that count, ended in the window: from `from` when given, else windowDays back from now, up to now. */
function countedRows(lines, { now = Date.now(), windowDays = FLAKY_WINDOW_DAYS, from } = {}) {
    const since = from ?? now - windowDays * DAY;
    return parseLines(lines).filter((row) => counts(row) && endOf(row) >= since && endOf(row) <= now);
}

/** The mixed commits of one check's runs: commits with at least one pass and one failure. Runs are on the same code
 *  when they share the commit and the folder: one label may run in two folders of a repository, which hold different
 *  code. Returns null when there are none, else { mixedCommits, passes, fails, lastEndedAt }, the counts summed over
 *  the mixed commits only, and lastEndedAt the end of the newest run on one of them. */
function mixedOf(runs) {
    const byHead = new Map();
    for (const row of runs) {
        const key = `${row.head}\n${row.cwd ?? ""}`;
        (byHead.get(key) ?? byHead.set(key, []).get(key)).push(row);
    }
    let mixedCommits = 0, passes = 0, fails = 0, last = -Infinity;
    for (const group of byHead.values()) {
        const passed = group.filter((row) => row.exit === 0).length;
        const failed = group.filter(isFailedRun).length;
        if (!passed || !failed) continue;
        mixedCommits += 1;
        passes += passed;
        fails += failed;
        last = Math.max(last, ...group.map(endOf));
    }
    return mixedCommits ? { mixedCommits, passes, fails, lastEndedAt: new Date(last).toISOString() } : null;
}

const checkOf = (row) => ({ label: row.label, cmd: row.cmd ?? null, project: lineProject(row), cwd: row.cwd ?? null });

/** The flaky checks in the window, newest mixed run first. lines: journal lines or rows. opts: { now, windowDays,
 *  from }. Each: { label, project, cwd, cmd, mixedCommits, passes, fails, lastEndedAt }. The newest run of a check
 *  stands for it: an older run joins the first check whose newest run sameCheck takes it for. */
export function flakyChecks(lines, opts = {}) {
    const checks = [];
    const newestFirst = countedRows(lines, opts).sort((a, b) => endOf(b) - endOf(a));
    for (const row of newestFirst) {
        const check = checks.find((c) => sameCheck(c.job, row));
        if (check) check.runs.push(row);
        else checks.push({ job: checkOf(row), runs: [row] });
    }
    return checks.flatMap(({ job, runs }) => {
        const mixed = mixedOf(runs);
        return mixed ? [{ ...job, ...mixed }] : [];
    }).sort((a, b) => Date.parse(b.lastEndedAt) - Date.parse(a.lastEndedAt));
}

/** The flaky facts of one check, or null when it is not flaky. job: { label, cmd, project, cwd }, as for failStop.
 *  opts: { now, windowDays }. Returns { mixedCommits, passes, fails, lastEndedAt, note }. */
export function flakyFor(lines, job, opts = {}) {
    const mixed = mixedOf(countedRows(lines, opts).filter((row) => sameCheck(job, row)));
    if (!mixed) return null;
    const days = opts.windowDays ?? FLAKY_WINDOW_DAYS;
    const times = mixed.mixedCommits === 1 ? "once" : `${mixed.mixedCommits} times`;
    const note = `flaky: this check passed and failed on the same commit ${times} in ${days} day${days === 1 ? "" : "s"}, `
        + `last ${ageText(Date.parse(mixed.lastEndedAt), opts.now ?? Date.now())}; the failure may not come from your change`;
    return { ...mixed, note };
}

/** The one advisory clause for a check, or null when it is not flaky. Arguments as for flakyFor. */
export const flakyNoteFor = (lines, job, opts = {}) => flakyFor(lines, job, opts)?.note ?? null;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/** The lines of `dotime-queue flaky`: one per flaky check, newest first, or one line that there are none. */
export function flakyLines(lines, { now = Date.now(), windowDays = FLAKY_WINDOW_DAYS } = {}) {
    const checks = flakyChecks(lines, { now, windowDays });
    if (!checks.length) return [`flaky: none in ${plural(windowDays, "day", "days")}`];
    return checks.map((c) => {
        const name = c.label === UNLABELLED || !c.label ? `${c.project}: unlabelled, folder ${c.cwd ?? "not recorded"}` : c.label;
        const runs = `${plural(c.passes, "pass", "passes")} and ${plural(c.fails, "failure", "failures")}`;
        return `${name}; mixed on ${plural(c.mixedCommits, "commit", "commits")}, ${runs}, `
            + `last ${ageText(Date.parse(c.lastEndedAt), now)}; command ${c.cmd ?? "not recorded"}`;
    });
}

/** How many flaky checks each project has, for `history`: { all, byProject }. */
export function flakyCounts(checks) {
    const byProject = {};
    for (const c of checks) byProject[c.project] = (byProject[c.project] ?? 0) + 1;
    return { all: checks.length, byProject };
}
