// The jobs the MCP server starts, kept in mcp-jobs/ in the state folder. A job id names up to five files there:
// <id>.json (the request, written once by the server), <id>.pid (the runner and queue pids, written by the runner),
// <id>.exit (how the queue process ended, written by the runner), <id>.log (everything the queue process and the
// job printed) and <id>.rerun (the id of the job that started it again after it was lost, written once). An id is 24
// lowercase hex characters, and every file name is built from a checked id only, so no caller can name a file outside
// this folder. Old jobs are pruned; a job whose runner is still alive never is.
import { randomBytes } from "node:crypto";
import {
    closeSync, constants, fstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../queue/files.mjs";
import { sameProcess } from "../queue/proctree.mjs";

export { sameProcess };

export const JOB_ID_RE = /^[0-9a-f]{24}$/;
export const KEEP_DAYS = 7;
export const KEEP_JOBS = 200;
/** How long a job may go without a pid file before it counts as lost: its runner never started. */
export const START_GRACE_MS = 30_000;
const DAY = 24 * 60 * 60 * 1000;
const TAIL_BYTES = 256 * 1024;
const MAX_LINE = 2000;
const EXTENSIONS = [".json", ".pid", ".exit", ".log", ".rerun"];

export const jobsDir = (home) => join(home, "mcp-jobs");
export const newJobId = () => randomBytes(12).toString("hex");

/** The files of one job. Throws for an id that is not a job id, so no path is ever built from other text. */
export function jobFiles(dir, id) {
    if (typeof id !== "string" || !JOB_ID_RE.test(id)) throw new Error("not a job id");
    const file = (ext) => join(dir, `${id}${ext}`);
    return { request: file(".json"), pid: file(".pid"), exit: file(".exit"), log: file(".log"), rerun: file(".rerun") };
}

/** Writes the request of a new job and returns its files. */
export function createJob(dir, id, request) {
    mkdirSync(dir, { recursive: true });
    const files = jobFiles(dir, id);
    writeJsonAtomic(files.request, request);
    return files;
}

/** { request, pid, exit, rerun } of a job, each null when its file is missing or broken; request null means no such
 *  job. */
export function readJob(dir, id) {
    const files = jobFiles(dir, id);
    return { files, request: readJson(files.request), pid: readJson(files.pid), exit: readJson(files.exit), rerun: readJson(files.rerun) };
}

/** Notes that the lost job id is started again as the job next, or with next null that it is not started again and
 *  why (notStarted). Only one caller ever wins: the file is created only when there is none. Returns true for the
 *  winner. */
export function claimRerun(dir, id, next, now = Date.now(), notStarted = null) {
    try {
        const note = next ? { id: next, at: now } : { notStarted, at: now };
        writeFileSync(jobFiles(dir, id).rerun, JSON.stringify(note), { flag: "wx" });
        return true;
    } catch {
        return false;
    }
}

/** Whether a job's runner may still be working: it has no exit file and its runner is alive, or it is younger than
 *  START_GRACE_MS and its runner has not written a pid file yet. */
export function runnerActive(job, now = Date.now(), check = sameProcess) {
    if (job.exit) return false;
    // The runner leads a process group of its own, so its group is its pid.
    if (job.pid) return check(job.pid.runnerPid, job.pid.runnerStartedAt, { group: job.pid.runnerPid });
    return now - (Number(job.request?.createdAt) || 0) < START_GRACE_MS;
}

/** The ids that have at least one job file in the folder. */
export function jobIds(dir) {
    let names = [];
    try { names = readdirSync(dir); } catch { return new Set(); }
    const ids = new Set();
    for (const name of names) {
        const id = name.slice(0, 24);
        if (JOB_ID_RE.test(id) && EXTENSIONS.includes(name.slice(24))) ids.add(id);
    }
    return ids;
}

/** The ids of the jobs whose runner may still be working (see runnerActive). */
export function activeJobs(dir, { now = Date.now(), check = sameProcess } = {}) {
    return [...jobIds(dir)].filter((id) => {
        const job = readJob(dir, id);
        return job.request && runnerActive(job, now, check);
    });
}

/** Removes the jobs older than keepDays whose runner is done, then the oldest done ones beyond keepJobs, and any
 *  stray file of a job whose request is gone once it is older than keepDays. Returns the ids removed. */
export function pruneJobs(dir, { now = Date.now(), keepDays = KEEP_DAYS, keepJobs = KEEP_JOBS, check = sameProcess } = {}) {
    const ids = jobIds(dir);
    const done = [];
    const removed = [];
    const drop = (id) => {
        for (const file of Object.values(jobFiles(dir, id))) rmSync(file, { force: true });
        removed.push(id);
    };
    for (const id of ids) {
        const job = readJob(dir, id);
        if (!job.request) {
            const files = Object.values(job.files);
            const newest = Math.max(0, ...files.map((file) => { try { return statSync(file).mtimeMs; } catch { return 0; } }));
            if (now - newest > keepDays * DAY) drop(id);
            continue;
        }
        if (runnerActive(job, now, check)) continue;
        const at = Number(job.request.createdAt) || 0;
        if (now - at > keepDays * DAY) drop(id);
        else done.push({ id, at });
    }
    done.sort((a, b) => a.at - b.at);
    for (const { id } of done.slice(0, Math.max(0, done.length - keepJobs))) drop(id);
    return removed;
}

/** The last count lines of a job log, each cut to MAX_LINE characters. Only the end of the file is read. Anything
 *  but a regular file in place of the log is refused: a symlink is never followed, and a FIFO is opened without
 *  waiting for a writer. */
export function tailLines(file, count) {
    if (count <= 0) return [];
    let fd;
    try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return []; }
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile()) return [];
        const size = stat.size;
        const length = Math.min(size, TAIL_BYTES);
        const buffer = Buffer.alloc(length);
        readSync(fd, buffer, 0, length, size - length);
        const lines = buffer.toString("utf8").split("\n");
        // The first line may be cut by the read window, and a final newline leaves an empty last item.
        if (length < size) lines.shift();
        if (lines.at(-1) === "") lines.pop();
        return lines.slice(-count).map((line) => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)} [cut]` : line));
    } finally {
        closeSync(fd);
    }
}
