// Slots, the waiting line, the nested runs and their places, stored as small JSON files in the state folder so
// unrelated processes can share them without a server. A slot, and a nested run's place under its parent job, is
// claimed with a hard link, which only one process can win. Every file is written under a temporary name and then
// moved into place, so a reader never meets half a file.
import { linkSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probeProcessAges } from "./probes.mjs";
import { parseElapsed } from "./ps.mjs";
import { alive } from "./proctree.mjs";
import { dropOldTemp, readJson, tempName, writeJsonAtomic } from "./files.mjs";

// When this process started (wall clock, ms). Its own entries carry it, so a reader can tell this process from a newer
// one that was given the same pid after it ended without cleaning up.
const BORN = Math.round(Date.now() - process.uptime() * 1000);
const SAME_START_MS = 5000;
const bornOf = (pid) => (pid === process.pid ? { born: BORN } : {});

/** Seconds each of the given processes has run, by pid. */
const processAges = (pids) => parseElapsed(probeProcessAges(pids));
const isEntryName = (name) => name.endsWith(".json");
// dirs: the slots and waitingLine folders, as paths() names them.
function makeDirs(dirs) {
    mkdirSync(dirs.slots, { recursive: true });
    mkdirSync(dirs.waitingLine, { recursive: true });
}
// An entry whose pid now belongs to a process that started later than the entry says.
function pidReused(data, seconds, now) {
    return seconds !== undefined && Math.abs(now - seconds * 1000 - data.born) > SAME_START_MS;
}
const lineOrder = (a, b) => Number(!!b.priority) - Number(!!a.priority) || a.at - b.at || a.pid - b.pid;

/** Returns { holders, queue }: the jobs holding a slot, and the line in start order; each entry carries the path of
 *  its file. When dirs names a nested folder, nested lists the nested runs too, and when it names a places folder,
 *  places lists the places nested runs hold. Entries of dead processes, and
 *  entries whose pid now belongs to a process that started later, are left out. Only with prune are their files, and
 *  abandoned temporary files, deleted and the slot and line folders created: a job that waits for a slot prunes, so
 *  the slot of a dead job comes free; `status` and other readers change nothing. */
export function snapshot({ dirs, isAlive = alive, ages = processAges, now = Date.now(), prune = false }) {
    if (prune) makeDirs(dirs);
    const liveEntries = (dir) => {
        let names = [];
        try { names = readdirSync(dir); } catch { /* no folder yet */ }
        const found = [];
        for (const name of names) {
            const file = join(dir, name);
            // A temporary name is a write in progress by another process: leave it alone unless it was abandoned.
            if (!isEntryName(name)) {
                if (prune) dropOldTemp(file, now);
                continue;
            }
            const data = readJson(file);
            found.push({ file, data, ok: Number.isInteger(data?.pid) && isAlive(data.pid) });
        }
        // An entry that names its start time is compared with the age of the process that has its pid now.
        const known = ages(found.filter((e) => e.ok && Number.isFinite(e.data.born)).map((e) => e.data.pid));
        const entries = [];
        for (const { file, data, ok } of found) {
            const seconds = ok && Number.isFinite(data.born) ? known.get(data.pid) : undefined;
            if (ok && !pidReused(data, seconds, now)) entries.push({ file, ...data });
            else if (prune) rmSync(file, { force: true });
        }
        return entries;
    };
    const holders = liveEntries(dirs.slots);
    const queue = liveEntries(dirs.waitingLine).sort(lineOrder);
    return {
        holders, queue,
        ...(dirs.nested ? { nested: liveEntries(dirs.nested) } : {}),
        ...(dirs.places ? { places: liveEntries(dirs.places) } : {}),
    };
}

/** Notes a nested run, one that runs inside another job and takes no slot itself. outer: { marker, pid, born, slot },
 *  the marker of the job it runs in, its direct parent (a slot holder or another nested run), and that job's pid and
 *  start time, stored as outer, outerPid and outerBorn so the note is never taken for one of a later job with the same
 *  marker; slot, when given, is the marker of the outermost job's slot, which the run hands its own job. waiting:
 *  the run waits for a place under that job, which updateSlot(file, pid, { waiting: undefined }) ends. The file is
 *  named nested-<pid>.json, and its name without the ending is the marker of the direct parent the run hands its own
 *  job. Returns the file; deleting it removes the note. */
export function addNested(pid, label, outer, dirs, { waiting = false, now = Date.now() } = {}) {
    mkdirSync(dirs.nested, { recursive: true });
    const file = join(dirs.nested, `nested-${pid}.json`);
    const from = { outer: outer.marker, outerPid: outer.pid, outerBorn: outer.born, ...(outer.slot ? { slot: outer.slot } : {}) };
    writeJsonAtomic(file, { pid, label, ...from, at: now, ...(waiting ? { waiting: true } : {}), ...bornOf(pid) });
    return file;
}

/** Claims one of the max places under a parent job for a nested run. parent: the key of that job, from placeKey().
 *  Returns the place file, or null when all are taken. releaseSlot() frees it. */
export function takePlace(pid, label, parent, max, dirs, now = Date.now()) {
    mkdirSync(dirs.places, { recursive: true });
    for (let n = 0; n < max; n++) {
        const place = join(dirs.places, `${parent}.${n}.json`);
        const temp = tempName(place);
        writeFileSync(temp, JSON.stringify({ pid, label, parent, at: now, ...bornOf(pid) }));
        try {
            linkSync(temp, place);
            return place;
        } catch { /* another nested run holds this place */ } finally { rmSync(temp, { force: true }); }
    }
    return null;
}

/** Joins the line. Returns the ticket file; deleting it leaves the line. */
export function enqueue(pid, label, priority, dirs, now = Date.now()) {
    makeDirs(dirs);
    const ticket = join(dirs.waitingLine, `${now}-${pid}.json`);
    writeJsonAtomic(ticket, { pid, label, at: now, ...(priority ? { priority: true } : {}), ...bornOf(pid) });
    return ticket;
}

/** Claims a free slot. Returns the slot file, or null when all are taken. */
export function takeSlot(pid, label, max, meta, dirs) {
    makeDirs(dirs);
    for (let n = 0; n < max; n++) {
        const slot = join(dirs.slots, `slot-${n}.json`);
        const temp = tempName(slot);
        writeFileSync(temp, JSON.stringify({ pid, label, at: Date.now(), ...meta, ...bornOf(pid) }));
        try {
            linkSync(temp, slot);
            return slot;
        } catch { /* another process holds this slot */ } finally { rmSync(temp, { force: true }); }
    }
    return null;
}

/** Frees a slot or a place, but only for the pid that holds it. */
export function releaseSlot(slot, pid) {
    if (slot && readJson(slot)?.pid === pid) rmSync(slot, { force: true });
}

/** Merges `fields` into `slot` if `pid` owns it; false otherwise. */
export function updateSlot(slot, pid, fields) {
    const current = slot && readJson(slot);
    if (current?.pid !== pid) return false;
    writeJsonAtomic(slot, { ...current, ...fields });
    return true;
}
