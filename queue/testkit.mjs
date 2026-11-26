// Helpers shared by the test files: temp folders and started processes that are cleaned up when the test file
// ends (also after a failed assertion or a signal), a state folder of their own, and git commands cut off from the
// configuration and hooks of whoever runs the tests. Every test file imports this module first. Importing it already
// points DOTIME_HOME at a fresh temp folder and sends notices to the log file only, so a test that forgets
// isolateProcess() still never touches the real state folder.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { after } from "node:test";

const created = [], started = new Map();
const KILL_WAIT_MS = 300;

/** The start time `ps` reports for a pid, or "" when the pid is gone. A pid whose start time has changed belongs
 *  to another process now. */
function startedAt(pid) {
    const ps = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
    return ps.status === 0 ? ps.stdout.trim() : "";
}

/** True when a tracked pid may now name a process this file did not start. A group whose leader has exited keeps
 *  its id until its last member ends (the system does not hand out a pid that is still a group id), so an empty
 *  answer is only a sign of reuse for a single process. */
function reused(pid, since, group) {
    const now = startedAt(pid);
    return group ? now !== "" && now !== since : now !== since;
}

/** Registers a process this test file started: a child object or a pid. group: the pid leads its own process
 *  group, and the whole group is to be stopped. Returns what it was given. */
export function track(childOrPid, { group = false } = {}) {
    const pid = typeof childOrPid === "number" ? childOrPid : childOrPid?.pid;
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return childOrPid;
    started.set(pid, { group, since: typeof childOrPid === "number" ? startedAt(pid) : null });
    // An exited child is forgotten at once, so its pid is never signalled after the system may have reused it.
    if (typeof childOrPid === "object") childOrPid.once("exit", () => started.delete(pid));
    return childOrPid;
}
function signalStarted(signal) {
    let reached = 0;
    for (const [pid, { group, since }] of started) {
        if (since !== null && reused(pid, since, group)) { started.delete(pid); continue; }
        try { process.kill(group ? -pid : pid, signal); reached++; } catch { started.delete(pid); }
    }
    return reached;
}
/** Stops every tracked process that is still there: TERM, a short wait, then KILL. */
export async function stopTracked() {
    if (!signalStarted("SIGTERM")) return;
    await pause(KILL_WAIT_MS);
    signalStarted("SIGKILL");
    started.clear();
}

after(stopTracked);
process.on("exit", () => {
    // Nothing can be awaited here, so the wait between TERM and KILL blocks.
    if (signalStarted("SIGTERM")) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, KILL_WAIT_MS); signalStarted("SIGKILL"); }
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
});
// A signal ends the test file through the exit handler above instead of skipping it.
for (const [signal, code] of [["SIGHUP", 129], ["SIGINT", 130], ["SIGTERM", 143]]) process.once(signal, () => process.exit(code));

export function tempDir(name) {
    const dir = mkdtempSync(join(tmpdir(), `dotime-${name}-`));
    created.push(dir);
    return dir;
}

process.env.DOTIME_HOME = tempDir("home");
process.env.DOTIME_NOTIFY = "log";

// Test git runs see none of the developer's git setup: no global or system config, no global ignore or attributes
// file. GIT_CEILING_DIRECTORIES: a test folder that is not a repository never finds one above the temp folder (TMPDIR
// may sit inside a checkout). GIT_OPTIONAL_LOCKS=0 keeps a status check read-only, so a test that only looks at a
// repository never leaves a changed index file behind.
export const GIT_ENV = Object.freeze({
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "core.excludesFile", GIT_CONFIG_VALUE_0: "/dev/null", GIT_CONFIG_KEY_1: "core.attributesFile", GIT_CONFIG_VALUE_1: "/dev/null",
    GIT_CEILING_DIRECTORIES: realpathSync(tmpdir()), GIT_OPTIONAL_LOCKS: "0",
    GIT_AUTHOR_NAME: "tester", GIT_AUTHOR_EMAIL: "tester", GIT_COMMITTER_NAME: "tester", GIT_COMMITTER_EMAIL: "tester",
});
const QUEUE_ENV = { DOTIME_TZ: "UTC", DOTIME_NOTIFY: "log" };

// GIT_DIR, GIT_INDEX_FILE and friends are set when the tests run inside a git hook; inherited, they would point
// the test repositories at the developer's own repository. Every GIT_ variable is dropped before GIT_ENV is added.
const outside = (name) => !name.startsWith("DOTIME_") && !name.startsWith("GIT_");
const gitFree = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));

/** A copy of the environment without DOTIME_ and GIT_ variables, pointed at the given state folder. */
export function cleanEnv(home, extra = {}) {
    const inherited = Object.entries(process.env).filter(([name]) => outside(name));
    return { ...Object.fromEntries(inherited), ...GIT_ENV, ...QUEUE_ENV, DOTIME_HOME: home, ...extra };
}

/** Does the same to this process. Returns the new state folder. Call it before the modules under test are imported. */
export function isolateProcess(name) {
    for (const key of Object.keys(process.env)) if (!outside(key)) delete process.env[key];
    const home = tempDir(name);
    Object.assign(process.env, GIT_ENV, QUEUE_ENV, { DOTIME_HOME: home });
    return home;
}

// An older git ignores some of the variables above without a word and would read the developer's own settings, so
// the first git command of a test file refuses to run unless git reports no settings file at all under GIT_ENV.
let gitChecked = false;
function checkGitIsolation() {
    if (gitChecked) return;
    // from a fresh folder of its own: the ceiling stops git below the temp folder, not at it
    const probe = mkdtempSync(join(realpathSync(tmpdir()), "dotime-gitcheck-"));
    const env = { ...gitFree(), ...GIT_ENV };
    const seen = spawnSync("git", ["config", "--list", "--show-origin"], { cwd: probe, env, encoding: "utf8" });
    rmSync(probe, { recursive: true, force: true });
    if (seen.error || /^file:/m.test(seen.stdout ?? "")) {
        throw new Error("git still reads a settings file under the test settings; use a newer git to run the tests");
    }
    gitChecked = true;
}

export function git(cwd, ...args) {
    checkGitIsolation();
    const ran = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { env: { ...gitFree(), ...GIT_ENV }, encoding: "utf8" });
    if (ran.status !== 0) throw new Error(`git ${args[0]} did not succeed`);
    return ran.stdout;
}

/** Creates a repository with one commit holding the given files. */
export function makeRepo(dir, files = { "notes.txt": "first\n" }) {
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q");
    for (const [name, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, name)), { recursive: true });
        writeFileSync(join(dir, name), text);
    }
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "start");
    return dir;
}

/** One made-up environment variable per setting, named after its key path (health.minFreeDiskGB gives
 *  DOTIME_HEALTH_MINFREEDISKGB), all holding the same value. */
export function settingEnv(defaults, value, prefix = "DOTIME") {
    const env = {};
    for (const [key, fallback] of Object.entries(defaults)) {
        const name = `${prefix}_${key.toUpperCase()}`;
        if (fallback && typeof fallback === "object" && !Array.isArray(fallback)) Object.assign(env, settingEnv(fallback, value, name));
        else env[name] = String(value);
    }
    return env;
}

export const pause = (ms) => new Promise((done) => setTimeout(done, ms));
/** Waits until check() is truthy; throws after the time limit. */
export async function until(check, limitMs = 10_000) {
    for (const end = Date.now() + limitMs; Date.now() < end;) {
        if (check()) return;
        await pause(25);
    }
    throw new Error("the expected state was not reached in time");
}

/** Every notice stored in a notices folder, as { key: entry }. A file that cannot be read, is not JSON, or has a name
 *  that is not an encoded key is passed to warn(text) and left out. */
export function readNotices(dir, warn = () => {}) {
    let names = [];
    try { names = readdirSync(dir); } catch { /* no notices yet */ }
    const all = {};
    for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
        const file = join(dir, name);
        let key;
        try {
            key = decodeURIComponent(name.slice(0, -".json".length));
        } catch {
            warn(`notice ignored: ${file} is not named after a notice key`);
            continue;
        }
        let text;
        try {
            text = readFileSync(file, "utf8");
        } catch (e) {
            warn(`notice ignored: ${file} could not be read (${e.code ?? e.message})`);
            continue;
        }
        try {
            all[key] = JSON.parse(text);
        } catch {
            warn(`notice ignored: ${file} is not valid JSON`);
        }
    }
    return all;
}
