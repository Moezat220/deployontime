// The health gate. A new job may start only while load, free memory, free disk and battery are inside their limits.
// healthVerdict() judges a reading and names each failed limit; readHealth() takes the reading.
import { probeDiskFreeGB, probeLoad, probeMemoryFreePct, probePowerText } from "./probes.mjs";
import { readJson, writeJsonAtomic } from "./files.mjs";

/** Returns { ok, blocks: [{ gate, text }] }. A reading of null is unknown and passes; 0 is a real value. limits:
 *  the health settings. */
export function healthVerdict({ load, cores, freePct, diskGB, battery = null }, limits) {
    const blocks = [];
    const loadCap = cores * limits.loadPerCore;
    if (load > loadCap) {
        blocks.push({ gate: "load", text: `load too high: ${load.toFixed(1)} now, ${loadCap.toFixed(1)} allowed` });
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

/** The current reading: { load, cores, freePct, diskGB, battery }. probes replaces single readings. */
export function readHealth({ probes = {} } = {}) {
    const read = {
        load: probeLoad, memory: probeMemoryFreePct, disk: probeDiskFreeGB, battery: readBattery, ...probes,
    };
    return { ...read.load(), freePct: read.memory(), diskGB: read.disk(), battery: read.battery() };
}

/** A reading at most maxAgeMs old, shared through a file in the state folder, so jobs that wait at the same time
 *  take one reading per poll between them instead of one each. A cache that cannot be read or written only means
 *  a fresh reading. */
export function cachedHealth(file, maxAgeMs, read = readHealth, now = Date.now()) {
    const saved = readJson(file, null);
    const age = now - saved?.at;
    if (saved?.reading && age >= 0 && age < maxAgeMs) return saved.reading;
    const reading = read();
    try { writeJsonAtomic(file, { at: now, reading }); } catch { /* the next poll reads again */ }
    return reading;
}
