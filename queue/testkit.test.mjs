// Importing testkit alone, without isolateProcess(), already gives the test file a state folder of its own.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { asPlatform, feedCpuReading, pause, readNotices, tempDir } from "./testkit.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

test("testkit: importing it points DOTIME_HOME at a temp folder and keeps notices in the log", () => {
    const home = realpathSync(process.env.DOTIME_HOME);
    assert.equal(home.startsWith(realpathSync(tmpdir()) + sep), true);
    assert.equal(process.env.DOTIME_NOTIFY, "log");
});

test("readNotices: a broken notice file or a name that is no encoded key is named and left out", () => {
    const dir = join(tempDir("notices"), "notices"), seen = [];
    mkdirSync(dir);
    writeFileSync(join(dir, "long-run%3A6340%3A1.json"), '{"minutes":22}');
    writeFileSync(join(dir, "idle-slot%3A5160%3A2.json"), "{");
    writeFileSync(join(dir, "100%.json"), "{}");
    assert.deepEqual(readNotices(dir, (text) => seen.push(text)), { "long-run:6340:1": { minutes: 22 } });
    assert.deepEqual(seen, [
        `notice ignored: ${join(dir, "100%.json")} is not named after a notice key`,
        `notice ignored: ${join(dir, "idle-slot%3A5160%3A2.json")} is not valid JSON`,
    ]);
    assert.deepEqual(readNotices(join(dir, "absent")), {});
});

test("asPlatform: a started script sees the platform it is given, and nothing else changes", () => {
    for (const platform of ["linux", "darwin"]) {
        const ran = spawnSync(process.execPath, [...asPlatform(platform), "-p", "process.platform + ' ' + (6 * 7)"], {
            encoding: "utf8", timeout: 30_000,
        });
        assert.deepEqual([ran.status, ran.stdout, ran.stderr], [0, `${platform} 42\n`, ""]);
    }
});

test("feedCpuReading: keeps a fresh shared reading with the given CPU value until it is stopped", async () => {
    const home = tempDir("testkit-feed");
    const stop = feedCpuReading(home, 12);
    const read = () => JSON.parse(readFileSync(join(home, "health.json"), "utf8"));
    const first = read();
    assert.equal(first.reading.busyCpuPct, 12);
    await pause(120);
    assert.equal(read().at > first.at, true, "written again");
    stop();
    const last = read().at;
    await pause(120);
    assert.equal(read().at, last, "not written after the stop");
});
