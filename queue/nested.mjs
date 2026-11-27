// Nested runs: a job started by the queue that itself calls `dotime-queue run`. The queue puts a marker naming the
// job's slot in the job's environment. A run that finds the marker runs at once, without a slot of its own, but only
// while the marker is genuine: the slot it names is held, and the process holding it is one of the run's own
// ancestors. Anything else, such as a marker copied into another shell or left over from a job that has ended, is
// ignored, so the marker cannot be used to skip the line from outside.
import { basename } from "node:path";
import { probeProcessTree } from "./probes.mjs";
import { ancestors } from "./proctree.mjs";
import { psRows } from "./ps.mjs";

/** The environment variable that carries the marker into a job. */
export const JOB_MARKER = "DOTIME_JOB";

const MARKER_FORM = /^slot-\d+$/;

/** The marker of a slot file: its name without the folder and the .json ending, such as "slot-0". */
export const markerOf = (slot) => basename(slot, ".json");

// The slot file of a job the queue started names the queue process, above pid 1, with its start time and the
// process group of the job. A file that lacks any of these was not written by a job that runs, and is not trusted:
// pid 1 in particular is an ancestor of every process.
const realHolder = (h) => Number.isInteger(h.pid) && h.pid > 1 && Number.isFinite(h.born) && Number.isInteger(h.pgid);

/** The slot holder a run is nested in, or null. marker: the value of the marker variable; pid: the run's own pid;
 *  holders: the slot holders from snapshot(), each with its file; rows: process rows ({ pid, ppid }), by default a
 *  fresh listing. A marker that is missing or malformed, names a slot nobody holds or one whose file lacks the pid,
 *  start time or process group of a running job, or names one whose holder is not an ancestor of pid gives null. */
export function outerJob({ marker, pid, holders, rows = null }) {
    if (typeof marker !== "string" || !MARKER_FORM.test(marker)) return null;
    const holder = holders.find((h) => markerOf(h.file) === marker);
    if (!holder || !realHolder(holder)) return null;
    const above = ancestors(rows ?? psRows(probeProcessTree()), pid).slice(1);
    return above.some((row) => row.pid === holder.pid) ? holder : null;
}
