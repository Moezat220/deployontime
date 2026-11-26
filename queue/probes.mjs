// Readings from the operating system, one small function per reading, with the text parsing kept apart so it can be
// tested on sample output. Only macOS tools are wired up. When the operating system gives no answer, a probe answers
// null or empty text instead of throwing.
import { spawnSync } from "node:child_process";
import { cpus, loadavg } from "node:os";

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
    const total = Number(found[1]), used = Number(found[2]);
    return total > 0 ? (used / total) * 100 : 0;
}
export const probeSwapPct = () => parseSwap(runTool("sysctl", ["-n", "vm.swapusage"]));

export const probePowerText = () => runTool("pmset", ["-g", "batt"], 1500);

// Three views of the process table: full rows for the reaper, CPU time including finished children, and a cheap
// pid/parent/group listing.
export const probeProcessTable = () => runTool("ps", ["-Ao", "pid=,ppid=,pgid=,etime=,time=,pcpu=,rss=,command="], 10_000);
export const probeProcessCpu = () => runTool("ps", ["-S", "-Ao", "pid=,ppid=,pgid=,time="], 10_000);
export const probeProcessTree = () => runTool("ps", ["-Ao", "pid=,ppid=,pgid="]);
export function probeGroupOf(pid) {
    const pgid = Number(runTool("ps", ["-o", "pgid=", "-p", String(pid)], 3000).trim());
    return Number.isInteger(pgid) && pgid > 0 ? pgid : null;
}

/** Shows a desktop notice. The texts travel as script arguments, so they are never run as script code. */
export function showDesktopNotice(title, message, { run = spawnSync, platform = process.platform } = {}) {
    if (platform !== "darwin") return false;
    const script = ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run"];
    try { return run("osascript", [...script, title, message], { stdio: "ignore", timeout: 10_000 }).status === 0; } catch { return false; }
}

/** Parses `launchctl list` output into a Map from label to { pid, exit }. */
export function parseLaunchctlList(text) {
    const jobs = new Map();
    for (const row of String(text ?? "").split("\n").slice(1)) {
        const [pid, status, label] = row.split("\t");
        if (label) jobs.set(label, { pid: pid === "-" ? null : Number(pid), exit: status === "-" ? null : Number(status) });
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
