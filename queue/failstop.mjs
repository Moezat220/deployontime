// The repeated-failure stop: a run is refused when the same check just failed twice on unchanged code.
import { clockTime } from "./clock.mjs";
import { isFailedRun, isStopped, lineProject, parseLines } from "./journal.mjs";
import { UNLABELLED } from "./kinds.mjs";
import { HOUR } from "./units.mjs";

// A run that ended by itself or at its limit; a stopped run says nothing about the code.
const countsAsAttempt = (row) => row.outcome === "timed-out" || (row.outcome === "ran" && !isStopped(row));
const failed = (row) => row.outcome === "timed-out" || isFailedRun(row);
const bothDiffer = (a, b) => a != null && b != null && a !== b;
// The journal stores the fingerprint as fp. Lines that call it fingerprint are read as well.
const printOf = (row) => row.fp ?? row.fingerprint;
/** Should this run be refused because the same check just failed twice on the same code?
 *  job = { label, cmd, project, cwd, head, fingerprint, at }.
 *  Returns { refuse: false }, { refuse: false, changed: "commit" | "files" | "command" }, or
 *  { refuse: true, reason }. */
export function failStop(lines, job, limitSettings, tz) {
    // Runs are one check when their labels match; failing that, when command, project and folder all match.
    const sameFolder = (row) => !job.cwd || !row.cwd || row.cwd === job.cwd;
    const sameCheck = (row) => (job.label !== UNLABELLED && row.label === job.label)
        || (!!job.cmd && row.cmd === job.cmd && lineProject(row) === job.project && sameFolder(row));
    const finished = parseLines(lines)
        .filter((row) => row.endedAt && countsAsAttempt(row) && sameCheck(row))
        .sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt));
    const [last, previous] = finished;
    if (!last || !previous || !failed(last) || !failed(previous)) return { refuse: false };
    const sincePrevious = (job.at ?? Date.now()) - Date.parse(previous.endedAt);
    if (sincePrevious > limitSettings.failWindowHours * HOUR) return { refuse: false };
    const codeMoved = last.head !== previous.head || bothDiffer(printOf(last), printOf(previous));
    if (codeMoved || bothDiffer(last.cmd, previous.cmd)) return { refuse: false };
    if (last.head !== undefined && last.head !== job.head) return { refuse: false, changed: "commit" };
    if (bothDiffer(printOf(last), job.fingerprint)) return { refuse: false, changed: "files" };
    if (bothDiffer(last.cmd, job.cmd)) return { refuse: false, changed: "command" };
    const ending = (row) => {
        const how = row.outcome === "timed-out" ? "run limit hit" : `exit ${row.exit}`;
        return `${how} at ${clockTime(Date.parse(row.endedAt), tz)}`;
    };
    const commit = last.head ? `, commit ${String(last.head).slice(0, 8)}` : "";
    return {
        refuse: true,
        reason: `same check failed twice on unchanged code: "${job.label}"${commit}, `
            + `${ending(previous)}, then ${ending(last)}; `
            + 'hint: change the code, or pass --after-fix "<note>" before the -- to run it anyway',
    };
}
