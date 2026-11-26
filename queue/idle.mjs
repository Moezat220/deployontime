// Idle detection from CPU samples. A dev-server group that used almost no CPU over the idle window may be stopped
// by the reaper; a job that holds a slot without using CPU only earns a notice. A sample is { t, cpu }, where cpu is
// the summed CPU seconds of the whole group, and samples are ordered oldest first.
import { loadSettings } from "./settings.mjs";
import { MINUTE } from "./units.mjs";


// Commands that run tests once and exit; they are never dev servers.
export const TEST_RUN_RE = /\bvitest (--)?run\b|\bnode --test\b|playwright test|jest(?!.*--watch)/;

export function isServer(command, pattern = loadSettings().reaper.serverPattern) {
    let matcher;
    try { matcher = new RegExp(pattern); } catch { return false; }
    return matcher.test(command) && !TEST_RUN_RE.test(command);
}

// marginMin: how much longer than the idle window samples are kept. bandMin: how far past the window the older
// sample of a server comparison may lie. toleranceMs: how much short of the window a slot comparison may fall,
// because a scheduler never fires exactly on time.
export const SAMPLING = { marginMin: 25, bandMin: 15, toleranceMs: 30_000 };
/** How long samples are kept for an idle window of the given length. */
export const sampleKeepMs = (windowMin, sampling = SAMPLING) => (windowMin + sampling.marginMin) * MINUTE;

/** Cuts the samples at the last decrease of the CPU total. A total only decreases when a process exits and its
 *  time drops out of the sum, so samples from before that cannot be compared with later ones. */
export function sinceReset(samples) {
    let start = 0;
    for (let i = 1; i < samples.length; i++) if (samples[i].cpu < samples[i - 1].cpu) start = i;
    return samples.slice(start);
}

/** CPU use and time span as a phrase: "1.5 s of CPU in 12 min". */
export const idleText = ({ usedS, minutes }) => `${usedS.toFixed(1)} s of CPU in ${minutes} min`;

/** Returns { idle, state, usedS?, minutes? } with state one of protected, new, sampling, restarted, active, idle. */
export function serverIdleVerdict({ ageMs, samples, now, exempt }, idle = loadSettings().idle, sampling = SAMPLING) {
    const windowMs = idle.serverIdleMin * MINUTE;
    if (exempt) return { idle: false, state: "protected" };
    if (ageMs < windowMs) return { idle: false, state: "new" };
    const usable = sinceReset(samples), newest = usable.at(-1);
    const older = usable.find((s) => now - s.t >= windowMs && now - s.t < windowMs + sampling.bandMin * MINUTE);
    if (!older || !newest) return { idle: false, state: usable.length < samples.length ? "restarted" : "sampling" };
    const usedS = newest.cpu - older.cpu, minutes = Math.round((now - older.t) / MINUTE);
    return usedS < idle.serverCpuS ? { idle: true, state: "idle", usedS, minutes } : { idle: false, state: "active", usedS, minutes };
}

/** The same question for a job in a slot. Returns { idle, state, usedS?, minutes?, since? } with state new, sampling,
 *  restarted, active or idle. */
export function slotIdleVerdict({ startedAt, samples, now }, idle = loadSettings().idle, sampling = SAMPLING) {
    const windowMs = idle.slotIdleMin * MINUTE;
    if (now - startedAt < windowMs) return { idle: false, state: "new" };
    const usable = sinceReset(samples), newest = usable.at(-1);
    const older = usable.findLast((s) => now - s.t >= windowMs - sampling.toleranceMs);
    if (!older || !newest || older === newest) return { idle: false, state: usable.length < samples.length ? "restarted" : "sampling" };
    const usedS = Math.round((newest.cpu - older.cpu) * 10) / 10, minutes = Math.round((now - older.t) / MINUTE);
    return usedS < idle.slotCpuS ? { idle: true, state: "idle", usedS, minutes, since: older.t } : { idle: false, state: "active", usedS, minutes };
}
