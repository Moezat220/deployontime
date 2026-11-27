// The `run` command, in three steps: planJob decides the limit and whether the job is refused, waitForSlot waits in
// line until a slot is taken, and runJob runs the job in its own process group under the limit. runCommand chains
// them and returns the exit code; it never ends the process itself. These come in through deps, so tests can drive
// each step: the clock, sleeping and timers, the health reading, the commit read when the job is queued and again
// when it starts, the current folder, starting the job, signals sent to it and signals received, messages,
// notifications and stored notices, and the environment in which a nested run finds the marker of its outer job.
// The rest is done directly: the slot, line and journal files in the folders named by files, the git calls for the
// project name and the code fingerprint, the process table read by snapshot and killTree, and this process's own
// pid and node binary.
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
import { addWait, append, cmdString, jobEnd, parseLines, readLines, record } from "./journal.mjs";
import { cmdStem, kindOf } from "./kinds.mjs";
import { decideLimit, kindStats, stemStats } from "./limits.mjs";
import { addNotice as storeNotice, longRunAlert } from "./notices.mjs";
import { JOB_MARKER, markerOf, outerJob } from "./nested.mjs";
import { killTree, signalGroup } from "./proctree.mjs";
import { folderProject, jobProject } from "./project.mjs";
import { addNested, enqueue, releaseSlot, snapshot, takeSlot, updateSlot } from "./slots.mjs";
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

/** Waits in line until this job holds a slot. job: { pid, label, maxWait, slotMeta, settings, files }. Priority
 *  plays no part in here: it is in the job's ticket, which orders the line, and in slotMeta.
 *  deps: { now, sleep, readHealth, say, leaving }; leaving() names a signal that asked the job to leave, or null.
 *  Returns { slot, tally, waitFrom }, { gaveUp: true, tally } or { left: signal, tally }; tally is the waiting time
 *  per gate in ms. */
export async function waitForSlot(job, deps) {
    const { pid, label, maxWait, settings, files } = job;
    const max = settings.slots;
    const tally = {};
    const waitFrom = deps.now();
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

/** Runs the job in a slot it holds and resolves with the exit code for `run`. job: { pid, label, project, cwd, cmd
 *  (the words), priority, kind, limit, waitFrom, settings, files, tz, journal, handOver, marker }, where journal is the
 *  writer from journalWriter() and handOver(), when given, is called as soon as the job's own signal handlers are in
 *  place, so the caller can remove the ones it had until then without a moment in which a signal finds none. The job
 *  finds marker, or else the marker of its slot, in JOB_MARKER. A nested run passes slot null and its outer marker.
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
    const env = { ...process.env, [JOB_MARKER]: job.marker ?? markerOf(slot) };
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

/** The writer of a job's one journal line. note({ startedAt, commit, tally }) fills in any of those as the job goes;
 *  finish() writes the line once and ignores later calls. */
export function journalWriter({ label, folder, cwd, priority, queuedAt, command, details, file, now }) {
    const known = { startedAt: null, commit: { head: null, clean: null }, tally: {} };
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
                exit, tally: known.tally, cmd: command, head, clean, extra: { ...details, ...more },
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
 *  instead of ending the process. A run whose deps.env holds a genuine marker of the job it runs in is nested: once
 *  past the refusal check it runs at once, with no slot, no place in line and no health gate. */
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
    const marker = deps.env?.[JOB_MARKER];
    const outer = marker ? outerJob({ marker, pid, holders: snapshot({ dirs: files }).holders }) : null;
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
    if (plan.afterFixUsed) {
        say(`--after-fix accepted: note "${afterFix}", the check had failed twice on unchanged code`);
    }
    const { limit, kind } = plan;
    const job = { pid, label, project, cwd, cmd, priority, kind, limit, settings, files, tz, journal };
    if (outer) return runNested({ ...job, outer }, deps);

    // Wait in line. INT and TERM wake the wait, which then returns, so the one exit path in main() ends the process.
    const ticket = enqueue(pid, label, priority, files);
    let slot = null;
    const leaveLine = () => {
        rmSync(ticket, { force: true });
        releaseSlot(slot, pid);
    };
    signals.on("exit", leaveLine);
    let leaving = null;
    const sleeps = wakeableSleep(deps.sleep);
    const leavers = LEAVE_SIGNALS.map((signal) => [signal, () => {
        leaving ??= signal;
        sleeps.wake();
    }]);
    for (const [signal, handler] of leavers) signals.on(signal, handler);
    const slotMeta = {
        kind, limitMin: limit.limitMin, killMin: limit.killMin, longRunMin: limit.longRunMin, project, cwd,
        ...(priority ? { priority: true } : {}),
    };
    const waitDeps = { ...deps, sleep: sleeps.sleep, leaving: () => leaving };
    // The leave handlers stay until runJob has added its own: with no listener at all, a signal would end the
    // process at once, with no journal line and the slot left behind. A signal that arrives while the job is being
    // started reaches the handlers of the job and is passed on to it.
    const dropLeavers = () => { for (const [signal, handler] of leavers) signals.off(signal, handler); };
    try {
        const waited = await waitForSlot({ pid, label, maxWait, slotMeta, settings, files }, waitDeps);
        journal.note({ tally: waited.tally });
        slot = waited.slot ?? null;
        if (waited.left || leaving) {
            journal.finish("left", EXIT.left, { signal: waited.left ?? leaving });
            return EXIT.left;
        }
        if (waited.gaveUp) {
            journal.finish("gave-up", EXIT.gaveUp);
            return EXIT.gaveUp;
        }
        rmSync(ticket, { force: true });
        return await runJob({ ...job, waitFrom: waited.waitFrom, handOver: dropLeavers }, slot, deps);
    } finally {
        dropLeavers();
        leaveLine();
        signals.off("exit", leaveLine);
    }
}

/** Runs a nested job: at once, in no slot, noted in the nested folder while it runs so `status` can show it under
 *  its outer job. job is the one runJob takes, without waitFrom, and with outer, the slot holder it runs inside.
 *  Everything from the handlers runJob adds onwards is the same as for a job in a slot. Until then leave handlers
 *  hold INT and TERM, as they do for a job in a slot, so a signal while the commit is read does not end the process
 *  with no journal line and the note left behind: runJob takes them over before such a signal is delivered, and it
 *  reaches the handlers of the job and is passed on to it. */
async function runNested(job, deps) {
    const { pid, label, outer, files } = job;
    const { signals } = deps;
    const marker = markerOf(outer.file);
    deps.say(`nested: inside "${outer.label}", pid ${outer.pid}; `
        + "starts at once: no slot, no place in line, no health gate");
    // They only keep the default action, ending the process, away: no signal reaches them, see above.
    const leavers = LEAVE_SIGNALS.map((signal) => [signal, () => {}]);
    for (const [signal, handler] of leavers) signals.on(signal, handler);
    const dropLeavers = () => { for (const [signal, handler] of leavers) signals.off(signal, handler); };
    const note = addNested(pid, label, { marker, pid: outer.pid, born: outer.born }, files);
    const forget = () => rmSync(note, { force: true });
    signals.on("exit", forget);
    try {
        return await runJob({ ...job, marker, waitFrom: deps.now(), handOver: dropLeavers }, null, deps);
    } finally {
        dropLeavers();
        forget();
        signals.off("exit", forget);
    }
}
