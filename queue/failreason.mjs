// Why a job failed, as one class, read from the end of its output and from how it ended. Only the class and a
// fixed name for the sign that decided it are kept: a sign is a word from the lists below and never text taken from
// the output, so the journal holds no output, and with it no secret. This only records: nothing here changes how a
// run ends, its exit code, a skip, the repeated-failure stop or the flaky flag.

/** Classes from the environment, as opposed to a failure of the code: a retry could fix only these. */
export const ENV_CLASSES = Object.freeze(["memory", "disk", "files", "port", "network"]);
export const CLASSES = Object.freeze(["run-limit", "signal", ...ENV_CLASSES, "test", "build", "unknown"]);

/** How much of the end of a failed job's output the wrapper reads back to classify. */
export const TAIL_BYTES = 64 * 1024;

// [sign, pattern]. Each list is tried in order and the first match names the sign.
const TEST_SIGNS = [
    ["# fail", /^# fail [1-9]\d*[ \t\r]*$/m],
    ["fail N", /^ℹ fail [1-9]\d*[ \t\r]*$/m],
    ["Tests: failed", /^[ \t]*Tests:?[ \t].*\b[1-9]\d* failed\b/m],
    ["go FAIL", /^--- FAIL: |^FAIL\t\S/m],
    ["FAIL", /^[ \t]*FAIL[ \t]+\S/m],
    ["failing", /^[ \t]*[1-9]\d* failing[ \t\r]*$/m],
    ["pytest failed", /^=+ .*\b[1-9]\d* failed\b.* =+[ \t\r]*$|^FAILED \S+::/m],
    ["AssertionError", /\bAssertionError\b/],
    ["assertion failed", /\bassertion failed\b/i],
];
const BUILD_SIGNS = [
    ["error TS", /\berror TS\d+:/],
    ["error:", /^\S+:\d+(:\d+)?:[ \t]*(fatal )?error:|^error(\[E\d+\])?:.*\n[ \t]*--> \S+:\d+/m],
];
const ENV_SIGNS = {
    memory: [
        ["ENOMEM", /\bENOMEM\b/],
        ["JavaScript heap out of memory", /JavaScript heap out of memory/],
    ],
    disk: [
        ["ENOSPC", /\bENOSPC\b/],
        ["no space left on device", /no space left on device/i],
    ],
    files: [
        ["EMFILE", /\bEMFILE\b/],
        ["ENFILE", /\bENFILE\b/],
        ["too many open files", /too many open files/i],
    ],
    port: [
        ["EADDRINUSE", /\bEADDRINUSE\b/],
        ["address already in use", /address already in use/i],
    ],
    network: [
        ["ECONNRESET", /\bECONNRESET\b/],
        ["ETIMEDOUT", /\bETIMEDOUT\b/],
        ["ENOTFOUND", /\bENOTFOUND\b/],
        ["EAI_AGAIN", /\bEAI_AGAIN\b/],
        ["ECONNREFUSED", /\bECONNREFUSED\b/],
        ["socket hang up", /socket hang up/i],
        ["getaddrinfo", /\bgetaddrinfo\b/],
    ],
};
// A shell prints "Killed" for a child the kernel's memory killer ended, and exits 128 + 9.
const OOM_EXIT = 137;
const KILLED_RE = /(^|[ \t])Killed([ \t\r]|$)/m;

/** Every sign a reason may hold: the only words that can reach the journal besides the class. */
export const SIGNS = Object.freeze([
    ...TEST_SIGNS, ...BUILD_SIGNS, ...Object.values(ENV_SIGNS).flat(),
].map(([sign]) => sign).concat(["Killed"]));

/** Why the output of a failure was not read: it went to a terminal, a pipe or something else that is not a file, a
 *  file sink could not be read back, or no reading came back from the wrapper. */
export const SOURCES = Object.freeze(["tty", "pipe", "other", "unread", "lost"]);

// A signal name is a fixed word as well.
const STOP_SIGN_RE = /^SIG[A-Z0-9]{2,8}$/;

// Colour and cursor codes, as a runner prints them with FORCE_COLOR, would split the words the signs look for.
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

const firstSign = (list, text) => list.find(([, re]) => re.test(text))?.[0] ?? null;

/** The class the output alone points to, or null: { class, sign, alsoSaw? }. A test or build summary wins over an
 *  environment sign, which is then named in alsoSaw: an environment error inside a failing test is still counted as a
 *  test failure. Environment classes are tried in the order of ENV_CLASSES. exit: the exit code, for the memory
 *  killer's "Killed" with 137. */
export function textReason(tail, exit = null) {
    const text = String(tail ?? "").replace(ANSI_RE, "");
    let env = null;
    for (const name of ENV_CLASSES) {
        const sign = firstSign(ENV_SIGNS[name], text);
        if (sign) { env = { class: name, sign }; break; }
    }
    if (!env && exit === OOM_EXIT && KILLED_RE.test(text)) env = { class: "memory", sign: "Killed" };
    const test = firstSign(TEST_SIGNS, text);
    const build = test ? null : firstSign(BUILD_SIGNS, text);
    if (test || build) {
        return { class: test ? "test" : "build", sign: test ?? build, ...(env ? { alsoSaw: env.class } : {}) };
    }
    return env;
}

/** The reason of a failed run: { class, sign?, alsoSaw?, source? }. tail: the end of the output, or found: the
 *  textReason() of it, worked out by the wrapper; neither when the output was not seen. exit and signal: how the job
 *  ended, where signal is a signal the job died by or the queue received; stoppedBy: the signal the journal names for a
 *  stop, which may come from a shell's exit code (128 + n) alone. outcome: the journal outcome; runLimitHit: the run
 *  limit stopped it. A run limit comes first, then a stop by a signal, except a stop by exit 137 alone whose output
 *  shows the memory killer's "Killed"; neither needs the output. source: why the output was not read, one of
 *  SOURCES; it is kept only with class unknown. */
export function failReason({
    tail, found, exit = null, signal = null, stoppedBy = null, outcome = "ran", runLimitHit = false, source,
}) {
    const read = found !== undefined ? found : tail != null ? textReason(tail, exit) : null;
    if (runLimitHit || outcome === "timed-out") return { class: "run-limit" };
    if (signal || outcome === "stopped") {
        const byExitAlone = !signal && exit === OOM_EXIT;
        if (byExitAlone && read?.class === "memory" && read.sign === "Killed") return { class: "memory", sign: "Killed" };
        const sign = signal ?? stoppedBy;
        return { class: "signal", ...(STOP_SIGN_RE.test(sign ?? "") ? { sign } : {}) };
    }
    if (read) return clean(read);
    return { class: "unknown", ...(SOURCES.includes(source) ? { source } : {}) };
}

// A reason from the wrapper is a message from another process: only known classes and signs are let through.
function clean(read) {
    if (!CLASSES.includes(read.class)) return { class: "unknown" };
    return {
        class: read.class,
        ...(SIGNS.includes(read.sign) ? { sign: read.sign } : {}),
        ...(ENV_CLASSES.includes(read.alsoSaw) ? { alsoSaw: read.alsoSaw } : {}),
    };
}
