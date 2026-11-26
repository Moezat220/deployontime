// How the wrapper ends after its job, and when it decides the queue process is gone. The functions are pure; the
// last test starts the real wrapper once to see that a command which cannot start is reported on descriptor 3.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { fileURLToPath } from "node:url";
import { cleanEnv, isolateProcess, track } from "./testkit.mjs";

const HOME = isolateProcess("group");
const { exitPlan, NO_START_EXIT, queueGone, startFailure } = await import("./group.mjs");
const WRAPPER = fileURLToPath(new URL("./group.mjs", import.meta.url));

test("exitPlan: a job that exited by itself passes its code on", () => {
    assert.deepEqual(exitPlan({ code: 0, signal: null }), { exit: 0 });
    assert.deepEqual(exitPlan({ code: 4, signal: null }), { exit: 4 });
    assert.deepEqual(exitPlan({ code: null, signal: null }), { exit: 0 });
});

test("exitPlan: a job ended by a signal makes the wrapper die by the same signal", () => {
    for (const signal of ["SIGTERM", "SIGINT", "SIGKILL", "SIGPIPE"]) {
        assert.deepEqual(exitPlan({ code: null, signal }), { reraise: signal, orExit: 128 + osConstants.signals[signal] }, signal);
    }
    assert.deepEqual(exitPlan({ code: null, signal: "SIGPIPE" }).orExit, 128 + osConstants.signals.SIGPIPE);
});

test("exitPlan: SIGUSR1 is never raised again and ends with the code a shell gives", () => {
    assert.deepEqual(exitPlan({ code: null, signal: "SIGUSR1" }), { exit: 128 + osConstants.signals.SIGUSR1 });
});

test("queueGone: true once the queue process is no longer the parent or no longer alive", () => {
    assert.equal(queueGone({ ppid: 4100, queuePid: 4100, isAlive: () => true }), false);
    assert.equal(queueGone({ ppid: 1, queuePid: 4100, isAlive: () => true }), true);
    assert.equal(queueGone({ ppid: 4100, queuePid: 4100, isAlive: () => false }), true);
});

test("startFailure: one JSON line that names what went wrong", () => {
    assert.deepEqual(JSON.parse(startFailure("spawn sample-tool ENOENT")), { startFailed: "spawn sample-tool ENOENT" });
    assert.equal(startFailure("x").endsWith("\n"), true);
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
