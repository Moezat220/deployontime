// The failure classes, read from short synthetic ends of output, and the order in which they win.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLASSES, ENV_CLASSES, failReason, SIGNS, SOURCES, textReason } from "./failreason.mjs";

const ran = (tail, exit = 1) => failReason({ tail, exit, outcome: "ran" });

test("failReason: each environment class from a realistic end of output", () => {
    const cases = [
        ["Error: listen EADDRINUSE: address already in use :::3000", "port", "EADDRINUSE"],
        ["OSError: [Errno 98] Address already in use", "port", "address already in use"],
        ["Error: read ECONNRESET\n    at TCP.onStreamRead", "network", "ECONNRESET"],
        ["npm ERR! network request to https://registry.example.org failed, reason: connect ETIMEDOUT", "network", "ETIMEDOUT"],
        ["Error: getaddrinfo ENOTFOUND registry.example.org", "network", "ENOTFOUND"],
        ["Error: getaddrinfo EAI_AGAIN registry.example.org", "network", "EAI_AGAIN"],
        ["connect ECONNREFUSED 127.0.0.1:5432", "network", "ECONNREFUSED"],
        ["Error: socket hang up", "network", "socket hang up"],
        ["Error: ENOSPC: no space left on device, write", "disk", "ENOSPC"],
        ["cp: cannot create file: No space left on device", "disk", "no space left on device"],
        ["Error: EMFILE: too many open files, watch", "files", "EMFILE"],
        ["Error: ENFILE: file table overflow", "files", "ENFILE"],
        ["OSError: [Errno 24] Too many open files", "files", "too many open files"],
        ["Error: spawn ENOMEM", "memory", "ENOMEM"],
        ["FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory", "memory", "JavaScript heap out of memory"],
    ];
    for (const [tail, cls, sign] of cases) assert.deepEqual(ran(tail), { class: cls, sign }, tail);
});

test("failReason: test runner summaries and assertion errors are class test", () => {
    const cases = [
        ["# tests 12\n# pass 11\n# fail 1\n", "# fail"],
        ["ℹ tests 12\nℹ pass 10\nℹ fail 2\n", "fail N"],
        ["Tests:       1 failed, 41 passed, 42 total", "Tests: failed"],
        ["      Tests  3 failed | 40 passed (43)", "Tests: failed"],
        [" FAIL  src/cart.test.ts > cart > adds an item", "FAIL"],
        ["  12 passing (40ms)\n  2 failing\n", "failing"],
        ["=========== 2 failed, 30 passed in 1.20s ===========", "pytest failed"],
        ["--- FAIL: TestCart (0.00s)\nFAIL\nexit status 1", "go FAIL"],
        ["AssertionError [ERR_ASSERTION]: Expected values to be strictly equal", "AssertionError"],
        ["Assertion failed: (count == 2), function main, file sample.c, line 9.", "assertion failed"],
    ];
    for (const [tail, sign] of cases) assert.deepEqual(ran(tail), { class: "test", sign }, tail);
});

test("failReason: compiler errors with a file and line are class build", () => {
    assert.deepEqual(ran("src/cart.ts(4,7): error TS2322: Type 'string' is not assignable"), { class: "build", sign: "error TS" });
    assert.deepEqual(ran("src/main.c:12:5: error: expected ';' after expression"), { class: "build", sign: "error:" });
    assert.deepEqual(ran("error[E0308]: mismatched types\n  --> src/main.rs:4:5"), { class: "build", sign: "error:" });
});

test("failReason: a passing summary or a zero count is no test failure", () => {
    assert.deepEqual(ran("# tests 3\n# pass 3\n# fail 0\n"), { class: "unknown" });
    assert.deepEqual(ran("Tests:       0 failed, 4 passed, 4 total"), { class: "unknown" });
    assert.deepEqual(ran("  0 failing\n"), { class: "unknown" });
    assert.deepEqual(ran(""), { class: "unknown" });
    assert.deepEqual(ran("something went wrong"), { class: "unknown" });
});

test("failReason: a test or build summary wins over an environment sign, which is named in alsoSaw", () => {
    const tail = "Error: read ECONNRESET\n    at TCP.onStreamRead\n# tests 4\n# pass 3\n# fail 1\n";
    assert.deepEqual(ran(tail), { class: "test", sign: "# fail", alsoSaw: "network" });
    assert.deepEqual(ran("ENOSPC: no space left on device\nsrc/a.ts(1,1): error TS1005: ';' expected"),
        { class: "build", sign: "error TS", alsoSaw: "disk" });
});

test("failReason: of two environment signs the class first in ENV_CLASSES wins", () => {
    assert.deepEqual(ENV_CLASSES, ["memory", "disk", "files", "port", "network"]);
    assert.deepEqual(ran("connect ECONNRESET\nError: EMFILE: too many open files"), { class: "files", sign: "EMFILE" });
});

test("failReason: a run limit comes first, then a signal, whatever the output says", () => {
    const tail = "# fail 2\nError: read ECONNRESET";
    assert.deepEqual(failReason({ tail, outcome: "timed-out", runLimitHit: true }), { class: "run-limit" });
    assert.deepEqual(failReason({ tail, outcome: "timed-out" }), { class: "run-limit" });
    assert.deepEqual(failReason({ tail, signal: "SIGTERM", outcome: "stopped" }), { class: "signal", sign: "SIGTERM" });
    assert.deepEqual(failReason({ tail, exit: 130, stoppedBy: "SIGINT", outcome: "stopped" }), { class: "signal", sign: "SIGINT" });
    assert.deepEqual(failReason({ outcome: "stopped" }), { class: "signal" });
});

test("failReason: the memory killer's Killed with exit 137 is memory, without it exit 137 stays a signal", () => {
    const killed = "  building...\nKilled\n";
    assert.deepEqual(failReason({ tail: killed, exit: 137, stoppedBy: "SIGKILL", outcome: "stopped" }), { class: "memory", sign: "Killed" });
    assert.deepEqual(failReason({ tail: "done", exit: 137, stoppedBy: "SIGKILL", outcome: "stopped" }), { class: "signal", sign: "SIGKILL" });
    assert.deepEqual(failReason({ tail: killed, signal: "SIGKILL", exit: null, outcome: "stopped" }), { class: "signal", sign: "SIGKILL" });
    assert.deepEqual(ran(killed, 1), { class: "unknown" }, "Killed alone, with another exit code, says nothing");
});

test("failReason: output not seen is unknown with its source; a reading from the wrapper is taken as found", () => {
    assert.deepEqual(failReason({ exit: 1, source: "tty" }), { class: "unknown", source: "tty" });
    assert.deepEqual(failReason({ exit: 1, source: "lost" }), { class: "unknown", source: "lost" });
    assert.deepEqual(failReason({ exit: 1, found: null }), { class: "unknown" });
    assert.deepEqual(failReason({ exit: 1, found: { class: "port", sign: "EADDRINUSE" } }), { class: "port", sign: "EADDRINUSE" });
    assert.deepEqual(failReason({ exit: 1, source: "tty", signal: "SIGTERM", outcome: "stopped" }), { class: "signal", sign: "SIGTERM" });
});

test("failReason: a reading from the wrapper with unknown words keeps only known classes and signs", () => {
    const sent = { class: "test", sign: "password=hunter2", alsoSaw: "secret-token" };
    assert.deepEqual(failReason({ exit: 1, found: sent }), { class: "test" });
    assert.deepEqual(failReason({ exit: 1, found: { class: "made-up", sign: "ECONNRESET" } }), { class: "unknown" });
});

test("failReason: a sign is only ever a word from the fixed list, never text of the output", () => {
    const secret = "TOKEN=abc123secret";
    const tails = [
        `${secret} Error: read ECONNRESET ${secret}`, `${secret}\n# fail 3\n${secret}`, `x.ts(1,1): error TS1: ${secret}`,
        `${secret} Killed`, `listen EADDRINUSE ${secret}`, secret,
    ];
    for (const tail of tails) {
        for (const exit of [1, 137]) {
            const reason = failReason({ tail, exit, outcome: exit === 137 ? "stopped" : "ran", stoppedBy: exit === 137 ? "SIGKILL" : null });
            assert.equal(CLASSES.includes(reason.class), true);
            if (reason.sign !== undefined) assert.equal(SIGNS.includes(reason.sign) || /^SIG[A-Z0-9]+$/.test(reason.sign), true, reason.sign);
            assert.equal(JSON.stringify(reason).includes("abc123"), false);
            for (const key of Object.keys(reason)) assert.equal(["class", "sign", "alsoSaw", "source"].includes(key), true, key);
        }
    }
    assert.deepEqual(failReason({ signal: "SIGTERM; rm -rf", outcome: "stopped" }), { class: "signal" });
});

test("textReason: null when the output points to nothing", () => {
    assert.equal(textReason("all good"), null);
    assert.deepEqual(textReason("connect ECONNREFUSED"), { class: "network", sign: "ECONNREFUSED" });
});

test("failReason: every source is kept with unknown, and a source that is not on the list is dropped", () => {
    for (const source of SOURCES) assert.deepEqual(failReason({ exit: 1, source }), { class: "unknown", source }, source);
    assert.deepEqual(failReason({ exit: 1, source: "TOKEN=abc" }), { class: "unknown" });
});

test("textReason: colour codes do not hide a summary, as a runner prints it with FORCE_COLOR", () => {
    const vitest = "\x1b[31mError: connect ECONNREFUSED 127.0.0.1:5432\x1b[39m\n"
        + "\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[31m1 failed\x1b[39m\x1b[22m\n"
        + "\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[31m2 failed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[1m\x1b[32m3 passed\x1b[39m\x1b[22m\n";
    assert.deepEqual(textReason(vitest), { class: "test", sign: "Tests: failed", alsoSaw: "network" });
    assert.deepEqual(textReason("\x1b[1m\x1b[31m# fail 2\x1b[0m\n"), { class: "test", sign: "# fail" });
});

test("textReason: 128 KB of blank lines, of space lines and of random text each take less than 200 ms", () => {
    let seed = 7;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
    const chars = "abcdefghij klmnop:=-#\n\t0123456789FAILTests";
    const noise = Array.from({ length: 131072 }, () => chars[random() % chars.length]).join("");
    for (const [name, text] of [["blank lines", "\n".repeat(131072)], ["space lines", " \n".repeat(65536)], ["random text", noise]]) {
        const began = process.hrtime.bigint();
        textReason(text, 1);
        const ms = Number(process.hrtime.bigint() - began) / 1e6;
        assert.equal(ms < 200, true, `${name}: ${ms.toFixed(1)} ms`);
    }
});
