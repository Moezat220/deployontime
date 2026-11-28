// Reading back what a failed job added to the file its output goes to: what each descriptor is, how its path is found
// on Linux and on macOS (both injected), that only what was added is read and only from the same file, and that
// nothing is read from a terminal or a pipe. One test reads a real file on this computer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, closeSync, fstatSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./testkit.mjs";
import { TAIL_BYTES } from "./failreason.mjs";
import { appendedBytes, pathOf, readOutput, sinkOf, sourceOf } from "./outputfile.mjs";

const stat = (kind, extra = {}) => ({
    isFile: () => kind === "file", isFIFO: () => kind === "fifo", isSocket: () => kind === "socket", dev: 7, ino: 70, size: 0, ...extra,
});

test("sinkOf: a regular file with its size, a terminal, a pipe or socket, anything else, and an fstat that fails", () => {
    assert.deepEqual(sinkOf(1, { fstat: () => stat("file", { size: 42 }), isTTY: () => false }), { fd: 1, kind: "file", dev: 7, ino: 70, size: 42 });
    assert.deepEqual(sinkOf(2, { fstat: () => stat("chr"), isTTY: () => true }), { fd: 2, kind: "tty" });
    assert.deepEqual(sinkOf(1, { fstat: () => stat("fifo"), isTTY: () => false }), { fd: 1, kind: "pipe" });
    assert.deepEqual(sinkOf(1, { fstat: () => stat("socket"), isTTY: () => false }), { fd: 1, kind: "pipe" });
    assert.deepEqual(sinkOf(1, { fstat: () => stat("chr"), isTTY: () => false }), { fd: 1, kind: "other" });
    assert.deepEqual(sinkOf(1, { fstat: () => { throw new Error("EBADF"); } }), { fd: 1, kind: "unread" });
});

test("pathOf: Linux reads /proc/self/fd, macOS asks lsof for this process and descriptor within the time left", () => {
    const linked = [];
    assert.equal(pathOf(1, { platform: "linux", readlink: (p) => { linked.push(p); return "/work/out.txt"; } }), "/work/out.txt");
    assert.deepEqual(linked, ["/proc/self/fd/1"]);
    const calls = [];
    const run = (cmd, args, options) => { calls.push([args, options.timeout]); return { status: 0, stdout: "p4100\nf2\nn/work/agent output.txt\n" }; };
    assert.equal(pathOf(2, { platform: "darwin", pid: 4100, timeoutMs: 1500, run }), "/work/agent output.txt");
    assert.deepEqual(calls, [[["-a", "-p", "4100", "-d", "2", "-Fn"], 1500]]);
    assert.equal(pathOf(1, { platform: "darwin", run: () => ({ status: 1, stdout: "" }) }), null);
    assert.equal(pathOf(1, { platform: "darwin", run: () => ({ error: new Error("ETIMEDOUT"), stdout: "" }) }), null);
    assert.equal(pathOf(1, { platform: "darwin", run: () => ({ status: 0, stdout: "p1\nf1\n" }) }), null);
    assert.equal(pathOf(1, { platform: "linux", readlink: () => { throw new Error("ENOENT"); } }), null);
});

test("appendedBytes: only what was added since the size was noted, at most the last bytes, and only from the same file", () => {
    const dir = tempDir("outputfile"), file = join(dir, "out.txt");
    writeFileSync(file, "Error: listen EADDRINUSE\n");
    const { dev, ino, size } = fstatSync(openSync(file, "r"));
    const sink = { fd: 1, kind: "file", dev, ino, size };
    appendFileSync(file, "Error: read ECONNRESET\n");
    assert.equal(appendedBytes(sink, { path: file }).toString(), "Error: read ECONNRESET\n");
    appendFileSync(file, "x".repeat(TAIL_BYTES));
    const last = appendedBytes(sink, { path: file });
    assert.deepEqual([last.length, last.toString().endsWith("x"), last.includes("ECONNRESET")], [TAIL_BYTES, true, false]);
    writeFileSync(file, "cut\n");
    assert.equal(appendedBytes(sink, { path: file }).toString(), "cut\n", "a file cut during the run is read from its start");
    const other = join(dir, "other.txt");
    writeFileSync(other, "Error: read ECONNRESET\n".repeat(4));
    assert.equal(appendedBytes(sink, { path: other }), null, "another file at the path");
    assert.equal(appendedBytes(sink, { path: join(dir, "gone.txt") }), null);
    assert.equal(appendedBytes(sink, { path: null }), null);
    assert.equal(appendedBytes(sink, { path: "relative.txt" }), null);
});

test("readOutput: one read for stdout and stderr on one file, nothing read from a terminal or a pipe, unread on errors", () => {
    const file = { kind: "file", dev: 7, ino: 70, size: 0 };
    const looked = [];
    const deps = { platform: "linux", readlink: (p) => { looked.push(p); return "/work/out.txt"; } };
    const same = readOutput([{ fd: 1, ...file }, { fd: 2, ...file }], { ...deps, open: () => { throw new Error("EACCES"); } });
    assert.deepEqual([same, looked], [{ source: "unread" }, ["/proc/self/fd/1"]], "one file is looked up once");
    assert.deepEqual(readOutput([{ fd: 1, kind: "tty" }, { fd: 2, kind: "pipe" }], deps), { source: "tty" });
    assert.deepEqual(readOutput([{ fd: 1, kind: "pipe" }, { fd: 2, kind: "other" }], deps), { source: "pipe" });
    assert.deepEqual(readOutput([{ fd: 1, kind: "other" }, { fd: 2, kind: "other" }], deps), { source: "other" });
    assert.deepEqual(readOutput([{ fd: 1, kind: "unread" }, { fd: 2, kind: "pipe" }], deps), { source: "unread" });
    assert.deepEqual(readOutput([{ fd: 1, ...file }], { ...deps, now: () => 0, budgetMs: 0 }), { source: "unread" }, "no time left");
    assert.deepEqual(sourceOf([{ kind: "file" }, { kind: "pipe" }]), "pipe");
});

test("readOutput: a real file on this computer, found by its descriptor, gives what was added to it", () => {
    const file = join(tempDir("outputfile-real"), "out.txt");
    writeFileSync(file, "Error: listen EADDRINUSE\n");
    const fd = openSync(file, "a");
    try {
        const sink = sinkOf(fd);
        assert.equal(sink.kind, "file");
        appendFileSync(fd, "Error: read ECONNRESET\n");
        assert.deepEqual(readOutput([sink, { ...sink, fd: 2 }]), { text: "Error: read ECONNRESET\n" });
    } finally { closeSync(fd); }
});
