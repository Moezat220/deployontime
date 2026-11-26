import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isolateProcess, pause, until } from "./testkit.mjs";

const HOME = isolateProcess("timer");
const { afterMinutes } = await import("./timer.mjs");

test("afterMinutes: follows the fake clock file when the state folder is inside the temp folder", async () => {
    const clock = join(HOME, "clock-a");
    let calls = 0;
    afterMinutes(6, () => calls++, { DOTIME_HOME: HOME, DOTIME_FAKE_CLOCK: clock });
    await pause(150);
    writeFileSync(clock, "5");
    await pause(150);
    assert.equal(calls, 0);
    writeFileSync(clock, "6");
    await until(() => calls === 1, 2000);
    writeFileSync(clock, "60");
    await pause(150);
    assert.equal(calls, 1);
});

test("afterMinutes: a wait longer than one timer can hold does not fire early", async () => {
    let calls = 0;
    const timer = afterMinutes(99_999, () => calls++, {});
    await new Promise((done) => setTimeout(done, 50));
    clearTimeout(timer);
    assert.equal(calls, 0);
});

test("afterMinutes: uses a real timer everywhere else", async () => {
    const clock = join(HOME, "clock-b"), outsideTemp = dirname(fileURLToPath(import.meta.url));
    writeFileSync(clock, "0");
    let calls = 0;
    const timers = [afterMinutes(0.001, () => calls++, { DOTIME_FAKE_CLOCK: clock }), afterMinutes(0.001, () => calls++, { DOTIME_HOME: outsideTemp, DOTIME_FAKE_CLOCK: clock })];
    await until(() => calls === 2, 2000);
    const slow = afterMinutes(30, () => calls++, { DOTIME_HOME: outsideTemp, DOTIME_FAKE_CLOCK: clock });
    writeFileSync(clock, "30");
    await pause(150);
    assert.equal(calls, 2);
    for (const timer of [...timers, slow]) clearTimeout(timer);
});
