import "./testkit.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { until } from "./testkit.mjs";
import { afterMinutes, afterMs, MAX_TIMER_MS, wakeableSleep } from "./timer.mjs";

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

test("afterMinutes: the function it returns cancels the wait, also after the first of several timers fired", () => {
    const timers = manualTimers(), cleared = [];
    let calls = 0;
    const cancel = afterMinutes(99_999, () => calls++, timers.schedule, (timer) => cleared.push(timer));
    timers.fireNext();
    cancel();
    assert.deepEqual([cleared, calls], [[timers.set[1]], 0], "the timer now waiting is the one cleared");
});

test("afterMs: fires once on a real timer unless it is cancelled first", async () => {
    let fired = 0, cancelledFired = 0;
    afterMs(1, () => fired++);
    afterMs(1, () => cancelledFired++)();
    await until(() => fired === 1, 2000);
    await new Promise((done) => setTimeout(done, 20));
    assert.deepEqual([fired, cancelledFired], [1, 0]);
});

test("wakeableSleep: a sleep that ended is no longer kept, so many polls leave nothing pending", async () => {
    const sleeps = wakeableSleep(() => Promise.resolve());
    for (let i = 0; i < 1000; i++) {
        await sleeps.sleep(3000);
        assert.equal(sleeps.pending(), 0);
    }
});

test("wakeableSleep: wake() ends the sleep under way, and every later sleep ends at once", async () => {
    const never = () => new Promise(() => {});
    const sleeps = wakeableSleep(never);
    const first = sleeps.sleep(3000);
    assert.equal(sleeps.pending(), 1);
    sleeps.wake();
    await first;
    assert.equal(sleeps.pending(), 0);
    await sleeps.sleep(3000);
    assert.equal(sleeps.pending(), 0);
});
