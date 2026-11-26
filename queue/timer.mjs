// Long timers, and a sleep that can be ended early. Node fires a timer longer than about 24 days after 1 ms, so a
// longer wait is made of several timers in a row.
import { MINUTE } from "./units.mjs";

/** The longest wait one Node timer can hold, in ms. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

function longTimer(fn, ms, schedule) {
    const step = Math.min(ms, MAX_TIMER_MS);
    return schedule(() => (ms > MAX_TIMER_MS ? longTimer(fn, ms - MAX_TIMER_MS, schedule) : fn()), step).unref();
}

/** An unref'd timer measured in minutes; past about 24 days only its first part can be cleared. schedule stands in
 *  for setTimeout. */
export function afterMinutes(min, fn, schedule = setTimeout) {
    return longTimer(fn, min * MINUTE, schedule);
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
