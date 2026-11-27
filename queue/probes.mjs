// Readings from the operating system, one small function per reading, with the text parsing kept apart so it can be
// tested on sample output. Only macOS tools are wired up. When the operating system gives no answer, a probe answers
// null or empty text instead of throwing.
import { spawnSync } from "node:child_process";
import { cpus, loadavg } from "node:os";
import { parseGroupId } from "./ps.mjs";

const BIG_OUTPUT = 32 * 1024 * 1024;

/** The environment for system tools: decimals with a dot (some locales write a comma, which would not parse) and
 *  UTF-8 text, so command lines with non-ASCII letters come through as they are. */
export function toolEnv(env = process.env) {
    const { LC_ALL, ...rest } = env;
    return { ...rest, LC_NUMERIC: "C", LC_CTYPE: "UTF-8" };
}

/** The tool's output, or empty text when the tool is missing, is stopped or runs out of time: part of a reading is
 *  never passed on as if it were all of it. */
export function runTool(tool, args, timeout = 5000) {
    try {
        const ran = spawnSync(tool, args, { encoding: "utf8", timeout, maxBuffer: BIG_OUTPUT, env: toolEnv() });
        return ran.error || ran.signal ? "" : ran.stdout || "";
    } catch { return ""; }
}

export const probeLoad = () => ({ load: loadavg()[0], cores: cpus().length });

const TIME_NAMES = ["user", "nice", "sys", "idle", "irq"];

/** True when list is a list of cores as os.cpus() gives them: each with times.{user,nice,sys,idle,irq} as numbers
 *  of 0 or more. Times read back from a file are checked with it before use. */
export function validCpuTimes(list) {
    if (!Array.isArray(list)) return false;
    return list.every((core) => TIME_NAMES.every((name) => Number.isFinite(core?.times?.[name]) && core.times[name] >= 0));
}

/** The share of CPU time in use across all cores between two os.cpus() snapshots, in percent, or null when no time
 *  passed between them, a snapshot is not a valid list of core times, or a counter went backwards. Only cores found
 *  in both snapshots count, so a core list that changed size still gives a fair share. */
export function cpuBusyPct(before, after) {
    if (!validCpuTimes(before) || !validCpuTimes(after)) return null;
    let busy = 0, total = 0;
    for (let i = 0; i < Math.min(before.length, after.length); i++) {
        const spent = Object.fromEntries(TIME_NAMES.map((name) => [name, after[i].times[name] - before[i].times[name]]));
        if (TIME_NAMES.some((name) => spent[name] < 0)) return null;
        const used = spent.user + spent.nice + spent.sys + spent.irq;
        busy += used;
        total += used + spent.idle;
    }
    if (!(total > 0)) return null;
    return (busy / total) * 100;
}

/** The CPU times of each core now, as { at, cpus: [{ times }] }, small enough to keep in a file for a later
 *  cpuBusyPct(). */
export const probeCpuTimes = (now = Date.now) => ({ at: now(), cpus: cpus().map(({ times }) => ({ times })) });

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** How busy the CPU is right now: the busy share over windowMs, in percent, or null. It waits windowMs. */
export function probeBusyCpuPct(windowMs = 1000, { snapshot = cpus, wait = pause } = {}) {
    try {
        const before = snapshot();
        wait(windowMs);
        return cpuBusyPct(before, snapshot());
    } catch { return null; }
}

/** Parses memory_pressure output into free percent, or null. */
export function parseMemoryPressure(text) {
    const found = String(text ?? "").match(/free percentage:\s*(\d+)%/);
    return found ? Number(found[1]) : null;
}
export const probeMemoryFreePct = () => parseMemoryPressure(runTool("memory_pressure", []));

/** Parses `df -k` output into free GB from its last row, or null. A full disk is 0, not null. */
export function parseDf(text) {
    const available = String(text ?? "").trim().split("\n").pop().split(/\s+/)[3];
    return /^\d+$/.test(available ?? "") ? Number(available) / (1024 * 1024) : null;
}
export const probeDiskFreeGB = (path = "/") => parseDf(runTool("df", ["-k", path]));

/** Parses `sysctl vm.swapusage` output into percent of swap in use (0 without swap). */
export function parseSwap(text) {
    const found = String(text ?? "").match(/total = ([\d.]+)M\s+used = ([\d.]+)M/);
    if (!found) return 0;
    const total = Number(found[1]);
    const used = Number(found[2]);
    return total > 0 ? (used / total) * 100 : 0;
}
export const probeSwapPct = () => parseSwap(runTool("sysctl", ["-n", "vm.swapusage"]));

export const probePowerText = () => runTool("pmset", ["-g", "batt"], 1500);

// Three views of the process table: full rows for the reaper, CPU time including finished children, and a cheap
// pid/parent/group listing.
const TABLE_COLUMNS = "pid=,ppid=,pgid=,etime=,time=,pcpu=,rss=,command=";
export const probeProcessTable = () => runTool("ps", ["-Ao", TABLE_COLUMNS], 10_000);
export const probeProcessCpu = () => runTool("ps", ["-S", "-Ao", "pid=,ppid=,pgid=,time="], 10_000);
export const probeProcessTree = () => runTool("ps", ["-Ao", "pid=,ppid=,pgid="]);
/** `ps -o pid=,etime=` for the given pids; empty text for none. */
export const probeProcessAges = (pids) => {
    if (!pids.length) return "";
    return runTool("ps", ["-o", "pid=,etime=", "-p", pids.join(",")]);
};
/** The process group of a pid, or null when ps has no answer. */
export const probeGroupOf = (pid) => parseGroupId(runTool("ps", ["-o", "pgid=", "-p", String(pid)], 3000));

/** Shows a desktop notice. The texts travel as script arguments, so they are never run as script code. */
export function showDesktopNotice(title, message, { run = spawnSync, platform = process.platform } = {}) {
    if (platform !== "darwin") return false;
    const script = [
        "-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run",
    ];
    try {
        return run("osascript", [...script, title, message], { stdio: "ignore", timeout: 10_000 }).status === 0;
    } catch { return false; }
}

/** Parses `launchctl list` output into a Map from label to { pid, exit }. */
export function parseLaunchctlList(text) {
    const jobs = new Map();
    for (const row of String(text ?? "").split("\n").slice(1)) {
        const [pid, status, label] = row.split("\t");
        if (!label) continue;
        jobs.set(label, { pid: pid === "-" ? null : Number(pid), exit: status === "-" ? null : Number(status) });
    }
    return jobs;
}
/** The scheduler's job list, or null when it cannot be read. */
export function probeScheduledJobs(run = spawnSync) {
    try {
        const listed = run("launchctl", ["list"], { encoding: "utf8", timeout: 10_000, maxBuffer: BIG_OUTPUT });
        return listed.status === 0 && listed.stdout ? parseLaunchctlList(listed.stdout) : null;
    } catch { return null; }
}
export function probeReadPlist(file) {
    try { return JSON.parse(runTool("plutil", ["-convert", "json", "-o", "-", file])); } catch { return null; }
}
