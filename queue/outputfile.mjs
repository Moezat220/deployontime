// What a failed job wrote to the file its stdout or stderr goes to, read back for failreason.mjs. The job's stdio is
// the wrapper's own, inherited as it is: nothing here comes between the job and its output. Before the job starts,
// the wrapper notes what each of its descriptors 1 and 2 is, and for a regular file its size. After a failure it
// opens that same file again, read only, and reads what was added since, at most the last TAIL_BYTES of it. The
// inherited descriptor itself is never read or moved: it is usually open for writing only and shares its offset with
// the job. A terminal, a pipe or anything else is not read at all. Nothing here throws, and the whole read is capped.
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readlinkSync, readSync } from "node:fs";
import { isatty } from "node:tty";
import { TAIL_BYTES } from "./failreason.mjs";

/** How long finding and reading the files may take in all. */
export const READ_BUDGET_MS = 2000;

const LSOF = existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof";

/** What descriptor fd is: { fd, kind, dev, ino, size } with kind "file", "tty", "pipe" or "other". A socket counts as
 *  a pipe: Node's own pipes to a child are sockets. kind is "unread" when it cannot be told. */
export function sinkOf(fd, { fstat = fstatSync, isTTY = isatty } = {}) {
    try {
        const st = fstat(fd);
        if (st.isFile()) return { fd, kind: "file", dev: st.dev, ino: st.ino, size: st.size };
        if (isTTY(fd)) return { fd, kind: "tty" };
        if (st.isFIFO() || st.isSocket()) return { fd, kind: "pipe" };
        return { fd, kind: "other" };
    } catch {
        return { fd, kind: "unread" };
    }
}

/** The sinks of stdout and stderr, noted before the job starts. */
export const outputSinks = (deps) => [sinkOf(1, deps), sinkOf(2, deps)];

/** The path of the file open on descriptor fd of process pid, or null: on Linux from /proc, elsewhere from lsof,
 *  given at most timeoutMs. The path may since name another file: the caller checks it is still the same one. */
export function pathOf(fd, { platform = process.platform, pid = process.pid, timeoutMs = READ_BUDGET_MS,
    readlink = readlinkSync, run = spawnSync } = {}) {
    try {
        if (platform === "linux") return readlink(`/proc/self/fd/${fd}`);
        const got = run(LSOF, ["-a", "-p", String(pid), "-d", String(fd), "-Fn"], {
            encoding: "utf8", timeout: Math.max(1, timeoutMs), stdio: ["ignore", "pipe", "ignore"],
        });
        if (got.error || got.status !== 0) return null;
        const line = String(got.stdout).split("\n").find((l) => l.startsWith("n"));
        return line ? line.slice(1) : null;
    } catch {
        return null;
    }
}

/** The bytes added to the file of sink since it was noted, at most the last `limit` of them, through a separate
 *  read-only open; null when the path is not found, names another file, or cannot be read. A file that shrank was
 *  cut during the run, and is read from its start. */
export function appendedBytes(sink, { path, limit = TAIL_BYTES, open = openSync, fstat = fstatSync,
    read = readSync, close = closeSync } = {}) {
    if (!path || !path.startsWith("/")) return null;
    let fd = null;
    try {
        fd = open(path, "r");
        const now = fstat(fd);
        if (!now.isFile() || now.dev !== sink.dev || now.ino !== sink.ino) return null;
        const from = Math.max(now.size >= sink.size ? sink.size : 0, now.size - limit);
        const bytes = Buffer.alloc(now.size - from);
        let got = 0;
        while (got < bytes.length) {
            const n = read(fd, bytes, got, bytes.length - got, from + got);
            if (n === 0) break;
            got += n;
        }
        return bytes.subarray(0, got);
    } catch {
        return null;
    } finally {
        if (fd !== null) try { close(fd); } catch { /* nothing to undo */ }
    }
}

/** What the output of a failed job shows: { text } with what it added to the file sinks, or { source } when nothing
 *  was read: "tty", "pipe" or "other" for what the streams were, "unread" when a file could not be read. Stdout and
 *  stderr on the same file are read once. deps: pathOf's and appendedBytes', and now() and budgetMs. */
export function readOutput(sinks, { now = Date.now, budgetMs = READ_BUDGET_MS, ...deps } = {}) {
    const until = now() + budgetMs;
    const files = sinks.filter((s, i) => s.kind === "file"
        && !sinks.slice(0, i).some((o) => o.kind === "file" && o.dev === s.dev && o.ino === s.ino));
    const parts = [];
    let failed = sinks.some((s) => s.kind === "unread");
    for (const sink of files) {
        const left = until - now();
        if (left <= 0) { failed = true; break; }
        const bytes = appendedBytes(sink, { ...deps, path: pathOf(sink.fd, { ...deps, timeoutMs: left }) });
        if (bytes) parts.push(bytes); else failed = true;
    }
    if (parts.length) return { text: parts.map((b) => b.toString("utf8")).join("\n") };
    return { source: failed ? "unread" : sourceOf(sinks) };
}

/** The source of a reason whose output was not read, from what the streams were: "tty" when either is a terminal,
 *  else "pipe" when either is a pipe, else "other". */
export function sourceOf(sinks) {
    const kinds = sinks.map((s) => s.kind);
    return kinds.includes("tty") ? "tty" : kinds.includes("pipe") ? "pipe" : "other";
}
