// Slots and the waiting line, stored as small JSON files in the state folder so unrelated processes can share them
// without a server. A slot is claimed with a hard link, which only one process can win. Every file is written under
// a temporary name and then moved into place, so a reader never meets half a file.
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSettings, paths } from "./settings.mjs";
import { runTool } from "./probes.mjs";

const STALE_TEMP_MS = 60_000;
// When this process started (wall clock, ms). Its own entries carry it, so a reader can tell this process from a newer
// one that was given the same pid after it ended without cleaning up.
const BORN = Math.round(Date.now() - process.uptime() * 1000);
const SAME_START_MS = 5000;
const bornOf = (pid) => (pid === process.pid ? { born: BORN } : {});

/** Seconds each listed process has run, from `ps -o pid=,etime=` ([[dd-]hh:]mm:ss). A pid ps does not list is left out. */
export function parseElapsed(text) {
    const ages = new Map();
    for (const line of String(text ?? "").split("\n")) {
        const m = line.trim().match(/^(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
        if (m) ages.set(Number(m[1]), ((Number(m[2] ?? 0) * 24 + Number(m[3] ?? 0)) * 60 + Number(m[4])) * 60 + Number(m[5]));
    }
    return ages;
}
export const processAges = (pids) => (pids.length ? parseElapsed(runTool("ps", ["-o", "pid=,etime=", "-p", pids.join(",")])) : new Map());

export function alive(pid) {
    // EPERM: the process exists but belongs to another user.
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
const tempName = (file, pid) => `${file}.tmp-${pid}`;
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
    const ticket = join(dirs.line, `${now}-${pid}.json`), temp = tempName(ticket, pid);
    writeFileSync(temp, JSON.stringify({ pid, label, at: now, ...(priority ? { priority: true } : {}), ...bornOf(pid) }));
    renameSync(temp, ticket);
    return ticket;
}

/** Claims a free slot. Returns the slot file, or null when all are taken. */
export function takeSlot(pid, label, max = loadSettings().slots, meta = {}, dirs = paths()) {
    makeDirs(dirs);
    for (let n = 0; n < max; n++) {
        const slot = join(dirs.slots, `slot-${n}.json`), temp = tempName(slot, pid);
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
    const temp = tempName(slot, pid);
    writeFileSync(temp, JSON.stringify({ ...current, ...fields }));
    renameSync(temp, slot);
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
    return maxWaitMin > 0 && now - startedAt >= maxWaitMin * 60_000;
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
