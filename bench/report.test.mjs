import assert from "node:assert/strict";
import { test } from "node:test";
import { loadRatio, markdown, results, scaledSettings, summarize } from "./report.mjs";

test("the settings ask for about twice the busy threads the computer has", () => {
    // 8 cores and 4 agents: 4 threads each, 16 busy threads in all
    assert.deepEqual(scaledSettings({ cores: 8, ramMB: 16384, agents: 4 }), { threads: 4, mem: 400 });
    assert.deepEqual(scaledSettings({ cores: 3, ramMB: 7168, agents: 4 }), { threads: 2, mem: 400 });
    // never fewer than one thread
    assert.deepEqual(scaledSettings({ cores: 1, ramMB: 16384, agents: 8 }), { threads: 1, mem: 400 });
});

test("the memory per thread is lowered to fit half the RAM, and only then", () => {
    // 12 cores and 4 agents: 4 agents × 6 threads × 400 MB = 9600 MB, exactly half of 19200 MB: kept
    assert.equal(scaledSettings({ cores: 12, ramMB: 19200, agents: 4 }).mem, 400);
    // 4 × 6 × 400 MB is more than half of 8192 MB: 4096 / 24 = 170 MB
    assert.deepEqual(scaledSettings({ cores: 12, ramMB: 8192, agents: 4 }), { threads: 6, mem: 170 });
});

const round = (way, repeat, seconds, runs, firstFailed, neverGreen = 0) =>
    ({ way, repeat, seconds, runs, errors: 0, firstFailed, neverGreen, agents: [] });

test("the summary gives the median and range of each way", () => {
    const rounds = [round("direct", 1, 373, 25, 400), round("queue", 1, 57, 4, 0),
        round("direct", 2, 447, 32, 400, 2), round("queue", 2, 58, 4, 0),
        round("direct", 3, 469, 30, 400, 1), round("queue", 3, 58, 4, 0)];
    const summary = summarize(rounds);
    assert.deepEqual(summary.direct.seconds, { median: 447, lowest: 373, highest: 469 });
    assert.equal(summary.direct.notAllGreen, 2);
    assert.deepEqual(summary.queue.runs, { median: 4, lowest: 4, highest: 4 });
    assert.equal(summary.queue.notAllGreen, 0);
});

test("the results hold the settings, the machine, every round and the summary", () => {
    const options = { repeat: 1, agents: 4, threads: 4, tests: 20, mem: 400, tries: 8, work: 250, slack: 1.6 };
    const machine = { chip: "test chip", model: "test model", cores: 8, ramMB: 16384, os: "macOS", node: "v22.0.0",
        commit: "abc" };
    const rounds = [round("direct", 1, 447, 32, 320, 2), round("queue", 1, 57, 4, 0)];
    const data = results({ options, deadlineMs: 160, aloneMedianMs: 100, queueSlots: 2, machine, rounds,
        complete: true });
    assert.deepEqual(Object.keys(data), ["complete", "configuration", "machine", "rounds", "summary"]);
    assert.equal(data.configuration.queueSlots, 2);
    assert.equal(data.configuration.busyThreads, 16);
    assert.equal(data.configuration.loadRatio, 2);
    assert.equal(data.configuration.deadlineMs, 160);
    assert.equal(data.configuration.aloneMedianMs, 100);
    assert.equal(data.configuration.threads, 4);

    const text = markdown(data);
    assert.match(text, /test chip \(test model\), 8 cores, 16384 MB RAM/);
    assert.match(text, /Load: 16 busy threads on 8 cores when all agents start at once, 2 per core/);
    assert.match(text, /, 2 queue slots/);
    assert.ok(text.includes("| Round 1: time until every agent had a green run | " +
        "not green after 8 tries (2 agents red, 447 s) | 57 s |"));
    assert.match(text, /\| First-run failures of 320 tests, median \(range\) \| 320 \(320 to 320\) \| 0 \(0 to 0\) \|/);
    assert.ok(text.includes("These settings follow the scaling rule: threads per suite = max(1, round(2 × cores"));
    assert.doesNotMatch(text, /Not complete/);
});

test("a run that stopped early says so", () => {
    const options = { repeat: 3, agents: 4, threads: 5, tests: 20, mem: 400, tries: 8, work: 250, slack: 1.6 };
    const data = results({ options, deadlineMs: null, aloneMedianMs: null, machine: { cores: 3, ramMB: 7168,
        node: "v22.0.0" }, rounds: [], complete: false, error: "the suite did not run on its own (exit 1)" });
    const text = markdown(data);
    assert.match(text, /\*\*Not complete:\*\* the suite did not run on its own \(exit 1\)\./);
    assert.match(text, /No round finished\./);
    // 3 cores and 4 agents would give 2 threads, not 5
    assert.match(text, /These settings were chosen by hand, not by the scaling rule/);
});

test("the load ratio is the busy threads for each core", () => {
    // a 3-core runner with 4 agents gets 2 threads each: 8 busy threads, 2.67 per core
    assert.equal(loadRatio({ agents: 4, threads: 2, cores: 3 }), 2.67);
    assert.equal(loadRatio({ agents: 4, threads: 4, cores: 8 }), 2);
});
