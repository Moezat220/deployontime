import { test } from "node:test";
import assert from "node:assert/strict";
import { isolateProcess } from "./testkit.mjs";

isolateProcess("nested");
const { JOB_MARKER, markerOf, outerJob } = await import("./nested.mjs");

// A run (pid 5104) started by a shell (5103) inside a job (5102) under its wrapper (5101), whose queue process is
// 5100; 5200 is an unrelated process that holds the other slot.
const ROWS = [
    { pid: 5100, ppid: 1 }, { pid: 5101, ppid: 5100 }, { pid: 5102, ppid: 5101 }, { pid: 5103, ppid: 5102 },
    { pid: 5104, ppid: 5103 }, { pid: 5200, ppid: 1 },
];
const HOLDERS = [
    { file: "/state/slots/slot-0.json", pid: 5100, label: "docs-site: test suite", born: 1_900_000_000_000, pgid: 5101 },
    { file: "/state/slots/slot-1.json", pid: 5200, label: "shop-api: e2e", born: 1_900_000_100_000, pgid: 5201 },
];
const find = (marker, pid = 5104) => outerJob({ marker, pid, holders: HOLDERS, rows: ROWS })?.label ?? null;

test("markerOf: the slot file's name without its folder and ending", () => {
    assert.equal(markerOf("/state/slots/slot-3.json"), "slot-3");
    assert.equal(JOB_MARKER, "DOTIME_JOB");
});

test("outerJob: a marker is genuine only for a held slot whose holder is an ancestor of the run", () => {
    assert.equal(find("slot-0"), "docs-site: test suite");
    assert.equal(find("slot-1"), null, "a marker copied from another job: its holder is not an ancestor");
    assert.equal(find("slot-2"), null, "a stale marker: nobody holds the slot");
    assert.equal(find("slot-0", 5200), null, "the right slot, asked from outside the job");
    assert.equal(find("slot-0", 5100), null, "the holder itself is not nested in its own slot");
});

test("outerJob: a slot file without the pid above 1, start time and process group of a running job is not trusted", () => {
    const [real] = HOLDERS, rows = [{ pid: 1, ppid: 0 }, ...ROWS];
    const check = (holder) => outerJob({ marker: "slot-0", pid: 5104, holders: [holder], rows })?.pid ?? null;
    assert.equal(check(real), 5100);
    assert.equal(check({ ...real, born: undefined }), null, "no start time");
    assert.equal(check({ ...real, pgid: undefined }), null, "no process group: the job has not started");
    assert.equal(check({ file: real.file, pid: 1, label: "forged" }), null, "pid 1, an ancestor of every process");
    assert.equal(check({ ...real, pid: 1 }), null, "pid 1 with every other field in place");
});

test("outerJob: a missing or malformed marker is ignored before any process listing is read", () => {
    const rows = { get byPid() { throw new Error("the process table was read"); } };
    for (const marker of [undefined, "", "slot-", "slot-0 ", "../slots/slot-0", "slot-0.json"]) {
        assert.equal(outerJob({ marker, pid: 5104, holders: HOLDERS, rows }), null, JSON.stringify(marker));
    }
});

test("outerJob: with no rows given it reads the real process table, where this file's parent is an ancestor", () => {
    const holders = [{ file: "/state/slots/slot-0.json", pid: process.ppid, label: "docs-site: test suite", born: 0, pgid: 1 }];
    assert.equal(outerJob({ marker: "slot-0", pid: process.pid, holders })?.pid, process.ppid);
});
