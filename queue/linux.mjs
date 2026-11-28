// Readings that Linux keeps in files under /proc and /sys, with the parsing kept apart so it can be tested on sample
// text. A file that is missing or cannot be read gives empty text, and a reading that cannot be made gives null, the
// same way a missing tool does on macOS.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The text of a file, or empty text when it is missing or cannot be read. */
export function readText(file) {
    try { return readFileSync(file, "utf8"); } catch { return ""; }
}

/** The start of a process in clock ticks since boot, field 22 (starttime) of a /proc/<pid>/stat line, or null when
 *  the line does not have it. The fields are counted from after the last ")", because the name of the program (the
 *  second field, in parentheses) may itself hold spaces and parentheses. */
export function parseStartTicks(text) {
    const line = String(text ?? "");
    const close = line.lastIndexOf(")");
    if (close < 0) return null;
    // After the name come the state (field 3) and the fields after it, so starttime is the 20th.
    const value = line.slice(close + 1).trim().split(/\s+/)[19];
    return /^\d+$/.test(value ?? "") ? Number(value) : null;
}

/** The start of the process with this pid in clock ticks since boot, or null when not on Linux, for a pid that is not
 *  a whole number above 1, or when /proc cannot be read. Unlike a wall-clock start time it does not move when the clock
 *  is set, so it tells a live process from a later one with the same pid. */
export function startTicks(pid, { platform = process.platform, read = readText } = {}) {
    if (platform !== "linux" || !Number.isInteger(pid) || pid <= 1) return null;
    return parseStartTicks(read(`/proc/${pid}/stat`));
}

export const BOOT_ID_FILE = "/proc/sys/kernel/random/boot_id";

/** The boot id from the text of BOOT_ID_FILE, trimmed, or null when the text is not one. */
export function parseBootId(text) {
    const id = String(text ?? "").trim();
    return /^[0-9a-f-]{8,64}$/i.test(id) ? id.toLowerCase() : null;
}

/** The id the kernel gave this boot, or null when not on Linux or when it cannot be read. Clock ticks count from the
 *  boot, so they name a process only together with the boot they belong to: after a restart a new process may get
 *  the same pid and the same ticks. The boot id is new at every boot, and unlike the boot time it does not move with
 *  the wall clock. */
export function readBootId({ platform = process.platform, read = readText } = {}) {
    return platform === "linux" ? parseBootId(read(BOOT_ID_FILE)) : null;
}

let ownBoot;
/** readBootId(), read once per process: the boot cannot change while a process runs. */
export function bootId() {
    if (ownBoot === undefined) ownBoot = readBootId();
    return ownBoot;
}

/** The start of a process as kept next to its pid on Linux: { ticks, boot }, boot only when it could be read; an empty
 *  object when the ticks cannot be read, as on macOS. */
export function startMarks(pid, { readTicks = startTicks, readBoot = bootId } = {}) {
    const ticks = readTicks(pid);
    if (!Number.isInteger(ticks)) return {};
    const boot = readBoot();
    return { ticks, ...(typeof boot === "string" && boot ? { boot } : {}) };
}

/** Parses /proc/meminfo into a Map from field name to its value in kB. */
export function parseMeminfo(text) {
    const fields = new Map();
    for (const line of String(text ?? "").split("\n")) {
        const found = line.match(/^(\w+):\s+(\d+)(?:\s+kB)?\s*$/);
        if (found) fields.set(found[1], Number(found[2]));
    }
    return fields;
}

/** The share of memory still available to new work, as a whole percent, or null when /proc/meminfo has no
 *  MemAvailable and MemTotal line. */
export function meminfoFreePct(fields) {
    const total = fields.get("MemTotal"), available = fields.get("MemAvailable");
    if (!(total > 0) || !Number.isFinite(available)) return null;
    return Math.round(Math.min(available, total) / total * 100);
}

/** The share of swap in use, in percent: 0 without swap or without the swap lines, as on macOS. */
export function meminfoSwapPct(fields) {
    const total = fields.get("SwapTotal"), free = fields.get("SwapFree");
    if (!(total > 0) || !Number.isFinite(free)) return 0;
    return Math.max(0, total - free) / total * 100;
}

export const POWER_SUPPLY_DIR = "/sys/class/power_supply";
const SUPPLY_FILES = ["type", "scope", "online", "capacity", "status"];

/** Every power supply in dir, as [{ name, type, scope, online, capacity, status }] with each file's text trimmed
 *  ("" when the file is missing). An empty list when the folder cannot be read. */
export function readPowerSupplies(dir = POWER_SUPPLY_DIR, { list = readdirSync, read = readText } = {}) {
    let names;
    try { names = list(dir).sort(); } catch { return []; }
    return names.map((name) => ({
        name, ...Object.fromEntries(SUPPLY_FILES.map((file) => [file, read(join(dir, name, file)).trim()])),
    }));
}

// A battery or charger of a mouse, keyboard or phone has the scope "Device"; only the computer's own supplies count.
const own = (supply) => supply.scope !== "Device";
const CHARGER_STATES = new Set(["Charging", "Full", "Not charging"]);

/** The battery reading for the gate from the power supplies: { onBattery, pct, plugged }, or null without a battery
 *  of the computer's own (a server or desktop) or when its state is unknown. Several batteries count as one: the
 *  mean charge, and on battery while any of them is discharging. A computer that is plugged in and still
 *  discharges counts as on battery, as on macOS. */
export function supplyBattery(supplies) {
    const batteries = supplies.filter((s) => own(s) && s.type === "Battery" && /^\d{1,3}$/.test(s.capacity));
    if (!batteries.length) return null;
    const chargers = supplies.filter((s) => own(s) && s.type !== "Battery" && /^[01]$/.test(s.online));
    const discharging = batteries.some((b) => b.status === "Discharging");
    const charging = batteries.some((b) => CHARGER_STATES.has(b.status));
    const plugged = chargers.length ? chargers.some((c) => c.online === "1") : charging;
    let onBattery = null;
    if (discharging) onBattery = true;
    else if (charging || plugged) onBattery = false;
    else if (chargers.length) onBattery = true;
    if (onBattery == null) return null;
    const pct = Math.round(batteries.reduce((sum, b) => sum + Number(b.capacity), 0) / batteries.length);
    return { onBattery, pct, plugged };
}
