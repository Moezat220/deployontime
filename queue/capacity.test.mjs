import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTO_FLOOR, autoMax, capacityPlan, extraInQuestion, extraSlotVerdict, planFields, tooSoonAfter } from "./capacity.mjs";

const RULES = { extraSlotCpuPct: 60, extraSlotSettleSec: 10 };
const settings = (more = {}) => ({ slots: 2, maxSlots: null, ...RULES, ...more });
const NONE = { slots: false, maxSlots: false };

test("autoMax: half the cores, at least 2, and 2 for a count that is not a whole number of 1 or more", () => {
    assert.equal(AUTO_FLOOR, 2);
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 10, 16, 64].map(autoMax), [2, 2, 2, 2, 2, 3, 3, 5, 8, 32]);
    for (const odd of [0, -4, 2.5, NaN, null, undefined, "8"]) assert.equal(autoMax(odd), 2, String(odd));
});

test("capacityPlan: neither slots nor maxSlots set gives half the cores while the CPU has room", () => {
    assert.deepEqual(capacityPlan({ settings: settings(), userSet: NONE, cores: 12 }), {
        base: 2, max: 6, source: "cores", reason: "up to 6 while the CPU has room (half of 12 cores)",
        cores: 12, cpuPct: 60, settleSec: 10,
    });
    assert.deepEqual(planFields(capacityPlan({ settings: settings(), cores: 16 })), { base: 2, max: 8, source: "cores" },
        "no userSet counts as neither set");
});

test("capacityPlan: a small computer, 5 cores or fewer, has exactly the 2 default slots", () => {
    const reasons = [1, 2, 3, 4, 5].map((cores) => {
        const plan = capacityPlan({ settings: settings(), userSet: NONE, cores });
        assert.deepEqual(planFields(plan), { base: 2, max: 2, source: "cores" }, `${cores} cores`);
        return plan.reason;
    });
    assert.deepEqual(reasons, [
        "2, this computer has 1 core", "2, this computer has 2 cores", "2, this computer has 3 cores",
        "2, this computer has 4 cores", "2, this computer has 5 cores",
    ]);
    assert.equal(capacityPlan({ settings: settings(), userSet: NONE, cores: NaN }).reason, "2, the core count is unknown");
});

test("capacityPlan: slots set by the user without maxSlots is exactly that many, on any computer", () => {
    for (const cores of [1, 4, 10, 64]) {
        for (const slots of [1, 2, 3, 8]) {
            const plan = capacityPlan({ settings: settings({ slots }), userSet: { slots: true, maxSlots: false }, cores });
            assert.deepEqual([plan.base, plan.max, plan.source, plan.reason], [slots, slots, "slots", `${slots}, set in settings`]);
        }
    }
    // The same number as the default, set in the file, still wins over the cores.
    assert.equal(capacityPlan({ settings: settings({ slots: 2 }), userSet: { slots: true }, cores: 32 }).max, 2);
    // A maxSlots value that is not marked as set by the user plays no part.
    assert.equal(capacityPlan({ settings: settings({ slots: 3, maxSlots: 9 }), userSet: { slots: true }, cores: 32 }).max, 3);
});

test("capacityPlan: maxSlots set by the user is used as is, with or without slots", () => {
    const both = { slots: true, maxSlots: true };
    assert.deepEqual(capacityPlan({ settings: settings({ slots: 3, maxSlots: 6 }), userSet: both, cores: 4 }), {
        base: 3, max: 6, source: "maxSlots", reason: "up to 6 while the CPU has room (maxSlots set in settings)",
        cores: 4, cpuPct: 60, settleSec: 10,
    });
    const only = capacityPlan({ settings: settings({ maxSlots: 3 }), userSet: { slots: false, maxSlots: true }, cores: 64 });
    assert.deepEqual(planFields(only), { base: 2, max: 3, source: "maxSlots" });
    const same = capacityPlan({ settings: settings({ slots: 3, maxSlots: 3 }), userSet: both, cores: 64 });
    assert.deepEqual([same.max, same.source, same.reason], [3, "maxSlots", "3, set in settings"]);
    // Below slots, which loadSettings() never lets through, it is not used.
    const below = capacityPlan({ settings: settings({ slots: 4, maxSlots: 3 }), userSet: both, cores: 64 });
    assert.deepEqual(planFields(below), { base: 4, max: 4, source: "slots" });
});

test("capacityPlan: slots above half the cores, with nothing set, keeps slots as the most", () => {
    const plan = capacityPlan({ settings: settings({ slots: 6 }), userSet: NONE, cores: 8 });
    assert.deepEqual([plan.base, plan.max, plan.reason], [6, 6, "6, this computer has 8 cores"]);
});

const plan = capacityPlan({ settings: settings({ slots: 2, maxSlots: 4 }), userSet: { maxSlots: true }, cores: 8 });
const NOW = 1_000_000;

test("extraInQuestion: only once the base slots are taken and the most is not reached", () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5].map((taken) => extraInQuestion({ plan, taken })), [false, false, true, true, false, false]);
    assert.equal(extraInQuestion({ plan, taken: 3, baseTaken: 1 }), false, "a base slot is free");
    const small = capacityPlan({ settings: settings(), userSet: NONE, cores: 4 });
    assert.deepEqual([0, 1, 2, 3].map((taken) => extraInQuestion({ plan: small, taken })), [false, false, false, false]);
});

test("extraSlotVerdict: allowed below the CPU threshold once the settle time has passed", () => {
    assert.deepEqual(extraSlotVerdict({ plan, taken: 2, cpuBusyPct: 31.4, lastStartMs: NOW - 10_000, now: NOW }), {
        allowed: true, reason: "extra slot free while the CPU has room: CPU 31% busy now, below 60%",
    });
    assert.equal(extraSlotVerdict({ plan, taken: 3, cpuBusyPct: 59.9, lastStartMs: null, now: NOW }).allowed, true);
});

test("extraSlotVerdict: refused with the reason, and with waitMs while only the settle time holds it back", () => {
    const at = (more) => extraSlotVerdict({ plan, taken: 2, cpuBusyPct: 20, lastStartMs: NOW - 60_000, now: NOW, ...more });
    assert.deepEqual(at({ cpuBusyPct: 60 }), { allowed: false, reason: "no extra slot: CPU 60% busy now, extra slots only below 60%" });
    assert.deepEqual(at({ cpuBusyPct: null }), { allowed: false, reason: "no extra slot: the live CPU reading is unknown" });
    assert.deepEqual(at({ cpuBusyPct: NaN }), { allowed: false, reason: "no extra slot: the live CPU reading is unknown" });
    assert.deepEqual(at({ taken: 4 }), { allowed: false, reason: "no extra slot: all 4 slots taken, extra ones included" });
    assert.deepEqual(at({ lastStartMs: NOW - 7500 }), {
        allowed: false, reason: "no extra slot: a job started 7 s ago, extra slots wait 10 s after a start", waitMs: 2500,
    });
});

test("extraSlotVerdict: no reason while no extra slot is in question", () => {
    assert.deepEqual(extraSlotVerdict({ plan, taken: 1, cpuBusyPct: 5, now: NOW }), { allowed: false, reason: null });
    const off = capacityPlan({ settings: settings({ slots: 3 }), userSet: { slots: true }, cores: 64 });
    assert.deepEqual(extraSlotVerdict({ plan: off, taken: 3, cpuBusyPct: 5, now: NOW }), { allowed: false, reason: null });
});

test("extraSlotVerdict: works on the numbers of any computer, not this one", () => {
    const other = capacityPlan({ settings: settings({ extraSlotCpuPct: 40, extraSlotSettleSec: 0 }), userSet: NONE, cores: 32 });
    assert.deepEqual(planFields(other), { base: 2, max: 16, source: "cores" });
    assert.equal(extraSlotVerdict({ plan: other, taken: 15, cpuBusyPct: 39, lastStartMs: NOW, now: NOW }).allowed, true);
    assert.equal(extraSlotVerdict({ plan: other, taken: 15, cpuBusyPct: 40, lastStartMs: NOW, now: NOW }).allowed, false);
});

test("tooSoonAfter: inside the settle time of the plan, and never without a known start", () => {
    assert.equal(tooSoonAfter({ plan, lastStartMs: NOW - 9999, now: NOW }), true);
    assert.equal(tooSoonAfter({ plan, lastStartMs: NOW - 10_000, now: NOW }), false);
    assert.equal(tooSoonAfter({ plan, lastStartMs: null, now: NOW }), false);
});
