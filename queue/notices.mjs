// The long-run and idle-slot notices: their text, the per-slot CPU sampling that finds a quiet job, and the store
// of notices already sent in the state folder.
import { loadSettings, paths, timeZone } from "./settings.mjs";
import { clockTime } from "./clock.mjs";
import { sampleKeepMs, slotIdleVerdict } from "./idle.mjs";
import { probeProcessCpu } from "./probes.mjs";
import { psRows } from "./ps.mjs";
import { jobCpu } from "./proctree.mjs";
import { readJson, writeJsonAtomic } from "./files.mjs";
import { MINUTE } from "./units.mjs";

function heldUpText(waiting, now) {
    if (!waiting.length) return "holding up no other job";
    return `holding up ${waiting.map((w) => `"${w.label}" (${Math.max(0, Math.round((now - w.at) / MINUTE))} min)`).join(" and ")}`;
}
/** The notice for a job that passed its long-run mark. Returns { title, message, key, entry }. */
export function longRunAlert({ label, project, pid, minutes, longRunBasis, limitMin, killMin, startedAt, waiting = [], now = Date.now(), tz = timeZone() }) {
    const heldUp = heldUpText(waiting, now), stopAt = clockTime(startedAt + killMin * MINUTE, tz);
    return {
        title: "dotime: job running long",
        message: `long run: "${label}" of project ${project}, pid ${pid}, ${heldUp}, ${minutes} min in its slot, long-run mark from ${longRunBasis}, limit ${limitMin} min, hard stop at ${stopAt}`,
        key: `long-run:${pid}:${startedAt}`,
        entry: { type: "long-run", project, label, pid, minutes, detail: `mark from ${longRunBasis}, limit ${limitMin} min, hard stop at ${stopAt}`, waiting: waiting.map((w) => w.label), at: now },
    };
}
/** The notice for a job that holds a slot without using CPU. Returns { title, message, key, entry }. */
export function idleAlert({ label, project, pid, usedS, minutes, startedAt, killMin = null, waiting = [], now = Date.now(), tz = timeZone() }) {
    const heldUp = heldUpText(waiting, now), use = `${usedS} s of CPU in ${minutes} min`;
    const limit = killMin ? `, limit reached at ${clockTime(startedAt + killMin * MINUTE, tz)}` : "";
    return {
        title: "dotime: slot held by a quiet job",
        message: `idle slot: "${label}" of project ${project}, pid ${pid}, ${heldUp}, ${use}, not stopped${limit}`,
        key: `idle-slot:${pid}:${startedAt}`,
        entry: { type: "idle-slot", project, label, pid, minutes, usedS, detail: use, waiting: waiting.map((w) => w.label), at: now },
    };
}

/** Takes one CPU sample per slot holder and judges it. ps: text from `ps -S -Ao pid=,ppid=,pgid=,time=`;
 *  state: { "<pid>:<startedAt>": { samples, told } } from the previous call.
 *  Returns { state, alerts }: state for the holders still present; each job gets at most one alert. */
export function slotIdleStep({ holders, ps, state = {}, waiting = [], now = Date.now(), idle = loadSettings().idle, tz = timeZone() }) {
    const rows = psRows(ps), next = {}, alerts = [], keepMs = sampleKeepMs(idle.slotIdleMin);
    for (const holder of holders) {
        const startedAt = holder.startedAt ?? holder.at, id = `${holder.pid}:${startedAt}`, cpu = jobCpu(holder, rows);
        if (cpu == null) {
            // Not in this process listing: carry the earlier samples forward untouched.
            if (state[id]) next[id] = state[id];
            continue;
        }
        const before = state[id] ?? { samples: [] };
        const samples = [...before.samples, { t: now, cpu }].filter((s) => now - s.t <= keepMs);
        const verdict = before.told ? null : slotIdleVerdict({ startedAt, samples, now }, idle);
        if (verdict?.idle) {
            alerts.push(idleAlert({ label: holder.label, project: holder.project ?? "unknown", pid: holder.pid, usedS: verdict.usedS, minutes: verdict.minutes, startedAt, killMin: holder.killMin, waiting, now, tz }));
        }
        next[id] = { samples, ...(before.told || verdict?.idle ? { told: true } : {}) };
    }
    return { state: next, alerts };
}
/** slotIdleStep plus delivery of the new alerts. On a dry run nothing is sent. Returns { state, lines }. */
export function slotIdleCheck({ holders, waiting = [], state = {}, now = Date.now(), dry = false, notify, ps = probeProcessCpu, record = addNotice, idle = loadSettings().idle }) {
    const step = slotIdleStep({ holders, ps: holders.length ? ps() : "", state, waiting, now, idle });
    if (!dry) for (const alert of step.alerts) { notify(alert.title, alert.message); record(alert.key, alert.entry); }
    return { state: step.state, lines: step.alerts.map((alert) => `${alert.message}${dry ? " (dry run, no notice sent)" : ""}`) };
}

/** Stores a notice in $DOTIME_HOME/notices.json under its key. Returns true when it was added, false when the key exists
 *  or the file cannot be written. */
export function addNotice(key, entry, file = paths().notices) {
    try {
        const all = readJson(file, {});
        if (all[key]) return false;
        all[key] = entry;
        writeJsonAtomic(file, all, 1);
        return true;
    } catch { return false; }
}
