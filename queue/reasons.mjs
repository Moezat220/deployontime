// `dotime-queue reasons`: the failures of the last days by the class failreason.mjs gave them, and for each class how
// many passed when the same check ran again on the same commit. That second number is what a retry of the class could
// have saved, so it is measured before any retry is built. A failure counts as passed on a re-run only when it began
// with a clean tree on a commit and the next run of the same check on that commit and in that folder, also from a
// clean tree, passed; checks are told apart as the flaky flag and the repeated-failure stop do (sameCheck). A run from
// a tree with uncommitted changes never counts either way: its code is not the commit's.
import { sameCheck } from "./failstop.mjs";
import { CLASSES, ENV_CLASSES } from "./failreason.mjs";
import { isFailedRun, isStopped, lineProject, parseLines } from "./journal.mjs";
import { isLost } from "./lost.mjs";
import { DAY, oneDecimal } from "./units.mjs";

export const REASONS_DAYS = 7;

const endOf = (row) => Date.parse(row.endedAt);
const onCleanCommit = (row) => row.clean === true && !!row.head;
/** A row that holds a failure: a run that failed, hit its run limit or was stopped. */
export const isFailure = (row) => isFailedRun(row) || row.outcome === "timed-out" || isStopped(row);
// A run that ended by itself, as the flaky flag counts runs: the only kind whose result says something about the code.
const counted = (row) => row.outcome === "ran" && onCleanCommit(row) && !isStopped(row);

/** The next counted run of the same check on the same commit and in the same folder after the failure, or null. */
function nextRun(failure, rows) {
    const check = { label: failure.label, cmd: failure.cmd ?? null, project: lineProject(failure), cwd: failure.cwd ?? null };
    const after = endOf(failure);
    let next = null;
    for (const row of rows) {
        if (row === failure || !counted(row) || row.head !== failure.head || (row.cwd ?? null) !== check.cwd) continue;
        if (endOf(row) <= after || !sameCheck(check, row)) continue;
        if (!next || endOf(row) < endOf(next)) next = row;
    }
    return next;
}

const tally = (counts, key) => { counts[key] = (counts[key] ?? 0) + 1; };
const ranked = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

/** The report as data: { days, from, to, classes, total, retry, lost }. classes, most failures first: { class, failures,
 *  clean, passedOnRerun, runMin, rerunMin, signs, alsoSaw }, where clean counts the failures from a clean tree on a
 *  commit, passedOnRerun those whose next run passed, runMin the run minutes of the failures and rerunMin those of
 *  the passing re-runs. total sums them and names in unrecorded the failures with no reason, journalled before the
 *  queue recorded one, and in nested the failures of jobs whose reason has via "nested": they are counted once, on
 *  the line of the run nested in them that failed. retry: per environment class with a passing re-run, { class, reruns, runMin }.
 *  lost: the runs cut off by a restart or a dead queue process; they are no failure of the code and are in no class. */
export function reasonsReport(lines, { now = Date.now(), days = REASONS_DAYS } = {}) {
    const from = now - days * DAY;
    const rows = parseLines(lines).filter((row) => row.endedAt && endOf(row) <= now);
    const failures = rows.filter((row) => isFailure(row) && endOf(row) >= from);
    const byClass = new Map();
    let unrecorded = 0, nested = 0;
    for (const row of failures) {
        // The failure of a run nested in this job: counted on the nested run's own line.
        if (row.reason?.via === "nested") { nested += 1; continue; }
        const name = row.reason?.class;
        if (!CLASSES.includes(name)) { unrecorded += 1; continue; }
        const entry = byClass.get(name) ?? byClass.set(name, {
            class: name, failures: 0, clean: 0, passedOnRerun: 0, runMin: 0, rerunMin: 0, signs: {}, alsoSaw: {},
        }).get(name);
        entry.failures += 1;
        entry.runMin += row.runMin ?? 0;
        if (row.reason.sign) tally(entry.signs, row.reason.sign);
        if (row.reason.alsoSaw) tally(entry.alsoSaw, row.reason.alsoSaw);
        if (!onCleanCommit(row)) continue;
        entry.clean += 1;
        const next = nextRun(row, rows);
        if (next?.exit !== 0) continue;
        entry.passedOnRerun += 1;
        entry.rerunMin += next.runMin ?? 0;
    }
    const classes = [...byClass.values()]
        .map((c) => ({
            ...c, runMin: oneDecimal(c.runMin), rerunMin: oneDecimal(c.rerunMin),
            signs: Object.fromEntries(ranked(c.signs)), alsoSaw: Object.fromEntries(ranked(c.alsoSaw)),
        }))
        .sort((a, b) => b.failures - a.failures || CLASSES.indexOf(a.class) - CLASSES.indexOf(b.class));
    const sum = (key) => classes.reduce((all, c) => all + c[key], 0);
    const total = {
        failures: sum("failures"), clean: sum("clean"), passedOnRerun: sum("passedOnRerun"),
        runMin: oneDecimal(sum("runMin")), rerunMin: oneDecimal(sum("rerunMin")), unrecorded, nested,
    };
    const retry = classes.filter((c) => ENV_CLASSES.includes(c.class) && c.passedOnRerun)
        .map((c) => ({ class: c.class, reruns: c.passedOnRerun, runMin: c.rerunMin }));
    const lost = rows.filter((row) => isLost(row) && endOf(row) >= from).length;
    return { days, from: new Date(from).toISOString(), to: new Date(now).toISOString(), classes, total, retry, lost };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const share = (part, whole) => (whole ? ` (${Math.round((100 * part) / whole)}%)` : "");
const counts = (map) => Object.entries(map).map(([name, n]) => `${name} ${n}`).join(", ");

// The part of a line both a class and the total have.
function body(c) {
    return `${plural(c.failures, "failure", "failures")}, ${c.clean} on a clean tree, ${c.passedOnRerun} passed on a `
        + `plain re-run of the same commit${share(c.passedOnRerun, c.clean)}, ${c.runMin} run-min`;
}

/** The lines of `dotime-queue reasons` for a reasonsReport(). */
export function reasonsLines(report) {
    const { classes, total, retry, days } = report;
    const left = total.unrecorded ? `; ${plural(total.unrecorded, "failure", "failures")} from before reasons were recorded not counted` : "";
    const lost = report.lost ? [`lost: ${plural(report.lost, "run", "runs")} cut off by a restart or a dead queue process`] : [];
    const none = total.unrecorded ? "no failure with a reason yet" : "no failures";
    if (!classes.length) return [`reasons: ${none} in ${plural(days, "day", "days")}${left}`, ...lost];
    const lines = classes.map((c) => {
        const signs = Object.keys(c.signs).length ? `; signs ${counts(c.signs)}` : "";
        const also = Object.keys(c.alsoSaw).length ? `; also saw ${counts(c.alsoSaw)}` : "";
        return `${c.class}: ${body(c)}${signs}${also}`;
    });
    lines.push(...lost);
    const inner = total.nested ? `; ${plural(total.nested, "outer job", "outer jobs")} counted on the run nested in it` : "";
    lines.push(`total in ${plural(days, "day", "days")}: ${body(total)}${inner}${left}`);
    lines.push(retry.length
        ? `a retry of the environment classes would have saved: ${retry
            .map((r) => `${r.class} ${plural(r.reruns, "re-run", "re-runs")} that passed (${r.runMin} run-min)`).join(", ")}`
        : "a retry of the environment classes would have saved nothing: no such failure passed on a re-run");
    return lines;
}
