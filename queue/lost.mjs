// Runs cut off by a restart or by a queue process that died: the job had started its command, and then nothing was
// left to write its journal line. A process cannot carry on from the middle, so such a run is recorded instead, as one
// journal line with the outcome lost, and never vanishes. Whoever frees the slot of a holder that is gone records it:
// `status`, a `run` that waits, the reaper, the schedule tick and the MCP server alike. The slot file is claimed
// first by moving it into the claims folder under a name of the claimer's own; only one process can win that move, so
// a run gets one line even when several of them find it at the same moment. A claim left behind by a claimer that
// died is finished by the next one that looks. A lost line never counts as a failure of the code: the repeated-failure
// stop, the flaky flag, run limits, pass stamps and the CPU readings all read only runs that ran.
import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { readJson, STALE_TEMP_MS } from "./files.mjs";
import { append, parseLines, readLines, record } from "./journal.mjs";

/** The environment variable that tells `run` it is the re-run of a lost MCP job, by that job's id. */
export const RERUN_MARKER = "DOTIME_RERUN_OF";
/** The words `reasons` and the MCP server use for a lost run. */
export const LOST_TEXT = "the run was cut off: the machine restarted or the queue process died; nothing ran to the end";
const CLAIM_END = ".claim";

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

const claimName = (claims, entry, from) => join(claims, `${entry.pid}-${from}-${process.pid}-${randomBytes(4).toString("hex")}${CLAIM_END}`);
const sameEntry = (a, b) => !!a && !!b && a.pid === b.pid && a.born === b.born && a.at === b.at && a.startedAt === b.startedAt;

/** Writes the lost line of a claimed slot file, unless its run never started or already has a line, and removes the
 *  claim. Returns the line written, or null. */
function settle(claim, entry, journalFile, now) {
    try {
        if (!Number.isFinite(entry?.startedAt) || !Number.isInteger(entry.pid) || journalled(entry, journalFile)) return null;
        const row = lostRow(draftOf(entry), now, "slot");
        return append(row, journalFile) ? row : null;
    } finally {
        rmSync(claim, { force: true });
    }
}

/** Records the run of a slot whose holder is gone. file: the slot file; entry: what was read from it, with the pid
 *  and start time found dead or reused. The file is moved to the claims folder first, so only one process goes on;
 *  a file that changed in the meantime belongs to a newer holder and is put back. A holder that had not started its
 *  command writes no line. Returns the line written, or null. dirs: { lost, journal }. Never throws. */
export function recordLost(file, entry, dirs, now = Date.now()) {
    try {
        mkdirSync(dirs.lost, { recursive: true });
        const claim = claimName(dirs.lost, entry, basename(file, ".json"));
        try { renameSync(file, claim); } catch { return null; }
        const moved = readJson(claim);
        if (!sameEntry(moved, entry)) {
            // A newer holder took the slot between the read and the move: it gets its file back.
            try { linkSync(claim, file); } catch { /* the slot was taken once more */ }
            rmSync(claim, { force: true });
            return null;
        }
        return settle(claim, moved, dirs.journal, now);
    } catch {
        return null;
    }
}

/** Finishes the claims a claimer left behind when it died between the move and the line: those older than
 *  STALE_TEMP_MS. Returns the lines written. */
export function finishAbandoned(dirs, now = Date.now()) {
    let names = [];
    try { names = readdirSync(dirs.lost); } catch { return []; }
    const rows = [];
    for (const name of names.filter((n) => n.endsWith(CLAIM_END))) {
        const file = join(dirs.lost, name);
        try {
            // The move that made the claim changed its ctime, not its mtime, which is the slot file's own.
            if (now - statSync(file).ctimeMs <= STALE_TEMP_MS) continue;
            const entry = readJson(file);
            const mine = claimName(dirs.lost, entry ?? { pid: 0 }, "abandoned");
            renameSync(file, mine);
            const row = settle(mine, entry, dirs.journal, now);
            if (row) rows.push(row);
        } catch { /* another process finished it */ }
    }
    return rows;
}

/** Whether a claim of the run of this queue pid is still being settled, so its line may be on the way. */
export function claimPending(dirs, pid) {
    try {
        return readdirSync(dirs.lost).some((name) => name.endsWith(CLAIM_END) && name.startsWith(`${pid}-`));
    } catch {
        return false;
    }
}
