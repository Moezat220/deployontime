// Run limits. A limit is taken from the journal: from earlier runs of the same command when there are enough, else
// from runs of the same kind, else from a default. An unreadable journal counts as no history and never holds a job
// back.
import { lineProject, parseLines } from "./journal.mjs";
import { cmdStem, kindOf } from "./kinds.mjs";
import { pctl } from "./stats.mjs";
import { DAY, oneDecimal } from "./units.mjs";

function passedRuns(lines, { project, now, windowDays }) {
    const oldest = now - windowDays * DAY;
    return parseLines(lines).filter((row) => {
        const ended = Date.parse(row.endedAt);
        const inWindow = ended >= oldest && ended <= now;
        return lineProject(row) === project && row.outcome === "ran" && row.exit === 0 && inWindow;
    });
}
const runTimes = (rows) => rows.map((row) => row.runMin ?? 0);
/** Returns { n, p75, p90 } in minutes, over passed runs of one kind in one project. */
export function kindStats(lines, { project, kind, now = Date.now(), windowDays }) {
    const ofKind = (row) => (row.kind ?? kindOf(row.label, row.cmd)) === kind;
    const times = runTimes(passedRuns(lines, { project, now, windowDays }).filter(ofKind));
    return { n: times.length, p75: pctl(times, 0.75), p90: pctl(times, 0.9) };
}
/** Returns { n, p75, p90, max, stem } in minutes, over passed runs with one command stem in one project. */
export function stemStats(lines, { project, stem, now = Date.now(), windowDays }) {
    if (!stem) return { n: 0, stem: null };
    const times = runTimes(passedRuns(lines, { project, now, windowDays }).filter((row) => cmdStem(row.cmd) === stem));
    const max = times.length ? Math.max(...times) : null;
    return { n: times.length, p75: pctl(times, 0.75), p90: pctl(times, 0.9), max, stem };
}

/** Picks the run limit and the long-run mark for a job. Returns { limitMin, basis, longRunMin, longRunBasis,
 *  killMin, notifyLongRun }; killMin is when the job is stopped. */
export function decideLimit(job, limitSettings) {
    const { maxRun = null, kind, stats = { n: 0 }, stem = null, priority = false } = job;
    const { minSamples, p90Factor, floorMin, longRunFactor, longRunUnmeasuredMin } = limitSettings;
    const ownHistory = (stem?.n ?? 0) >= minSamples;
    const source = ownHistory ? stem : stats;
    const subject = ownHistory ? `command "${stem.stem}"` : `kind ${kind}`;
    const measured = source.n >= minSamples;
    const fixed = maxRun != null || kind === "debug";
    let limitMin;
    let basis;
    if (maxRun != null) {
        limitMin = maxRun;
        basis = "the --max-run flag";
    } else if (kind === "debug") {
        limitMin = limitSettings.debugMin;
        basis = "the debug-job setting";
    } else if (measured) {
        const fromRuns = oneDecimal(source.p90 * p90Factor);
        const lifted = fromRuns < floorMin ? `, lifted to the ${floorMin} min minimum` : "";
        limitMin = Math.max(floorMin, fromRuns);
        basis = `${source.n} passed runs of ${subject} (${p90Factor} times their p90 of ${source.p90} min${lifted})`;
    } else {
        limitMin = limitSettings.defaultMin;
        basis = `the default (${source.n} of the ${minSamples} passed runs needed for ${subject})`;
    }
    const markFrom = (s, what) => `${longRunFactor} times the p75 of ${s.p75} min over ${s.n} passed runs of ${what}`;
    let longRunMin = measured ? Math.max(floorMin, oneDecimal(source.p75 * longRunFactor)) : longRunUnmeasuredMin;
    const unmeasured = `the ${longRunUnmeasuredMin} min setting for jobs without history`;
    let longRunBasis = measured ? markFrom(source, subject) : unmeasured;
    // A command with only a few runs cannot set the limit, but it may raise one that its own runs already exceed.
    if (!ownHistory && stem?.n > 0) {
        const fromLongest = oneDecimal(stem.max * p90Factor);
        const ownMark = oneDecimal(stem.p75 * longRunFactor);
        if (!fixed && fromLongest > limitMin) {
            limitMin = fromLongest;
            basis = `${stem.max} min, the longest passed run of command "${stem.stem}" (${stem.n} on record), `
                + `times ${p90Factor}; that is more than ${basis}`;
        }
        if (ownMark > longRunMin) {
            longRunMin = ownMark;
            longRunBasis = markFrom(stem, `command "${stem.stem}"`);
        }
    }
    const killMin = priority ? limitMin * limitSettings.priorityGrace : limitMin;
    return { limitMin, basis, longRunMin, longRunBasis, killMin, notifyLongRun: longRunMin < killMin };
}
