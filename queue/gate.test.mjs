import "./testkit.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockReason, blockText, decide, gateBlocks, gateReason, shouldGiveUp } from "./gate.mjs";

const MINUTE = 60_000;
const busy = [{ label: "mobile-app: bundle" }, { label: "shop-api: integration suite" }, { label: "docs-site: build" }];
const lowDisk = { ok: false, blocks: [{ gate: "disk", text: "disk too low: 2.0 GB free, 12 GB needed" }] };
const hot = { ok: false, blocks: [{ gate: "load", text: "load too high: 9.0 now, 8.0 allowed" }, { gate: "memory", text: "memory too low: 8% free, 25% needed" }] };

test("decide: only the first in line may go, and only into a free slot", () => {
    const queue = [{ pid: 601 }, { pid: 602 }, { pid: 603 }];
    assert.deepEqual(decide({ holders: [{}], queue }, 601, 2), { go: true, position: 1 });
    assert.deepEqual(decide({ holders: [{}], queue }, 603, 2), { go: false, position: 3 });
    assert.deepEqual(decide({ holders: [{}, {}], queue }, 601, 2), { go: false, position: 1 });
    assert.deepEqual(decide({ holders: [{}, {}, {}], queue }, 601, 2), { go: false, position: 1 });
});

test("decide: a pid that is not in line is placed behind everyone", () => {
    assert.deepEqual(decide({ holders: [], queue: [{ pid: 601 }, { pid: 602 }] }, 777, 2), { go: false, position: 3 });
    assert.deepEqual(decide({ holders: [], queue: [] }, 777, 2), { go: false, position: 1 });
});

test("gateBlocks: lists full slots and every failed health limit", () => {
    assert.deepEqual(gateBlocks({ holders: busy, health: { ok: true, blocks: [] } }, 3), [{ gate: "slots", text: 'no free slot: 3 of 3 taken, by "mobile-app: bundle" and "shop-api: integration suite" and "docs-site: build"' }]);
    assert.deepEqual(gateBlocks({ holders: busy, health: hot }, 3).map((b) => b.gate), ["slots", "load", "memory"]);
    assert.deepEqual(gateBlocks({ holders: busy.slice(0, 1), health: lowDisk }, 3), lowDisk.blocks);
});

test("gateBlocks: names the line only when nothing else is in the way", () => {
    assert.deepEqual(gateBlocks({ holders: [], health: { ok: true, blocks: [] }, ahead: 4 }, 3), [{ gate: "line", text: "not first in line: 4 ahead" }]);
    assert.deepEqual(gateBlocks({ holders: [], health: lowDisk, ahead: 4 }, 3).map((b) => b.gate), ["disk"]);
    assert.deepEqual(gateBlocks({ holders: [], health: null }, 3), []);
});

test("gateReason: the blocks as one sentence, empty when a job could start", () => {
    assert.equal(gateReason({ holders: busy.slice(0, 1), health: hot }, 1), 'no free slot: 1 of 1 taken, by "mobile-app: bundle"; load too high: 9.0 now, 8.0 allowed; memory too low: 8% free, 25% needed');
    assert.equal(gateReason({ holders: [], health: { ok: true, blocks: [] } }, 3), "");
    assert.equal(blockText(lowDisk.blocks), "disk too low: 2.0 GB free, 12 GB needed");
});

test("blockReason: full slots hide the health gate, a free slot exposes it", () => {
    assert.deepEqual(blockReason({ holders: busy, health: hot, ahead: 2 }, 3).map((b) => b.gate), ["slots"]);
    assert.deepEqual(blockReason({ holders: busy.slice(0, 2), health: hot, ahead: 2 }, 3).map((b) => b.gate), ["load", "memory"]);
    assert.deepEqual(blockReason({ holders: busy.slice(0, 2), health: { ok: true, blocks: [] }, ahead: 2 }, 3).map((b) => b.gate), ["line"]);
    assert.deepEqual(blockReason({ holders: [], health: null }, 3), []);
});

test("shouldGiveUp: true from the limit on, never with a limit of 0", () => {
    const startedAt = 5 * MINUTE;
    assert.equal(shouldGiveUp({ startedAt, now: startedAt + 45 * MINUTE - 1, maxWaitMin: 45 }), false);
    assert.equal(shouldGiveUp({ startedAt, now: startedAt + 45 * MINUTE, maxWaitMin: 45 }), true);
    assert.equal(shouldGiveUp({ startedAt, now: startedAt + 30_000, maxWaitMin: 0.5 }), true);
    assert.equal(shouldGiveUp({ startedAt, now: startedAt + 10_000 * MINUTE, maxWaitMin: 0 }), false);
});
