// Long timers. Node fires a timer longer than about 24 days after 1 ms, so a longer wait is made of several timers
// in a row.
import { isSandbox } from "./settings.mjs";
import { readFileSync } from "node:fs";
import { MINUTE } from "./units.mjs";

/** The longest wait one Node timer can hold, in ms. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

function longTimer(fn, ms) {
    const step = Math.min(ms, MAX_TIMER_MS);
    return setTimeout(() => (ms > MAX_TIMER_MS ? longTimer(fn, ms - MAX_TIMER_MS) : fn()), step).unref();
}

/** An unref'd timer measured in minutes; past about 24 days only its first part can be cleared. Tests can drive it:
 *  with a sandbox state folder and DOTIME_FAKE_CLOCK set, the elapsed minutes are polled from the file that variable
 *  names. */
export function afterMinutes(min, fn, env = process.env) {
    const fakeClock = env.DOTIME_FAKE_CLOCK && isSandbox(env) ? env.DOTIME_FAKE_CLOCK : null;
    if (!fakeClock) return longTimer(fn, min * MINUTE);
    const poll = setInterval(() => {
        let passed = 0;
        try { passed = Number(readFileSync(fakeClock, "utf8")) || 0; } catch { /* no file yet */ }
        if (passed >= min) {
            clearInterval(poll);
            fn();
        }
    }, 50);
    return poll.unref();
}
