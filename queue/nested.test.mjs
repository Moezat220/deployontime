import { test } from "node:test";
import assert from "node:assert/strict";
import { isolateProcess } from "./testkit.mjs";

isolateProcess("nested");
const { JOB_MARKER, markerOf, outerJob, PARENT_MARKER, parentJob, placeKey, slotMarkerOf, stillRunning } = await import("./nested.mjs");

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
    assert.deepEqual([JOB_MARKER, PARENT_MARKER], ["DOTIME_JOB", "DOTIME_PARENT"]);
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

// The run 5104 above is itself nested: its job (5106) under its wrapper (5105) starts a shell (5107) that runs the
// queue again (5108). 5300 is a nested run of the other slot's job.
const DEEP_ROWS = [
    ...ROWS, { pid: 5105, ppid: 5104 }, { pid: 5106, ppid: 5105 }, { pid: 5107, ppid: 5106 }, { pid: 5108, ppid: 5107 },
    { pid: 5300, ppid: 5200 },
];
const NOTE = {
    file: "/state/nested/nested-5104.json", pid: 5104, label: "docs-site: unit tests", outer: "slot-0", outerPid: 5100,
    outerBorn: 1_900_000_000_000, born: 1_900_000_000_500, pgid: 5105,
};
const OTHER_NOTE = { ...NOTE, file: "/state/nested/nested-5300.json", pid: 5300, label: "shop-api: unit tests", pgid: 5301 };
const findDeep = (marker, pid = 5108, nested = [NOTE, OTHER_NOTE]) => outerJob({ marker, pid, holders: HOLDERS, nested, rows: DEEP_ROWS })?.label ?? null;

test("outerJob: a nested run's marker names its own note and is checked as strictly as a slot's", () => {
    assert.equal(findDeep("nested-5104"), "docs-site: unit tests", "the direct parent, not the outermost job");
    assert.equal(findDeep("slot-0"), "docs-site: test suite", "the slot marker still names the outer job");
    assert.equal(findDeep("nested-5300"), null, "a marker copied from another nested run: not an ancestor");
    assert.equal(findDeep("nested-5999"), null, "a stale marker: no such note");
    assert.equal(findDeep("nested-5104", 5200), null, "the right note, asked from outside the job");
    assert.equal(findDeep("nested-5104", 5104), null, "the nested run itself is not nested in its own note");
    assert.equal(findDeep("nested-5104", 5108, [{ ...NOTE, pgid: undefined }]), null, "no process group: its job has not started");
    assert.equal(findDeep("nested-5104", 5108, [{ ...NOTE, waiting: true }]), null, "the run still waits for a place");
    assert.equal(findDeep("nested-5104", 5108, [{ ...NOTE, born: undefined }]), null, "no start time");
    assert.equal(findDeep("nested-5104", 5108, [{ ...NOTE, pid: 5100 }]), null, "a note that names another pid than its file");
    assert.equal(findDeep("nested-5104", 5108, []), null, "notes are only looked up among the nested runs");
    assert.equal(outerJob({ marker: "slot-0", pid: 5108, holders: [], nested: [{ ...NOTE, file: "/state/nested/slot-0.json" }], rows: DEEP_ROWS }), null,
        "a slot marker is never looked up among the notes");
});

test("parentJob: the direct parent in DOTIME_PARENT first, else the slot in DOTIME_JOB, each checked as strictly", () => {
    const find = (env, pid = 5108) => parentJob({ env, pid, holders: HOLDERS, nested: [NOTE, OTHER_NOTE], rows: DEEP_ROWS })?.label ?? null;
    assert.equal(find({ DOTIME_JOB: "slot-0", DOTIME_PARENT: "nested-5104" }), "docs-site: unit tests");
    assert.equal(find({ DOTIME_JOB: "slot-0" }), "docs-site: test suite", "a job started by a copy that sets only DOTIME_JOB");
    assert.equal(find({ DOTIME_JOB: "slot-0", DOTIME_PARENT: "slot-0" }), "docs-site: test suite", "the job of a slot");
    assert.equal(find({ DOTIME_JOB: "slot-0", DOTIME_PARENT: "nested-5300" }), "docs-site: test suite",
        "a parent marker copied from another nested run falls back to the slot");
    assert.equal(find({ DOTIME_JOB: "slot-1", DOTIME_PARENT: "nested-5300" }), null, "neither is an ancestor");
    assert.equal(find({ DOTIME_JOB: "nested-5104" }), null, "DOTIME_JOB names only a slot");
    assert.equal(find({ DOTIME_JOB: "slot-0", DOTIME_PARENT: "nested-5104" }, 5200), null, "asked from outside the job");
    assert.equal(find({}), null);
    let reads = 0;
    const rows = { get byPid() { reads++; return new Map(); } };
    parentJob({ env: { DOTIME_JOB: "../slot-0", DOTIME_PARENT: "nested-x" }, pid: 5108, holders: HOLDERS, rows });
    assert.equal(reads, 0, "malformed markers are dropped before any process listing is read");
});

test("slotMarkerOf: a slot holder's own slot, or the slot a nested run's note names", () => {
    assert.equal(slotMarkerOf(HOLDERS[1]), "slot-1");
    assert.equal(slotMarkerOf({ ...NOTE, slot: "slot-0" }), "slot-0");
});

test("stillRunning: the parent's slot or note is still there with the same pid and start time, and still running", () => {
    const [slotJob] = HOLDERS;
    assert.equal(stillRunning(slotJob, { holders: HOLDERS, nested: [] }), true);
    assert.equal(stillRunning(slotJob, { holders: [], nested: [] }), false, "the slot was freed");
    assert.equal(stillRunning(slotJob, { holders: [{ ...slotJob, pid: 5400 }] }), false, "a later job holds the slot");
    assert.equal(stillRunning(slotJob, { holders: [{ ...slotJob, born: slotJob.born + 9000 }] }), false, "same pid, later start");
    assert.equal(stillRunning(slotJob, { holders: [], nested: [{ ...slotJob, file: "/state/nested/slot-0.json" }] }), false,
        "a slot is never looked up among the notes");
    assert.equal(stillRunning(NOTE, { holders: HOLDERS, nested: [NOTE] }), true);
    assert.equal(stillRunning(NOTE, { holders: HOLDERS, nested: [] }), false, "the note was removed");
    assert.equal(stillRunning(NOTE, { holders: HOLDERS, nested: [{ ...NOTE, pgid: undefined }] }), false, "no process group");
});

test("placeKey: the parent's marker and start time", () => {
    assert.equal(placeKey(HOLDERS[0]), "slot-0.1900000000000");
    assert.equal(placeKey(NOTE), "nested-5104.1900000000500");
});

test("outerJob: a missing or malformed marker is ignored before any process listing is read", () => {
    const rows = { get byPid() { throw new Error("the process table was read"); } };
    const malformed = ["", "slot-", "slot-0 ", "../slots/slot-0", "slot-0.json", "nested-", "nested-5104 ", "nested-x", "../nested/nested-5104"];
    for (const marker of [undefined, ...malformed]) {
        assert.equal(outerJob({ marker, pid: 5104, holders: HOLDERS, nested: [NOTE], rows }), null, JSON.stringify(marker));
    }
});

test("outerJob: with no rows given it reads the real process table, where this file's parent is an ancestor", () => {
    const holders = [{ file: "/state/slots/slot-0.json", pid: process.ppid, label: "docs-site: test suite", born: 0, pgid: 1 }];
    assert.equal(outerJob({ marker: "slot-0", pid: process.pid, holders })?.pid, process.ppid);
});
