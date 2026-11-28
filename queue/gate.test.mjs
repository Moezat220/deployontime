import "./testkit.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { capacityPlan } from "./capacity.mjs";
import {
    baseTaken, blockReason, blockText, decide, extraInQuestion, gateBlocks, gateReason, shouldGiveUp, slotRoom, startCrowded,
    takenText,
} from "./gate.mjs";

const MINUTE = 60_000;
const busy = [{ label: "mobile-app: bundle" }, { label: "shop-api: integration suite" }, { label: "docs-site: build" }];
const lowDisk = { ok: false, blocks: [{ gate: "disk", text: "disk too low: 2.0 GB free, 12 GB needed" }] };
const hot = { ok: false, blocks: [
    { gate: "load", text: "load too high: 9.0 now, 8.0 allowed" },
    { gate: "memory", text: "memory too low: 8% free, 25% needed" },
] };

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
    assert.deepEqual(gateBlocks({ holders: busy, health: { ok: true, blocks: [] } }, 3), [{
        gate: "slots",
        text: 'no free slot: 3 of 3 taken, by "mobile-app: bundle" and "shop-api: integration suite" and "docs-site: build"',
    }]);
    assert.deepEqual(gateBlocks({ holders: busy, health: hot }, 3).map((b) => b.gate), ["slots", "load", "memory"]);
    assert.deepEqual(gateBlocks({ holders: busy.slice(0, 1), health: lowDisk }, 3), lowDisk.blocks);
});

test("gateBlocks: names the line only when nothing else is in the way", () => {
    assert.deepEqual(gateBlocks({ holders: [], health: { ok: true, blocks: [] }, ahead: 4 }, 3), [{ gate: "line", text: "not first in line: 4 ahead" }]);
    assert.deepEqual(gateBlocks({ holders: [], health: lowDisk, ahead: 4 }, 3).map((b) => b.gate), ["disk"]);
    assert.deepEqual(gateBlocks({ holders: [], health: null }, 3), []);
});

test("gateReason: the blocks as one sentence, empty when a job could start", () => {
    assert.equal(
        gateReason({ holders: busy.slice(0, 1), health: hot }, 1),
        'no free slot: 1 of 1 taken, by "mobile-app: bundle"; load too high: 9.0 now, 8.0 allowed; '
            + "memory too low: 8% free, 25% needed",
    );
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

// ---- extra slots ----

// The plan of a settings file that sets slots 2 and maxSlots 4, with the default extra-slot rules.
const planOf = (more = {}) => capacityPlan({
    settings: { slots: 2, maxSlots: 4, extraSlotCpuPct: 60, extraSlotSettleSec: 10, ...more },
    userSet: { slots: true, maxSlots: true }, cores: 8,
});
const ROOMY = planOf();
const NOW = 50 * MINUTE;
const ran = (secondsAgo, label = "shop-api: lint") => ({ label, at: NOW - secondsAgo * 1000 - 500, startedAt: NOW - secondsAgo * 1000 });

test("slotRoom: gives an extra slot while the CPU is below the threshold and no job started in the settle window", () => {
    const holders = [ran(40), ran(25)];
    assert.deepEqual(slotRoom({ holders, busyCpuPct: 31.4, now: NOW }, ROOMY), {
        max: 3, extra: true, why: "extra slot free while the CPU has room: CPU 31% busy now, below 60%",
    });
    assert.equal(slotRoom({ holders: [...holders, ran(12)], busyCpuPct: 59.9, now: NOW }, ROOMY).max, 4, "one more extra slot");
    assert.equal(slotRoom({ holders, busyCpuPct: 31, now: NOW }, planOf({ extraSlotSettleSec: 0 })).extra, true);
});

test("slotRoom: refuses an extra slot while the CPU is at or above the threshold", () => {
    const holders = [ran(40), ran(25)];
    for (const busyCpuPct of [60, 60.2, 97]) {
        const room = slotRoom({ holders, busyCpuPct, now: NOW }, ROOMY);
        assert.deepEqual([room.max, room.extra], [2, false], String(busyCpuPct));
        assert.match(room.why, /^no extra slot: CPU \d+% busy now, extra slots only below 60%$/);
    }
});

test("slotRoom: refuses an extra slot when a job started within the settle window, also a nested run", () => {
    assert.deepEqual(slotRoom({ holders: [ran(40), ran(4)], busyCpuPct: 20, now: NOW }, ROOMY), {
        max: 2, extra: false, why: "no extra slot: a job started 4 s ago, extra slots wait 10 s after a start", waitMs: 6000,
    });
    // A job that has taken its slot but not started yet counts from when it took the slot.
    const justTaken = { label: "docs-site: build", at: NOW - 2000 };
    assert.equal(slotRoom({ holders: [ran(40), justTaken], busyCpuPct: 20, now: NOW }, ROOMY).extra, false);
    const nested = [{ startedAt: NOW - 3000 }, { waiting: true, at: NOW }];
    assert.equal(slotRoom({ holders: [ran(40), ran(30)], nested, busyCpuPct: 20, now: NOW }, ROOMY).extra, false);
    assert.equal(slotRoom({ holders: [ran(40), ran(30)], nested: nested.slice(1), busyCpuPct: 20, now: NOW }, ROOMY).extra, true,
        "a nested run that still waits has not started");
});

test("slotRoom: refuses an extra slot once maxSlots are taken, and when the CPU reading is unknown", () => {
    const full = [ran(90), ran(80), ran(70), ran(60)];
    assert.deepEqual(slotRoom({ holders: full, busyCpuPct: 5, now: NOW }, ROOMY), {
        max: 4, extra: false, why: "no extra slot: all 4 slots taken, extra ones included",
    });
    for (const busyCpuPct of [null, undefined, Number.NaN]) {
        assert.deepEqual(slotRoom({ holders: [ran(40), ran(30)], busyCpuPct, now: NOW }, ROOMY), {
            max: 2, extra: false, why: "no extra slot: the live CPU reading is unknown",
        });
    }
});

test("slotRoom: the base slots do not depend on the CPU, and maxSlots equal to slots turns extra slots off", () => {
    for (const busyCpuPct of [null, 99, 5]) {
        assert.deepEqual(slotRoom({ holders: [ran(1)], busyCpuPct, now: NOW }, ROOMY), { max: 2, extra: false, why: null });
        assert.deepEqual(slotRoom({ holders: [], busyCpuPct, now: NOW }, ROOMY), { max: 2, extra: false, why: null });
    }
    assert.deepEqual(slotRoom({ holders: [ran(90), ran(80)], busyCpuPct: 5, now: NOW }, planOf({ maxSlots: 2 })), { max: 2, extra: false, why: null });
});

test("extraInQuestion: only once the base slots are taken and maxSlots is not reached", () => {
    const jobs = (n) => Array.from({ length: n }, () => ran(40));
    assert.deepEqual([0, 1, 2, 3, 4, 5].map((n) => extraInQuestion(jobs(n), ROOMY)), [false, false, true, true, false, false]);
    assert.equal(extraInQuestion(jobs(2), planOf({ maxSlots: 2 })), false);
});

// A holder in the slot file of the given number.
const inSlot = (n, secondsAgo) => ({ ...ran(secondsAgo), file: `/state/slots/slot-${n}.json` });

test("slotRoom: a base slot freed while a job holds an extra slot is a base slot again, free of the CPU and settle checks", () => {
    // slot-0 ended; slot-1 runs, and slot-2 is an extra slot that started a moment ago.
    const holders = [inSlot(1, 40), inSlot(2, 1)];
    for (const busyCpuPct of [null, 99, 5]) {
        assert.deepEqual(slotRoom({ holders, busyCpuPct, now: NOW }, ROOMY), { max: 3, limit: 2, extra: false, why: null });
    }
    assert.equal(extraInQuestion(holders, ROOMY), false, "no live CPU reading is needed for it");
    assert.equal(extraInQuestion([inSlot(0, 40), inSlot(1, 30)], ROOMY), true);
    assert.equal(baseTaken([inSlot(0, 40), inSlot(3, 30), ran(9)], 2), 2, "a holder without a slot file counts as base");
});

test("slotRoom: says how long the settle time still holds an extra slot back", () => {
    assert.equal(slotRoom({ holders: [ran(40), ran(7.5)], busyCpuPct: 20, now: NOW }, ROOMY).waitMs, 2500);
    assert.equal("waitMs" in slotRoom({ holders: [ran(40), ran(7.5)], busyCpuPct: 70, now: NOW }, ROOMY), false,
        "only while the settle time alone holds it back");
});

test("startCrowded: a job in an extra slot gives it back when another job took a slot first inside the settle time", () => {
    const mine = "/state/slots/slot-2.json";
    const own = { label: "shop-api: lint", at: NOW, file: mine };
    // A --priority job took the base slot that freed a moment before this job took the extra one.
    const quick = { label: "docs-site: build", at: NOW - 200, file: "/state/slots/slot-0.json" };
    assert.equal(startCrowded({ holders: [quick, inSlot(1, 40), own], mine, now: NOW }, ROOMY), true);
    assert.equal(startCrowded({ holders: [{ ...quick, at: NOW + 50 }, inSlot(1, 40), own], mine, now: NOW }, ROOMY), false,
        "a job that took its slot later is the one to judge");
    assert.equal(startCrowded({ holders: [{ ...quick, at: NOW }, inSlot(1, 40), own], mine, now: NOW }, ROOMY), true,
        "a tie goes to the lower slot number");
    assert.equal(startCrowded({ holders: [inSlot(0, 40), inSlot(1, 30), own], mine, now: NOW }, ROOMY), false);
    const nested = [{ startedAt: NOW - 1000 }];
    assert.equal(startCrowded({ holders: [inSlot(0, 40), inSlot(1, 30), own], nested, mine, now: NOW }, ROOMY), true);
    const base = { ...own, file: "/state/slots/slot-0.json" };
    assert.equal(startCrowded({ holders: [quick, base], mine: base.file, now: NOW }, ROOMY), false, "a base slot is never given back");
});

test("gateBlocks: full slots say why no extra slot is given, and count the extra slots apart", () => {
    const holders = [ran(40, "shop-api: lint"), ran(4, "docs-site: build")];
    const room = slotRoom({ holders, busyCpuPct: 20, now: NOW }, ROOMY);
    assert.equal(gateReason({ holders, health: { ok: true, blocks: [] }, room, base: 2 }, room.max),
        'no free slot: 2 of 2 taken, by "shop-api: lint" and "docs-site: build"; '
            + "no extra slot: a job started 4 s ago, extra slots wait 10 s after a start");
    const three = [...holders, ran(2, "mobile-app: bundle")];
    const hot = slotRoom({ holders: three, busyCpuPct: 75, now: NOW }, ROOMY);
    assert.deepEqual(blockReason({ holders: three, health: null, room: hot, base: 2 }, hot.max), [{
        gate: "slots",
        text: 'no free slot: 3 taken (2 + 1 extra while the CPU has room), by "shop-api: lint" and "docs-site: build" and '
            + '"mobile-app: bundle"; no extra slot: CPU 75% busy now, extra slots only below 60%',
    }]);
    const open = slotRoom({ holders: [ran(40), ran(30)], busyCpuPct: 20, now: NOW }, ROOMY);
    assert.equal(gateReason({ holders: [ran(40), ran(30)], health: { ok: true, blocks: [] }, room: open, base: 2 }, open.max), "");
});

test("takenText: the plain count, or the base and extra slots apart", () => {
    assert.equal(takenText(1, 2), "1 of 2 taken");
    assert.equal(takenText(2, 2), "2 of 2 taken");
    assert.equal(takenText(3, 2), "3 taken (2 + 1 extra while the CPU has room)");
    assert.equal(takenText(5, 5, 2), "5 taken (2 + 3 extra while the CPU has room)");
});
