// How the wrapper ends after its job, when it decides the queue process is gone, and what it reports after a failure.
// Most functions are pure; some tests start the real wrapper, with pipes or a file as its stdout and stderr.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { constants as osConstants } from "node:os";
import { fileURLToPath } from "node:url";
import { closeSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanEnv, isolateProcess, tempDir, track } from "./testkit.mjs";

const HOME = isolateProcess("job-wrapper");
const { exitPlan, NO_START_EXIT, queueGone, readStartFailure, startFailureLine, wrapperEnd } = await import("./job-wrapper.mjs");
const WRAPPER = fileURLToPath(new URL("./job-wrapper.mjs", import.meta.url));

test("exitPlan: a job that exited by itself passes its code on", () => {
    assert.deepEqual(exitPlan({ code: 0, signal: null }), { exit: 0 });
    assert.deepEqual(exitPlan({ code: 4, signal: null }), { exit: 4 });
    assert.deepEqual(exitPlan({ code: null, signal: null }), { exit: 0 });
});

test("exitPlan: a job ended by a signal makes the wrapper die by the same signal", () => {
    for (const signal of ["SIGTERM", "SIGINT", "SIGKILL", "SIGPIPE"]) {
        assert.deepEqual(exitPlan({ code: null, signal }), { reraise: signal, orExit: 128 + osConstants.signals[signal] }, signal);
    }
});

test("exitPlan: SIGUSR1 is never raised again and ends with the code a shell gives", () => {
    assert.deepEqual(exitPlan({ code: null, signal: "SIGUSR1" }), { exit: 128 + osConstants.signals.SIGUSR1 });
});

test("queueGone: true once the queue process is no longer the parent or no longer alive", () => {
    assert.equal(queueGone({ ppid: 4100, queuePid: 4100, isAlive: () => true }), false);
    assert.equal(queueGone({ ppid: 1, queuePid: 4100, isAlive: () => true }), true);
    assert.equal(queueGone({ ppid: 4100, queuePid: 4100, isAlive: () => false }), true);
});

test("startFailureLine: one JSON line that names what went wrong", () => {
    assert.deepEqual(JSON.parse(startFailureLine("spawn sample-tool ENOENT")), { startFailed: "spawn sample-tool ENOENT" });
    assert.equal(startFailureLine("x").endsWith("\n"), true);
});

test("readStartFailure: reads back what the writer sent, and nothing from other text", () => {
    assert.equal(readStartFailure(startFailureLine("spawn sample-tool EACCES")), "spawn sample-tool EACCES");
    assert.equal(readStartFailure(`not json\n{"other":1}\n${startFailureLine("spawn sample-tool ENOENT")}`), "spawn sample-tool ENOENT");
    assert.equal(readStartFailure(startFailureLine("spawn sample-tool ENOENT").slice(0, 20)), null);
    for (const text of ["", "\n", "garbage", '{"startFailed": 3}', "null"]) assert.equal(readStartFailure(text), null, text);
});

const fakeWrapper = () => ({ child: new EventEmitter(), report: new PassThrough() });

test("wrapperEnd: resolves with the exit and the whole report once the report has ended", async () => {
    const { child, report } = fakeWrapper(), done = wrapperEnd(child, report, 5000);
    report.write("{\"startFailed\":");
    child.emit("exit", NO_START_EXIT, null);
    report.end('"spawn sample-tool ENOENT"}\n');
    assert.deepEqual(await done, { code: NO_START_EXIT, signal: null, report: startFailureLine("spawn sample-tool ENOENT") });
});

test("wrapperEnd: a report that never ends delays the result by the drain time only", async () => {
    const { child, report } = fakeWrapper(), began = Date.now(), done = wrapperEnd(child, report, 60);
    child.emit("exit", 0, null);
    assert.deepEqual(await done, { code: 0, signal: null, report: "" });
    assert.equal(Date.now() - began < 1000, true);
    assert.equal(report.destroyed, true);
});

test("wrapperEnd: an error on the report stream ends the wait and is not thrown", async () => {
    const { child, report } = fakeWrapper(), done = wrapperEnd(child, report, 5000);
    child.emit("exit", null, "SIGTERM");
    report.destroy(new Error("sample socket error"));
    assert.deepEqual(await done, { code: null, signal: "SIGTERM", report: "" });
});

test("wrapper: a command that cannot start is reported on descriptor 3 and ends with exit 127", async () => {
    const child = track(spawn(process.execPath, [WRAPPER, String(process.pid), "dotime-command-that-is-not-installed"], {
        env: cleanEnv(HOME),
        stdio: ["ignore", "pipe", "pipe", "pipe"],
    }));
    let report = "", stderr = "";
    child.stdio[3].on("data", (text) => { report += text; });
    child.stderr.on("data", (text) => { stderr += text; });
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.deepEqual([code, stderr], [NO_START_EXIT, ""]);
    assert.equal(JSON.parse(report).startFailed.includes("ENOENT"), true);
});

// ---- the failure reason ----

const { failureReport, readReason, reasonLine } = await import("./job-wrapper.mjs");

/** Starts a command, directly or through the wrapper, and collects both streams as bytes and descriptor 3 as text.
 *  file: a path both streams are appended to instead of pipes. */
function collect(args, { wrapped, file } = {}) {
    const argv = wrapped ? [WRAPPER, String(process.pid), process.execPath, ...args] : args;
    const fd = file ? openSync(file, "a") : null;
    const stdio = fd === null ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", fd, fd, "pipe"];
    const child = track(spawn(process.execPath, argv, { env: cleanEnv(HOME), stdio }));
    if (fd !== null) closeSync(fd);
    const out = [], err = [];
    let report = "";
    child.stdout?.on("data", (b) => out.push(b));
    child.stderr?.on("data", (b) => err.push(b));
    child.stdio[3].on("data", (t) => { report += t; });
    return new Promise((resolve) => child.on("close", (code, signal) => resolve({
        code, signal, out: Buffer.concat(out), err: Buffer.concat(err), report,
    })));
}

// Writes 1 MB to stdout and 1 MB to stderr in chunks of differing size, in turns, each chunk numbered so a cut or a
// change of order shows; then exits with the code in the argument, or by the signal named there.
const NOISY = `
const end = process.argv[1];
const chunk = (stream, i, size) => Buffer.from(String(stream + i + ":").padEnd(size, String.fromCharCode(97 + (i % 26))) + "\\n");
let i = 0, out = 0, err = 0;
const MB = 1024 * 1024;
const next = () => {
    while (out < MB || err < MB) {
        const size = 100 + ((i * 7919) % 4000);
        let ok = true;
        if (out < MB) { const b = chunk("o", i, size); out += b.length; ok = process.stdout.write(b) && ok; }
        if (err < MB) { const b = chunk("e", i, size + 13); err += b.length; ok = process.stderr.write(b) && ok; }
        i += 1;
        if (!ok) { setImmediate(next); return; }
    }
    if (end.startsWith("SIG")) process.stdout.write("", () => process.kill(process.pid, end));
    else process.exitCode = Number(end);
};
next();
`;

test("wrapper: the job's output reaches the same pipes unchanged, and is not read: exit code and signal are kept", async () => {
    const direct = await collect(["-e", NOISY, "3"]);
    const wrapped = await collect(["-e", NOISY, "3"], { wrapped: true });
    assert.equal(direct.out.length > 1024 * 1024 && direct.err.length > 1024 * 1024, true);
    assert.equal(wrapped.out.equals(direct.out), true, "stdout differs");
    assert.equal(wrapped.err.equals(direct.err), true, "stderr differs");
    assert.deepEqual([wrapped.code, wrapped.signal], [3, null]);
    assert.deepEqual(readReason(wrapped.report), { seen: false, found: null, source: "pipe" });
    const killed = await collect(["-e", NOISY, "SIGTERM"], { wrapped: true });
    assert.deepEqual([killed.code, killed.signal], [null, "SIGTERM"]);
    assert.equal(killed.out.equals(direct.out), true);
});

test("wrapper: a failed command's class, read back from its file, goes on descriptor 3 without its output", async () => {
    const dir = tempDir("wrapper-sink");
    const script = "console.log('TOKEN=abc123secret'); console.error('Error: listen EADDRINUSE :::3000'); process.exit(1)";
    const failed = await collect(["-e", script], { wrapped: true, file: join(dir, "failed.txt") });
    assert.equal(failed.code, 1);
    assert.equal(readFileSync(join(dir, "failed.txt"), "utf8"), "TOKEN=abc123secret\nError: listen EADDRINUSE :::3000\n");
    assert.deepEqual(readReason(failed.report), { seen: true, found: { class: "port", sign: "EADDRINUSE" } });
    assert.equal(failed.report.includes("abc123"), false);
    const passed = await collect(["-e", "console.log('Error: read ECONNRESET')"], { wrapped: true, file: join(dir, "passed.txt") });
    assert.deepEqual([passed.code, passed.report], [0, ""]);
});

test("failureReport: nothing for a pass, the output read for an exit code, the sinks alone for a signal", () => {
    const sinks = [{ fd: 1, kind: "file", dev: 1, ino: 2, size: 0 }, { fd: 2, kind: "tty" }];
    let reads = 0;
    const read = (given) => { reads += 1; assert.equal(given, sinks); return { text: "Error: read ECONNRESET" }; };
    assert.equal(failureReport({ code: 0, signal: null }, sinks, read), null);
    assert.deepEqual(failureReport({ code: 1, signal: null }, sinks, read), { seen: true, found: { class: "network", sign: "ECONNRESET" } });
    assert.deepEqual(failureReport({ code: null, signal: "SIGTERM" }, sinks, read), { seen: false, source: "tty" });
    assert.equal(reads, 1, "a signal reads nothing");
    assert.deepEqual(failureReport({ code: 2, signal: null }, sinks, () => ({ source: "unread" })), { seen: false, source: "unread" });
});

test("reasonLine and readReason: read back what was sent, and nothing from other lines", () => {
    assert.deepEqual(readReason(reasonLine({ seen: false })), { seen: false, found: null, source: null });
    assert.deepEqual(readReason(reasonLine({ seen: false, source: "pipe" })), { seen: false, found: null, source: "pipe" });
    const sent = reasonLine({ seen: true, found: { class: "test", sign: "# fail" } });
    assert.deepEqual(readReason(`garbage\n${startFailureLine("x")}${sent}`), { seen: true, found: { class: "test", sign: "# fail" } });
    for (const text of ["", "null", '{"seen":"yes"}', sent.slice(0, 10)]) assert.equal(readReason(text), null, text);
});
