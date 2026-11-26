import "./testkit.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { until } from "./testkit.mjs";
import { afterMinutes, MAX_TIMER_MS } from "./timer.mjs";

// Stands in for setTimeout: keeps each timer so the test fires it by hand.
function manualTimers() {
    const set = [];
    const schedule = (fn, ms) => {
        const timer = { fn, ms, unref: () => timer };
        set.push(timer);
        return timer;
    };
    return { set, schedule, fireNext: () => set.at(-1).fn() };
}

test("afterMinutes: a short wait fires once on a real timer", async () => {
    let calls = 0;
    afterMinutes(0.001, () => calls++);
    await until(() => calls === 1, 2000);
    assert.equal(calls, 1);
});

test("afterMinutes: a wait longer than one timer can hold is made of timers in a row and fires only at the end", () => {
    const timers = manualTimers();
    let calls = 0;
    afterMinutes(99_999, () => calls++, timers.schedule);
    const total = 99_999 * 60_000;
    assert.deepEqual(timers.set.map((t) => t.ms), [MAX_TIMER_MS]);
    timers.fireNext();
    timers.fireNext();
    assert.deepEqual([calls, timers.set.map((t) => t.ms)], [0, [MAX_TIMER_MS, MAX_TIMER_MS, total - 2 * MAX_TIMER_MS]]);
    timers.fireNext();
    assert.equal(calls, 1);
});
