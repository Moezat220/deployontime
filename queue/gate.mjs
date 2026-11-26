// The gate policy: who may take a free slot, what keeps a waiting job out, and when a waiting job gives up. It only
// judges the slots, the line and a health verdict it is handed; slots.mjs keeps the files.
import { loadSettings } from "./settings.mjs";
import { MINUTE } from "./units.mjs";

/** Returns { go, position }: go when this pid is first in line and a slot is free. */
export function decide({ holders, queue }, pid, max = loadSettings().slots) {
    const index = queue.findIndex((ticket) => ticket.pid === pid);
    const position = index < 0 ? queue.length + 1 : index + 1;
    return { go: position === 1 && index === 0 && holders.length < max, position };
}

/** Everything that keeps a new job from starting, as [{ gate, text }]. ahead = waiters in front of the caller. */
export function gateBlocks({ holders, health, ahead = 0 }, max = loadSettings().slots) {
    const blocks = [];
    if (holders.length >= max) {
        const names = holders.map((h) => `"${h.label}"`).join(" and ");
        blocks.push({ gate: "slots", text: `no free slot: ${holders.length} of ${max} taken, by ${names}` });
    }
    if (health && !health.ok) blocks.push(...health.blocks);
    if (!blocks.length && ahead > 0) blocks.push({ gate: "line", text: `not first in line: ${ahead} ahead` });
    return blocks;
}
export const blockText = (blocks) => blocks.map((b) => b.text).join("; ");
/** The same as one sentence; "" when a job could start now. */
export const gateReason = (state, max) => blockText(gateBlocks(state, max));

/** The blocks a waiter's time is booked to: full slots alone, else the health gate, else the line in front. */
export function blockReason({ holders, health, ahead = 0 }, max = loadSettings().slots) {
    if (holders.length >= max) return gateBlocks({ holders, health: null }, max);
    if (health && !health.ok) return health.blocks;
    return gateBlocks({ holders, health: null, ahead }, max);
}

/** maxWaitMin of 0 means no limit. */
export function shouldGiveUp({ startedAt, now, maxWaitMin }) {
    return maxWaitMin > 0 && now - startedAt >= maxWaitMin * MINUTE;
}
