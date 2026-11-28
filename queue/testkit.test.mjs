// Importing testkit alone, without isolateProcess(), already gives the test file a state folder of its own.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
    asPlatform, ended, feedCpuReading, FOREVER, pause, pidIn, readNotices, savePid, tempDir, track, until, withChild,
} from "./testkit.mjs";
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

test("savePid and withChild: a test that sees the pid file reads the whole pid, never an empty file", async () => {
    // The file is looked for as fast as possible, so a file that showed up before its pid was in it would be read.
    const readAsSoonAsThere = (file) => {
        for (const end = Date.now() + 10_000; Date.now() < end;) if (existsSync(file)) return pidIn(file);
        throw new Error(`no pid file ${file}`);
    };
    for (let n = 0; n < 20; n++) {
        const file = join(tempDir("testkit-pid"), "job.pid"), job = track(spawn(process.execPath, ["-e", savePid(file)], { stdio: "ignore" }));
        assert.equal(readAsSoonAsThere(file), job.pid, `try ${n + 1}`);
        job.kill("SIGKILL");
        await once(job, "exit");
    }
    for (let n = 0; n < 5; n++) {
        const file = join(tempDir("testkit-pid"), "child.pid"), job = track(spawn(process.execPath, ["-e", withChild(file)], { stdio: "ignore" }));
        const child = readAsSoonAsThere(file);
        track(child);
        assert.deepEqual([child !== job.pid, ended(child)], [true, false], `try ${n + 1}`);
        process.kill(child, "SIGKILL");
        job.kill("SIGKILL");
        await once(job, "exit");
    }
});

test("pidIn and ended: anything but a pid above 1 is refused; ended is true for an exited process and a zombie", async () => {
    const file = join(tempDir("testkit-pid"), "job.pid");
    for (const text of ["", "0", "1", "-4", "4.5", "pid"]) {
        writeFileSync(file, text);
        assert.throws(() => pidIn(file), /^Error: not a pid of a started process: /, JSON.stringify(text));
    }
    // ps prints nothing for pid 0, so without the check ended(0) would be true while signal 0 to it reaches this group.
    for (const pid of [0, 1, -1, Number.NaN]) assert.throws(() => ended(pid), /not a pid of a started process/);
    const running = track(spawn(process.execPath, ["-e", FOREVER], { stdio: "ignore" }));
    await until(() => spawnSync("ps", ["-o", "stat=", "-p", String(running.pid)], { encoding: "utf8" }).stdout.trim() !== "");
    assert.equal(ended(running.pid), false, "running");
    running.kill("SIGKILL");
    await once(running, "exit");
    assert.equal(ended(running.pid), true, "exited and reaped");
    // The shell starts a short sleep and then becomes a long one, which never reaps the short one: a zombie.
    const parent = track(spawn("sh", ["-c", "sleep 0 & echo $!; exec sleep 30"], { stdio: ["ignore", "pipe", "ignore"] }));
    const [out] = await once(parent.stdout, "data");
    const zombie = Number(String(out).trim());
    const stat = () => spawnSync("ps", ["-o", "stat=", "-p", String(zombie)], { encoding: "utf8" }).stdout.trim();
    await until(() => stat().startsWith("Z"));
    assert.doesNotThrow(() => process.kill(zombie, 0), "signal 0 still reaches a zombie");
    assert.equal(ended(zombie), true, "a zombie has ended");
    parent.kill("SIGKILL");
    await once(parent, "exit");
});
