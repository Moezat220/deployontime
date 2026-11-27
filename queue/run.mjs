// The `run` command, in three steps: planJob decides the limit and whether the job is refused, and skipFor whether a
// check that already passed on this commit is skipped; waitForSlot waits in line until a slot is taken (for a nested
// run, waitForPlace waits until a place under its parent job is), and runJob runs the job in its own process group
// under the limit. runCommand chains them and returns the exit code; it never
// ends the process itself. These come in through deps, so tests can drive each step: the clock, sleeping and timers,
// the health reading, the commit read when the job is queued and again when it starts, the current folder, starting
// the job, signals sent to it and signals received, messages, notifications and stored notices, and the environment
// in which a nested run finds the marker of its parent job. The rest is done directly: the slot, line, nested, place
// and journal files in the folders named by files, the git calls for the project name and the code fingerprint, the
// process table read by snapshot and killTree, and this process's own pid and node binary.
import { spawn as spawnProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseRunArgs, USAGE, USAGE_EXIT } from "./args.mjs";
import { minutesSince } from "./clock.mjs";
import { failStop } from "./failstop.mjs";
import { fingerprint } from "./fingerprint.mjs";
import { blockReason, blockText, decide, gateBlocks, shouldGiveUp } from "./gate.mjs";
import { gitState as readGitState } from "./git.mjs";
import { healthVerdict } from "./health.mjs";
import { NO_START_EXIT, readStartFailure, wrapperEnd } from "./job-wrapper.mjs";
import { addWait, append, cmdString, jobEnd, parseLines, readLines, record, SKIPPABLE_KINDS, skipStamp } from "./journal.mjs";
import { cmdStem, kindOf } from "./kinds.mjs";
import { decideLimit, kindStats, stemStats } from "./limits.mjs";
import { addNotice as storeNotice, longRunAlert } from "./notices.mjs";
import { JOB_MARKER, markerOf, PARENT_MARKER, parentJob, placeKey, slotMarkerOf, stillRunning } from "./nested.mjs";
import { killTree, signalGroup } from "./proctree.mjs";
import { folderProject, jobProject } from "./project.mjs";
import { addNested, enqueue, releaseSlot, snapshot, takePlace, takeSlot, updateSlot } from "./slots.mjs";
import { afterMs, MAX_TIMER_MS, wakeableSleep } from "./timer.mjs";
import { MINUTE } from "./units.mjs";

/** The exit codes of dotime-queue itself; a job that ran passes its own code on. */
export const EXIT = { usage: USAGE_EXIT, refused: 3, gaveUp: 75, timedOut: 124, noStart: NO_START_EXIT, left: 130 };
const REPEAT_WAIT_LINE_MS = MINUTE;
const WRAPPER = fileURLToPath(new URL("./job-wrapper.mjs", import.meta.url));
// Signals that take a waiting job out of the line, and signals that are passed on to a running job.
const LEAVE_SIGNALS = ["SIGINT", "SIGTERM"];
const FORWARD_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/** Decides the run limit of a job and whether it is refused, from the journal rows alone; reads and changes
 *  nothing. request: { label, command (the command line as text), kind (given with --kind, or undefined), maxRun,
 *  priority, afterFix, project, cwd, head, fingerprint, queuedAt, tz }.
 *  Returns { kind, stem, limit, refusal, afterFixUsed, details }: refusal is null or { reason }; afterFixUsed is true
 *  when --after-fix let through a run that would have been refused; details go into the journal line, with the
 *  fingerprint as fp. */
export function planJob(request, settings, journalRows) {
    const { label, command, maxRun, priority, afterFix, project, cwd, head, queuedAt, tz } = request;
    const limits = settings.limits;
    const kind = kindOf(label, command, request.kind);
    const stem = cmdStem(command);
    const window = { project, now: queuedAt, windowDays: limits.windowDays };
    const stats = kindStats(journalRows, { ...window, kind });
    const stemRuns = stemStats(journalRows, { ...window, stem });
    const limit = decideLimit({ maxRun, kind, stats, stem: stemRuns, priority }, limits);
    const check = { label, cmd: command, project, cwd, head, fingerprint: request.fingerprint, at: queuedAt };
    const verdict = failStop(journalRows, check, limits, tz);
    const details = {
        kind,
        ...(stem ? { stem } : {}),
        limitMin: limit.limitMin,
        limitBasis: limit.basis,
        // Stored as fp, the name every copy of the queue that shares the journal reads.
        fp: request.fingerprint,
        ...(afterFix ? { afterFix } : {}),
    };
    return {
        kind,
        stem,
        limit,
        refusal: verdict.refuse && !afterFix ? { reason: verdict.reason } : null,
        afterFixUsed: verdict.refuse && !!afterFix,
        details,
    };
}

/** The pass stamp on which a job is skipped, or null when it must run. Only a job of a kind in SKIPPABLE_KINDS is
 *  ever skipped, and only on a stamp from skipStamp: a run of the same project, label and command that passed on this
 *  commit with a clean tree, while the tree is still clean now, with no failure of it on the commit since.
 *  job: { kind, label, command, project (the folder's project, as journal lines store it), commit ({ head, clean },
 *  read when the job was queued), noSkip, at, tz }. rows: the journal rows. */
export function skipFor(job, rows) {
    if (job.noSkip || !SKIPPABLE_KINDS.includes(job.kind)) return null;
    const folder = { project: job.project, ...job.commit };
    return skipStamp(rows, folder, { label: job.label, cmd: job.command }, { tz: job.tz, at: job.at });
}

/** Waits in line until this job holds a slot. job: { pid, label, maxWait, slotMeta, settings, files, waitFrom,
 *  tally }; waitFrom and tally, when given, carry on an earlier wait, so the wait limit counts from its start and the
 *  time is booked with it. Priority plays no part in here: it is in the job's ticket, which orders the line, and in
 *  slotMeta.
 *  deps: { now, sleep, readHealth, say, leaving }; leaving() names a signal that asked the job to leave, or null.
 *  Returns { slot, tally, waitFrom }, { gaveUp: true, tally } or { left: signal, tally }; tally is the waiting time
 *  per gate in ms. */
export async function waitForSlot(job, deps) {
    const { pid, label, maxWait, settings, files } = job;
    const max = settings.slots;
    const tally = { ...job.tally };
    const waitFrom = job.waitFrom ?? deps.now();
    let shownPosition = 0;
    let shownAt = 0;
    for (;;) {
        const signal = deps.leaving?.() ?? null;
        if (signal) return { left: signal, tally };
        const snap = snapshot({ dirs: files, prune: true });
        const turn = decide(snap, pid, max);
        const ahead = turn.position - 1;
        // One reading per poll, taken only when something needs it; the message reuses it.
        let reading = null;
        const health = () => (reading ??= healthVerdict(deps.readHealth(), settings.health));
        // Only full slots make the health reading irrelevant to a waiter.
        const slotFree = snap.holders.length < max;
        const gateHealth = turn.go || slotFree ? health() : null;
        if (turn.go && gateHealth.ok) {
            const slot = takeSlot(pid, label, max, job.slotMeta, files);
            if (slot) return { slot, tally, waitFrom };
        }
        const heldBy = blockReason({ holders: snap.holders, health: gateHealth, ahead }, max);
        const now = deps.now();
        const giveUp = shouldGiveUp({ startedAt: waitFrom, now, maxWaitMin: maxWait });
        if (giveUp || turn.position !== shownPosition || now - shownAt > REPEAT_WAIT_LINE_MS) {
            const all = gateBlocks({ holders: snap.holders, health: health(), ahead }, max);
            const why = blockText(all) || "slot lost: another job took it a moment ago";
            const waited = `${minutesSince(waitFrom, now)} min waited`;
            if (giveUp) {
                deps.say(`gave up: exit ${EXIT.gaveUp}, position ${turn.position}, ${waited}; ${why}; `
                    + "hint: --max-wait 0 waits without limit");
                return { gaveUp: true, tally };
            }
            const limitText = maxWait ? `wait limit ${maxWait} min` : "no wait limit";
            deps.say(`in line: position ${turn.position}, ${waited}, ${limitText}; ${why}`);
            shownPosition = turn.position;
            shownAt = now;
        }
        const sleptFrom = deps.now();
        await deps.sleep(settings.pollMs);
        // A poll that ends with a signal pending is not booked: the job leaves at the top of the loop.
        if (deps.leaving?.()) continue;
        addWait(tally, heldBy, deps.now() - sleptFrom);
    }
}

/** Waits until a nested run holds one of the settings.nestedPerJob places under its parent job. Only the parent's
 *  places count: no slot, no line and no health gate, so a nested run can never wait for its own outer job. Nested
 *  runs that wait under the same parent take the places in the order their notes were written. job: { pid, label,
 *  parent, maxWait, settings, files }, where parent is the job from outerJob(). deps: { now, sleep, say, leaving },
 *  as for waitForSlot. Returns { place, tally, waitFrom, atOnce }, where atOnce is true when the first look found a
 *  place, { gaveUp: true, tally }, { left: signal, tally }, or { parentGone: true, tally, waitFrom } once the parent
 *  has ended: the run is then no longer inside a job, and must not start without a slot. The parent is checked on
 *  every poll, and once more after a place was taken. */
export async function waitForPlace(job, deps) {
    const { pid, label, parent, maxWait, settings, files } = job;
    const max = settings.nestedPerJob;
    const key = placeKey(parent);
    const marker = markerOf(parent.file);
    const under = (n) => n.outer === marker && n.outerPid === parent.pid && n.outerBorn === parent.born;
    const tally = {};
    const waitFrom = deps.now();
    let shownPosition = 0;
    let shownAt = 0;
    for (;;) {
        const signal = deps.leaving?.() ?? null;
        if (signal) return { left: signal, tally };
        const snap = snapshot({ dirs: files, prune: true });
        if (!stillRunning(parent, snap)) return { parentGone: true, tally, waitFrom };
        const taken = snap.places.filter((p) => p.parent === key).length;
        const waiters = snap.nested.filter((n) => n.waiting && under(n)).sort((a, b) => a.at - b.at || a.pid - b.pid);
        const index = waiters.findIndex((n) => n.pid === pid);
        const position = index < 0 ? waiters.length + 1 : index + 1;
        if (position <= max - taken) {
            const place = takePlace(pid, label, key, max, files);
            if (place && !stillRunning(parent, snapshot({ dirs: files }))) {
                releaseSlot(place, pid);
                return { parentGone: true, tally, waitFrom };
            }
            if (place) return { place, tally, waitFrom, atOnce: shownPosition === 0 && !Object.keys(tally).length };
        }
        const ahead = position - 1;
        const why = taken >= max
            ? `no free nested place: ${taken} of ${max} taken under "${parent.label}", pid ${parent.pid}`
            : ahead > 0 ? `not first in line under "${parent.label}": ${ahead} ahead`
                : "place lost: another nested run took it a moment ago";
        const now = deps.now();
        const giveUp = shouldGiveUp({ startedAt: waitFrom, now, maxWaitMin: maxWait });
        if (giveUp || position !== shownPosition || now - shownAt > REPEAT_WAIT_LINE_MS) {
            const waited = `${minutesSince(waitFrom, now)} min waited`;
            if (giveUp) {
                deps.say(`gave up: exit ${EXIT.gaveUp}, nested position ${position}, ${waited}; ${why}; `
                    + "hint: --max-wait 0 waits without limit, and nestedPerJob in config.json sets the places");
                return { gaveUp: true, tally };
            }
            const limitText = maxWait ? `wait limit ${maxWait} min` : "no wait limit";
            deps.say(`in line for a nested place: position ${position}, ${waited}, ${limitText}; ${why}`);
            shownPosition = position;
            shownAt = now;
        }
        const sleptFrom = deps.now();
        await deps.sleep(settings.pollMs);
        if (deps.leaving?.()) continue;
        addWait(tally, [{ gate: "nested" }], deps.now() - sleptFrom);
    }
}

/** Runs the job in a slot it holds and resolves with the exit code for `run`. job: { pid, label, project, cwd, cmd
 *  (the words), priority, kind, limit, waitFrom, settings, files, tz, journal, handOver, slotMarker }, where journal
 *  is the writer from journalWriter() and handOver(), when given, is called as soon as the job's own signal handlers
 *  are in place, so the caller can remove the ones it had until then without a moment in which a signal finds none.
 *  The job finds the marker of its slot in JOB_MARKER and in PARENT_MARKER. A nested run passes its note in place of
 *  a slot and the marker of the outermost job's slot as slotMarker, so its job finds that slot in JOB_MARKER and the
 *  note in PARENT_MARKER, and the note gets the job's process group and is removed at the end the same way.
 *  deps: { now, spawn, say, after, later, kill, notify, addNotice, gitState, signals }: after(minutes, fn) is the long
 *  timer, later(ms, fn) a short one, each returning a function that cancels it, kill(pid, signal) sends a signal,
 *  addNotice(key, entry, file) stores a notice, gitState(cwd) reads the commit, and signals is the process whose INT,
 *  TERM, HUP and exit events are watched. Every handler and timer it adds is removed at the end. A run limit whose last
 *  KILL is refused is reported, and journalled with stopFailed, as a stop that failed. */
export function runJob(job, slot, deps) {
    const { pid, label, project, limit, settings, files, tz, journal } = job;
    const killGraceMs = settings.limits.killGraceMs;
    const { say, signals } = deps;
    // The commit is read at this point because it is what a pass stamp will vouch for.
    const commit = deps.gitState(job.cwd);
    const startedAt = deps.now();
    journal.note({ commit, startedAt });
    if (startedAt - job.waitFrom > 5000) say(`started: ${minutesSince(job.waitFrom, startedAt)} min in line`);
    // File descriptor 3 is a pipe on which the wrapper reports a command that could not be started. Whether the
    // job inherits it depends on the system, so the run ends when the wrapper exits and not when the pipe closes.
    const stdio = ["inherit", "inherit", "inherit", "pipe"];
    const env = { ...process.env, [JOB_MARKER]: job.slotMarker ?? markerOf(slot), [PARENT_MARKER]: markerOf(slot) };
    const child = deps.spawn(process.execPath, [WRAPPER, String(pid), ...job.cmd], { stdio, detached: true, env });
    updateSlot(slot, pid, { pgid: child.pid, startedAt });
    const signalJob = (signal) => {
        if (signalGroup(child.pid, signal, deps.kill).sent) return;
        try { child.kill(signal); } catch { /* already gone */ }
    };

    // INT, TERM and HUP go on to the job; the first one received is kept for the journal.
    let received = null;
    let receivedAt = null;
    const forwarders = FORWARD_SIGNALS.map((signal) => [signal, () => {
        if (!received) {
            received = signal;
            receivedAt = deps.now();
        }
        signalJob(signal);
    }]);
    const onExit = () => { if (child.exitCode === null && child.signalCode === null) signalJob("SIGTERM"); };
    for (const [signal, handler] of forwarders) signals.on(signal, handler);
    signals.on("exit", onExit);
    job.handOver?.();

    let pastLimit = false;
    let longRunAt = null;
    let warnedAt = null;
    let ended = false;
    const timers = [];
    const after = (minutes, fn) => { timers.push(deps.after(minutes, fn)); };
    const later = (ms, fn) => { timers.push(deps.later(ms, fn)); };
    let done;
    const result = new Promise((resolve) => { done = resolve; });
    const end = (exit) => {
        if (ended) return;
        ended = true;
        releaseSlot(slot, pid);
        for (const [signal, handler] of forwarders) signals.off(signal, handler);
        // Safe to drop: the wrapper has exited, or the backstop ended a run whose last KILL was refused, and a TERM
        // at exit would be refused the same way.
        signals.off("exit", onExit);
        for (const cancel of timers) cancel();
        done(exit);
    };
    const stamps = () => ({
        ...(longRunAt ? { longRunAt: new Date(longRunAt).toISOString() } : {}),
        ...(warnedAt ? { warnedAt: new Date(warnedAt).toISOString() } : {}),
    });
    const killJob = (signal) => killTree(child.pid, signal, { kill: deps.kill });
    // The last KILL decides: a process it cannot signal is still there, so the stop failed. A TERM refused earlier
    // to a process that has ended since does not count.
    const endTimedOut = () => {
        if (ended) return;
        const refused = killJob("SIGKILL").refused;
        const why = refused.length ? `KILL refused for ${refused.join(", ")}` : null;
        journal.finish("timed-out", EXIT.timedOut, { ...stamps(), ...(why ? { stopFailed: why } : {}) });
        const how = why ? `stop failed after ${limit.killMin} min, ${why}` : `stopped after ${limit.killMin} min`;
        say(`timed out: exit ${EXIT.timedOut}, ${how}; hint: the kind was taken as `
            + `${job.kind} (--kind <name> overrides it), and --max-run <min> sets the limit directly`);
        end(EXIT.timedOut);
    };
    after(limit.killMin, () => {
        pastLimit = true;
        say(`run limit: stopping "${label}", KILL follows TERM after ${killGraceMs / 1000} s; ran ${limit.killMin} min `
            + `against a limit of ${limit.limitMin} min, set by ${limit.basis}`);
        killJob("SIGTERM");
        later(killGraceMs, () => killJob("SIGKILL"));
        // Backstop for a wrapper that never exits.
        later(Math.min(killGraceMs + 5000, MAX_TIMER_MS), endTimedOut);
    });
    if (job.priority) {
        after(limit.limitMin, () => {
            warnedAt = deps.now();
            say(`priority warning: hard stop at ${limit.killMin} min, the ${limit.limitMin} min limit `
                + `(set by ${limit.basis}) was passed by "${label}"`);
        });
    }
    if (limit.notifyLongRun) {
        after(limit.longRunMin, () => {
            longRunAt = deps.now();
            try {
                const alert = longRunAlert({
                    label, project, pid, minutes: minutesSince(startedAt, longRunAt), longRunBasis: limit.longRunBasis,
                    limitMin: limit.limitMin, killMin: limit.killMin, startedAt,
                    waiting: snapshot({ dirs: files }).queue, now: longRunAt, tz,
                });
                say(alert.message);
                deps.notify(alert.title, alert.message);
                deps.addNotice(alert.key, alert.entry, files.notices);
            } catch { /* a notice that fails must not disturb the job */ }
        });
    }
    wrapperEnd(child, child.stdio[3]).then(({ code, signal, report }) => {
        if (pastLimit) return endTimedOut();
        const startFailed = readStartFailure(report);
        if (startFailed !== null) {
            journal.finish("could-not-start", EXIT.noStart, stamps());
            say(`start failed: exit ${EXIT.noStart}, ${startFailed}`);
            return end(EXIT.noStart);
        }
        const exit = code ?? (signal ? 1 : 0);
        const how = jobEnd({ code, signal, received });
        const stoppedAt = new Date(receivedAt ?? deps.now()).toISOString();
        const stopped = how.signal ? { signal: how.signal, stoppedAt } : {};
        journal.finish(how.outcome, exit, { ...stamps(), ...stopped });
        if (how.signal) {
            say(`stopped: signal ${how.signal}, ${minutesSince(startedAt, deps.now())} min run, `
                + "journalled as stopped and not as failed");
        }
        end(exit);
    });
    // The wrapper is node itself, so this happens only when the system cannot start a process at all.
    child.on("error", (e) => {
        journal.finish("could-not-start", EXIT.noStart);
        say(`start failed: exit ${EXIT.noStart}, ${e.message}`);
        end(EXIT.noStart);
    });
    return result;
}

/** The writer of a job's one journal line. note({ startedAt, commit, tally, details }) fills in any of those as the
 *  job goes; finish() writes the line once and ignores later calls. */
export function journalWriter({ label, folder, cwd, priority, queuedAt, command, details, file, now }) {
    const known = { startedAt: null, commit: { head: null, clean: null }, tally: {}, details };
    let written = false;
    return {
        note(fields) {
            for (const name of Object.keys(known)) if (fields[name] !== undefined) known[name] = fields[name];
        },
        finish(outcome, exit, more = {}) {
            if (written) return;
            written = true;
            const { head, clean } = known.commit;
            append(record({
                label, project: folder, cwd, priority, queuedAt, startedAt: known.startedAt, endedAt: now(), outcome,
                exit, tally: known.tally, cmd: command, head, clean, extra: { ...known.details, ...more },
            }), file);
        },
    };
}

const sleepFor = (ms) => new Promise((done) => setTimeout(done, ms));

/** The deps of the real command. readHealth, notify and after(minutes, fn) come from the entry point. */
export function realDeps({ readHealth, notify, after }) {
    return {
        now: Date.now,
        sleep: sleepFor,
        readHealth,
        spawn: spawnProcess,
        say: (text) => process.stderr.write(`dotime-queue: ${text}\n`),
        usage: (text) => process.stderr.write(`${text}\n`),
        after,
        later: afterMs,
        kill: (pid, signal) => process.kill(pid, signal),
        notify,
        addNotice: storeNotice,
        gitState: readGitState,
        signals: process,
        cwd: () => process.cwd(),
        env: process.env,
    };
}

/** The folder the job runs in: ctx.cwd when given, else the current folder, read through deps.cwd(). Returns
 *  { cwd } or { error } when the current folder was removed. */
export function jobFolder(ctx, deps) {
    if (ctx.cwd !== undefined) return { cwd: ctx.cwd };
    try {
        return { cwd: deps.cwd() };
    } catch (e) {
        if (e.code !== "ENOENT") throw e;
        return { error: "the current folder was removed; start the job from a folder that exists" };
    }
}

/** Runs `dotime-queue run <args>` and resolves with its exit code. ctx: { settings, files, tz, cwd }; without cwd
 *  the current folder is read, and only after the arguments were found valid, so a usage error is reported the same
 *  way in a folder that was removed. A signal while the job waits takes it out of the line and resolves with 130
 *  instead of ending the process. A run whose deps.env holds a genuine marker of the job it runs in, in
 *  PARENT_MARKER or JOB_MARKER, is nested: once past the refusal check it runs with no slot, no place in line and no
 *  health gate, as soon as a place under that job is free. A test or lint check that already passed on the same clean
 *  commit is not run at all, nested or not, unless --no-skip is given: see skipFor. It takes no slot or place, is
 *  journalled as skipped with the stamp it relied on, and resolves with 0. */
export async function runCommand(args, ctx, deps) {
    const { settings, files, tz } = ctx;
    const { say, signals } = deps;
    const parsed = parseRunArgs(args, settings);
    if (parsed.error) {
        if (parsed.error === USAGE) deps.usage(USAGE);
        else say(parsed.error);
        return EXIT.usage;
    }
    const folderRead = jobFolder(ctx, deps);
    if (folderRead.error) {
        say(folderRead.error);
        return EXIT.usage;
    }
    const { cwd } = folderRead;
    const { label, cmd, priority, maxWait, maxRun, afterFix } = parsed;
    const queuedAt = deps.now();
    const folder = folderProject(cwd);
    const command = cmdString(cmd);
    const project = jobProject({ label, project: folder, cwd });
    const before = deps.gitState(cwd);
    const print = fingerprint(cwd, cmd, settings.outputDirs);
    const request = { label, command, kind: parsed.kind, maxRun, priority, afterFix, project, cwd, queuedAt, tz };
    // The journal is read and parsed once for the whole plan.
    const rows = parseLines(readLines(files.journal));
    const plan = planJob({ ...request, head: before.head, fingerprint: print }, settings, rows);
    const pid = process.pid;
    const markers = deps.env?.[PARENT_MARKER] || deps.env?.[JOB_MARKER];
    const outer = markers ? parentJob({ env: deps.env, pid, ...snapshot({ dirs: files }) }) : null;
    const details = outer ? { ...plan.details, nested: true } : plan.details;
    const journal = journalWriter({
        label, folder, cwd, priority, queuedAt, command, details, file: files.journal, now: deps.now,
    });
    if (plan.refusal) {
        journal.note({ commit: before });
        journal.finish("refused", EXIT.refused);
        say(`refused: exit ${EXIT.refused}; ${plan.refusal.reason}`);
        return EXIT.refused;
    }
    const stamp = skipFor({
        kind: plan.kind, label, command, project: folder, commit: before, noSkip: parsed.noSkip, at: queuedAt, tz,
    }, rows);
    if (stamp) {
        const ago = Math.max(0, Math.round((deps.now() - Date.parse(stamp.endedAt)) / MINUTE));
        journal.note({ commit: before });
        // The stamp is kept with the line, so history can tell how much run time the skip saved.
        journal.finish("skipped", 0, { stamp: { head: stamp.head, endedAt: stamp.endedAt, runMin: stamp.runMin } });
        say(`skipped: "${label}" already passed on commit ${String(stamp.head).slice(0, 8)} (${ago} min ago); `
            + "--no-skip runs it anyway");
        return 0;
    }
    if (plan.afterFixUsed) {
        say(`--after-fix accepted: note "${afterFix}", the check had failed twice on unchanged code`);
    }
    const { limit, kind } = plan;
    // INT and TERM wake the wait, which then returns, so the one exit path in main() ends the process. The leave
    // handlers stay until runJob has added its own: with no listener at all, a signal would end the process at once,
    // with no journal line and the slot, place or note left behind. A signal that arrives while the job is being
    // started reaches the handlers of the job and is passed on to it.
    const watch = watchLeave(signals, deps.sleep);
    const job = {
        pid, label, project, cwd, cmd, priority, kind, limit, settings, files, tz, journal, maxWait, handOver: watch.drop,
    };
    const waitDeps = { ...deps, sleep: watch.sleep, leaving: watch.leaving };
    try {
        if (!outer) return await runInLine(job, waitDeps, deps);
        const nested = await runNested({ ...job, outer }, waitDeps, deps);
        if (!nested.parentGone) return nested.exit;
        say(`parent gone: "${outer.label}", pid ${outer.pid}, ended while this run waited for a nested place; `
            + "joins the line as a normal run");
        journal.note({ details: plan.details });
        return await runInLine({ ...job, waitFrom: nested.waitFrom, tally: nested.tally }, waitDeps, deps);
    } finally {
        watch.drop();
    }
}

/** Watches INT and TERM while a run waits: the first one is kept, and each wakes the wait. Returns { leaving, sleep,
 *  drop }: leaving() names that signal or gives null, sleep is deps.sleep made wakeable, and drop() removes the
 *  handlers; calling it again does nothing. */
function watchLeave(signals, sleep) {
    let leaving = null;
    let dropped = false;
    const sleeps = wakeableSleep(sleep);
    const leavers = LEAVE_SIGNALS.map((signal) => [signal, () => {
        leaving ??= signal;
        sleeps.wake();
    }]);
    for (const [signal, handler] of leavers) signals.on(signal, handler);
    const drop = () => {
        if (dropped) return;
        dropped = true;
        for (const [signal, handler] of leavers) signals.off(signal, handler);
    };
    return { leaving: () => leaving, sleep: sleeps.sleep, drop };
}

/** Journals a wait that ended without a slot or place, and gives its exit code: 130 for a signal, 75 for the wait
 *  limit. Gives null when the wait ended with a slot or place and no signal is pending. */
function endOfWait(waited, journal, leaving) {
    journal.note({ tally: waited.tally });
    if (waited.left || leaving) {
        journal.finish("left", EXIT.left, { signal: waited.left ?? leaving });
        return EXIT.left;
    }
    if (waited.gaveUp) {
        journal.finish("gave-up", EXIT.gaveUp);
        return EXIT.gaveUp;
    }
    return null;
}

/** Runs a job that waits in line for a slot. job is the one runJob takes, with maxWait, and with waitFrom and tally
 *  only when it carries on an earlier wait. waitDeps are deps with the wakeable sleep and leaving() of runCommand. */
async function runInLine(job, waitDeps, deps) {
    const { pid, label, priority, kind, limit, project, cwd, settings, files, journal, maxWait } = job;
    const { signals } = deps;
    const ticket = enqueue(pid, label, priority, files);
    let slot = null;
    const leaveLine = () => {
        rmSync(ticket, { force: true });
        releaseSlot(slot, pid);
    };
    signals.on("exit", leaveLine);
    const slotMeta = {
        kind, limitMin: limit.limitMin, killMin: limit.killMin, longRunMin: limit.longRunMin, project, cwd,
        ...(priority ? { priority: true } : {}),
    };
    try {
        const { waitFrom, tally } = job;
        const waited = await waitForSlot({ pid, label, maxWait, slotMeta, settings, files, waitFrom, tally }, waitDeps);
        slot = waited.slot ?? null;
        const ended = endOfWait(waited, journal, waitDeps.leaving());
        if (ended !== null) return ended;
        rmSync(ticket, { force: true });
        return await runJob({ ...job, waitFrom: waited.waitFrom }, slot, deps);
    } finally {
        leaveLine();
        signals.off("exit", leaveLine);
    }
}

/** Runs a nested job: in no slot, but in one of the places under its parent job, the one in outer, waiting for one
 *  when all are taken. It is noted in the nested folder from the start, so `status` can show it under its parent, and
 *  the note is the marker its own job is handed. job is the one runJob takes, without waitFrom, and with outer and
 *  maxWait; waitDeps are as for runInLine. While it waits, INT and TERM take it out as they take a job out of the
 *  line; from the handlers runJob adds onwards everything is the same as for a job in a slot. Resolves with { exit },
 *  or with { parentGone: true, tally, waitFrom } when the parent ended while the run waited; its note is removed
 *  then, and the caller sends it to the line. */
async function runNested(job, waitDeps, deps) {
    const { pid, label, outer, files, journal, maxWait, settings } = job;
    const { signals, say } = deps;
    const intro = `nested: inside "${outer.label}", pid ${outer.pid}`;
    const parent = { marker: markerOf(outer.file), pid: outer.pid, born: outer.born, slot: slotMarkerOf(outer) };
    const note = addNested(pid, label, parent, files, { waiting: true });
    let place = null;
    const leave = () => {
        rmSync(note, { force: true });
        releaseSlot(place, pid);
    };
    signals.on("exit", leave);
    try {
        const waited = await waitForPlace({ pid, label, parent: outer, maxWait, settings, files }, waitDeps);
        place = waited.place ?? null;
        if (waited.parentGone && !waitDeps.leaving()) return waited;
        const ended = endOfWait(waited, journal, waitDeps.leaving());
        if (ended !== null) return { exit: ended };
        say(waited.atOnce ? `${intro}; starts at once: no slot, no place in line, no health gate`
            : `${intro}; starts now that a nested place is free: no slot, no place in line, no health gate`);
        updateSlot(note, pid, { waiting: undefined });
        return { exit: await runJob({ ...job, waitFrom: waited.waitFrom, slotMarker: parent.slot }, note, deps) };
    } finally {
        leave();
        signals.off("exit", leave);
    }
}
