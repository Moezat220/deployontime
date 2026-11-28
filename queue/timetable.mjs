// The scheduled jobs in $DOTIME_HOME/schedule.json, and the lock that lets one process at a time change them: the
// tick, or a `schedule` command. The file is written whole under a temporary name and moved into place, so a reader
// never meets half of it. It names commands the tick runs, so it and the lock are readable and writable by their
// owner alone, and the tick runs nothing from a file another user owns or may write (scheduleTrust).
import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseCron, parseEvery } from "./cron.mjs";
import { readJson, STALE_TEMP_MS, writeJsonAtomic } from "./files.mjs";

export const EMPTY = Object.freeze({ v: 1, jobs: [] });
/** The permissions of schedule.json, its lock and the tick's own files: the owner alone reads and writes them. */
export const OWNER_ONLY = 0o600;

/** Why a stored job cannot be used, or null. A job needs an id, a label, a folder, a command and exactly one of a
 *  valid `every` or `cron`. */
export function jobProblem(job) {
    if (!job || typeof job !== "object" || !/^[0-9a-f]{8}$/.test(job.id ?? "")) return "no valid id";
    if (typeof job.label !== "string" || !job.label.trim()) return "no label";
    if (typeof job.cwd !== "string" || !job.cwd.startsWith("/")) return "no absolute folder in cwd";
    if (!Array.isArray(job.command) || !job.command.length || !job.command.every((w) => typeof w === "string")) {
        return "no command";
    }
    if (!Number.isFinite(Date.parse(job.createdAt))) return "no createdAt time";
    if ((job.every === undefined) === (job.cron === undefined)) return "needs exactly one of every and cron";
    const times = job.every !== undefined ? parseEvery(job.every) : parseCron(job.cron);
    return times.error ? times.error.replace(/^--\w+: /, "") : null;
}

/** The stored jobs as { jobs }, or { error } for a file that cannot be read or is not a schedule. A missing file is an
 *  empty schedule. */
export function readSchedule(file) {
    let problem = null;
    const data = readJson(file, EMPTY, (kind, code) => {
        problem = kind === "invalid" ? "it is not valid JSON" : `it could not be read (${code})`;
    });
    if (problem) return { error: `${file} cannot be used: ${problem}; fix or remove it` };
    if (!data || data.v !== 1 || !Array.isArray(data.jobs)) {
        return { error: `${file} cannot be used: it needs { "v": 1, "jobs": [...] }; fix or remove it` };
    }
    return { jobs: data.jobs };
}

/** Writes the jobs; throws when the file cannot be written. */
export function writeSchedule(file, jobs) {
    writeJsonAtomic(file, { v: 1, jobs }, 2, OWNER_ONLY);
}

/** Why the tick must not run the commands in schedule.json, or null: the file belongs to another user, or its group
 *  or other users may write it. A missing file is fine. stat: { uid, mode }; uid: the user this process runs as. */
export function scheduleTrust(file, uid, stat = statSync) {
    let st;
    try { st = stat(file); } catch { return null; }
    if (uid !== undefined && st.uid !== uid) {
        return `${file} belongs to user ${st.uid}, not to you (${uid}), and may name any command; make it yours with chown, then chmod 600 ${file}`;
    }
    if (st.mode & 0o022) {
        return `${file} may be written by ${st.mode & 0o002 ? "any user" : "its group"}; chmod 600 ${file} fixes it`;
    }
    return null;
}

/** Takes the lock file for this process, or gives null when a live process holds it. owner: { pid, born }. A lock
 *  whose process is gone, or whose pid now names a process that started at another time, is taken over; so is one
 *  that cannot be read once it is older than a write could take. To take one over, the stale lock is first moved to a
 *  name of this process's own: of two processes that both found it stale only one can move it, and one that moved a
 *  lock another process had just taken puts it back. deps: { isGone(owner), now, fs (renameSync, linkSync and
 *  readFileSync, for tests) }. Returns a function that frees the lock. */
export function takeLock(file, owner, { isGone, now = Date.now(), fs = { renameSync, linkSync, readFileSync } }) {
    mkdirSync(dirname(file), { recursive: true });
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            writeFileSync(file, JSON.stringify(owner), { flag: "wx", mode: OWNER_ONLY });
            return () => {
                if (readJson(file)?.pid === owner.pid) rmSync(file, { force: true });
            };
        } catch (e) {
            if (e.code !== "EEXIST") throw e;
        }
        let text = null, holder = null;
        try { text = fs.readFileSync(file, "utf8"); holder = JSON.parse(text); } catch { /* being written, or broken */ }
        let stale;
        if (Number.isInteger(holder?.pid)) stale = isGone(holder);
        else {
            try { stale = now - statSync(file).mtimeMs > STALE_TEMP_MS; } catch { stale = true; }
        }
        if (!stale) return null;
        const aside = `${file}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
        try {
            fs.renameSync(file, aside);
        } catch (e) {
            if (e.code === "ENOENT") continue; // another process took it over first
            throw e;
        }
        let moved = null, movedHolder = null;
        try { moved = fs.readFileSync(aside, "utf8"); movedHolder = JSON.parse(moved); } catch { /* gone, or broken */ }
        const taken = text !== null ? moved !== text : Number.isInteger(movedHolder?.pid) && !isGone(movedHolder);
        if (taken) {
            // Not the lock found stale: another process took it over in between. Put it back, unless a third one
            // already holds the name again.
            try { fs.linkSync(aside, file); } catch { /* the name is taken again */ }
            rmSync(aside, { force: true });
            return null;
        }
        rmSync(aside, { force: true });
    }
    return null;
}

/** Runs change(jobs) under the lock, waiting up to waitMs for it, and writes what it returns. change gives
 *  { jobs, ...result } to write, or { error, ...result } to write nothing. Returns the result, or { busy: true } when
 *  the lock stayed taken. A schedule.json that scheduleTrust refuses is not read or rewritten, since writing it would
 *  make another user's jobs look like the user's own to the tick. deps: as for takeLock, with pause(ms) that blocks,
 *  and uid and stat for scheduleTrust. */
export function changeSchedule(files, owner, change, { waitMs = 5000, pause, uid = process.getuid?.(), stat, ...lockDeps }) {
    let release = null;
    for (let waited = 0; !(release = takeLock(files.scheduleLock, owner, lockDeps)); waited += 50) {
        if (waited >= waitMs) return { busy: true };
        pause(50);
    }
    try {
        const distrust = scheduleTrust(files.schedule, uid, stat);
        if (distrust) return { error: distrust };
        const read = readSchedule(files.schedule);
        if (read.error) return { error: read.error };
        const result = change(read.jobs);
        if (!result.error) writeSchedule(files.schedule, result.jobs);
        return result;
    } finally {
        release();
    }
}
