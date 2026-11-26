// The repeated-failure stop: a run is refused when the same check just failed twice on unchanged code.
import { loadSettings, timeZone } from "./settings.mjs";
import { clockTime } from "./clock.mjs";
import { isFailedRun, isStopped, lineProject, parseLines } from "./journal.mjs";
import { UNLABELLED } from "./args.mjs";
import { HOUR } from "./units.mjs";

const failed = (row) => row.outcome === "timed-out" || isFailedRun(row);
const bothDiffer = (a, b) => a != null && b != null && a !== b;
/** Should this run be refused because the same check just failed twice on the same code?
 *  job = { label, cmd, project, cwd, head, fp, at }.
 *  Returns { refuse: false }, { refuse: false, changed: "commit" | "files" | "command" } or { refuse: true, reason }. */
export function failStop(lines, job, limitSettings = loadSettings().limits, tz = timeZone()) {
    // Runs are one check when their labels match; failing that, when command, project and folder all match.
    const sameCheck = (row) => (job.label !== UNLABELLED && row.label === job.label)
        || (!!job.cmd && row.cmd === job.cmd && lineProject(row) === job.project && (!job.cwd || !row.cwd || row.cwd === job.cwd));
    const finished = parseLines(lines)
        .filter((row) => row.endedAt && (row.outcome === "timed-out" || (row.outcome === "ran" && !isStopped(row))) && sameCheck(row))
        .sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt));
    const [last, previous] = finished;
    if (!last || !previous || !failed(last) || !failed(previous)) return { refuse: false };
    if ((job.at ?? Date.now()) - Date.parse(previous.endedAt) > limitSettings.failWindowHours * HOUR) return { refuse: false };
    if (last.head !== previous.head || bothDiffer(last.fp, previous.fp) || bothDiffer(last.cmd, previous.cmd)) return { refuse: false };
    if (last.head !== undefined && last.head !== job.head) return { refuse: false, changed: "commit" };
    if (bothDiffer(last.fp, job.fp)) return { refuse: false, changed: "files" };
    if (bothDiffer(last.cmd, job.cmd)) return { refuse: false, changed: "command" };
    const ending = (row) => `${row.outcome === "timed-out" ? "run limit hit" : `exit ${row.exit}`} at ${clockTime(Date.parse(row.endedAt), tz)}`;
    const commit = last.head ? `, commit ${String(last.head).slice(0, 8)}` : "";
    return {
        refuse: true,
        reason: `same check failed twice on unchanged code: "${job.label}"${commit}, ${ending(previous)}, then ${ending(last)}; `
            + 'hint: change the code, or pass --after-fix "<note>" before the -- to run it anyway',
    };
}
