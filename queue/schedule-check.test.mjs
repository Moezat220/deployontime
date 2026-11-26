// The checks run on made-up jobs. Only the last test starts the real script, with --dry, which reads and never writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanEnv, isolateProcess, tempDir } from "./testkit.mjs";

const HOME = isolateProcess("schedule");
const { checkAll, globMatch, judge, LIST_ERROR, maxLogAgeMs, readRules, reportText, scriptsOf } = await import("./schedule-check.mjs");

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR, NOW = Date.UTC(2032, 4, 21, 6, 0);
const LABEL = "com.example.cleanup";
const hourly = { Label: LABEL, ProgramArguments: ["/opt/tools/bin/node", "/opt/tasks/cleanup.mjs", "--older-than", "30"], StartInterval: 3600, StandardOutPath: "/var/log/tasks/cleanup.log" };
const facts = (fields = {}) => ({ label: LABEL, plist: hourly, loaded: true, exit: 0, logMtime: NOW - 40 * MINUTE, scriptsMissing: [], ...fields });
const problems = (fields, rules = {}) => judge(facts(fields), rules, NOW, "UTC").problems;

test("readRules: empty rules without a file, else the file's content", () => {
    assert.deepEqual(readRules(), { skip: [], okExit: {} });
    writeFileSync(join(HOME, "schedule-check.json"), JSON.stringify({ skip: ["org.sample.*"], maxLogAgeH: { [LABEL]: 5 } }));
    assert.deepEqual(readRules(), { skip: ["org.sample.*"], maxLogAgeH: { [LABEL]: 5 } });
    const broken = join(tempDir("schedule"), "rules.json");
    writeFileSync(broken, "{");
    assert.deepEqual(readRules(broken), { skip: [], okExit: {} });
});

test("globMatch: * stands for any text, everything else is literal", () => {
    const cases = [["org.sample.*", "org.sample.agent", true], ["org.sample.*", "org.samples.agent", false], ["*.cleanup", LABEL, true], ["com.*.clean*", LABEL, true], [LABEL, LABEL, true], [LABEL, `${LABEL}.old`, false], ["com.example.c+", "com.example.cc", false], ["comXexample.cleanup", LABEL, false]];
    for (const [pattern, label, expected] of cases) assert.equal(globMatch(pattern, label), expected, `${pattern} on ${label}`);
});

test("maxLogAgeMs: three intervals for an interval job, with a half-hour minimum", () => {
    assert.equal(maxLogAgeMs({ StartInterval: 120 }), 30 * MINUTE);
    assert.equal(maxLogAgeMs({ StartInterval: 900 }), 45 * MINUTE);
    assert.equal(maxLogAgeMs(hourly), 3 * HOUR);
});

test("maxLogAgeMs: a calendar job is judged by how often it fires", () => {
    assert.equal(maxLogAgeMs({ StartCalendarInterval: { Minute: 30 } }), 3 * HOUR);
    assert.equal(maxLogAgeMs({ StartCalendarInterval: { Hour: 2, Minute: 30 } }), 26 * HOUR);
    assert.equal(maxLogAgeMs({ StartCalendarInterval: [{ Hour: 2 }, { Hour: 14 }] }), 26 * HOUR);
    assert.equal(maxLogAgeMs({ StartCalendarInterval: [{ Weekday: 0, Hour: 2 }, { Weekday: 3, Hour: 2 }] }), 8 * DAY);
    assert.equal(maxLogAgeMs({ StartCalendarInterval: { Day: 15, Hour: 2 } }), 32 * DAY);
});

test("maxLogAgeMs: null for a job without a schedule", () => {
    assert.equal(maxLogAgeMs({ RunAtLoad: true }), null);
    assert.equal(maxLogAgeMs({ KeepAlive: { SuccessfulExit: false } }), null);
});

test("scriptsOf: absolute script paths among the arguments, not the interpreter or its options", () => {
    assert.deepEqual(scriptsOf(hourly), ["/opt/tasks/cleanup.mjs"]);
    assert.deepEqual(scriptsOf({ ProgramArguments: ["/bin/zsh", "/opt/tasks/rotate.zsh", "tasks/relative.sh", "/opt/tasks/data.json", 7] }), ["/opt/tasks/rotate.zsh"]);
    assert.deepEqual(scriptsOf({ Program: "/opt/tasks/report.py" }), ["/opt/tasks/report.py"]);
    assert.deepEqual(scriptsOf({}), []);
});

test("judge: a loaded job with a good exit and a fresh log has no problems", () => {
    assert.deepEqual(judge(facts(), {}, NOW, "UTC"), { label: LABEL, ok: true, problems: [], log: "/var/log/tasks/cleanup.log" });
    assert.deepEqual(problems({ exit: null }), []);
});

test("judge: names each kind of problem", () => {
    assert.deepEqual(problems({ loaded: false, exit: null }), ["not loaded in the scheduler"]);
    assert.deepEqual(problems({ scriptsMissing: ["/opt/tasks/cleanup.mjs", "/opt/tasks/lib.mjs"] }), ["script not found: /opt/tasks/cleanup.mjs, /opt/tasks/lib.mjs"]);
    assert.deepEqual(problems({ exit: 78 }), ["last run exit code 78"]);
    assert.deepEqual(problems({ exit: -15 }), ["last run ended by signal 15"]);
    assert.deepEqual(problems({ logMtime: NOW - 4 * HOUR }), ["log not written since 2032-05-21 02:00 UTC"]);
    assert.deepEqual(problems({ logMtime: null }), ["log file not found"]);
});

test("judge: several problems are listed together, and an unloaded job is not blamed for its exit code or log file", () => {
    assert.deepEqual(problems({ exit: 1, logMtime: NOW - 9 * HOUR, scriptsMissing: ["/opt/tasks/cleanup.mjs"] }), ["script not found: /opt/tasks/cleanup.mjs", "last run exit code 1", "log not written since 2032-05-20 21:00 UTC"]);
    assert.deepEqual(problems({ loaded: false, exit: 1, logMtime: null }), ["not loaded in the scheduler"]);
});

test("judge: a job without a log path or without a schedule gets no log check", () => {
    const { StandardOutPath, ...silent } = hourly, { StartInterval, ...unscheduled } = hourly;
    assert.deepEqual(judge(facts({ plist: silent, logMtime: null }), {}, NOW, "UTC"), { label: LABEL, ok: true, problems: [], log: null });
    assert.equal(judge(facts({ plist: unscheduled, logMtime: NOW - 90 * DAY }), {}, NOW, "UTC").ok, true);
    assert.equal(judge(facts({ plist: { ...silent, StandardErrorPath: "/var/log/tasks/cleanup.err" } }), {}, NOW, "UTC").log, "/var/log/tasks/cleanup.err");
});

test("judge: rules accept other exit codes and change or switch off the log check", () => {
    assert.deepEqual(problems({ exit: 78 }, { okExit: { [LABEL]: [0, 78] } }), []);
    assert.deepEqual(problems({ exit: 0 }, { okExit: { [LABEL]: [78] } }), ["last run exit code 0"]);
    assert.deepEqual(problems({ logMtime: NOW - 4 * HOUR }, { maxLogAgeH: { [LABEL]: 6 } }), []);
    assert.deepEqual(problems({ logMtime: NOW - 4 * HOUR }, { maxLogAgeH: { [LABEL]: 1 } }), ["log not written since 2032-05-21 02:00 UTC"]);
    assert.deepEqual(problems({ logMtime: NOW - 400 * DAY }, { maxLogAgeH: { [LABEL]: null } }), []);
    assert.deepEqual(problems({ exit: 78 }, { okExit: { "com.example.other": [78] } }), ["last run exit code 78"]);
});

const JOBS = {
    "a-cleanup.plist": hourly,
    "b-agent.plist": { Label: "org.sample.agent", KeepAlive: true },
    "c-broken.plist": null,
    "d-mirror.plist": { ProgramArguments: ["/opt/tasks/mirror.sh"], StartCalendarInterval: { Hour: 4 }, StandardErrorPath: "/var/log/tasks/mirror.err" },
};
const readers = (overrides = {}) => ({
    dir: "/srv/job-files", list: () => ["notes.txt", ...Object.keys(JOBS).reverse()], rules: { skip: ["org.sample.*"] }, now: NOW, tz: "UTC",
    status: () => new Map([[LABEL, { pid: null, exit: 0 }], ["org.sample.agent", { pid: 88, exit: null }]]),
    readPlist: (file) => JOBS[file.replace("/srv/job-files/", "")], exists: (file) => file !== "/opt/tasks/mirror.sh",
    mtime: (file) => { if (file.endsWith(".err")) throw new Error("absent"); return NOW - 10 * MINUTE; }, ...overrides,
});

test("checkAll: judges each job file in name order, honouring skip rules", () => {
    assert.deepEqual(checkAll(readers()), {
        error: null,
        results: [
            { label: LABEL, ok: true, problems: [], log: "/var/log/tasks/cleanup.log" },
            { label: "c-broken.plist", ok: false, problems: ["job file unreadable"], log: null },
            { label: "d-mirror", ok: false, problems: ["not loaded in the scheduler", "script not found: /opt/tasks/mirror.sh"], log: "/var/log/tasks/mirror.err" },
        ],
    });
    assert.equal(checkAll(readers({ rules: {} })).results.length, 4);
});

test("checkAll: reports that the job list could not be read, not every job as unloaded", () => {
    assert.deepEqual(checkAll(readers({ status: () => null })), { results: [], error: LIST_ERROR });
    assert.equal(LIST_ERROR, "could not read the job list");
});

test("checkAll: no job folder means no jobs and no error", () => {
    assert.deepEqual(checkAll(readers({ list: () => { throw new Error("absent"); }, status: assert.fail })), { results: [], error: null });
});

test("reportText: null when all jobs are fine, else one line naming the broken ones", () => {
    const fine = { label: LABEL, ok: true, problems: [] };
    assert.equal(reportText([]), null);
    assert.equal(reportText([fine, fine]), null);
    assert.equal(reportText([fine, { label: "d-mirror", ok: false, problems: ["not loaded in the scheduler", "log file not found"] }, { label: "e-report", ok: false, problems: ["last run exit code 2"] }]),
        "scheduled jobs with problems: 2 of 3; d-mirror: not loaded in the scheduler, log file not found; e-report: last run exit code 2");
});

test("main: runs when the script is started through a symlink", () => {
    const link = join(tempDir("schedule-link"), "schedule-link.mjs");
    symlinkSync(fileURLToPath(new URL("./schedule-check.mjs", import.meta.url)), link);
    // a made-up user folder, so the developer's own LaunchAgents files are not read
    const home = tempDir("schedule-home"), user = tempDir("schedule-user");
    const ran = spawnSync(process.execPath, [link, "--dry"], { env: cleanEnv(home, { HOME: user }), encoding: "utf8", timeout: 60_000 });
    assert.equal(ran.status === 0 || ran.status === 1, true, "the script did not exit normally");
    assert.equal(ran.stdout.startsWith("schedule-check "), true, "the script printed no report line");
    assert.equal(ran.status === 1, ran.stdout.includes(LIST_ERROR), "exit code and report disagree");
    assert.deepEqual(readdirSync(home), [], "--dry wrote to the state folder");
});
