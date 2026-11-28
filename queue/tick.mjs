// The one-minute step of scheduled jobs, `dotime-queue schedule tick`. A system entry starts it every minute; it
// reads schedule.json, starts each job that is due as a `dotime-queue run` of its own, and returns at once, so it never
// waits for a slot. Due times that passed before the newest one mean the tick did not run for a while: they are
// journalled and sent as one notice, and the job runs once to catch up, never once per missed time. A job whose last
// scheduled run still waits or runs is not started again; that is journalled too. A last run that was cut off by a
// restart with no journal line of its own gets a lost line, and the job counts as free. Nothing here decides how a job
// runs: the run it starts goes through the gate, slots, refusals, skips, limits, journal and notices like any other.
//
// A due time is saved before its run is started, so a tick that cannot save starts nothing rather than the same run
// every minute. A problem that stops the tick each minute (a schedule that cannot be saved, read or trusted) is sent
// as one notice, which schedule-notes.json remembers until the problem changes or goes away.
import { closeSync, fchmodSync, mkdirSync, openSync, statSync } from "node:fs";
import { join } from "node:path";
import { dateTime } from "./clock.mjs";
import { dueBetween } from "./cron.mjs";
import { readJson, writeJsonAtomic } from "./files.mjs";
import { append, cmdString, isTickNote, parseLines, readLines, record } from "./journal.mjs";
import { claimPending, lostReason } from "./lost.mjs";
import { JOB_MARKER, NO_SKIP_MARKER, PARENT_MARKER } from "./nested.mjs";
import { folderProject } from "./project.mjs";
import { snapshot } from "./slots.mjs";
import { jobProblem, OWNER_ONLY, readSchedule, scheduleTrust, takeLock, writeSchedule } from "./timetable.mjs";
import { MINUTE } from "./units.mjs";

/** How recent one missed due time may be and still be a tick that came a few seconds late, which gets its journal line
 *  but no notice; also how far ahead a lastDue may lie before it counts as odd. */
export const GRACE_MS = 2 * MINUTE;
/** The environment variable that tells `run` which scheduled job started it. */
export const SCHEDULED_MARKER = "DOTIME_SCHEDULED";
/** The exit code journalled for a scheduled job that could not be started, as for a command that could not start. */
const NO_START = 127;
/** How long a run that was started but whose pid could not be saved counts as still going, at most: until its journal
 *  line comes, or this long after its start. */
export const NO_PID_MS = 24 * 60 * MINUTE;

const iso = (ms) => new Date(ms).toISOString();

/** What one tick does for a job, from its stored times alone: null when nothing is due, else { due, missed }, where
 *  due is the newest due time, the one that starts now, and missed is { count, oldest, newest } for every due time
 *  before it, or null: a due time is either started or reported, never dropped without a word. Due times count from
 *  lastDue, or from createdAt for a job that was never due. */
export function planTick(job, now, wall) {
    if (!job.enabled) return null;
    const from = Date.parse(job.lastDue ?? job.createdAt);
    const due = dueBetween(job, from, now, wall);
    if (!due.count) return null;
    const before = due.count > 1 ? dueBetween(job, from, due.newest - 1, wall) : null;
    return { due: due.newest, missed: before?.count ? before : null };
}

/** Why a job's lastDue cannot be counted from, or null: it is not a time, or it lies further ahead than GRACE_MS. */
export function oddLastDue(job, now) {
    if (job.lastDue === undefined) return null;
    const due = Date.parse(job.lastDue);
    if (!Number.isFinite(due)) return "is not a time";
    return due > now + GRACE_MS ? "lies ahead of now" : null;
}

/** Is the last run this job started still waiting or running? Its pid must be alive and belong to the process
 *  that was started then. isGone({ pid, born }) is the same check the slots use. A run started without its pid saved
 *  counts as going until a journal line of this job from then on comes, or NO_PID_MS has passed; rows() gives the
 *  journal lines. */
export function stillGoing(job, isGone, now = 0, rows = () => []) {
    if (Number.isInteger(job.lastPid)) return !isGone({ pid: job.lastPid, born: job.lastBorn });
    const started = Date.parse(job.lastStart);
    if (!Number.isFinite(started) || now - started >= NO_PID_MS) return false;
    return !rows().some((r) => r.scheduled === job.id && !isTickNote(r) && Date.parse(r.queuedAt) >= started);
}

/** Was the last run this job started cut off, with no journal line of its own? Its pid, saved, is gone (isGone), no
 *  line of this job from a run with that pid exists (one queued more than a day before lastStart is from an earlier
 *  process with the same pid), and no claim of its slot is still being settled (see lost.mjs; such a claim writes the
 *  line itself). rows() gives the journal lines; the tick's own lines do not count. */
export function lastRunLost(job, isGone, rows, files) {
    if (!Number.isInteger(job.lastPid) || !isGone({ pid: job.lastPid, born: job.lastBorn })) return false;
    const started = Date.parse(job.lastStart);
    if (!Number.isFinite(started) || claimPending(files, job.lastPid)) return false;
    const own = (r) => r.scheduled === job.id && !r.byTick && r.pid === job.lastPid && Date.parse(r.queuedAt) >= started - 24 * 60 * MINUTE;
    return !rows().some(own);
}

/** A journal line written by the tick itself, for a job it did not start as a run: missed, busy, could-not-start, or
 *  lost for a run it started that was cut off with no line of its own. */
export function tickRow(job, outcome, now, extra = {}, exit = null) {
    return record({
        label: job.label, project: folderProject(job.cwd), cwd: job.cwd, priority: false, queuedAt: now, startedAt: null,
        endedAt: now, outcome, exit, tally: {}, cmd: cmdString(job.command), extra: { scheduled: job.id, byTick: true, ...extra },
    });
}

/** Starts the job as `dotime-queue run` in its folder, in a process group of its own that the tick does not wait for,
 *  with SCHEDULED_MARKER set and the markers of any job the tick itself runs in removed. Its output replaces the
 *  last one in schedule-runs/<id>.log. Returns { pid } or { error }. deps: { spawn, env, node, cli }. */
export function startRun(job, files, deps) {
    try {
        if (!statSync(job.cwd).isDirectory()) return { error: `${job.cwd} is not a folder` };
    } catch {
        return { error: `the folder ${job.cwd} is missing` };
    }
    mkdirSync(files.scheduleRuns, { recursive: true });
    const log = openSync(join(files.scheduleRuns, `${job.id}.log`), "w", OWNER_ONLY);
    try {
        fchmodSync(log, OWNER_ONLY);
        const env = { ...deps.env, [SCHEDULED_MARKER]: job.id };
        for (const name of [JOB_MARKER, PARENT_MARKER, NO_SKIP_MARKER]) delete env[name];
        const flags = [...(job.isolate ? ["--isolate"] : []), ...(job.noSkip ? ["--no-skip"] : [])];
        const words = [deps.cli, "run", `--label=${job.label}`, ...flags, "--", ...job.command];
        const child = deps.spawn(deps.node, words, { cwd: job.cwd, env, detached: true, stdio: ["ignore", log, log] });
        child.on?.("error", () => { /* reported through the missing pid */ });
        child.unref?.();
        return Number.isInteger(child.pid) ? { pid: child.pid } : { error: "the run could not be started" };
    } finally {
        closeSync(log);
    }
}

const runs = (n) => `${n} ${n === 1 ? "run" : "runs"}`;

/** The notices the tick sends for a problem that would otherwise come back every minute, kept in a file by a key:
 *  once(key, value, title, message) sends one only when the key had another value, and only once that is saved, so
 *  it is never sent each minute; clear(key) forgets it when the problem is gone. When even that file cannot be saved,
 *  as on a full disk, the notice goes out on the tick in minute 0 of each hour only, so it is still told, at most
 *  once an hour. now: the time of this tick in ms. */
export function noticeBook(file, notify, now = Date.now()) {
    const kept = readJson(file, {}) ?? {};
    const save = () => {
        try { writeJsonAtomic(file, kept, undefined, OWNER_ONLY); return true; } catch { return false; }
    };
    return {
        once(key, value, title, message) {
            if (kept[key] === value) return;
            kept[key] = value;
            if (!save()) {
                delete kept[key];
                if (new Date(now).getUTCMinutes() !== 0) return;
            }
            try { notify(title, message); } catch { /* a notice that fails changes nothing */ }
        },
        clear(key) {
            if (!(key in kept)) return;
            delete kept[key];
            save();
        },
    };
}

/** Saves the jobs, or gives the error. deps.writeSchedule, for tests, stands in for the write. */
function trySave(files, jobs, deps) {
    try {
        (deps.writeSchedule ?? writeSchedule)(files.schedule, jobs);
        return null;
    } catch (e) {
        return e;
    }
}

/** One tick for one job that is due: saves the new lastDue first, and on a start lastStart without a pid; then
 *  journals and notices missed times and starts the run, or writes a busy line; then saves the pid of the run.
 *  Returns { saveError } when the first save failed, in which case nothing was journalled or started. */
function tickJob(job, plan, now, jobs, files, deps) {
    const { print } = deps;
    const rows = () => parseLines(readLines(files.journal));
    const busy = stillGoing(job, deps.isGone, now, rows);
    const lost = !busy && lastRunLost(job, deps.isGone, rows, files);
    const head = `${job.id} "${job.label}"`;
    const before = { lastStart: job.lastStart, lastPid: job.lastPid, lastBorn: job.lastBorn };
    job.lastDue = iso(plan.due);
    if (!busy) {
        job.lastStart = iso(now);
        delete job.lastPid;
        delete job.lastBorn;
    }
    const saveError = trySave(files, jobs, deps);
    if (saveError) return { saveError };
    if (lost) {
        const facts = { lostPid: before.lastPid, lastStart: before.lastStart, reason: lostReason("tick") };
        append(tickRow(job, "lost", now, facts), files.journal);
        print(`schedule tick: lost ${head}, the last run, pid ${before.lastPid}, was cut off with no journal line; it counts as free`);
    }
    if (plan.missed) {
        const { count, oldest, newest } = plan.missed;
        append(tickRow(job, "missed", now, { missed: count, missedFrom: iso(oldest), missedTo: iso(newest) }), files.journal);
        const next = busy ? "not started now: the last run is still going" : "running once now";
        // One due time missed by a tick that came a few seconds late (a launchd StartInterval drifts against the clock)
        // is journalled and printed, but is no notice: only a real gap is worth interrupting someone for.
        const jitter = count === 1 && now - newest <= GRACE_MS;
        if (!jitter) {
            try {
                deps.notify(`dotime: missed ${job.label}`, `${runs(count)} missed while the tick did not run; ${next}`);
            } catch { /* a notice that fails changes nothing */ }
        }
        print(`schedule tick: missed ${head}, ${runs(count)}, from ${dateTime(oldest, deps.zone)} to ${dateTime(newest, deps.zone)}`);
    }
    if (busy) {
        append(tickRow(job, "busy", now, Number.isInteger(job.lastPid) ? { busyPid: job.lastPid } : {}), files.journal);
        const which = Number.isInteger(job.lastPid) ? `the last run, pid ${job.lastPid},` : "the last run, whose pid was not saved,";
        print(`schedule tick: busy ${head}, not started; ${which} still waits or runs`);
        return {};
    }
    const started = startRun(job, files, deps);
    if (started.error) {
        append(tickRow(job, "could-not-start", now, {}, NO_START), files.journal);
        print(`schedule tick: not started ${head}; ${started.error}`);
        Object.assign(job, before);
        for (const key of Object.keys(before)) if (job[key] === undefined) delete job[key];
    } else {
        Object.assign(job, { lastPid: started.pid, lastBorn: now });
        print(`schedule tick: started ${head}, pid ${started.pid}, due ${dateTime(plan.due, deps.zone)}`);
    }
    const late = trySave(files, jobs, deps);
    if (late) {
        deps.say(`schedule tick: ${files.schedule} could not be saved after the start of ${head} (${late.code ?? late.message}); `
            + "the next ticks count it as going until its journal line comes");
    }
    return {};
}

/** `schedule tick`. Returns at once with 0 when another tick holds the lock, or when nothing is due, and prints
 *  nothing then. Exits 1, starting nothing, when schedule.json cannot be read, is not trusted (scheduleTrust), or
 *  cannot be saved; each of these is also sent as one notice. deps: { now, wall, zone, uid, owner ({ pid, born } of
 *  this process), isGone, spawn, env, node, cli, notify, print, say, and for tests writeSchedule }. */
export function runTick(files, deps) {
    const release = takeLock(files.scheduleLock, deps.owner, { isGone: deps.isGone, now: deps.now() });
    if (!release) return 0;
    try {
        const book = noticeBook(files.tickNotes, deps.notify, deps.now());
        const distrust = scheduleTrust(files.schedule, deps.uid);
        if (distrust) {
            deps.say(`schedule tick: nothing runs; ${distrust}`);
            book.once("trust", distrust, "dotime: schedule not run", distrust);
            return 1;
        }
        book.clear("trust");
        const read = readSchedule(files.schedule);
        if (read.error) {
            deps.say(`schedule tick: ${read.error}`);
            let stamp = "";
            try { stamp = String(statSync(files.schedule).mtimeMs); } catch { /* unreadable */ }
            book.once("broken", stamp, "dotime: schedule cannot be used", `${read.error}; no scheduled job runs until then`);
            return 1;
        }
        book.clear("broken");
        // A run whose holder is gone after its command started is recorded as lost first, from its slot, so it has
        // its line before its job is looked at.
        snapshot({ dirs: files });
        let saved = false;
        for (const job of read.jobs) {
            if (!job?.enabled) continue;
            const problem = jobProblem(job);
            if (problem) {
                deps.say(`schedule tick: job ${job.id ?? "without id"} skipped; ${problem}`);
                continue;
            }
            const now = deps.now();
            const odd = oddLastDue(job, now);
            let saveError = null;
            if (odd) {
                deps.say(`schedule tick: job ${job.id} lastDue ${JSON.stringify(job.lastDue)} ${odd}; its due times count from now`);
                job.lastDue = iso(now);
                saveError = trySave(files, read.jobs, deps);
            } else {
                const plan = planTick(job, now, deps.wall);
                if (!plan) continue;
                ({ saveError } = tickJob(job, plan, now, read.jobs, files, deps));
            }
            if (saveError) {
                const why = saveError.code ?? saveError.message;
                deps.say(`schedule tick: ${files.schedule} could not be saved (${why}); nothing was started`);
                book.once("save", why, "dotime: schedule tick stopped",
                    `${files.schedule} could not be saved (${why}); no scheduled job starts until it can`);
                return 1;
            }
            saved = true;
        }
        if (saved) book.clear("save");
        return 0;
    } finally {
        release();
    }
}
