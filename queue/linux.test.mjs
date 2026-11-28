// The Linux readers run here on sample text, so they are tested on every machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { tempDir } from "./testkit.mjs";
import {
    meminfoFreePct, meminfoSwapPct, parseMeminfo, parseStartTicks, POWER_SUPPLY_DIR, readPowerSupplies, readText, startTicks,
    supplyBattery,
} from "./linux.mjs";

const MEMINFO = [
    "MemTotal:       16303428 kB",
    "MemFree:          912004 kB",
    "MemAvailable:    4075857 kB",
    "Buffers:          402116 kB",
    "Cached:          3998120 kB",
    "SwapTotal:       4194300 kB",
    "SwapFree:        3145725 kB",
    "HugePages_Total:       0",
    "",
].join("\n");

test("readText: the file's text, and empty text for a file that is missing or is a folder", () => {
    const dir = tempDir("linux-read"), file = join(dir, "meminfo");
    writeFileSync(file, "MemTotal: 1 kB\n");
    assert.equal(readText(file), "MemTotal: 1 kB\n");
    assert.equal(readText(join(dir, "absent")), "");
    assert.equal(readText(dir), "");
});

test("parseMeminfo: one entry per field in kB, also for fields without a unit", () => {
    const fields = parseMeminfo(MEMINFO);
    assert.equal(fields.get("MemTotal"), 16_303_428);
    assert.equal(fields.get("MemAvailable"), 4_075_857);
    assert.equal(fields.get("HugePages_Total"), 0);
    assert.equal(parseMeminfo("").size, 0);
    assert.equal(parseMeminfo(undefined).size, 0);
    assert.equal(parseMeminfo("MemTotal: lots\n").size, 0);
});

test("meminfoFreePct: the available share as a whole percent, null without the two lines", () => {
    assert.equal(meminfoFreePct(parseMeminfo(MEMINFO)), 25);
    assert.equal(meminfoFreePct(parseMeminfo("MemTotal: 1000 kB\nMemAvailable: 0 kB\n")), 0);
    const oldKernel = parseMeminfo("MemTotal: 1000 kB\nMemFree: 500 kB\n");
    assert.equal(meminfoFreePct(oldKernel), null, "an old kernel without MemAvailable");
    assert.equal(meminfoFreePct(parseMeminfo("MemTotal: 0 kB\nMemAvailable: 0 kB\n")), null);
    assert.equal(meminfoFreePct(parseMeminfo("")), null);
    assert.equal(meminfoFreePct(parseMeminfo("MemTotal: 1000 kB\nMemAvailable: 1200 kB\n")), 100, "never above 100");
});

test("meminfoSwapPct: the share of swap in use, 0 without swap or without the lines", () => {
    assert.equal(meminfoSwapPct(parseMeminfo(MEMINFO)), 25);
    assert.equal(meminfoSwapPct(parseMeminfo("SwapTotal: 0 kB\nSwapFree: 0 kB\n")), 0);
    assert.equal(meminfoSwapPct(parseMeminfo("")), 0);
});

/** A made-up /sys/class/power_supply folder: { name: { file: text } }. */
function supplyDir(supplies) {
    const dir = tempDir("power-supply");
    for (const [name, files] of Object.entries(supplies)) {
        mkdirSync(join(dir, name));
        for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, name, file), `${text}\n`);
    }
    return dir;
}
const supply = (name, type, more = {}) => ({ name, type, scope: "", online: "", capacity: "", status: "", ...more });

test("readPowerSupplies: each supply with its files trimmed, missing files empty, in name order", () => {
    const dir = supplyDir({
        BAT0: { type: "Battery", capacity: "57", status: "Discharging" },
        AC: { type: "Mains", online: "0" },
        "hidpp_battery_0": { type: "Battery", scope: "Device", capacity: "80", status: "Discharging" },
    });
    assert.deepEqual(readPowerSupplies(dir), [
        supply("AC", "Mains", { online: "0" }),
        supply("BAT0", "Battery", { capacity: "57", status: "Discharging" }),
        supply("hidpp_battery_0", "Battery", { scope: "Device", capacity: "80", status: "Discharging" }),
    ]);
    assert.equal(POWER_SUPPLY_DIR, "/sys/class/power_supply");
});

test("readPowerSupplies: an empty list when the folder is missing or cannot be listed", () => {
    assert.deepEqual(readPowerSupplies(join(tempDir("power-supply"), "absent")), []);
    assert.deepEqual(readPowerSupplies("/sys/class/power_supply", { list: () => { throw new Error("EACCES"); } }), []);
});

test("supplyBattery: unplugged, charging, full, and plugged in but still draining", () => {
    const mains = (online) => supply("AC", "Mains", { online });
    const battery = (capacity, status) => supply("BAT0", "Battery", { capacity, status });
    const read = (online, capacity, status) => supplyBattery([mains(online), battery(capacity, status)]);
    assert.deepEqual(read("0", "37", "Discharging"), { onBattery: true, pct: 37, plugged: false });
    assert.deepEqual(read("1", "91", "Charging"), { onBattery: false, pct: 91, plugged: true });
    assert.deepEqual(read("1", "100", "Full"), { onBattery: false, pct: 100, plugged: true });
    assert.deepEqual(read("1", "80", "Not charging"), { onBattery: false, pct: 80, plugged: true });
    assert.deepEqual(read("1", "58", "Discharging"), { onBattery: true, pct: 58, plugged: true });
    assert.deepEqual(read("1", "70", "Unknown"), { onBattery: false, pct: 70, plugged: true });
    assert.deepEqual(read("0", "70", "Unknown"), { onBattery: true, pct: 70, plugged: false });
});

test("supplyBattery: without a charger folder the battery state alone decides", () => {
    const battery = (status) => supply("BAT1", "Battery", { capacity: "44", status });
    assert.deepEqual(supplyBattery([battery("Discharging")]), { onBattery: true, pct: 44, plugged: false });
    assert.deepEqual(supplyBattery([battery("Charging")]), { onBattery: false, pct: 44, plugged: true });
    assert.equal(supplyBattery([battery("Unknown")]), null, "a state that says nothing is unknown");
    assert.equal(supplyBattery([battery("")]), null);
});

test("supplyBattery: two batteries count as one, and a mouse or phone battery does not count", () => {
    const both = [
        supply("AC", "Mains", { online: "0" }),
        supply("BAT0", "Battery", { capacity: "20", status: "Unknown" }),
        supply("BAT1", "Battery", { capacity: "61", status: "Discharging" }),
    ];
    assert.deepEqual(supplyBattery(both), { onBattery: true, pct: 41, plugged: false });
    const mouse = supply("hidpp_battery_0", "Battery", { scope: "Device", capacity: "5", status: "Discharging" });
    assert.equal(supplyBattery([mouse]), null);
    assert.deepEqual(supplyBattery([supply("AC", "Mains", { online: "1" }), mouse]), null);
});

test("supplyBattery: null on a server or desktop without a battery, or with unreadable files", () => {
    assert.equal(supplyBattery([]), null);
    assert.equal(supplyBattery([supply("AC", "Mains", { online: "1" })]), null);
    assert.equal(supplyBattery([supply("BAT0", "Battery", { status: "Discharging" })]), null, "no charge level");
    assert.equal(supplyBattery([supply("BAT0", "Battery", { capacity: "lots", status: "Discharging" })]), null);
});

// A /proc/<pid>/stat line: pid, (name), state, then the numbers; field 22, starttime, is 98765 here.
const STAT_REST = "S 1 4101 4101 0 -1 4194560 2000 0 0 0 10 5 0 0 20 0 11 0 98765 1234567 2345 18446744073709551615";

test("parseStartTicks: field 22 counted from after the last parenthesis, whatever the program name holds", () => {
    assert.equal(parseStartTicks(`4101 (node) ${STAT_REST}\n`), 98765);
    assert.equal(parseStartTicks(`4102 (my tool) (v2) ${STAT_REST}`), 98765, "a name with spaces and \") (\"");
    assert.equal(parseStartTicks(`4103 (a)b) ${STAT_REST}`), 98765, "a name with a lone \")\"");
    assert.equal(parseStartTicks(""), null);
    assert.equal(parseStartTicks("4104 (node) S 1 4104"), null, "a line cut short");
    assert.equal(parseStartTicks(`4105 node ${STAT_REST}`), null, "no parenthesis");
    assert.equal(parseStartTicks(`4106 (node) ${STAT_REST.replace("98765", "-5")}`), null, "not a whole number");
});

test("startTicks: reads /proc/<pid>/stat on Linux only, and never for a pid that is not a whole number above 1", () => {
    const asked = [];
    const read = (file) => { asked.push(file); return `4101 (node) ${STAT_REST}`; };
    assert.equal(startTicks(4101, { platform: "linux", read }), 98765);
    assert.deepEqual(asked, ["/proc/4101/stat"]);
    assert.equal(startTicks(4101, { platform: "darwin", read }), null);
    for (const pid of [0, 1, -4101, 4.5, "4101", undefined]) assert.equal(startTicks(pid, { platform: "linux", read }), null, String(pid));
    assert.equal(startTicks(4101, { platform: "linux", read: () => "" }), null, "a pid that is gone");
    assert.equal(asked.length, 1);
});

test("startTicks: this process has a start in clock ticks that stays the same", { skip: process.platform !== "linux" && "/proc is Linux only" }, () => {
    const first = startTicks(process.pid);
    assert.equal(Number.isInteger(first) && first > 0, true, String(first));
    assert.equal(startTicks(process.pid), first);
});
