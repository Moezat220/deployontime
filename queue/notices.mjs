// The long-run and idle-slot notices: their text, the per-slot CPU sampling that finds a quiet job, and the store
// of notices already sent, a folder in the state folder.
import { clockTime } from "./clock.mjs";
import { sampleKeepMs, slotIdleVerdict } from "./idle.mjs";
import { probeProcessCpu } from "./probes.mjs";
import { psRows } from "./ps.mjs";
import { jobCpu } from "./proctree.mjs";
import { linkSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempName } from "./files.mjs";
import { MINUTE } from "./units.mjs";

function heldUpText(waiting, now) {
    if (!waiting.length) return "holding up no other job";
    const waited = (w) => Math.max(0, Math.round((now - w.at) / MINUTE));
    return `holding up ${waiting.map((w) => `"${w.label}" (${waited(w)} min)`).join(" and ")}`;
}
/** The notice for a job that passed its long-run mark. Returns { title, message, key, entry }. */
export function longRunAlert(job) {
    const { label, project, pid, minutes, longRunBasis, limitMin, killMin, startedAt, tz } = job;
    const { waiting = [], now = Date.now() } = job;
    const heldUp = heldUpText(waiting, now);
    const stopAt = clockTime(startedAt + killMin * MINUTE, tz);
    return {
        title: "dotime: job running long",
        message: `long run: "${label}" of project ${project}, pid ${pid}, ${heldUp}, ${minutes} min in its slot, `
            + `long-run mark from ${longRunBasis}, limit ${limitMin} min, hard stop at ${stopAt}`,
        key: `long-run:${pid}:${startedAt}`,
        entry: {
            type: "long-run", project, label, pid, minutes,
            detail: `mark from ${longRunBasis}, limit ${limitMin} min, hard stop at ${stopAt}`,
            waiting: waiting.map((w) => w.label), at: now,
        },
    };
}
/** The notice for a job that holds a slot without using CPU. Returns { title, message, key, entry }. */
export function idleAlert(job) {
    const { label, project, pid, usedS, minutes, startedAt, killMin = null, waiting = [], now = Date.now(), tz } = job;
    const heldUp = heldUpText(waiting, now);
    const use = `${usedS} s of CPU in ${minutes} min`;
    const limit = killMin ? `, limit reached at ${clockTime(startedAt + killMin * MINUTE, tz)}` : "";
    return {
        title: "dotime: slot held by a quiet job",
        message: `idle slot: "${label}" of project ${project}, pid ${pid}, ${heldUp}, ${use}, not stopped${limit}`,
        key: `idle-slot:${pid}:${startedAt}`,
        entry: {
            type: "idle-slot", project, label, pid, minutes, usedS, detail: use,
            waiting: waiting.map((w) => w.label), at: now,
        },
    };
}

/** Takes one CPU sample per slot holder and judges it. ps: text from `ps -S -Ao pid=,ppid=,pgid=,time=`;
 *  state: { "<pid>:<startedAt>": { samples, told } } from the previous call.
 *  Returns { state, alerts }: state for the holders still present; each job gets at most one alert. */
export function slotIdleStep({ holders, ps, state = {}, waiting = [], now = Date.now(), idle, tz }) {
    const rows = psRows(ps);
    const next = {};
    const alerts = [];
    const keepMs = sampleKeepMs(idle.slotIdleMin);
    for (const holder of holders) {
        const startedAt = holder.startedAt ?? holder.at;
        const id = `${holder.pid}:${startedAt}`;
        const cpu = jobCpu(holder, rows);
        if (cpu == null) {
            // Not in this process listing: carry the earlier samples forward untouched.
            if (state[id]) next[id] = state[id];
            continue;
        }
        const before = state[id] ?? { samples: [] };
        const samples = [...before.samples, { t: now, cpu }].filter((s) => now - s.t <= keepMs);
        const verdict = before.told ? null : slotIdleVerdict({ startedAt, samples, now }, idle);
        if (verdict?.idle) {
            alerts.push(idleAlert({
                label: holder.label, project: holder.project ?? "unknown", pid: holder.pid, usedS: verdict.usedS,
                minutes: verdict.minutes, startedAt, killMin: holder.killMin, waiting, now, tz,
            }));
        }
        next[id] = { samples, ...(before.told || verdict?.idle ? { told: true } : {}) };
    }
    return { state: next, alerts };
}
/** slotIdleStep plus delivery of the new alerts. On a dry run nothing is sent. Returns { state, lines }. */
export function slotIdleCheck(check) {
    const { holders, notify, record, idle, tz } = check;
    const { waiting = [], state = {}, now = Date.now(), dry = false, ps = probeProcessCpu } = check;
    const step = slotIdleStep({ holders, ps: holders.length ? ps() : "", state, waiting, now, idle, tz });
    if (!dry) for (const alert of step.alerts) { notify(alert.title, alert.message); record(alert.key, alert.entry); }
    const note = dry ? " (dry run, no notice sent)" : "";
    return { state: step.state, lines: step.alerts.map((alert) => `${alert.message}${note}`) };
}

// The store holds one file per notice, named after its key. A notice is written under a temporary name and then
// linked into place, which fails when the file exists, so two processes that send notices at once never lose one,
// and the first of two with the same key wins.
const noticeFile = (dir, key) => join(dir, `${encodeURIComponent(key)}.json`);

/** Stores a notice in the notices folder of the state folder under its key. Returns true when it was added, false
 *  when the key exists or the file cannot be written. */
export function addNotice(key, entry, dir) {
    const file = noticeFile(dir, key);
    const temp = tempName(file);
    try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(temp, JSON.stringify(entry, null, 1));
        linkSync(temp, file);
        return true;
    } catch {
        return false;
    } finally {
        try { rmSync(temp, { force: true }); } catch { /* the folder itself could not be made */ }
    }
}
