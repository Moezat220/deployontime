// Slots, the waiting line, the nested runs and their places, stored as small JSON files in the state folder so
// unrelated processes can share them without a server. A slot, and a nested run's place under its parent job, is
// claimed with a hard link, which only one process can win. Every file is written under a temporary name and then
// moved into place, so a reader never meets half a file.
import { linkSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probeProcessAges } from "./probes.mjs";
import { parseElapsed } from "./ps.mjs";
import { alive, sameTicks } from "./proctree.mjs";
import { bootId, startMarks, startTicks } from "./linux.mjs";
import { dropOldTemp, readJson, tempName, writeJsonAtomic } from "./files.mjs";
import { claimHolder, finishAbandoned, freeBroken, recordLost } from "./lost.mjs";

// When this process started (wall clock, ms). Its own entries carry it, so a reader can tell this process from a newer
// one that was given the same pid after it ended without cleaning up.
export const BORN = Math.round(Date.now() - process.uptime() * 1000);
/** On Linux, when this process started in clock ticks since boot and the boot they count from, { ticks, boot }
 *  (startMarks); an empty object elsewhere. Its own entries carry them, which a change of the wall clock cannot move. */
export const MARKS = startMarks(process.pid);
const SAME_START_MS = 5000;
const bornOf = (pid) => (pid === process.pid ? { born: BORN, ...MARKS } : {});
/** The identity fields of this process, { pid, born, ticks?, boot? }, as its entries and the schedule lock carry them. */
export const OWNER = { pid: process.pid, ...bornOf(process.pid) };
// Only a pid above 1 can name a holder: 0 and 1 are never a job, and a kill sent to 0 reaches the sender's own group.
const holderPid = (pid) => Number.isInteger(pid) && pid > 1;

/** Seconds each of the given processes has run, by pid. */
const processAges = (pids) => parseElapsed(probeProcessAges(pids));
const isEntryName = (name) => name.endsWith(".json");
// dirs: the slots and waitingLine folders, as paths() names them.
function makeDirs(dirs) {
    mkdirSync(dirs.slots, { recursive: true });
    mkdirSync(dirs.waitingLine, { recursive: true });
}
/** True while a process group with this id has a member. */
export const groupAlive = (pgid) => alive(-pgid);
// An entry whose pid now belongs to a process that started at another time than the entry says. On Linux `ps` counts
// a process's age from the boot, so after the wall clock is set by more than a few seconds every live process seems
// to have started at another time: an entry of a job that started its command (it has the job's process group, pgid)
// counts as reused only once that group is gone too. An entry that keeps ticks and their boot (Linux) is judged by the
// ticks alone while the boot is this one and the pid's own can be read: equal ticks are the same process whatever the
// clock says, other ticks a reused pid. read: { readTicks, readBoot }.
function pidReused(data, seconds, now, hasGroup = groupAlive, read = {}) {
    const same = sameTicks(data.pid, data, read);
    if (same !== null) return !same;
    if (seconds === undefined || Math.abs(now - seconds * 1000 - data.born) <= SAME_START_MS) return false;
    return !(Number.isInteger(data.pgid) && data.pgid > 1 && hasGroup(data.pgid));
}
/** True when the process an entry ({ pid, born, ticks?, boot?, pgid? }) names has ended, or its pid now names a process that
 *  started at another time (see pidReused). A pid that is not a whole number above 1 names no process. */
export function processGone(entry, {
    isAlive = alive, ages = processAges, now = Date.now(), hasGroup = groupAlive, readTicks = startTicks, readBoot = bootId,
} = {}) {
    if (!holderPid(entry?.pid) || !isAlive(entry.pid)) return true;
    const same = sameTicks(entry.pid, entry, { readTicks, readBoot });
    if (same !== null) return !same;
    return Number.isFinite(entry.born) && pidReused(entry, ages([entry.pid]).get(entry.pid), now, hasGroup, { readTicks: () => null });
}
// Frees the file of a holder that is gone through the same claim as a lost run (lost.mjs), so a reader with an old
// reading never removes the file of a newer holder; a file that could not be read is freed by freeBroken(). Without a
// claims folder the file is just removed.
function freeHolder(file, data, dirs, now) {
    if (!dirs.lost) return rmSync(file, { force: true });
    if (!data) return freeBroken(file, dirs.lost, now);
    const won = claimHolder(file, data, dirs.lost);
    if (won) rmSync(won.claim, { force: true });
}
const lineOrder = (a, b) => Number(!!b.priority) - Number(!!a.priority) || a.at - b.at || a.pid - b.pid;

/** Returns { holders, queue }: the jobs holding a slot, and the line in start order; each entry carries the path of
 *  its file. When dirs names a nested folder, nested lists the nested runs too, and when it names a places folder,
 *  places lists the places nested runs hold. Entries of dead processes, and
 *  entries whose pid now belongs to a process that started later, are left out. Only with prune are their files, and
 *  abandoned temporary files, deleted and the slot and line folders created: a job that waits for a slot prunes, so
 *  the slot of a dead job comes free; `status` and other readers change nothing else. The one exception is a slot
 *  whose holder is gone after its command had started: with lost (by default when dirs names the lost and journal
 *  files, as paths() does) its run is recorded as lost, once, and its slot file goes (see lost.mjs). Slot and place
 *  files are freed through the same claim, so an old reading never frees the file of a newer holder. hasGroup: whether
 *  a process group still has a member, readTicks the start of a pid in clock ticks and readBoot this boot's id (see
 *  pidReused). An entry
 *  whose pid is not a whole number above 1 names no holder and is freed like one that is gone. */
export function snapshot({
    dirs, isAlive = alive, ages = processAges, now = Date.now(), prune = false, lost = !!(dirs.lost && dirs.journal), hasGroup = groupAlive,
    readTicks = startTicks, readBoot = bootId,
}) {
    if (prune) makeDirs(dirs);
    if (lost) finishAbandoned(dirs, now);
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
            found.push({ file, data, ok: holderPid(data?.pid) && isAlive(data.pid) });
        }
        // An entry that names its start time is compared with the age of the process that has its pid now.
        const known = ages(found.filter((e) => e.ok && Number.isFinite(e.data.born)).map((e) => e.data.pid));
        const entries = [];
        for (const { file, data, ok } of found) {
            const seconds = ok && Number.isFinite(data.born) ? known.get(data.pid) : undefined;
            if (ok && !pidReused(data, seconds, now, hasGroup, { readTicks, readBoot })) entries.push({ file, ...data });
            else if (lost && dir === dirs.slots && Number.isFinite(data?.startedAt)) recordLost(file, data, dirs, now);
            // A slot and a place are taken again under the same name, so they are freed through a claim.
            else if (prune && (dir === dirs.slots || dir === dirs.places)) freeHolder(file, data, dirs, now);
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

/** Claims a free slot, the lowest numbered one. Returns the slot file, or null when all are taken. meta: the fields
 *  the slot file carries, or a function that gives them for a slot number, so they can depend on the slot claimed. */
export function takeSlot(pid, label, max, meta, dirs) {
    makeDirs(dirs);
    for (let n = 0; n < max; n++) {
        const slot = join(dirs.slots, `slot-${n}.json`);
        const temp = tempName(slot);
        const fields = typeof meta === "function" ? meta(n) : meta;
        writeFileSync(temp, JSON.stringify({ pid, label, at: Date.now(), ...fields, ...bornOf(pid) }));
        try {
            linkSync(temp, slot);
            return slot;
        } catch { /* another process holds this slot */ } finally { rmSync(temp, { force: true }); }
    }
    return null;
}

/** The number of a slot file, as takeSlot() names it, or NaN for another name. */
export const slotNumber = (file) => Number(/slot-(\d+)\.json$/.exec(String(file))?.[1] ?? NaN);

/** Frees a slot or a place, but only for the pid that holds it. */
export function releaseSlot(slot, pid) {
    if (slot && readJson(slot)?.pid === pid) rmSync(slot, { force: true });
}

/** Merges `fields` into `slot` if `pid` owns it; false otherwise, and false when the write fails. It never throws:
 *  a job calls it after its command has started, and a failed note must not end the job and leave the command
 *  running on its own. */
export function updateSlot(slot, pid, fields) {
    const current = slot && readJson(slot);
    if (current?.pid !== pid) return false;
    try {
        writeJsonAtomic(slot, { ...current, ...fields });
    } catch {
        return false;
    }
    return true;
}
