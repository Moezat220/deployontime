// Slots and the waiting line, stored as small JSON files in the state folder so unrelated processes can share them
// without a server. A slot is claimed with a hard link, which only one process can win. Every file is written under
// a temporary name and then moved into place, so a reader never meets half a file.
import { linkSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probeProcessAges } from "./probes.mjs";
import { parseElapsed } from "./ps.mjs";
import { alive } from "./proctree.mjs";
import { readJson, tempName, writeJsonAtomic } from "./files.mjs";
import { MINUTE } from "./units.mjs";

const STALE_TEMP_MS = MINUTE;
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
function dropOldTemp(file, now) {
    try {
        if (now - statSync(file).mtimeMs > STALE_TEMP_MS) rmSync(file, { force: true });
    } catch { /* already gone */ }
}
// An entry whose pid now belongs to a process that started later than the entry says.
function pidReused(data, seconds, now) {
    return seconds !== undefined && Math.abs(now - seconds * 1000 - data.born) > SAME_START_MS;
}
const lineOrder = (a, b) => Number(!!b.priority) - Number(!!a.priority) || a.at - b.at || a.pid - b.pid;

/** Returns { holders, queue }: the jobs holding a slot, and the line in start order; each entry carries the path of
 *  its file. Entries of dead processes, and entries whose pid now belongs to a process that started later, are left
 *  out. Only with prune are their files, and abandoned temporary files, deleted and the folders created: a job that
 *  waits for a slot prunes, so the slot of a dead job comes free; `status` and other readers change nothing. */
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
    return { holders, queue };
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

/** Frees a slot, but only for the pid that holds it. */
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
