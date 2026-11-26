// Real signals go only to processes that this file starts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { isolateProcess, track, until } from "./testkit.mjs";

isolateProcess("proctree");
const { alive, ancestors, descendants, jobCpu, killTree, signalGroup, stopGroup, treeIndex, treePids } = await import("./proctree.mjs");
const { psRows } = await import("./ps.mjs");

const TABLE = [
    "  4100     1  4100   0:04.00",
    "  4101  4100  4100   0:06.50",
    "  4102  4101  4102   0:01.25",
    "  4103  4102  4102   0:00.25",
    "  4300     1  4100   0:02.00",
    "  4200     1  4200   0:30.00",
].join("\n");

test("alive: true for this process, false for a pid above the pid range", () => {
    assert.equal(alive(process.pid), true);
    assert.equal(alive(2 ** 30 + 7), false);
});

test("treePids: a leader's pids include a child that started a group of its own", () => {
    assert.deepEqual(treePids(4100, TABLE).sort(), [4100, 4101, 4102, 4103, 4300]);
    assert.deepEqual(treePids(4200, TABLE), [4200]);
    assert.deepEqual(treePids(4999, TABLE), [4999]);
});

test("jobCpu: sums the job's processes, and is null when its leader is gone", () => {
    const rows = psRows(TABLE);
    assert.equal(jobCpu({ pid: 4000, pgid: 4100 }, rows), 14);
    assert.equal(jobCpu({ pid: 4200 }, rows), 30);
    assert.equal(jobCpu({ pid: 4000, pgid: 4999 }, rows), null);
});

test("killTree: stops a started job together with a child that left its group", async () => {
    const child = "setInterval(() => {}, 1000)";
    const leaderCode =
        `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(child)}], ` +
        `{ detached: true, stdio: "ignore" }); console.log(c.pid); setInterval(() => {}, 1000);`;
    const leader = track(spawn(process.execPath, ["-e", leaderCode], { detached: true, stdio: ["ignore", "pipe", "ignore"] }), { group: true });
    const exited = new Promise((done) => leader.once("exit", done));
    const strayChild = track(await new Promise((done) => leader.stdout.once("data", (text) => done(Number(String(text).trim())))), { group: true });
    assert.deepEqual([alive(leader.pid), alive(strayChild)], [true, true]);
    const { pids: signalled, refused } = killTree(leader.pid, "SIGKILL");
    assert.deepEqual([signalled.includes(leader.pid), signalled.includes(strayChild), refused], [true, true, []]);
    await exited;
    await until(() => !alive(strayChild), 3000);
});

test("killTree: names each refused signal, and passes over processes that are gone", () => {
    const sent = [];
    const kill = (pid, signal) => {
        sent.push([pid, signal]);
        const code = { [-4100]: "EPERM", 4102: "EPERM", 4103: "ESRCH" }[pid];
        if (code) throw Object.assign(new Error("signal refused"), { code });
    };
    const result = killTree(4100, "SIGTERM", { ps: TABLE, kill });
    assert.deepEqual(result.refused, ["group 4100 (EPERM)", "pid 4102 (EPERM)"]);
    assert.deepEqual(sent.map(([pid]) => pid).sort(), [-4100, 4100, 4101, 4102, 4103, 4300].sort());
    assert.deepEqual(killTree(4200, "SIGKILL", { ps: TABLE, kill: () => {} }), { pids: [4200], refused: [] });
});

test("stopGroup: ends a started group, with KILL for a process that ignores TERM", async () => {
    const stubborn = track(spawn(
        process.execPath,
        ["-e", 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);'],
        { detached: true, stdio: ["ignore", "pipe", "ignore"] }
    ), { group: true });
    const exited = new Promise((done) => stubborn.once("exit", (code, signal) => done(signal)));
    await new Promise((done) => stubborn.stdout.once("data", done));
    await stopGroup(stubborn.pid, [{ pid: stubborn.pid }], { graceMs: 150 });
    assert.equal(await exited, "SIGKILL");
    await until(() => !alive(stubborn.pid), 3000);
});

test("descendants: the roots and everything below them, also from a prebuilt index", () => {
    const rows = psRows(TABLE);
    assert.deepEqual([...descendants(rows, [4101])].sort(), [4101, 4102, 4103]);
    assert.deepEqual([...descendants(treeIndex(rows), [4100, 4200])].sort(), [4100, 4101, 4102, 4103, 4200]);
    assert.deepEqual([...descendants(rows, [4999])], [4999]);
    const loop = [{ pid: 0, ppid: 0 }, { pid: 1, ppid: 0 }];
    assert.deepEqual([...descendants(loop, [0])].sort(), [0, 1], "a process listed as its own parent ends the walk");
});

test("ancestors: the row and its parents nearest first, ending at a missing pid, a loop or the depth limit", () => {
    const rows = psRows(TABLE);
    assert.deepEqual(ancestors(rows, 4103).map((row) => row.pid), [4103, 4102, 4101, 4100]);
    assert.deepEqual(ancestors(rows, 4999), []);
    assert.deepEqual(ancestors([{ pid: 0, ppid: 0 }], 0).map((row) => row.pid), [0]);
    const chain = Array.from({ length: 200 }, (_, i) => ({ pid: i + 2, ppid: i + 3 }));
    assert.equal(ancestors(chain, 2).length, 64);
});

test("signalGroup: says whether the signal went out, and the error code when it did not", () => {
    const sent = [];
    assert.deepEqual(signalGroup(4100, "SIGTERM", (pid, signal) => sent.push([pid, signal])), { sent: true });
    assert.deepEqual(sent, [[-4100, "SIGTERM"]]);
    const refuse = (code) => () => { throw Object.assign(new Error(code), { code }); };
    assert.deepEqual(signalGroup(4100, "SIGTERM", refuse("EPERM")), { sent: false, code: "EPERM" });
    assert.deepEqual(signalGroup(2 ** 30 + 7, 0), { sent: false, code: "ESRCH" });
});

test("stopGroup: a refused signal is reported as a failed stop, a group that is already gone as stopped", async () => {
    const refuse = (code) => () => { throw Object.assign(new Error(code), { code }); };
    const procs = [{ pid: 2400 }, { pid: 2401 }];
    const termRefused = await stopGroup(2400, procs, { graceMs: 0, isAlive: () => true, kill: refuse("EPERM") });
    assert.deepEqual(termRefused, { stopped: false, why: "TERM refused (EPERM)" });
    const killRefused = await stopGroup(2400, procs, {
        graceMs: 0, isAlive: (pid) => pid === 2401, kill: (pid) => { if (pid > 0) refuse("EPERM")(); },
    });
    assert.deepEqual(killRefused, { stopped: false, why: "KILL refused for pid 2401 (EPERM)" });
    assert.deepEqual(await stopGroup(2400, procs, { graceMs: 0, isAlive: () => false, kill: refuse("ESRCH") }), { stopped: true });
});
