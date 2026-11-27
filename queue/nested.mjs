// Nested runs: a job started by the queue that itself calls `dotime-queue run`. The queue puts two markers in the job's
// environment: one that names the slot of the outermost job, as every copy of the queue reads it, and one that names
// the job's direct parent: that same slot, or for a job of a nested run that run's own note in the nested folder. A
// run that finds a marker is nested in that job, its parent: it takes no slot, but waits for one of the parent's few
// places for nested runs. That holds only while the marker is genuine: the slot or note it names is held by a job that
// has started, and the process holding it is one of the run's own ancestors. Anything else, such as a marker copied
// into another shell or left over from a job that has ended, is ignored, so the markers cannot be used to skip the
// line from outside.
import { basename } from "node:path";
import { probeProcessTree } from "./probes.mjs";
import { ancestors } from "./proctree.mjs";
import { psRows } from "./ps.mjs";

/** The environment variable that carries the marker of the outermost job's slot into a job. */
export const JOB_MARKER = "DOTIME_JOB";
/** The environment variable that carries the marker of a job's direct parent: a slot, or a nested run's note. */
export const PARENT_MARKER = "DOTIME_PARENT";

const SLOT_FORM = /^slot-\d+$/;
const NESTED_FORM = /^nested-\d+$/;

/** The marker of a slot file or a nested note: its name without the folder and the .json ending, such as "slot-0" or
 *  "nested-5104". */
export const markerOf = (file) => basename(file, ".json");

/** The key under which the places of a parent job are kept: its marker and start time, so a later job with the same
 *  marker never shares them. */
export const placeKey = (parent) => `${markerOf(parent.file)}.${parent.born}`;

// The slot file or note of a job the queue started names the queue process, above pid 1, with its start time and the
// process group of the job. A file that lacks any of these was not written by a job that runs, and is not trusted:
// pid 1 in particular is an ancestor of every process. A nested run that still waits for a place has no process
// group yet, so its marker is not trusted either.
const realHolder = (h) => Number.isInteger(h.pid) && h.pid > 1 && Number.isFinite(h.born) && Number.isInteger(h.pgid);

/** The job a run is nested in, its direct parent, or null. marker: the value of the marker variable; pid: the run's
 *  own pid; holders and nested: the slot holders and nested runs from snapshot(), each with its file; rows: process
 *  rows ({ pid, ppid }), by default a fresh listing. A marker that is missing or malformed, names a slot or note
 *  nobody holds or one whose file lacks the pid, start time or process group of a running job, or names one whose
 *  holder is not an ancestor of pid gives null. */
export function outerJob({ marker, pid, holders, nested = [], rows = null }) {
    if (typeof marker !== "string") return null;
    const pool = SLOT_FORM.test(marker) ? holders : NESTED_FORM.test(marker) ? nested : null;
    if (!pool) return null;
    const holder = pool.find((h) => markerOf(h.file) === marker);
    if (!holder || !realHolder(holder) || holder.waiting) return null;
    if (NESTED_FORM.test(marker) && marker !== `nested-${holder.pid}`) return null;
    const above = ancestors(rows ?? psRows(probeProcessTree()), pid).slice(1);
    return above.some((row) => row.pid === holder.pid) ? holder : null;
}

/** The job a run is nested in, from the markers in env, or null. The direct parent in PARENT_MARKER is tried first;
 *  when it is missing or not genuine, the slot in JOB_MARKER is, as a job started by a copy of the queue that sets
 *  only that one hands it on. JOB_MARKER is taken only in the form of a slot. pid, holders, nested and rows: as for
 *  outerJob(); the process table is read at most once. */
export function parentJob({ env, pid, holders, nested = [], rows = null }) {
    const parentMarker = env?.[PARENT_MARKER], slotMarker = env?.[JOB_MARKER];
    const asked = [parentMarker, typeof slotMarker === "string" && SLOT_FORM.test(slotMarker) ? slotMarker : undefined];
    let listing = rows;
    const table = () => (listing ??= psRows(probeProcessTree()));
    for (const marker of asked) {
        if (typeof marker !== "string" || !(SLOT_FORM.test(marker) || NESTED_FORM.test(marker))) continue;
        const found = outerJob({ marker, pid, holders, nested, rows: table() });
        if (found) return found;
    }
    return null;
}

/** The marker of the slot of the outermost job that parent, the job from outerJob(), runs in: its own slot, or the
 *  one its note names. */
export const slotMarkerOf = (parent) => (SLOT_FORM.test(markerOf(parent.file)) ? markerOf(parent.file) : parent.slot);

/** Whether parent, the job from outerJob(), still runs: its slot or note is there with the same pid and start time,
 *  and is still that of a running job. holders and nested: from snapshot(). Once the job has ended its file is gone,
 *  or belongs to a later job, and this gives false. */
export function stillRunning(parent, { holders, nested = [] }) {
    const pool = SLOT_FORM.test(markerOf(parent.file)) ? holders : nested;
    return pool.some((h) => h.file === parent.file && h.pid === parent.pid && h.born === parent.born && realHolder(h)
        && !h.waiting);
}
