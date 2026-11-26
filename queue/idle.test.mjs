import "./testkit.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { idleText, isServer, psSeconds, sampleKeepMs, SAMPLING, serverIdleVerdict, sinceReset, slotIdleVerdict, TEST_RUN_RE } from "./idle.mjs";
import { DEFAULTS } from "./settings.mjs";

const MINUTE = 60_000, PATTERN = DEFAULTS.reaper.serverPattern;
const IDLE = { serverIdleMin: 40, serverCpuS: 8, slotIdleMin: 15, slotCpuS: 4 };
const NOW = 500 * MINUTE;
const at = (minutesAgo, cpu) => ({ t: NOW - minutesAgo * MINUTE, cpu });

test("isServer: watch-mode tools match the default pattern, one-shot commands do not", () => {
    const servers = ["node /srv/shop-api/node_modules/.bin/vite", "node /srv/docs-site/node_modules/.bin/next dev -p 4100", "npx wrangler dev", "node node_modules/.bin/webpack serve", "nodemon src/api.js", "node node_modules/.bin/vitest"];
    const others = ["node node_modules/.bin/vitest run", "node --test", "node scripts/build.mjs", "next build", "wrangler deploy", "npm install", "node node_modules/.bin/vite build --watch"];
    for (const command of servers) assert.equal(isServer(command, PATTERN), true, command);
    for (const command of others) assert.equal(isServer(command, PATTERN), false, command);
});

test("isServer: follows the pattern it is given and rejects a broken one", () => {
    assert.equal(isServer("preview-server --port 4300", "preview-server"), true);
    assert.equal(isServer("node node_modules/.bin/vite", "preview-server"), false);
    assert.equal(isServer("preview-server", "[unclosed"), false);
});

test("TEST_RUN_RE: matches test commands that exit by themselves", () => {
    for (const command of ["npx vitest run", "npx vitest --run", "node --test queue/", "npx playwright test --project mobile", "node node_modules/.bin/jest"]) assert.equal(TEST_RUN_RE.test(command), true, command);
    for (const command of ["npx vitest", "node node_modules/.bin/jest --watch", "node server.js"]) assert.equal(TEST_RUN_RE.test(command), false, command);
});

test("sinceReset: drops everything before the last fall of the CPU total", () => {
    const samples = [at(40, 30), at(30, 44), at(20, 7), at(10, 9), at(0, 9)];
    assert.deepEqual(sinceReset(samples), samples.slice(2));
    assert.deepEqual(sinceReset([at(20, 3), at(10, 3), at(0, 8)]).length, 3);
    assert.deepEqual(sinceReset([]), []);
});

test("sampleKeepMs: grows with the idle window", () => {
    assert.equal(sampleKeepMs(35), (35 + SAMPLING.marginMin) * MINUTE);
    assert.equal(sampleKeepMs(90) - sampleKeepMs(35), 55 * MINUTE);
    assert.equal(sampleKeepMs(IDLE.serverIdleMin) > (IDLE.serverIdleMin + SAMPLING.bandMin) * MINUTE, true);
});

test("serverIdleVerdict: reports each state", () => {
    const verdict = (input) => serverIdleVerdict({ ageMs: 5 * 60 * MINUTE, now: NOW, ...input }, IDLE);
    assert.deepEqual(verdict({ samples: [at(44, 600), at(0, 606.5)] }), { idle: true, state: "idle", usedS: 6.5, minutes: 44 });
    assert.deepEqual(verdict({ samples: [at(44, 600), at(0, 675)] }), { idle: false, state: "active", usedS: 75, minutes: 44 });
    assert.deepEqual(verdict({ samples: [at(25, 600), at(0, 600)] }), { idle: false, state: "sampling" });
    assert.deepEqual(verdict({ samples: [] }), { idle: false, state: "sampling" });
    assert.deepEqual(verdict({ samples: [at(44, 600), at(0, 600)], ageMs: (IDLE.serverIdleMin - 3) * MINUTE }), { idle: false, state: "new" });
    assert.deepEqual(verdict({ samples: [at(44, 600), at(0, 600)], exempt: true }), { idle: false, state: "protected" });
});

test("serverIdleVerdict: a fall of the CPU total restarts the measurement", () => {
    const verdict = serverIdleVerdict({ ageMs: 5 * 60 * MINUTE, samples: [at(44, 900), at(20, 15), at(0, 16)], now: NOW }, IDLE);
    assert.deepEqual(verdict, { idle: false, state: "restarted" });
});

test("serverIdleVerdict: the older sample must lie inside the band behind the window", () => {
    const beyondBand = [at(IDLE.serverIdleMin + SAMPLING.bandMin, 5), at(0, 5)];
    assert.equal(serverIdleVerdict({ ageMs: 5 * 60 * MINUTE, samples: beyondBand, now: NOW }, IDLE).state, "sampling");
    const longWindow = { ...IDLE, serverIdleMin: 90 };
    assert.equal(serverIdleVerdict({ ageMs: 5 * 60 * MINUTE, samples: [at(44, 5), at(0, 5)], now: NOW }, longWindow).state, "sampling");
    assert.equal(serverIdleVerdict({ ageMs: 5 * 60 * MINUTE, samples: [at(93, 5), at(0, 5)], now: NOW }, longWindow).idle, true);
});

test("slotIdleVerdict: reports each state with the measured use", () => {
    const verdict = (startedAgo, samples) => slotIdleVerdict({ startedAt: NOW - startedAgo * MINUTE, samples, now: NOW }, IDLE);
    assert.deepEqual(verdict(55, [at(34, 70), at(17, 70.5), at(0, 73.1)]), { idle: true, state: "idle", usedS: 2.6, minutes: 17, since: NOW - 17 * MINUTE });
    assert.deepEqual(verdict(55, [at(17, 70), at(0, 190)]), { idle: false, state: "active", usedS: 120, minutes: 17 });
    assert.deepEqual(verdict(55, [at(22, 400), at(6, 3), at(0, 3)]), { idle: false, state: "restarted" });
    assert.deepEqual(verdict(55, [at(9, 2), at(0, 2)]), { idle: false, state: "sampling" });
    assert.deepEqual(verdict(55, [at(0, 2)]), { idle: false, state: "sampling" });
    assert.deepEqual(verdict(11, [at(11, 2), at(0, 2)]), { idle: false, state: "new" });
});

test("slotIdleVerdict: accepts a sample that is a few seconds short of the window", () => {
    const windowStart = NOW - IDLE.slotIdleMin * MINUTE, startedAt = NOW - 90 * MINUTE;
    const nearly = { t: windowStart + 20_000, cpu: 8 }, short = { t: windowStart + 2 * SAMPLING.toleranceMs, cpu: 8 };
    assert.equal(slotIdleVerdict({ startedAt, samples: [nearly, at(0, 8)], now: NOW }, IDLE).idle, true);
    assert.equal(slotIdleVerdict({ startedAt, samples: [short, at(0, 8)], now: NOW }, IDLE).state, "sampling");
});

test("idleText: use and time span in one phrase", () => {
    assert.equal(idleText({ usedS: 3.5, minutes: 22 }), "3.5 s of CPU in 22 min");
    assert.equal(idleText({ usedS: 0, minutes: 10 }), "0.0 s of CPU in 10 min");
});

test("psSeconds: converts every `ps` time layout", () => {
    assert.equal(psSeconds("0:07.25"), 7.25);
    assert.equal(psSeconds("41:30"), 2490);
    assert.equal(psSeconds("03:00:10"), 10_810);
    assert.equal(psSeconds("5-00:00:30"), 5 * 86_400 + 30);
    assert.equal(psSeconds(" 1:00 "), 60);
});
