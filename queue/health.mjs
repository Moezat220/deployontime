// The health gate. A new job may start only while load, free memory, free disk and battery are inside their limits.
// healthVerdict() judges a reading and names each failed limit; readHealth() takes the reading; cachedHealth()
// shares one reading between jobs that wait at the same time. The 1-minute load lags behind: it stays high for a while
// after heavy work has ended. So a high load holds a job only while the CPU is also busy right now.
import {
    cpuBusyPct, pause, probeCpuTimes, probeDiskFreeGB, probeLoad, probeMemoryFreePct, probePowerText, validCpuTimes,
} from "./probes.mjs";
import { dropOldTemps, readJson, writeJsonAtomic } from "./files.mjs";
import { DEFAULTS } from "./settings.mjs";

/** Returns { ok, blocks: [{ gate, text }] }. A reading of null is unknown and passes; 0 is a real value. limits:
 *  the health settings. A load above its limit holds a job unless the live CPU reading (busyCpuPct) is known and
 *  below limits.busyCpuPct; limits without busyCpuPct use the default. */
export function healthVerdict({ load, cores, busyCpuPct = null, freePct, diskGB, battery = null }, limits) {
    const blocks = [];
    const loadCap = cores * limits.loadPerCore;
    const cpuKnown = Number.isFinite(busyCpuPct);
    if (load > loadCap && (!cpuKnown || busyCpuPct >= (limits.busyCpuPct ?? DEFAULTS.health.busyCpuPct))) {
        const cpu = cpuKnown ? `; CPU ${Math.round(busyCpuPct)}% busy now` : "";
        const text = `load too high: ${load.toFixed(1)} now, ${loadCap.toFixed(1)} allowed${cpu}`;
        blocks.push({ gate: "load", text });
    }
    if (freePct != null && freePct < limits.minFreeMemPct) {
        blocks.push({ gate: "memory", text: `memory too low: ${freePct}% free, ${limits.minFreeMemPct}% needed` });
    }
    if (diskGB != null && diskGB < limits.minFreeDiskGB) {
        const text = `disk too low: ${diskGB.toFixed(1)} GB free, ${limits.minFreeDiskGB} GB needed`;
        blocks.push({ gate: "disk", text });
    }
    if (battery?.onBattery === true && Number.isFinite(battery.pct) && battery.pct <= limits.minBatteryPct) {
        const supply = battery.plugged ? "plugged in but still draining" : "not plugged in";
        const text = `battery too low: ${battery.pct}% left, more than ${limits.minBatteryPct}% needed, ${supply}`;
        blocks.push({ gate: "battery", text });
    }
    return { ok: blocks.length === 0, blocks };
}

/** Parses `pmset -g batt` output into { ac: true | false | null, pct, charge }. */
export function parsePower(text) {
    const report = String(text ?? "");
    const source = report.match(/Now drawing from '([^']+)'/)?.[1], level = report.match(/(\d{1,3})%;/)?.[1];
    return {
        ac: source ? source === "AC Power" : null,
        pct: level == null ? null : Number(level),
        charge: report.match(/\d{1,3}%;\s*([^;\n]+)/)?.[1].trim() ?? null,
    };
}

/** Returns { onBattery: true | false | null, plugged }. A plugged-in computer that still loses charge counts as on
 *  battery. */
export function powerState(power) {
    if (power?.ac === false) return { onBattery: true, plugged: false };
    if (power?.ac !== true) return { onBattery: null, plugged: false };
    return { onBattery: power.charge === "discharging", plugged: true };
}

/** The battery reading for the gate, or null when it is unknown. */
export function readBattery(probe = probePowerText) {
    try {
        const power = parsePower(probe());
        const state = powerState(power);
        if (state.onBattery == null || power.pct == null) return null;
        return { onBattery: state.onBattery, pct: power.pct, plugged: state.plugged };
    } catch { return null; }
}

/** The oldest shared reading a job may start on, whatever the poll time. */
export const MAX_SHARED_READING_MS = 5000;

/** The shortest span of saved CPU times a live CPU reading is measured over. */
export const MIN_CPU_SPAN_MS = 500;

/** The span a live CPU reading of its own is measured over, when no usable CPU times were saved. */
export const OWN_CPU_SPAN_MS = 1000;

/** CPU times now, or null when they cannot be read. */
function cpuTimesNow(read) {
    try { return read.cpuTimes(); } catch { return null; }
}

/** { busyCpuPct, cpuTimes }: the live CPU reading and the CPU times it ended on. Valid saved CPU times (since) up to
 *  MAX_SHARED_READING_MS old are measured against: at once when they are at least MIN_CPU_SPAN_MS old, after waiting
 *  the rest of MIN_CPU_SPAN_MS when they are younger. Otherwise the reading waits OWN_CPU_SPAN_MS between two
 *  snapshots of its own. */
function busyCpuNow(since, read) {
    let times = cpuTimesNow(read);
    const age = times?.at - since?.at;
    if (validCpuTimes(since?.cpus) && age >= 0 && age <= MAX_SHARED_READING_MS) {
        if (age < MIN_CPU_SPAN_MS) {
            read.wait(MIN_CPU_SPAN_MS - age);
            times = cpuTimesNow(read);
        }
        const busyCpuPct = cpuBusyPct(since.cpus, times?.cpus);
        if (busyCpuPct != null) return { busyCpuPct, cpuTimes: times };
    }
    if (!times) return { busyCpuPct: null, cpuTimes: null };
    read.wait(OWN_CPU_SPAN_MS);
    const after = cpuTimesNow(read);
    return { busyCpuPct: cpuBusyPct(times.cpus, after?.cpus), cpuTimes: after };
}

/** Does a limit other than the load hold a job? The reading is judged with a load of 0, so only the others count. */
function otherLimitsHold(cores, rest, limits) {
    return !healthVerdict({ load: 0, cores, ...rest }, limits).ok;
}

/** The current reading: { load, cores, busyCpuPct, freePct, diskGB, battery }. probes replaces single readings.
 *  The live CPU reading is taken only when limits (the health settings) are given, the load is above its limit and
 *  no other limit already holds a job; otherwise busyCpuPct is null. With limits the reading also carries cpuTimes,
 *  the CPU times it ended on; handed back as cpuSince to a later reading, they let that reading measure the CPU
 *  without waiting. */
export function readHealth({ probes = {}, limits = null, cpuSince = null } = {}) {
    const read = {
        load: probeLoad, cpuTimes: probeCpuTimes, wait: pause, memory: probeMemoryFreePct,
        disk: probeDiskFreeGB, battery: readBattery, ...probes,
    };
    const { load, cores } = read.load();
    const rest = { freePct: read.memory(), diskGB: read.disk(), battery: read.battery() };
    if (!limits) return { load, cores, busyCpuPct: null, ...rest };
    const loadHolds = load > cores * limits.loadPerCore;
    const { busyCpuPct, cpuTimes } = loadHolds && !otherLimitsHold(cores, rest, limits)
        ? busyCpuNow(cpuSince, read)
        : { busyCpuPct: null, cpuTimes: cpuTimesNow(read) };
    return { load, cores, busyCpuPct, ...rest, cpuTimes };
}

/** The CPU times kept in the file of the shared reading (see cachedHealth), or null when there are none. */
export function savedCpuTimes(file) {
    return cpuTimesOf(readJson(file, null));
}

const cpuTimesOf = (saved) => saved?.cpuTimes ?? null;

/** A reading shared through a file in the state folder, so jobs that wait at the same time take one reading per
 *  poll between them instead of one each. A saved reading is used while it is younger than maxAgeMs (the poll
 *  time) and than MAX_SHARED_READING_MS; an older one is read fresh. The file also keeps the CPU times of the last
 *  reading, which the next reading measures the CPU against, and the time a reading finished, so a reading that
 *  took a while is not already old when it is saved. A cache that cannot be read or written only means a fresh
 *  reading. Temporary files of the cache that a process left behind when it died while writing are removed when a
 *  reading is saved. read is handed { cpuSince }. clock gives the time now. */
export function cachedHealth(file, maxAgeMs, read = readHealth, clock = Date.now) {
    const saved = readJson(file, null);
    const age = clock() - saved?.at;
    if (saved?.reading && age >= 0 && age < Math.min(maxAgeMs, MAX_SHARED_READING_MS)) return saved.reading;
    const { cpuTimes, ...reading } = read({ cpuSince: cpuTimesOf(saved) });
    try { writeJsonAtomic(file, { at: clock(), reading, cpuTimes }); } catch { /* the next poll reads again */ }
    dropOldTemps(file);
    return reading;
}
