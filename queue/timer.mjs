// Long timers, and a sleep that can be ended early. Node fires a timer longer than about 24 days after 1 ms, so a
// longer wait is made of several timers in a row.
import { MINUTE } from "./units.mjs";

/** The longest wait one Node timer can hold, in ms. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** An unref'd timer measured in minutes. Returns a function that cancels it, also when the wait is made of several
 *  timers in a row. schedule and unschedule stand in for setTimeout and clearTimeout. */
export function afterMinutes(min, fn, schedule = setTimeout, unschedule = clearTimeout) {
    let current = null;
    const step = (ms) => {
        const next = () => (ms > MAX_TIMER_MS ? step(ms - MAX_TIMER_MS) : fn());
        current = schedule(next, Math.min(ms, MAX_TIMER_MS)).unref();
    };
    step(min * MINUTE);
    return () => unschedule(current);
}

/** An unref'd timer in ms. Returns a function that cancels it. */
export function afterMs(ms, fn) {
    const timer = setTimeout(fn, ms).unref();
    return () => clearTimeout(timer);
}

/** Wraps sleep(ms) so that wake() ends the current sleeps and makes every later one end at once. A sleep that has
 *  ended, either way, is dropped from the list of sleeps to wake, so many sleeps in a row keep nothing.
 *  pending() is the number of sleeps that have not ended. */
export function wakeableSleep(sleep) {
    const sleeping = new Set();
    let woken = false;
    return {
        sleep(ms) {
            if (woken) return Promise.resolve();
            return new Promise((resolve) => {
                const finish = () => { if (sleeping.delete(finish)) resolve(); };
                sleeping.add(finish);
                sleep(ms).then(finish);
            });
        },
        wake() {
            woken = true;
            for (const finish of [...sleeping]) finish();
        },
        pending: () => sleeping.size,
    };
}
