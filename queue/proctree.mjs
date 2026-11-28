// Process trees and signals: which processes make up a job, and how a job or a process group is told to stop.
// Every walk over a process table and every group signal of the queue goes through here.
import { probeProcessAges, probeProcessTree } from "./probes.mjs";
import { parseElapsed, psRows } from "./ps.mjs";
import { bootId, startTicks } from "./linux.mjs";

// The longest chain of parents followed, so a damaged table can never keep a walk going.
const MAX_DEPTH = 64;
// How far apart two start times may be and still name the same process.
const SAME_START_MS = 5000;

/** True while a process with this pid exists. EPERM: it exists but belongs to another user. */
export function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) { return e.code === "EPERM"; }
}

/** Whether the process with this pid started at the given clock tick since boot (see startTicks) of the given boot
 *  (see bootId): false when the given boot and this one are both known and differ, since a process of another boot
 *  has ended (a pid and its ticks may come again after a restart); else true or false, or null when ticks or boot is
 *  not given, when this boot cannot be read, or when the pid's own ticks cannot be read, as on macOS. */
export function sameTicks(pid, { ticks, boot } = {}, { readTicks = startTicks, readBoot = bootId } = {}) {
    const known = (id) => typeof id === "string" && id !== "";
    const here = readBoot();
    if (known(boot) && known(here) && here !== boot) return false;
    if (!Number.isInteger(ticks) || !known(boot) || !known(here)) return null;
    const own = readTicks(pid);
    return Number.isInteger(own) ? own === ticks : null;
}

/** True while the process with this pid is the one that wrote startedAt (ms) when it began: a pid that a later
 *  process was given counts as gone. ages: pid to seconds run, as `ps` reports it. strict: when the start time or the
 *  age cannot be read, answer false instead of true; used before sending a signal, so a stranger is never stopped.
 *  group: the process group the process belongs to. On Linux `ps` counts an age from the boot, so after the wall
 *  clock is set by more than a few seconds every live process seems to have started at another time; without strict,
 *  a live pid whose age alone disagrees still counts as the same while its group has a member (hasGroup). ticks: the
 *  start of the process in clock ticks since boot, kept on Linux (startTicks), and boot the boot they count from
 *  (bootId); when both are given, the boot is this one (readBoot) and the pid's own ticks can be read (readTicks), the
 *  ticks alone decide, whatever the wall clock says. A process kept with another boot than this one is gone, also when
 *  strict and whatever its age; only when either boot is unknown does the age decide. */
export function sameProcess(pid, startedAt, {
    isAlive = alive, ages = (pids) => parseElapsed(probeProcessAges(pids)), strict = false, group, hasGroup = (pgid) => alive(-pgid), now = Date.now(),
    ticks, boot, readTicks = startTicks, readBoot = bootId,
} = {}) {
    if (!Number.isInteger(pid) || pid <= 1 || !isAlive(pid)) return false;
    const same = sameTicks(pid, { ticks, boot }, { readTicks, readBoot });
    if (same !== null) return same;
    if (!Number.isFinite(startedAt)) return !strict;
    const seconds = ages([pid]).get(pid);
    if (seconds === undefined && strict) return false;
    // ps counts whole seconds, and the runner writes its start a moment after it began.
    if (seconds === undefined || Math.abs(now - seconds * 1000 - startedAt) <= SAME_START_MS + 1000) return true;
    return !strict && Number.isInteger(group) && group > 1 && hasGroup(group);
}

/** An index over process rows ({ pid, ppid }): byPid and children (parent pid to child pids). Build it once to walk
 *  a large table many times; every walk below also takes the rows themselves. */
export function treeIndex(rows) {
    const byPid = new Map();
    const children = new Map();
    for (const row of rows) {
        byPid.set(row.pid, row);
        (children.get(row.ppid) ?? children.set(row.ppid, []).get(row.ppid)).push(row.pid);
    }
    return { byPid, children };
}
const indexOf = (table) => (table instanceof Array ? treeIndex(table) : table);

/** The root pids and every process below them by parent pid, as a Set. */
export function descendants(table, rootPids) {
    const { children } = indexOf(table);
    const found = new Set(rootPids);
    const todo = [...found];
    while (todo.length) {
        for (const child of children.get(todo.pop()) ?? []) {
            if (found.has(child)) continue;
            found.add(child);
            todo.push(child);
        }
    }
    return found;
}

/** The row of pid and the rows of its parents, nearest first. Stops at a pid missing from the table, at a pid seen
 *  before, and after MAX_DEPTH rows. */
export function ancestors(table, pid) {
    const { byPid } = indexOf(table);
    const chain = [];
    const seen = new Set();
    for (let row = byPid.get(pid); row && !seen.has(row.pid) && chain.length < MAX_DEPTH; row = byPid.get(row.ppid)) {
        seen.add(row.pid);
        chain.push(row);
    }
    return chain;
}

// The pids of a job: its group members, then everything below them by parent pid, which also catches children
// that started a group of their own.
function jobPids(leader, rows) {
    const members = rows.filter((row) => row.pgid === leader).map((row) => row.pid);
    return descendants(rows, [leader, ...members]);
}

/** The pids of a job, from the given `ps` text or a fresh listing. */
export function treePids(leader, ps = null) {
    return [...jobPids(leader, psRows(ps ?? probeProcessTree()))];
}

/** Returns null for a holder whose leader process is not listed, else the CPU seconds of all its processes. */
export function jobCpu(holder, rows) {
    const leader = holder.pgid ?? holder.pid;
    if (!rows.some((row) => row.pid === leader)) return null;
    const pids = jobPids(leader, rows);
    return Math.round(rows.reduce((sum, row) => sum + (pids.has(row.pid) ? row.cpu : 0), 0) * 100) / 100;
}

const sendSignal = (pid, signal) => process.kill(pid, signal);

/** Sends a signal to a whole process group. Returns { sent: true }, or { sent: false, code } with the error code:
 *  ESRCH when the group is gone, EPERM when it belongs to another user. */
export function signalGroup(pgid, signal, kill = sendSignal) {
    try {
        kill(-pgid, signal);
        return { sent: true };
    } catch (e) { return { sent: false, code: e.code ?? String(e.message) }; }
}

/** Signals a job: the group as a whole first, then each process of the job. A group or process that is gone
 *  already is passed over. Returns { pids, refused }: the pids it signalled, and one text for each signal that was
 *  refused, such as "pid 4101 (EPERM)". opts: ps, the `ps` text to walk instead of a fresh listing; kill. */
export function killTree(leader, signal, { ps = null, kill = sendSignal } = {}) {
    const pids = treePids(leader, ps);
    const refused = [];
    const group = signalGroup(leader, signal, kill);
    if (!group.sent && group.code !== "ESRCH") refused.push(`group ${leader} (${group.code})`);
    for (const pid of pids) {
        try {
            kill(pid, signal);
        } catch (e) {
            if (e.code !== "ESRCH") refused.push(`pid ${pid} (${e.code ?? e.message})`);
        }
    }
    return { pids, refused };
}

/** Sends TERM to a process group, waits graceMs, then sends KILL to the listed processes that are still there.
 *  Returns { stopped: true }, or { stopped: false, why } when a signal was refused. A group that is already gone
 *  counts as stopped. */
export async function stopGroup(pgid, procs, { graceMs, isAlive = alive, kill = sendSignal }) {
    const term = signalGroup(pgid, "SIGTERM", kill);
    if (!term.sent && term.code !== "ESRCH") return { stopped: false, why: `TERM refused (${term.code})` };
    await new Promise((done) => setTimeout(done, graceMs));
    const refused = [];
    for (const proc of procs) {
        if (!isAlive(proc.pid)) continue;
        try {
            kill(proc.pid, "SIGKILL");
        } catch (e) {
            if (e.code !== "ESRCH") refused.push(`${proc.pid} (${e.code ?? e.message})`);
        }
    }
    return refused.length ? { stopped: false, why: `KILL refused for pid ${refused.join(", ")}` } : { stopped: true };
}
