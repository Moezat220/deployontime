// Long timers. Node fires a timer longer than about 24 days after 1 ms, so a longer wait is made of several timers
// in a row.
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
