import "../queue/testkit.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTO, busyShare, queuedRun, readOptions, roundConfig, summary } from "./slots.mjs";

test("readOptions: the defaults with no options", () => {
    const { opts } = readOptions([]);
    assert.deepEqual(opts.slots, [2, 3, 4, 6]);
    assert.equal(opts["light-agents"], 6);
    assert.equal(opts["light-threads"], 1);
    assert.equal(opts["heavy-agents"], 4);
    assert.equal(opts["heavy-threads"], 5);
    assert.equal(opts.repeat, 1);
});

test("readOptions: takes a slot list and numbers", () => {
    const { opts } = readOptions(["--slots", "1,5", "--heavy-threads", "3", "--slack", "2.5", "--tests", "4"]);
    assert.deepEqual(opts.slots, [1, 5]);
    assert.equal(opts["heavy-threads"], 3);
    assert.equal(opts.slack, 2.5);
    assert.equal(opts.tests, 4);
});

test("readOptions: refuses unknown, misspelled and doubled options", () => {
    assert.match(readOptions(["--slot", "2"]).error, /unknown option: --slot$/);
    assert.match(readOptions(["slots", "2"]).error, /unknown option: slots$/);
    assert.match(readOptions(["--repeat", "2", "--repeat", "3"]).error, /given twice: --repeat/);
    assert.match(readOptions(["--tests"]).error, /needs a value: --tests/);
});

test("readOptions: refuses bad numbers", () => {
    for (const bad of ["0", "-1", "1.5", "x", "", "Infinity"]) {
        assert.match(readOptions(["--agents-typo", bad]).error, /unknown option/);
        assert.match(readOptions(["--tries", bad]).error, /--tries needs a whole number above 0/, bad);
    }
    assert.match(readOptions(["--slack", "abc"]).error, /--slack needs a number above 0/);
    assert.match(readOptions(["--slack", "0"]).error, /--slack needs a number above 0/);
});

test("readOptions: refuses a bad slot list", () => {
    for (const bad of ["", "2,", "2,x", "0,2", "1.5", "-2", "2;3"]) {
        assert.match(readOptions(["--slots", bad]).error, /--slots needs whole numbers of 1 or more/, bad);
    }
    assert.match(readOptions(["--slots", "2,3,2"]).error, /--slots names a count twice/);
});

test("readOptions: takes auto in the slot list, once", () => {
    assert.deepEqual(readOptions(["--slots", "2,6,auto"]).opts.slots, [2, 6, AUTO]);
    assert.deepEqual(readOptions(["--slots", "auto"]).opts.slots, [AUTO]);
    for (const bad of ["Auto", "automatic", "2,auto5"]) {
        assert.match(readOptions(["--slots", bad]).error, /--slots needs whole numbers of 1 or more or "auto"/, bad);
    }
    assert.match(readOptions(["--slots", "auto,2,auto"]).error, /--slots names a count twice/);
});

test("roundConfig: a slot count is fixed, auto keeps the queue's defaults", () => {
    assert.deepEqual(roundConfig(6), { slots: 6, maxSlots: 6 });
    assert.deepEqual(roundConfig(AUTO), {});
});

test("summary: one value alone, several as median and range", () => {
    assert.equal(summary([12], " s"), "12 s");
    assert.equal(summary([15, 10, 12], " s"), "12 s (10 to 15)");
    assert.equal(summary([0, 3]), "3 (0 to 3)");
});

test("busyShare: the busy part of all core time between two readings", () => {
    const at = (user, idle) => ({ times: { user, nice: 0, sys: 0, idle, irq: 0 } });
    const before = [at(100, 100), at(100, 100)];
    assert.equal(busyShare(before, [at(200, 100), at(100, 200)]), 0.5);
    assert.equal(busyShare(before, [at(200, 100), at(200, 100)]), 1);
    assert.equal(busyShare(before, [at(100, 200), at(100, 200)]), 0);
    assert.equal(busyShare(before, before), 0);
});

test("queuedRun: every queued run passes --no-skip, and a retry also --after-fix", () => {
    const light = { name: "LIGHT" };
    const first = queuedRun(light, 3, 1, ["suite.mjs", "1"]);
    assert.deepEqual(first.slice(1, 9), ["run", "--label", "bench: light agent 3", "--max-run", "30", "--max-wait", "0", "--no-skip"]);
    assert.deepEqual(first.slice(-4), ["--", process.execPath, "suite.mjs", "1"]);
    assert.equal(first.includes("--after-fix"), false);
    const retry = queuedRun(light, 3, 2, ["suite.mjs", "1"]);
    assert.deepEqual([retry.includes("--no-skip"), retry[retry.indexOf("--after-fix") + 1]], [true, "benchmark retry on unchanged code"]);
});
