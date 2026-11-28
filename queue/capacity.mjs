// Capacity: how many jobs a computer may run at once, and whether one more may start beyond the base slots. It is
// pure: every input is a number or a plain object handed in, and nothing here reads a file, the clock or this
// process, so the same answers hold for any computer whose numbers are known.
//
// A plan has the base slots, which are always there, and a maximum. Slots beyond the base, up to the maximum, are
// extra slots: one is given only while the live CPU reading shows room and no job has just started. Where the
// maximum comes from, in this order:
//   - maxSlots set by the user: that number;
//   - slots set by the user and maxSlots not: exactly slots, so no extra slots;
//   - neither: half the cores, at least 2, and never below slots. With 5 cores or fewer that is 2, so no extra slots.

/** The fewest slots the automatic maximum gives, the default of slots. */
export const AUTO_FLOOR = 2;

/** The automatic maximum for a core count: half the cores, at least AUTO_FLOOR. A count that is not a whole number
 *  of 1 or more gives AUTO_FLOOR. */
export const autoMax = (cores) => (Number.isInteger(cores) && cores >= 1 ? Math.max(AUTO_FLOOR, Math.floor(cores / 2)) : AUTO_FLOOR);

const coresText = (cores) => `${cores} core${cores === 1 ? "" : "s"}`;

/** The capacity plan. settings: { slots, maxSlots, extraSlotCpuPct, extraSlotSettleSec }, as loadSettings() gives
 *  them; maxSlots counts only when userSet.maxSlots is true. userSet: { slots, maxSlots }, true for each one the
 *  user's settings file sets, as loadSettings() tells. cores: the core count of the computer the plan is for.
 *  Returns { base, max, source, reason, cores, cpuPct, settleSec }: base the base slots, max the most slots with
 *  extra ones, source "maxSlots", "slots" or "cores" for where max comes from, reason a few words on it for
 *  `status`, and cpuPct and settleSec the extra-slot rules, for extraSlotVerdict(). */
export function capacityPlan({ settings, userSet = {}, cores }) {
    const base = settings.slots;
    const rules = { cores, cpuPct: settings.extraSlotCpuPct, settleSec: settings.extraSlotSettleSec };
    const plan = (max, source, reason) => ({ base, max, source, reason, ...rules });
    const extra = (max, why) => `up to ${max} while the CPU has room (${why})`;
    if (userSet.maxSlots && Number.isInteger(settings.maxSlots) && settings.maxSlots >= base) {
        const max = settings.maxSlots;
        return plan(max, "maxSlots", max > base ? extra(max, "maxSlots set in settings") : `${max}, set in settings`);
    }
    if (userSet.slots) return plan(base, "slots", `${base}, set in settings`);
    const known = Number.isInteger(cores) && cores >= 1;
    const max = Math.max(base, autoMax(cores));
    if (max > base) return plan(max, "cores", extra(max, `half of ${coresText(cores)}`));
    return plan(base, "cores", known ? `${base}, this computer has ${coresText(cores)}` : `${base}, the core count is unknown`);
}

/** True when the base slots are all taken and an extra slot is left, so the live CPU reading decides whether the
 *  next job may start. taken: the jobs in slots. baseTaken: those in base slots, taken when not given. */
export const extraInQuestion = ({ plan, taken, baseTaken = taken }) => baseTaken >= plan.base && taken < plan.max;

/** Whether the next job may take an extra slot. plan: from capacityPlan(). taken: the jobs in slots. cpuBusyPct: the
 *  live CPU reading in percent, or null when it is unknown. lastStartMs: the newest start of a job in ms, or null
 *  when none is known. now: the time in ms. Returns { allowed, reason }, and waitMs while only the settle time holds
 *  the slot back: the time until it has passed. reason is null while no extra slot is in question: a base slot is
 *  free or the plan has no extra slots. */
export function extraSlotVerdict({ plan, taken, cpuBusyPct = null, lastStartMs = null, now }) {
    const { base, max, cpuPct, settleSec } = plan;
    if (max <= base || taken < base) return { allowed: false, reason: null };
    const refuse = (why, more = {}) => ({ allowed: false, reason: `no extra slot: ${why}`, ...more });
    if (taken >= max) return refuse(`all ${max} slots taken, extra ones included`);
    if (!Number.isFinite(cpuBusyPct)) return refuse("the live CPU reading is unknown");
    const cpu = `CPU ${Math.round(cpuBusyPct)}% busy now`;
    if (cpuBusyPct >= cpuPct) return refuse(`${cpu}, extra slots only below ${cpuPct}%`);
    const since = Number.isFinite(lastStartMs) ? (now - lastStartMs) / 1000 : Infinity;
    if (since < settleSec) {
        const why = `a job started ${Math.max(0, Math.floor(since))} s ago, extra slots wait ${settleSec} s after a start`;
        return refuse(why, { waitMs: Math.ceil((settleSec - since) * 1000) });
    }
    return { allowed: true, reason: `extra slot free while the CPU has room: ${cpu}, below ${cpuPct}%` };
}

/** True when two starts are inside the settle time of the plan: one at lastStartMs, the other at now. */
export const tooSoonAfter = ({ plan, lastStartMs, now }) => Number.isFinite(lastStartMs) && (now - lastStartMs) / 1000 < plan.settleSec;

/** The fields `queue_status` carries: { base, max, source }. */
export const planFields = ({ base, max, source }) => ({ base, max, source });
