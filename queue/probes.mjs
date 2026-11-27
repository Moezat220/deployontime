// Readings from the operating system, one small function per reading, with the text parsing kept apart so it can be
// tested on sample output. A probe that differs between macOS and Linux takes the platform as an option, so tests
// can take either branch on any machine. Other platforms take the macOS branch, except that they show no desktop
// notice. When the operating system gives no answer, a probe answers null or empty text instead of throwing.
import { spawnSync } from "node:child_process";
import { statfsSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { parseGroupId } from "./ps.mjs";
import { meminfoFreePct, meminfoSwapPct, parseMeminfo, readText } from "./linux.mjs";

const BIG_OUTPUT = 32 * 1024 * 1024;

/** The environment for system tools: decimals with a dot (some locales write a comma, which would not parse) and
 *  UTF-8 text, so command lines with non-ASCII letters come through as they are. Linux names the UTF-8 locale
 *  C.UTF-8; a bare UTF-8 is not a locale there. */
export function toolEnv(env = process.env, platform = process.platform) {
    const { LC_ALL, ...rest } = env;
    return { ...rest, LC_NUMERIC: "C", LC_CTYPE: platform === "linux" ? "C.UTF-8" : "UTF-8" };
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

/** Blocks for ms milliseconds. */
export const pause = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** Parses memory_pressure output into free percent, or null. */
export function parseMemoryPressure(text) {
    const found = String(text ?? "").match(/free percentage:\s*(\d+)%/);
    return found ? Number(found[1]) : null;
}
/** Free memory in percent, or null: on Linux the available share from /proc/meminfo, on macOS what
 *  memory_pressure reports. */
export function probeMemoryFreePct({ platform = process.platform, run = runTool, read = readText } = {}) {
    if (platform === "linux") return meminfoFreePct(parseMeminfo(read("/proc/meminfo")));
    return parseMemoryPressure(run("memory_pressure", []));
}

/** Free GB from a file system reading of statfs, counting only the blocks a user who is not root may use, as `df`
 *  does; null when the reading has no usable numbers. A full disk is 0, not null. */
export function statfsFreeGB(reading) {
    const { bavail, bsize } = reading ?? {};
    return Number.isFinite(bavail) && bavail >= 0 && bsize > 0 ? (bavail * bsize) / 1024 ** 3 : null;
}
/** Free GB on the disk that holds path, the same way on macOS and Linux, or null when it cannot be read. */
export function probeDiskFreeGB(path = "/", { statfs = statfsSync } = {}) {
    try { return statfsFreeGB(statfs(path)); } catch { return null; }
}

/** Parses `sysctl vm.swapusage` output into percent of swap in use (0 without swap). */
export function parseSwap(text) {
    const found = String(text ?? "").match(/total = ([\d.]+)M\s+used = ([\d.]+)M/);
    if (!found) return 0;
    const total = Number(found[1]);
    const used = Number(found[2]);
    return total > 0 ? (used / total) * 100 : 0;
}
/** Swap in use, in percent: on Linux from /proc/meminfo, on macOS from sysctl; 0 without swap or a reading. */
export function probeSwapPct({ platform = process.platform, run = runTool, read = readText } = {}) {
    if (platform === "linux") return meminfoSwapPct(parseMeminfo(read("/proc/meminfo")));
    return parseSwap(run("sysctl", ["-n", "vm.swapusage"]));
}

export const probePowerText = () => runTool("pmset", ["-g", "batt"], 1500);

// Three views of the process table: full rows for the reaper, CPU time including finished children, and a cheap
// pid/parent/group listing. The options and columns are the same for macOS ps and Linux (procps) ps, except the one
// that adds the CPU time of finished children. -ww keeps the command column whole whatever COLUMNS says.
const TABLE_COLUMNS = "pid=,ppid=,pgid=,etime=,time=,pcpu=,rss=,command=";
export function probeProcessTable({ run = runTool } = {}) {
    return run("ps", ["-ww", "-Ao", TABLE_COLUMNS], 10_000);
}
/** CPU time per process including its finished children: -S on macOS, --cumulative on Linux. */
export function probeProcessCpu({ platform = process.platform, run = runTool } = {}) {
    const withChildren = platform === "linux" ? "--cumulative" : "-S";
    return run("ps", [withChildren, "-Ao", "pid=,ppid=,pgid=,time="], 10_000);
}
export const probeProcessTree = () => runTool("ps", ["-Ao", "pid=,ppid=,pgid="]);
/** `ps -o pid=,etime=` for the given pids; empty text for none. */
export const probeProcessAges = (pids) => {
    if (!pids.length) return "";
    return runTool("ps", ["-o", "pid=,etime=", "-p", pids.join(",")]);
};
/** The process group of a pid, or null when ps has no answer. */
export const probeGroupOf = (pid) => parseGroupId(runTool("ps", ["-o", "pgid=", "-p", String(pid)], 3000));

/** Shows a desktop notice: through osascript on macOS, through notify-send on Linux, and not at all elsewhere. False
 *  when it could not be shown, also when notify-send is not installed, as on most servers. The texts travel as
 *  arguments after the options, so they are never read as script code or as options. */
export function showDesktopNotice(title, message, { run = spawnSync, platform = process.platform } = {}) {
    if (platform === "linux") {
        try {
            return run("notify-send", ["--", title, message], { stdio: "ignore", timeout: 10_000 }).status === 0;
        } catch { return false; }
    }
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
