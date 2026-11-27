// The gate policy: who may take a free slot, what keeps a waiting job out, and when a waiting job gives up. It only
// judges the slots, the line and a health verdict it is handed; slots.mjs keeps the files. max is the slot count.
// slotRoom() says how many slots may be filled right now: the base slots always, and an extra one while the CPU has
// room for it. The base slots are the slot files numbered below settings.slots; the others are extra slots.
import { slotNumber } from "./slots.mjs";
import { MINUTE } from "./units.mjs";

/** How many holders are in base slots. A holder without a slot file name counts as one in a base slot. */
export const baseTaken = (holders, slots) => holders.filter((h) => !(slotNumber(h.file) >= slots)).length;

/** True when the base slots are all taken and an extra slot is left, so the live CPU reading decides. holders: the
 *  slot holders as snapshot() gives them. settings: { slots, maxSlots }. */
export const extraInQuestion = (holders, { slots, maxSlots }) =>
    baseTaken(holders, slots) >= slots && holders.length < maxSlots;

/** The newest start among the slot holders and the running nested runs, in ms, or null when there is none. */
function lastStart(holders, nested) {
    const starts = [...holders.map((h) => h.startedAt ?? h.at), ...nested.filter((n) => !n.waiting).map((n) => n.startedAt)];
    const known = starts.filter(Number.isFinite);
    return known.length ? Math.max(...known) : null;
}

/** How many slots may be filled now. Returns { max, extra, why }: max is the slot count for decide() and gateBlocks();
 *  extra is true when the next slot to be taken is an extra one; why says why an extra slot is or is not given, or is
 *  null while a base slot is free or extra slots are turned off. An extra slot, beyond settings.slots and up to
 *  settings.maxSlots, is given only while the live CPU reading (busyCpuPct) is known and below
 *  settings.extraSlotCpuPct, and no job has started in the last settings.extraSlotSettleSec seconds. The health gate
 *  is judged apart from this and applies to every slot. A base slot that is free while jobs hold extra slots is
 *  taken as a base slot: the answer then also carries limit, the number of slots takeSlot() may look at, so only a
 *  base slot is claimed. While only the settle time holds an extra slot back, the answer carries waitMs, the time
 *  until it has passed. */
export function slotRoom({ holders, nested = [], busyCpuPct = null, now }, settings) {
    const { slots, maxSlots, extraSlotCpuPct: cpuPct, extraSlotSettleSec: settleSec } = settings;
    const taken = holders.length;
    const refuse = (why, more = {}) => ({ max: Math.min(taken, maxSlots), extra: false, why: `no extra slot: ${why}`, ...more });
    if (taken < slots || maxSlots <= slots) return { max: slots, extra: false, why: null };
    if (baseTaken(holders, slots) < slots) return { max: taken + 1, limit: slots, extra: false, why: null };
    if (taken >= maxSlots) return refuse(`all ${maxSlots} slots taken, extra ones included`);
    if (!Number.isFinite(busyCpuPct)) return refuse("the live CPU reading is unknown");
    const cpu = `CPU ${Math.round(busyCpuPct)}% busy now`;
    if (busyCpuPct >= cpuPct) return refuse(`${cpu}, extra slots only below ${cpuPct}%`);
    const last = lastStart(holders, nested);
    const since = last === null ? Infinity : (now - last) / 1000;
    if (since < settleSec) {
        const why = `a job started ${Math.max(0, Math.floor(since))} s ago, extra slots wait ${settleSec} s after a start`;
        return refuse(why, { waitMs: Math.ceil((settleSec - since) * 1000) });
    }
    return { max: taken + 1, extra: true, why: `extra slot free while the CPU has room: ${cpu}, below ${cpuPct}%` };
}

/** True when a job that just took an extra slot, one numbered settings.slots or higher, must give it back: another
 *  job started within settings.extraSlotSettleSec seconds and not after it. That other job is a slot holder that
 *  claimed its slot first, or a nested run that started first. So two jobs that waited at the same moment, such as
 *  a --priority job that took a base slot as one freed and a job that took an extra slot, never both start inside
 *  the settle time with one of them beyond the base slots: the one in the extra slot waits. state: { holders, nested,
 *  mine, now }, holders and nested as snapshot() gives them, mine the file of the slot just taken. A tie on the
 *  claim time goes to the lower slot number. */
export function startCrowded({ holders, nested = [], mine, now }, { slots, extraSlotSettleSec: settleSec }) {
    const own = holders.find((h) => h.file === mine);
    if (!own || !(slotNumber(own.file) >= slots)) return false;
    const first = (h) => h.at < own.at || (h.at === own.at && slotNumber(h.file) < slotNumber(own.file));
    const before = holders.filter((h) => h !== own && first(h));
    const nestedBefore = nested.filter((n) => !n.waiting && n.startedAt <= own.at);
    const last = lastStart(before, nestedBefore);
    return last !== null && (now - last) / 1000 < settleSec;
}

/** Returns { go, position }: go when this pid is first in line and a slot is free. */
export function decide({ holders, queue }, pid, max) {
    const index = queue.findIndex((ticket) => ticket.pid === pid);
    const position = index < 0 ? queue.length + 1 : index + 1;
    return { go: position === 1 && index === 0 && holders.length < max, position };
}

/** "2 of 2 taken", or "3 taken (2 + 1 extra while the CPU has room)" while jobs hold extra slots. base: the base slot
 *  count, max when not given. */
export function takenText(taken, max, base = max) {
    if (taken <= base) return `${taken} of ${max} taken`;
    return `${taken} taken (${base} + ${taken - base} extra while the CPU has room)`;
}

/** Everything that keeps a new job from starting, as [{ gate, text }]. ahead = waiters in front of the caller. room,
 *  when given, is the slotRoom() answer, and max is its max: full slots then also say why no extra slot is given. */
export function gateBlocks({ holders, health, ahead = 0, room = null, base }, max) {
    const blocks = [];
    if (holders.length >= max) {
        const names = holders.map((h) => `"${h.label}"`).join(" and ");
        const why = room?.why ? `; ${room.why}` : "";
        blocks.push({ gate: "slots", text: `no free slot: ${takenText(holders.length, max, base)}, by ${names}${why}` });
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
