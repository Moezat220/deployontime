// The jobs the MCP server starts, kept in mcp-jobs/ in the state folder. A job id names four files there:
// <id>.json (the request, written once by the server), <id>.pid (the runner and queue pids, written by the runner),
// <id>.exit (how the queue process ended, written by the runner) and <id>.log (everything the queue process and the
// job printed). An id is 24 lowercase hex characters, and every file name is built from a checked id only, so no
// caller can name a file outside this folder. Old jobs are pruned; a job whose runner is still alive never is.
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../queue/files.mjs";
import { alive } from "../queue/proctree.mjs";
import { probeProcessAges } from "../queue/probes.mjs";
import { parseElapsed } from "../queue/ps.mjs";

export const JOB_ID_RE = /^[0-9a-f]{24}$/;
export const KEEP_DAYS = 7;
export const KEEP_JOBS = 200;
/** How long a job may go without a pid file before it counts as lost: its runner never started. */
export const START_GRACE_MS = 30_000;
const DAY = 24 * 60 * 60 * 1000;
const SAME_START_MS = 5000;
const TAIL_BYTES = 256 * 1024;
const MAX_LINE = 2000;
const EXTENSIONS = [".json", ".pid", ".exit", ".log"];

export const jobsDir = (home) => join(home, "mcp-jobs");
export const newJobId = () => randomBytes(12).toString("hex");

/** The files of one job. Throws for an id that is not a job id, so no path is ever built from other text. */
export function jobFiles(dir, id) {
    if (typeof id !== "string" || !JOB_ID_RE.test(id)) throw new Error("not a job id");
    const file = (ext) => join(dir, `${id}${ext}`);
    return { request: file(".json"), pid: file(".pid"), exit: file(".exit"), log: file(".log") };
}

/** Writes the request of a new job and returns its files. */
export function createJob(dir, id, request) {
    mkdirSync(dir, { recursive: true });
    const files = jobFiles(dir, id);
    writeJsonAtomic(files.request, request);
    return files;
}

/** { request, pid, exit } of a job, each null when its file is missing or broken; request null means no such job. */
export function readJob(dir, id) {
    const files = jobFiles(dir, id);
    return { files, request: readJson(files.request), pid: readJson(files.pid), exit: readJson(files.exit) };
}

/** True while the process with this pid is the one that wrote startedAt (ms) when it began: a pid that a later
 *  process was given counts as gone. ages: pid to seconds run, as `ps` reports it. */
export function sameProcess(pid, startedAt, { isAlive = alive, ages = (pids) => parseElapsed(probeProcessAges(pids)) } = {}) {
    if (!Number.isInteger(pid) || pid <= 1 || !isAlive(pid)) return false;
    if (!Number.isFinite(startedAt)) return true;
    const seconds = ages([pid]).get(pid);
    // ps counts whole seconds, and the runner writes its start a moment after it began.
    return seconds === undefined || Math.abs(Date.now() - seconds * 1000 - startedAt) <= SAME_START_MS + 1000;
}

/** Whether a job's runner may still be working: it has no exit file and its runner is alive, or it is younger than
 *  START_GRACE_MS and its runner has not written a pid file yet. */
export function runnerActive(job, now = Date.now(), check = sameProcess) {
    if (job.exit) return false;
    if (job.pid) return check(job.pid.runnerPid, job.pid.runnerStartedAt);
    return now - (Number(job.request?.createdAt) || 0) < START_GRACE_MS;
}

/** Removes the jobs older than keepDays whose runner is done, then the oldest done ones beyond keepJobs, and any
 *  stray file of a job whose request is gone once it is older than keepDays. Returns the ids removed. */
export function pruneJobs(dir, { now = Date.now(), keepDays = KEEP_DAYS, keepJobs = KEEP_JOBS, check = sameProcess } = {}) {
    let names = [];
    try { names = readdirSync(dir); } catch { return []; }
    const ids = new Set();
    for (const name of names) {
        const id = name.slice(0, 24);
        if (JOB_ID_RE.test(id) && EXTENSIONS.includes(name.slice(24))) ids.add(id);
    }
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

/** The last count lines of a job log, each cut to MAX_LINE characters. Only the end of the file is read, and a
 *  symlink in place of the log is refused. */
export function tailLines(file, count) {
    if (count <= 0) return [];
    let fd;
    try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return []; }
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
