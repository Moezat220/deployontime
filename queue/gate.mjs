// The gate policy: who may take a free slot, what keeps a waiting job out, and when a waiting job gives up. It only
// judges the slots, the line and a health verdict it is handed; slots.mjs keeps the files. max is the slot count.
// slotRoom() says how many slots may be filled right now, as capacity.mjs decides from the plan: the base slots
// always, and an extra one while the CPU has room for it. The base slots are the slot files numbered below
// plan.base; the others are extra slots.
import { extraInQuestion as extraAsked, extraSlotVerdict, tooSoonAfter } from "./capacity.mjs";
import { slotNumber } from "./slots.mjs";
import { MINUTE } from "./units.mjs";

/** True when the holder is in an extra slot: its slot file is numbered base or higher. A holder without a slot file
 *  name counts as one in a base slot. */
export const inExtraSlot = (holder, base) => slotNumber(holder.file) >= base;

/** How many holders are in base slots. */
export const baseTaken = (holders, base) => holders.filter((h) => !inExtraSlot(h, base)).length;

/** True when the base slots are all taken and an extra slot is left, so the live CPU reading decides. holders: the
 *  slot holders as snapshot() gives them. plan: from capacityPlan(). */
export const extraInQuestion = (holders, plan) =>
    extraAsked({ plan, taken: holders.length, baseTaken: baseTaken(holders, plan.base) });

/** The newest start among the slot holders and the running nested runs, in ms, or null when there is none. A holder
 *  that has claimed its slot but not started yet counts as starting now: an isolated run first makes its worktree,
 *  which can take longer than the settle time. */
function lastStart(holders, nested, now) {
    const starts = [...holders.map((h) => h.startedAt ?? now), ...nested.filter((n) => !n.waiting).map((n) => n.startedAt)];
    const known = starts.filter(Number.isFinite);
    return known.length ? Math.max(...known) : null;
}

// What slotRoom() says of an extra slot when the live CPU reading was left out on purpose.
export const NOT_JUDGED = "an extra slot is judged on the live CPU reading once a job waits";

/** How many slots may be filled now. Returns { max, extra, why }: max is the slot count for decide() and gateBlocks();
 *  extra is true when the next slot to be taken is an extra one; why says why an extra slot is or is not given, or is
 *  null while a base slot is free or the plan has no extra slots. extraSlotVerdict() decides on an extra slot, from
 *  the live CPU reading (busyCpuPct) and the newest start among the holders and nested runs. The health gate is
 *  judged apart from this and applies to every slot. A base slot that is free while jobs hold extra slots is taken
 *  as a base slot: the answer then also carries limit, the number of slots takeSlot() may look at, so only a base
 *  slot is claimed. While only the settle time holds an extra slot back, the answer carries waitMs, the time until
 *  it has passed. cpuAsked: false when the live CPU reading was left out on purpose, as `status` does while nobody
 *  waits; an extra slot that is in question is then neither given nor refused, and why says so. plan: from
 *  capacityPlan(). */
export function slotRoom({ holders, nested = [], busyCpuPct = null, cpuAsked = true, now }, plan) {
    const { base } = plan;
    const taken = holders.length;
    if (taken < base || plan.max <= base) return { max: base, extra: false, why: null };
    if (baseTaken(holders, base) < base) return { max: taken + 1, limit: base, extra: false, why: null };
    if (!cpuAsked && taken < plan.max) return { max: taken, extra: false, why: NOT_JUDGED };
    const verdict = extraSlotVerdict({ plan, taken, cpuBusyPct: busyCpuPct, lastStartMs: lastStart(holders, nested, now), now });
    if (!verdict.allowed) {
        const wait = verdict.waitMs ? { waitMs: verdict.waitMs } : {};
        return { max: Math.min(taken, plan.max), extra: false, why: verdict.reason, ...wait };
    }
    return { max: taken + 1, extra: true, why: verdict.reason };
}

/** True when a job that just took an extra slot, one numbered plan.base or higher, must give it back: another job
 *  started within the settle time of the plan and not after it. That other job is a slot holder that claimed its
 *  slot first, or a nested run that started first. So two jobs that waited at the same moment, such as a --priority
 *  job that took a base slot as one freed and a job that took an extra slot, never both start inside the settle
 *  time with one of them beyond the base slots: the one in the extra slot waits. state: { holders, nested, mine,
 *  now }, holders and nested as snapshot() gives them, mine the file of the slot just taken. A tie on the claim time
 *  goes to the lower slot number. */
export function startCrowded({ holders, nested = [], mine, now }, plan) {
    const own = holders.find((h) => h.file === mine);
    if (!own || !(slotNumber(own.file) >= plan.base)) return false;
    const first = (h) => h.at < own.at || (h.at === own.at && slotNumber(h.file) < slotNumber(own.file));
    const before = holders.filter((h) => h !== own && first(h));
    const nestedBefore = nested.filter((n) => !n.waiting && n.startedAt <= own.at);
    return tooSoonAfter({ plan, lastStartMs: lastStart(before, nestedBefore, now), now });
}

/** Returns { go, position }: go when this pid is first in line and a slot is free. */
export function decide({ holders, queue }, pid, max) {
    const index = queue.findIndex((ticket) => ticket.pid === pid);
    const position = index < 0 ? queue.length + 1 : index + 1;
    return { go: position === 1 && index === 0 && holders.length < max, position };
}

/** "2 of 2 taken", or "3 taken (2 of 2 base, 1 extra)" while jobs hold extra slots, counted by slot file as
 *  inExtraSlot() does, so a base slot that is free while jobs hold extra slots shows as free. base: the base slot
 *  count. */
export function takenText(holders, base) {
    const taken = holders.length, extra = taken - baseTaken(holders, base);
    return extra ? `${taken} taken (${taken - extra} of ${base} base, ${extra} extra)` : `${taken} of ${base} taken`;
}

/** Everything that keeps a new job from starting, as [{ gate, text }]. ahead = waiters in front of the caller. room,
 *  when given, is the slotRoom() answer, and max is its max: full slots then also say why no extra slot is given. */
export function gateBlocks({ holders, health, ahead = 0, room = null, base }, max) {
    const blocks = [];
    if (holders.length >= max) {
        const names = holders.map((h) => `"${h.label}"`).join(" and ");
        const why = room?.why ? `; ${room.why}` : "";
        blocks.push({ gate: "slots", text: `no free slot: ${takenText(holders, base ?? max)}, by ${names}${why}` });
    }
    if (health && !health.ok) blocks.push(...health.blocks);
    if (!blocks.length && ahead > 0) blocks.push({ gate: "line", text: `not first in line: ${ahead} ahead` });
    return blocks;
}
export const blockText = (blocks) => blocks.map((b) => b.text).join("; ");
/** The same as one sentence; "" when a job could start now. */
export const gateReason = (state, max) => blockText(gateBlocks(state, max));

/** The blocks a waiter's time is booked to: full slots alone, else the health gate, else the line in front. */
export function blockReason({ holders, health, ahead = 0, room = null, base }, max) {
    if (holders.length >= max) return gateBlocks({ holders, health: null, room, base }, max);
    if (health && !health.ok) return health.blocks;
    return gateBlocks({ holders, health: null, ahead }, max);
}

/** maxWaitMin of 0 means no limit. */
export function shouldGiveUp({ startedAt, now, maxWaitMin }) {
    return maxWaitMin > 0 && now - startedAt >= maxWaitMin * MINUTE;
}
