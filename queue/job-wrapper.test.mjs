// How the wrapper ends after its job, and when it decides the queue process is gone. The functions are pure; the
// last test starts the real wrapper once to see that a command which cannot start is reported on descriptor 3.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { constants as osConstants } from "node:os";
import { fileURLToPath } from "node:url";
import { cleanEnv, isolateProcess, track } from "./testkit.mjs";

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
    const child = track(spawn(process.execPath, [WRAPPER, String(process.pid), "dotime-command-that-is-not-installed"], { env: cleanEnv(HOME), stdio: ["ignore", "pipe", "pipe", "pipe"] }));
    let report = "", stderr = "";
    child.stdio[3].on("data", (text) => { report += text; });
    child.stderr.on("data", (text) => { stderr += text; });
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.deepEqual([code, stderr], [NO_START_EXIT, ""]);
    assert.equal(JSON.parse(report).startFailed.includes("ENOENT"), true);
});
