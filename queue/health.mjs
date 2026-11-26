// The health gate. A new job may start only while load, free memory, free disk and battery are inside their limits.
// healthVerdict() judges a reading and names each failed limit; readHealth() takes the reading.
import { isSandbox, loadSettings } from "./settings.mjs";
import { probeDiskFreeGB, probeLoad, probeMemoryFreePct, probePowerText } from "./probes.mjs";

/** Returns { ok, blocks: [{ gate, text }] }. A reading of null is unknown and passes; 0 is a real value. */
export function healthVerdict({ load, cores, freePct, diskGB, battery = null }, limits = loadSettings().health) {
    const blocks = [], loadCap = cores * limits.loadPerCore;
    if (load > loadCap) blocks.push({ gate: "load", text: `load too high: ${load.toFixed(1)} now, ${loadCap.toFixed(1)} allowed` });
    if (freePct != null && freePct < limits.minFreeMemPct) {
        blocks.push({ gate: "memory", text: `memory too low: ${freePct}% free, ${limits.minFreeMemPct}% needed` });
    }
    if (diskGB != null && diskGB < limits.minFreeDiskGB) {
        blocks.push({ gate: "disk", text: `disk too low: ${diskGB.toFixed(1)} GB free, ${limits.minFreeDiskGB} GB needed` });
    }
    if (battery?.onBattery === true && Number.isFinite(battery.pct) && battery.pct <= limits.minBatteryPct) {
        const supply = battery.plugged ? "plugged in but still draining" : "not plugged in";
        blocks.push({ gate: "battery", text: `battery too low: ${battery.pct}% left, more than ${limits.minBatteryPct}% needed, ${supply}` });
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

/** Returns { onBattery: true | false | null, plugged }. A plugged-in computer that still loses charge counts as on battery. */
export function powerState(power) {
    if (power?.ac === false) return { onBattery: true, plugged: false };
    if (power?.ac !== true) return { onBattery: null, plugged: false };
    return { onBattery: power.charge === "discharging", plugged: true };
}

/** The battery reading for the gate, or null when it is unknown. */
export function readBattery(probe = probePowerText) {
    try {
        const power = parsePower(probe()), state = powerState(power);
        if (state.onBattery == null || power.pct == null) return null;
        return { onBattery: state.onBattery, pct: power.pct, plugged: state.plugged };
    } catch { return null; }
}

/** The current reading. Inside a sandbox state folder, DOTIME_FAKE_HEALTH (JSON) stands in for it. */
export function readHealth({ env = process.env, probes = {} } = {}) {
    if (env.DOTIME_FAKE_HEALTH && isSandbox(env)) {
        try { return JSON.parse(env.DOTIME_FAKE_HEALTH); } catch { /* fall through to the real reading */ }
    }
    const read = { load: probeLoad, memory: probeMemoryFreePct, disk: probeDiskFreeGB, battery: readBattery, ...probes };
    return { ...read.load(), freePct: read.memory(), diskGB: read.disk(), battery: read.battery() };
}
