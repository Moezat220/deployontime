// Slots and the waiting line, stored as small JSON files in the state folder so unrelated processes can share them
// without a server. A slot is claimed with a hard link, which only one process can win. Every file is written under
// a temporary name and then moved into place, so a reader never meets half a file.
import { linkSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSettings, paths } from "./settings.mjs";
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
function makeDirs(dirs) {
    mkdirSync(dirs.slots, { recursive: true });
    mkdirSync(dirs.line, { recursive: true });
}
function dropOldTemp(file, now) {
    try { if (now - statSync(file).mtimeMs > STALE_TEMP_MS) rmSync(file, { force: true }); } catch { /* already gone */ }
}

/** Returns { holders, queue }: the jobs holding a slot, and the line in start order. Entries of dead processes, and
 *  entries whose pid now belongs to a process that started later, are left out and their files deleted. With
 *  readOnly nothing on disk is created or deleted. */
export function snapshot({ dirs = paths(), isAlive = alive, ages = processAges, now = Date.now(), readOnly = false } = {}) {
    if (!readOnly) makeDirs(dirs);
    const liveEntries = (dir) => {
        let names = [];
        try { names = readdirSync(dir); } catch { /* no folder yet */ }
        const found = [];
        for (const name of names) {
            const file = join(dir, name);
            // A temporary name is a write in progress by another process: leave it alone unless it was abandoned.
            if (!isEntryName(name)) { if (!readOnly) dropOldTemp(file, now); continue; }
            const data = readJson(file);
            found.push({ file, data, ok: Number.isInteger(data?.pid) && isAlive(data.pid) });
        }
        // An entry that names its start time is compared with the age of the process that has its pid now.
        const known = ages(found.filter((e) => e.ok && Number.isFinite(e.data.born)).map((e) => e.data.pid));
        const entries = [];
        for (const { file, data, ok } of found) {
            const seconds = ok && Number.isFinite(data.born) ? known.get(data.pid) : undefined;
            if (ok && !(seconds !== undefined && Math.abs(now - seconds * 1000 - data.born) > SAME_START_MS)) entries.push({ f: file, ...data });
            else if (!readOnly) rmSync(file, { force: true });
        }
        return entries;
    };
    const holders = liveEntries(dirs.slots);
    const queue = liveEntries(dirs.line).sort((a, b) => Number(!!b.priority) - Number(!!a.priority) || a.at - b.at || a.pid - b.pid);
    return { holders, queue };
}

/** Returns { go, position }: go when this pid is first in line and a slot is free. */
export function decide({ holders, queue }, pid, max = loadSettings().slots) {
    const index = queue.findIndex((ticket) => ticket.pid === pid);
    const position = index < 0 ? queue.length + 1 : index + 1;
    return { go: position === 1 && index === 0 && holders.length < max, position };
}

/** Joins the line. Returns the ticket file; deleting it leaves the line. */
export function enqueue(pid, label, priority = false, dirs = paths(), now = Date.now()) {
    makeDirs(dirs);
    const ticket = join(dirs.line, `${now}-${pid}.json`);
    writeJsonAtomic(ticket, { pid, label, at: now, ...(priority ? { priority: true } : {}), ...bornOf(pid) });
    return ticket;
}

/** Claims a free slot. Returns the slot file, or null when all are taken. */
export function takeSlot(pid, label, max = loadSettings().slots, meta = {}, dirs = paths()) {
    makeDirs(dirs);
    for (let n = 0; n < max; n++) {
        const slot = join(dirs.slots, `slot-${n}.json`), temp = tempName(slot);
        writeFileSync(temp, JSON.stringify({ pid, label, at: Date.now(), ...meta, ...bornOf(pid) }));
        try { linkSync(temp, slot); return slot; } catch { /* another process holds this slot */ } finally { rmSync(temp, { force: true }); }
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

/** Everything that keeps a new job from starting, as [{ gate, text }]. ahead = waiters in front of the caller. */
export function gateBlocks({ holders, health, ahead = 0 }, max = loadSettings().slots) {
    const blocks = [];
    if (holders.length >= max) {
        const names = holders.map((h) => `"${h.label}"`).join(" and ");
        blocks.push({ gate: "slots", text: `no free slot: ${holders.length} of ${max} taken, by ${names}` });
    }
    if (health && !health.ok) blocks.push(...health.blocks);
    if (!blocks.length && ahead > 0) blocks.push({ gate: "line", text: `not first in line: ${ahead} ahead` });
    return blocks;
}
export const blockText = (blocks) => blocks.map((b) => b.text).join("; ");
/** The same as one sentence; "" when a job could start now. */
export const gateReason = (state, max) => blockText(gateBlocks(state, max));

/** The blocks a waiter's time is booked to: full slots alone, else the health gate, else the line in front. */
export function blockReason({ holders, health, ahead = 0 }, max = loadSettings().slots) {
    if (holders.length >= max) return gateBlocks({ holders, health: null }, max);
    if (health && !health.ok) return health.blocks;
    return gateBlocks({ holders, health: null, ahead }, max);
}

/** maxWaitMin of 0 means no limit. */
export function shouldGiveUp({ startedAt, now, maxWaitMin }) {
    return maxWaitMin > 0 && now - startedAt >= maxWaitMin * MINUTE;
}

/** Reads --max-wait from the flags in front of "--". Returns minutes, the fallback when absent, null when not a valid number. */
export function parseMaxWait(args, fallback = loadSettings().maxWaitMin) {
    const cut = args.indexOf("--"), flags = cut < 0 ? args : args.slice(0, cut);
    const joined = flags.find((a) => a.startsWith("--max-wait=")), at = flags.indexOf("--max-wait");
    const raw = joined ? joined.slice("--max-wait=".length) : at >= 0 ? flags[at + 1] ?? "" : undefined;
    if (raw === undefined) return fallback;
    const minutes = Number(raw);
    return raw !== "" && Number.isFinite(minutes) && minutes >= 0 ? minutes : null;
}
