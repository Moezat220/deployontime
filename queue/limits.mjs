// Run limits, the stop for a check that keeps failing on unchanged code, and the long-run and idle-slot notices.
// A limit is taken from the journal: from earlier runs of the same command when there are enough, else from runs of
// the same kind, else from a default. An unreadable journal counts as no history and never holds a job back.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { isSandbox, loadSettings, paths, timeZone } from "./settings.mjs";
import { clockTime } from "./clock.mjs";
import { isFailedRun, isStopped, lineProject, parseLines, readOnlyGit } from "./journal.mjs";
import { psSeconds, sampleKeepMs, slotIdleVerdict } from "./idle.mjs";
import { probeProcessCpu, probeProcessTree } from "./probes.mjs";
import { pctl } from "./stats.mjs";

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const limitSettings = () => loadSettings().limits;
const oneDecimal = (x) => Math.round(x * 10) / 10;

/** The label a job gets when --label is missing. */
export const UNLABELLED = "unnamed";

// Node runs a timer longer than this after 1 ms, so longer waits are made of several timers in a row.
export const MAX_TIMER_MS = 2 ** 31 - 1;
function longTimer(fn, ms) {
    return setTimeout(() => (ms > MAX_TIMER_MS ? longTimer(fn, ms - MAX_TIMER_MS) : fn()), Math.min(ms, MAX_TIMER_MS)).unref();
}

/** An unref'd timer measured in minutes; past about 24 days only its first part can be cleared. Tests can drive it:
 *  with a sandbox state folder and DOTIME_FAKE_CLOCK set, the elapsed minutes are polled from the file that variable
 *  names. */
export function afterMinutes(min, fn, env = process.env) {
    const fakeClock = env.DOTIME_FAKE_CLOCK && isSandbox(env) ? env.DOTIME_FAKE_CLOCK : null;
    if (!fakeClock) return longTimer(fn, min * MINUTE);
    const poll = setInterval(() => {
        let passed = 0;
        try { passed = Number(readFileSync(fakeClock, "utf8")) || 0; } catch { /* no file yet */ }
        if (passed >= min) { clearInterval(poll); fn(); }
    }, 50);
    return poll.unref();
}

// ---- job kinds ----

const DEBUG_WORDS = "debug|repro|bisect|probe";
export const DEBUG_LABEL_RE = new RegExp(`\\b(${DEBUG_WORDS})\\b|\\?`, "i");
// In a command the word must not be followed by "=", so setting a DEBUG variable does not make a debug job.
export const DEBUG_CMD_RE = new RegExp(`\\b(${DEBUG_WORDS})\\b(?!=)`, "i");
/** The label without its "project:" prefix, so a project name never decides the kind. */
const taskOf = (label) => String(label ?? "").replace(/^[^:]{1,40}:\s*/, "");

// Ordered from heaviest to lightest; the first match wins.
export const KINDS = [
    ["deploy", /\b(deploy|release|publish)\b/i],
    ["test", /\b(tests?|check|suite|spec|e2e|vitest|jest|playwright)\b|node --test/i],
    ["build", /\b(build|bundle|compile)\b/i],
    ["lint", /\b(lint|typecheck|tsc|format)\b/i],
];
/** A given kind wins. Otherwise the label's task part is read first, then the command, and in each a debug word
 *  comes before KINDS; "other" when nothing matches. */
export function kindOf(label, command, given) {
    if (given) return String(given).toLowerCase();
    for (const [text, debugRe] of [[taskOf(label), DEBUG_LABEL_RE], [String(command ?? ""), DEBUG_CMD_RE]]) {
        if (debugRe.test(text)) return "debug";
        const hit = KINDS.find(([, pattern]) => pattern.test(text));
        if (hit) return hit[0];
    }
    return "other";
}

// ---- command stems ----
// The stem is what stays the same between two runs of one command: the program and the task it is given, without
// paths, flags or variable assignments. Runs are compared with earlier runs that have the same stem.

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn"]);
const TOOL_RUNNERS = new Set(["npx", "pnpx", "bunx"]);
const SHELLS = new Set(["sh", "bash", "zsh"]);
const INTERPRETERS = new Set(["node", "tsx", "ts-node", "vite-node", "bun", "deno", "python", "python3", ...SHELLS]);
const INLINE_CODE_FLAGS = new Set(["-e", "-c", "--eval"]);
const baseName = (word) => String(word).split("/").pop();
const isPlainWord = (word) => /^[a-z][\w:.-]*$/i.test(word);

function splitWords(line) {
    const words = String(line ?? "").match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? [];
    return words.map((word) => {
        if (!word.startsWith('"')) return word;
        try { return JSON.parse(word); } catch { return word; }
    });
}
function stemOfWords(words) {
    let first = 0;
    while (first < words.length && (words[first] === "env" || /^[A-Za-z_]\w*=/.test(words[first]))) first++;
    const program = baseName(words[first] ?? "");
    if (!program) return null;
    const args = words.slice(first + 1).filter((word) => !word.startsWith("-") || INLINE_CODE_FLAGS.has(word));
    if (SHELLS.has(program) && args[0] === "-c") {
        // sh -c "a && b": stem each chained command, then join.
        const parts = String(args[1] ?? "").split(/&&|\|\||[;|]/).map((part) => stemOfWords(splitWords(part.trim())));
        return parts.filter(Boolean).join(" && ") || null;
    }
    if (INLINE_CODE_FLAGS.has(args[0])) return null;
    if (PACKAGE_MANAGERS.has(program)) return [program, ...args.slice(0, args[0] === "run" || args[0] === "exec" ? 2 : 1)].join(" ");
    if (TOOL_RUNNERS.has(program)) {
        if (INTERPRETERS.has(args[0])) return [program, args[0], ...args.slice(1, 2).map(baseName)].join(" ");
        return [program, ...args.slice(0, 1), ...args.slice(1, 2).filter(isPlainWord)].join(" ");
    }
    if (INTERPRETERS.has(program)) return [program, ...args.slice(0, 1).map(baseName)].join(" ");
    return [program, ...args.slice(0, 1).filter(isPlainWord)].join(" ");
}
const stemCache = new Map();
/** The stem of a command line as written by cmdString(), or null when it has none (inline code, empty line). */
export function cmdStem(command) {
    const line = String(command ?? "");
    if (!stemCache.has(line)) stemCache.set(line, stemOfWords(splitWords(line)) || null);
    return stemCache.get(line);
}

// ---- statistics over earlier runs ----

function passedRuns(lines, { project, now, windowDays }) {
    const oldest = now - windowDays * DAY;
    return parseLines(lines).filter((row) => {
        const ended = Date.parse(row.endedAt);
        return lineProject(row) === project && row.outcome === "ran" && row.exit === 0 && ended >= oldest && ended <= now;
    });
}
const runTimes = (rows) => rows.map((row) => row.runMin ?? 0);
/** Returns { n, p75, p90 } in minutes, over passed runs of one kind in one project. */
export function kindStats(lines, { project, kind, now = Date.now(), windowDays = limitSettings().windowDays }) {
    const times = runTimes(passedRuns(lines, { project, now, windowDays }).filter((row) => (row.kind ?? kindOf(row.label, row.cmd)) === kind));
    return { n: times.length, p75: pctl(times, 0.75), p90: pctl(times, 0.9) };
}
/** Returns { n, p75, p90, max, stem } in minutes, over passed runs with one command stem in one project. */
export function stemStats(lines, { project, stem, now = Date.now(), windowDays = limitSettings().windowDays }) {
    if (!stem) return { n: 0, stem: null };
    const times = runTimes(passedRuns(lines, { project, now, windowDays }).filter((row) => cmdStem(row.cmd) === stem));
    return { n: times.length, p75: pctl(times, 0.75), p90: pctl(times, 0.9), max: times.length ? Math.max(...times) : null, stem };
}

/** Picks the run limit and the long-run mark for a job.
 *  Returns { limitMin, basis, longRunMin, longRunBasis, killMin, notifyLongRun }; killMin is when the job is stopped. */
export function decideLimit({ maxRun = null, kind, stats = { n: 0 }, stem = null, priority = false }, L = limitSettings()) {
    const ownHistory = (stem?.n ?? 0) >= L.minSamples;
    const source = ownHistory ? stem : stats, subject = ownHistory ? `command "${stem.stem}"` : `kind ${kind}`;
    const measured = source.n >= L.minSamples, fixed = maxRun != null || kind === "debug";
    let limitMin, basis;
    if (maxRun != null) {
        limitMin = maxRun; basis = "the --max-run flag";
    } else if (kind === "debug") {
        limitMin = L.debugMin; basis = "the debug-job setting";
    } else if (measured) {
        const fromRuns = oneDecimal(source.p90 * L.p90Factor);
        limitMin = Math.max(L.floorMin, fromRuns);
        basis = `${source.n} passed runs of ${subject} (${L.p90Factor} times their p90 of ${source.p90} min${fromRuns < L.floorMin ? `, lifted to the ${L.floorMin} min minimum` : ""})`;
    } else {
        limitMin = L.defaultMin; basis = `the default (${source.n} of the ${L.minSamples} passed runs needed for ${subject})`;
    }
    const markFrom = (s, what) => `${L.longRunFactor} times the p75 of ${s.p75} min over ${s.n} passed runs of ${what}`;
    let longRunMin = measured ? Math.max(L.floorMin, oneDecimal(source.p75 * L.longRunFactor)) : L.longRunUnmeasuredMin;
    let longRunBasis = measured ? markFrom(source, subject) : `the ${L.longRunUnmeasuredMin} min setting for jobs without history`;
    // A command with only a few runs cannot set the limit, but it may raise one that its own runs already exceed.
    if (!ownHistory && stem?.n > 0) {
        const fromLongest = oneDecimal(stem.max * L.p90Factor), ownMark = oneDecimal(stem.p75 * L.longRunFactor);
        if (!fixed && fromLongest > limitMin) {
            limitMin = fromLongest;
            basis = `${stem.max} min, the longest passed run of command "${stem.stem}" (${stem.n} on record), times ${L.p90Factor}; that is more than ${basis}`;
        }
        if (ownMark > longRunMin) { longRunMin = ownMark; longRunBasis = markFrom(stem, `command "${stem.stem}"`); }
    }
    const killMin = priority ? limitMin * L.priorityGrace : limitMin;
    return { limitMin, basis, longRunMin, longRunBasis, killMin, notifyLongRun: longRunMin < killMin };
}

// ---- flags ----

/** The value of --name <value> or --name=<value> among the flags in front of "--"; undefined when absent. */
export function opt(args, name) {
    const cut = args.indexOf("--"), flags = cut < 0 ? args : args.slice(0, cut);
    const joined = flags.find((a) => a.startsWith(`${name}=`)), at = flags.indexOf(name);
    return joined ? joined.slice(name.length + 1) : at >= 0 ? flags[at + 1] : undefined;
}
/** --max-run in minutes: null when absent, NaN when it is not a number above 0. */
export function parseMaxRun(args) {
    const raw = opt(args, "--max-run");
    if (raw === undefined) return null;
    const value = Number(raw);
    return raw !== "" && Number.isFinite(value) && value > 0 ? value : NaN;
}

// ---- code fingerprint ----
// A hash that moves when the code under test moves. Tracked files always count. Small untracked files are hashed
// whole, big ones as size plus modification time. Untracked files in output folders, and untracked media, archive
// and log files, stay out of it: a check rewrites those on every run.

export const UNTRACKED = { maxFileBytes: 1024 * 1024, maxFiles: 2000, maxTotalBytes: 32 * 1024 * 1024 };
const SKIPPED_UNTRACKED_RE = /\.(png|jpe?g|gif|webp|avif|ico|bmp|mp4|webm|mov|pdf|zip|t?gz|log)$/i;
const SCRIPT_MAX_BYTES = 4 * 1024 * 1024;

function addUntracked(hash, cwd, ignoreDirs) {
    const top = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 10_000, env: readOnlyGit() }).stdout?.trim();
    if (!top) return;
    const excludes = ignoreDirs.map((dir) => `:(top,exclude,glob)**/${dir}/**`);
    const listed = spawnSync("git", ["-C", top, "ls-files", "-o", "--exclude-standard", "-z", "--", ".", ...excludes], { encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024 * 1024, env: readOnlyGit() });
    if (listed.status !== 0) { hash.update("untracked-unknown"); return; }
    const files = listed.stdout.split("\0").filter((name) => name && !SKIPPED_UNTRACKED_RE.test(name)).sort().slice(0, UNTRACKED.maxFiles);
    let bytesRead = 0;
    for (const name of files) {
        try {
            const path = join(top, name), info = statSync(path);
            if (!info.isFile()) continue;
            hash.update(`\0${name}\0`);
            if (info.size <= UNTRACKED.maxFileBytes && bytesRead + info.size <= UNTRACKED.maxTotalBytes) { hash.update(readFileSync(path)); bytesRead += info.size; }
            else hash.update(`${info.size}:${info.mtimeMs}`);
        } catch { /* the file went away */ }
    }
}
/** A short hash over uncommitted changes, untracked files and any file named in the command. Never throws. */
export function codePrint(cwd, command = [], ignoreDirs = loadSettings().outputDirs) {
    const hash = createHash("sha1");
    try {
        // --no-ext-diff --no-textconv: a diff program configured in the repository is never started by the queue
        for (const args of [["status", "--porcelain"], ["diff", "--no-ext-diff", "--no-textconv", "HEAD"]]) {
            const ran = spawnSync("git", ["-C", cwd, ...args], { encoding: "buffer", timeout: 15_000, maxBuffer: 256 * 1024 * 1024, env: readOnlyGit() });
            hash.update(ran.status === 0 ? ran.stdout : Buffer.from("git-unknown"));
        }
        addUntracked(hash, cwd, ignoreDirs);
    } catch { hash.update("git-unknown"); }
    for (const arg of command) {
        try {
            const path = arg.startsWith("/") ? arg : join(cwd, arg), info = statSync(path);
            if (info.isFile() && info.size < SCRIPT_MAX_BYTES) hash.update(readFileSync(path));
        } catch { /* not a file */ }
    }
    return hash.digest("hex").slice(0, 16);
}

// ---- repeated-failure stop ----

const failed = (row) => row.outcome === "timed-out" || isFailedRun(row);
const bothDiffer = (a, b) => a != null && b != null && a !== b;
/** Should this run be refused because the same check just failed twice on the same code?
 *  job = { label, cmd, project, cwd, head, fp, at }.
 *  Returns { refuse: false }, { refuse: false, changed: "commit" | "files" | "command" } or { refuse: true, reason }. */
export function failStop(lines, job, L = limitSettings(), tz = timeZone()) {
    // Runs are one check when their labels match; failing that, when command, project and folder all match.
    const sameCheck = (row) => (job.label !== UNLABELLED && row.label === job.label)
        || (!!job.cmd && row.cmd === job.cmd && lineProject(row) === job.project && (!job.cwd || !row.cwd || row.cwd === job.cwd));
    const finished = parseLines(lines)
        .filter((row) => row.endedAt && (row.outcome === "timed-out" || (row.outcome === "ran" && !isStopped(row))) && sameCheck(row))
        .sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt));
    const [last, previous] = finished;
    if (!last || !previous || !failed(last) || !failed(previous)) return { refuse: false };
    if ((job.at ?? Date.now()) - Date.parse(previous.endedAt) > L.failWindowHours * HOUR) return { refuse: false };
    if (last.head !== previous.head || bothDiffer(last.fp, previous.fp) || bothDiffer(last.cmd, previous.cmd)) return { refuse: false };
    if (last.head !== undefined && last.head !== job.head) return { refuse: false, changed: "commit" };
    if (bothDiffer(last.fp, job.fp)) return { refuse: false, changed: "files" };
    if (bothDiffer(last.cmd, job.cmd)) return { refuse: false, changed: "command" };
    const ending = (row) => `${row.outcome === "timed-out" ? "run limit hit" : `exit ${row.exit}`} at ${clockTime(Date.parse(row.endedAt), tz)}`;
    const commit = last.head ? `, commit ${String(last.head).slice(0, 8)}` : "";
    return {
        refuse: true,
        reason: `same check failed twice on unchanged code: "${job.label}"${commit}, ${ending(previous)}, then ${ending(last)}; `
            + 'hint: change the code, or pass --after-fix "<note>" before the -- to run it anyway',
    };
}

// ---- notices ----

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
        let all = {};
        try { all = JSON.parse(readFileSync(file, "utf8")); } catch { /* start a new file */ }
        if (all[key]) return false;
        all[key] = entry;
        mkdirSync(dirname(file), { recursive: true });
        const temp = `${file}.tmp-${process.pid}`;
        writeFileSync(temp, JSON.stringify(all, null, 1));
        renameSync(temp, file);
        return true;
    } catch { return false; }
}

// ---- process trees ----

/** Parses `ps -o pid=,ppid=,pgid=[,time=]` text into [{ pid, ppid, pgid, cpu }]; cpu is 0 without a time column. */
export function psRows(text) {
    const rows = [];
    for (const line of String(text ?? "").split("\n")) {
        const [pid, ppid, pgid, time] = line.trim().split(/\s+/);
        if (![pid, ppid, pgid].every((x) => /^\d+$/.test(x ?? ""))) continue;
        rows.push({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), cpu: time ? psSeconds(time) : 0 });
    }
    return rows;
}
// Group members first, then descendants by parent pid, which also catches children that changed group.
function jobPids(leader, rows) {
    const pids = new Set([leader]);
    for (const row of rows) if (row.pgid === leader) pids.add(row.pid);
    for (let grew = true; grew;) {
        grew = false;
        for (const row of rows) if (pids.has(row.ppid) && !pids.has(row.pid)) { pids.add(row.pid); grew = true; }
    }
    return pids;
}
/** The pids of a job, from the given `ps` text or a fresh listing. */
export function treePids(leader, ps = null) {
    return [...jobPids(leader, psRows(ps ?? probeProcessTree()))];
}
/** Returns null for a holder whose leader process is not listed, else the CPU seconds of all its processes. */
export function jobCpu(holder, rows) {
    const leader = holder.pgid ?? holder.pid;
    if (!rows.some((row) => row.pid === leader)) return null;
    const pids = jobPids(leader, rows);
    return Math.round(rows.reduce((sum, row) => sum + (pids.has(row.pid) ? row.cpu : 0), 0) * 100) / 100;
}
/** Returns the pids it signalled: the group as a whole first, then each process of the job. */
export function killTree(leader, signal, ps = null) {
    const pids = treePids(leader, ps);
    try { process.kill(-leader, signal); } catch { /* no such group */ }
    for (const pid of pids) { try { process.kill(pid, signal); } catch { /* already gone */ } }
    return pids;
}
