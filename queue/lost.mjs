// Runs cut off by a restart or by a queue process that died: the job had started its command, and then nothing was
// left to write its journal line. A process cannot carry on from the middle, so such a run is recorded instead, as one
// journal line with the outcome lost, and never vanishes. Whoever frees the slot of a holder that is gone records it:
// `status`, a `run` that waits, the reaper, the schedule tick and the MCP server alike.
//
// The slot file is claimed first with a hard link into the claims folder, under a name fixed by the run it names (its
// pid, start time and the time its command started). Only one process can make that link, so a run gets one line
// even when several of them find it at the same moment, and a finder with an old reading of the slot never touches
// what is there now: the claim holds what the slot holds at the moment of the link, and when that is not the run it
// read, it only removes its own link. The winner frees the slot path only while it still is the file it claimed.
// Just before the line is written the claim is linked to its done name, which only one process can hold, so a claimer
// that was paused for long can never write a second line after another process took its claim over. A claim left
// behind by a claimer that died is finished by the next one that looks. A lost line never counts as a failure of the
// code: the repeated-failure stop, the flaky flag, run limits, pass stamps and the CPU readings all read only runs
// that ran.
import { randomBytes } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { readJson, STALE_TEMP_MS } from "./files.mjs";
import { append, parseLines, readLines, record } from "./journal.mjs";

/** The environment variable that tells `run` it is the re-run of a lost MCP job, by that job's id. */
export const RERUN_MARKER = "DOTIME_RERUN_OF";
/** The words `reasons` and the MCP server use for a lost run. */
export const LOST_TEXT = "the run was cut off: the machine restarted or the queue process died; nothing ran to the end";
const CLAIM_END = ".claim";
const DONE_END = ".done";
const BROKEN_END = ".broken";
const TAKEN = ".taken-";
// A done claim, or a look at a broken file, is removed once it is this old: its process finished or died meanwhile.
const STALE_DONE_MS = 10 * STALE_TEMP_MS;

export const isLost = (row) => row?.outcome === "lost";
/** The reason field of a lost line; source says who found it: slot or tick. */
export const lostReason = (source) => ({ class: "lost", source });

/** The id of the lost MCP job a run starts again, from RERUN_MARKER, or null; anything but a job id is no id. */
export function rerunOfEnv(env) {
    const id = env?.[RERUN_MARKER];
    return typeof id === "string" && /^[0-9a-f]{24}$/.test(id) ? id : null;
}

const isoOrNull = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** The journal fields of the run that held a slot: the ones `run` keeps in the slot file as run once its command has
 *  started, or for a slot file written without them, what the slot itself says. */
function draftOf(entry) {
    if (entry.run && typeof entry.run === "object") return entry.run;
    return {
        label: entry.label, project: undefined, cwd: entry.cwd, priority: entry.priority, queuedAt: entry.at,
        startedAt: entry.startedAt, cmd: null, extra: { pid: entry.pid, ...(entry.kind ? { kind: entry.kind } : {}) },
    };
}

/** The lost journal line of a run. draft: its journal fields so far, as journalWriter().draft() gives them; endedAt:
 *  when it was found. */
export function lostRow(draft, endedAt, source) {
    return record({
        ...draft, endedAt, outcome: "lost", exit: null, tally: draft.tally ?? {},
        extra: { ...(draft.extra ?? {}), reason: lostReason(source) },
    });
}

/** Whether the journal already has a line of the run that held this slot: one with its queue pid and start time. */
function journalled(entry, journalFile) {
    const startedAt = isoOrNull(entry.startedAt);
    return parseLines(readLines(journalFile)).some((row) => row.pid === entry.pid && row.startedAt === startedAt);
}

const part = (value) => (Number.isFinite(value) ? String(Math.round(value)) : "x");
/** The claim name of the holder an entry names, the same for every process that claims it: its pid, start time, and
 *  the time its command started, or for a holder that never started, the time it took the slot. */
const claimBase = (entry) => `${part(entry.pid)}-${part(entry.born)}-${Number.isFinite(entry.startedAt) ? part(entry.startedAt) : `at${part(entry.at)}`}`;
const baseOf = (file) => file.replace(/(\.claim|\.done|\.taken-[^/]*)$/, "");
const sameEntry = (a, b) => !!a && !!b && a.pid === b.pid && a.born === b.born && a.at === b.at && a.startedAt === b.startedAt;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

/** Claims the file of a holder that is gone. file: the slot (or place) file; entry: what was read from it. Links the
 *  file to the claim name of that holder; a second claimer of the same holder fails there and touches nothing. When
 *  the linked file is not that holder's (a newer holder has the path now), only the claim goes. Otherwise the path
 *  is unlinked while it still is the claimed file. Returns { claim, entry } for the winner, else null. dir: the claims
 *  folder. Never throws. */
export function claimHolder(file, entry, dir) {
    try {
        mkdirSync(dir, { recursive: true });
        const claim = join(dir, `${claimBase(entry)}${CLAIM_END}`);
        try { linkSync(file, claim); } catch { return null; }
        const held = readJson(claim);
        if (!sameEntry(held, entry)) {
            rmSync(claim, { force: true });
            return null;
        }
        try {
            if (sameFile(lstatSync(file), statSync(claim))) rmSync(file, { force: true });
        } catch { /* the path is gone already */ }
        return { claim, entry: held };
    } catch {
        return null;
    }
}

/** Frees a slot (or place) file that could not be read: it is gone since the folder was listed, often claimed by
 *  another process a moment ago, or it is broken. The file is linked under a name of this process's own first, so
 *  what is looked at is one file; it is removed only while it still cannot be read, is older than STALE_TEMP_MS (a
 *  newer holder's file is young and whole), and is still the file at the path. dir: the claims folder. Never throws. */
export function freeBroken(file, dir, now = Date.now()) {
    let look = null;
    try {
        mkdirSync(dir, { recursive: true });
        look = join(dir, `broken-${process.pid}-${randomBytes(4).toString("hex")}${BROKEN_END}`);
        try { linkSync(file, look); } catch { look = null; return; }
        const seen = statSync(look);
        if (readJson(look) !== null || now - seen.mtimeMs <= STALE_TEMP_MS) return;
        if (sameFile(lstatSync(file), seen)) rmSync(file, { force: true });
    } catch { /* gone already */ } finally {
        if (look) rmSync(look, { force: true });
    }
}

/** Writes the lost line of a claimed slot file, unless its run never started or already has a line. The claim is
 *  linked to its done name first, which only one process can hold: a claim another process took over in the
 *  meantime is no longer ours, and nothing is written. A line that could not be written leaves the claim for the
 *  next finder. Returns the line, or null. */
function settle(claim, entry, journalFile, now, beforeAppend) {
    const done = `${baseOf(claim)}${DONE_END}`;
    // A link and not a rename: a rename would replace the done claim of another process that settles the same run,
    // which a link that looked up the slot path before it was freed can let in.
    try { linkSync(claim, done); } catch { return null; } finally { rmSync(claim, { force: true }); }
    let keep = false;
    try {
        if (!Number.isFinite(entry?.startedAt) || !Number.isInteger(entry.pid) || journalled(entry, journalFile)) return null;
        const row = lostRow(draftOf(entry), now, "slot");
        beforeAppend?.();
        if (append(row, journalFile)) return row;
        keep = true;
        return null;
    } catch {
        keep = true;
        return null;
    } finally {
        if (keep) {
            try { renameSync(done, done.slice(0, -DONE_END.length) + CLAIM_END); } catch { rmSync(done, { force: true }); }
        } else rmSync(done, { force: true });
    }
}

/** Records the run of a slot whose holder is gone. file: the slot file; entry: what was read from it, with the pid
 *  and start time found dead or reused. Claimed with claimHolder(), so only one process goes on and a file that is a
 *  newer holder's is left alone. A holder that had not started its command writes no line, and its slot is freed all
 *  the same. Returns the line written, or null. dirs: { lost, journal }. beforeAppend: called just before the line is
 *  written, for tests. Never throws. */
export function recordLost(file, entry, dirs, now = Date.now(), { beforeAppend } = {}) {
    try {
        const won = claimHolder(file, entry, dirs.lost);
        return won ? settle(won.claim, won.entry, dirs.journal, now, beforeAppend) : null;
    } catch {
        return null;
    }
}

/** Finishes the claims a claimer left behind when it died between the claim and the line: those older than
 *  STALE_TEMP_MS. A done claim is never taken over, only removed once it is STALE_DONE_MS old. Returns the lines
 *  written. */
export function finishAbandoned(dirs, now = Date.now()) {
    let names = [];
    try { names = readdirSync(dirs.lost); } catch { return []; }
    const rows = [];
    for (const name of names) {
        const file = join(dirs.lost, name);
        try {
            // The link that made the claim changed its ctime, not its mtime, which is the slot file's own.
            const age = now - statSync(file).ctimeMs;
            if (name.endsWith(DONE_END) || name.endsWith(BROKEN_END)) {
                if (age > STALE_DONE_MS) rmSync(file, { force: true });
                continue;
            }
            // A claim taken over by a finisher that died in turn is taken over again the same way.
            if (!(name.endsWith(CLAIM_END) || name.includes(TAKEN)) || age <= STALE_TEMP_MS) continue;
            const mine = `${baseOf(file)}${TAKEN}${process.pid}-${randomBytes(4).toString("hex")}`;
            renameSync(file, mine);
            const row = settle(mine, readJson(mine), dirs.journal, now);
            if (row) rows.push(row);
        } catch { /* another process finished it */ }
    }
    return rows;
}

/** Whether a claim of the run of this queue pid is still being settled, so its line may be on the way. */
export function claimPending(dirs, pid) {
    try {
        const open = (name) => name.endsWith(CLAIM_END) || name.endsWith(DONE_END) || name.includes(TAKEN);
        return readdirSync(dirs.lost).some((name) => name.startsWith(`${pid}-`) && open(name));
    } catch {
        return false;
    }
}
