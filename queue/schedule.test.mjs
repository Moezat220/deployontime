// The `schedule` commands that change and show the jobs: add, list, remove, enable and disable, driven in this process
// with a fixed clock, zone and ids, and a few through the real cli.mjs for the exit codes and the words on screen.
import { cleanEnv, isolateProcess, tempDir } from "./testkit.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

isolateProcess("schedule");
const { cmdSchedule, jobLine, lastText, parseAdd } = await import("./schedule.mjs");
const { zoneWall } = await import("./cron.mjs");
const { readSchedule } = await import("./timetable.mjs");
const { paths } = await import("./settings.mjs");
const { BORN } = await import("./slots.mjs");

const MINUTE = 60_000;
const CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const T0 = Date.UTC(2031, 4, 6, 10, 0, 30);
const iso = (ms) => new Date(ms).toISOString();

function bench({ installed = false } = {}) {
    const files = paths({ DOTIME_HOME: tempDir("schedule-home") });
    const work = realpathSync(tempDir("schedule-work"));
    const out = { printed: [], said: [] };
    const ids = ["0a1b2c3d", "0a1b2c3d", "4e5f6a7b", "8c9d0e1f"];
    const clock = { now: T0 };
    const deps = {
        now: () => clock.now, wall: zoneWall("UTC"), zone: "UTC", owner: { pid: process.pid, born: BORN },
        isGone: () => true, pause: () => assert.fail("no wait expected"), newId: () => ids.shift(), cwd: () => work,
        print: (line) => out.printed.push(line), say: (line) => out.said.push(line), installed: () => installed,
    };
    const run = (...args) => cmdSchedule(args, files, deps);
    return { files, work, out, deps, clock, run, jobs: () => readSchedule(files.schedule).jobs };
}

test("parseAdd: the label, one kind of times, the command, and --isolate and --cwd when given", () => {
    assert.deepEqual(parseAdd(["add", "--label", " shop-api: lint ", "--every", "1h", "--", "npm", "run", "lint"]), {
        label: "shop-api: lint", every: "1h", isolate: false, noSkip: false, cwd: undefined, command: ["npm", "run", "lint"],
    });
    assert.deepEqual(parseAdd(["add", "--cron=0  2 * * *", "--isolate", "--cwd", "/srv/shop-api", "--label=shop-api: suite", "--", "make", "--isolate"]), {
        label: "shop-api: suite", cron: "0 2 * * *", isolate: true, noSkip: false, cwd: "/srv/shop-api", command: ["make", "--isolate"],
    });
    assert.equal(parseAdd(["add", "--label", "a: b", "--every", "1h", "--no-skip", "--", "make"]).noSkip, true);
    assert.equal(parseAdd(["add", "--label", "a: b", "--every", "1h", "--", "make", "--no-skip"]).noSkip, false, "a word of the command");
});

test("add --no-skip: stored as noSkip, shown by add and list; without it the job has no such field", () => {
    const b = bench({ installed: true });
    assert.equal(b.run("add", "--label", "shop-api: suite", "--cron", "0 2 * * *", "--no-skip", "--", "npm", "test"), 0);
    assert.equal(b.out.printed[0], 'schedule: added 0a1b2c3d, "shop-api: suite", cron 0 2 * * *, no-skip; next: 2031-05-07 02:00 UTC');
    assert.equal(b.jobs()[0].noSkip, true);
    b.run("add", "--label", "shop-api: lint", "--every", "1h", "--", "npm", "run", "lint");
    assert.equal("noSkip" in b.jobs()[1], false, "opt-in only");
    b.out.printed.length = 0;
    assert.equal(b.run("list"), 0);
    assert.match(b.out.printed[0], /^schedule 0a1b2c3d: "shop-api: suite", cron 0 2 \* \* \*, no-skip, enabled; next: /);
    assert.match(b.out.printed[1], /^schedule 4e5f6a7b: "shop-api: lint", every 1h, enabled; next: /);
});

test("add: prints the new id and the next run time, and stores the job", () => {
    const b = bench({ installed: true });
    assert.equal(b.run("add", "--label", "shop-api: lint", "--every", "15m", "--", "npm", "run", "lint"), 0);
    assert.deepEqual(b.out, { printed: ['schedule: added 0a1b2c3d, "shop-api: lint", every 15m; next: 2031-05-06 10:15 UTC'], said: [] });
    assert.deepEqual(b.jobs(), [{
        id: "0a1b2c3d", label: "shop-api: lint", cwd: b.work, command: ["npm", "run", "lint"], every: "15m", enabled: true, createdAt: iso(T0),
    }]);
    assert.equal(b.run("add", "--label", "shop-api: suite", "--cron", "0 2 * * *", "--isolate", "--cwd", b.files.home, "--", "npm", "test"), 0);
    assert.equal(b.out.printed[1], 'schedule: added 4e5f6a7b, "shop-api: suite", cron 0 2 * * *; next: 2031-05-07 02:00 UTC', "a taken id is drawn again");
    assert.deepEqual([b.jobs()[1].isolate, b.jobs()[1].cwd, b.jobs()[1].cron], [true, realpathSync(b.files.home), "0 2 * * *"]);
    assert.deepEqual(readdirSync(b.files.home).sort(), ["schedule.json"], "written whole, no temporary file or lock left");
});

test("add: one hint on how to start the tick when it is not installed, on each add", () => {
    const b = bench();
    b.run("add", "--label", "shop-api: lint", "--every", "1h", "--", "npm", "run", "lint");
    b.run("add", "--label", "shop-api: suite", "--every", "1d", "--", "npm", "test");
    assert.deepEqual(b.out.said, Array(2).fill("hint: nothing runs the tick yet; dotime-queue schedule install starts it every minute, "
        + "and schedule install --dry shows what it would write"));
});

test("add: refuses a missing label, a bad or missing time, no command, an unknown flag and a missing folder, with exit 2", () => {
    const b = bench();
    const cases = [
        [["--every", "1h", "--", "make"], 'schedule add: needs --label "<project>: <task>"'],
        [["--label", "  ", "--every", "1h", "--", "make"], 'schedule add: needs --label "<project>: <task>"'],
        [["--label", "a: b", "--", "make"], 'schedule add: needs exactly one of --every <step> and --cron "<expr>"'],
        [["--label", "a: b", "--every", "1h", "--cron", "0 2 * * *", "--", "make"], 'schedule add: needs exactly one of --every <step> and --cron "<expr>"'],
        [["--label", "a: b", "--every", "30s", "--", "make"],
            'schedule add: --every: "30s" is not a step; give a whole number with m, h or d, such as 15m, 2h or 1d, at least 1m'],
        [["--label", "a: b", "--cron", "0 2 * *", "--", "make"],
            'schedule add: --cron: "0 2 * *" needs 5 fields, minute hour day-of-month month day-of-week, such as "0 2 * * *"'],
        [["--label", "a: b", "--cron", "0 25 * * *", "--", "make"], 'schedule add: --cron: hour field "25" is out of range; hour runs from 0 to 23'],
        [["--label", "a: b", "--every", "1h"], "schedule add: needs the command after --, as for run"],
        [["--label", "a: b", "--every", "1h", "--"], "schedule add: needs the command after --, as for run"],
        [["--label", "a: b", "--every", "1h", "--max-run", "5", "--", "make"], "schedule add: unknown option --max-run"],
        [["--label", "a: b", "--every", "1h", "--cwd", "/nonexistent/shop", "--", "make"], "schedule add: --cwd: /nonexistent/shop is not a folder"],
    ];
    for (const [words, message] of cases) {
        b.out.said.length = 0;
        assert.equal(b.run("add", ...words), 2, words.join(" "));
        assert.deepEqual(b.out.said, [message], words.join(" "));
    }
    assert.deepEqual(b.out.printed, []);
    assert.equal(existsSync(b.files.schedule), false, "nothing was written");
});

test("list: one line per job with its times, state, next run and last outcome, or schedule: none", () => {
    const b = bench({ installed: true });
    b.run("list");
    assert.deepEqual(b.out.printed, ["schedule: none"]);
    b.run("add", "--label", "shop-api: lint", "--every", "1h", "--", "npm", "run", "lint");
    b.run("add", "--label", "shop-api: suite", "--cron", "0 2 * * 1-5", "--", "npm", "test");
    b.run("disable", "4e5f6a7b");
    const row = (more) => JSON.stringify({ v: 1, label: "shop-api: lint", queuedAt: iso(T0), ...more });
    writeFileSync(b.files.journal, `${[row({ outcome: "ran", exit: 1, scheduled: "0a1b2c3d" }), row({ outcome: "ran", exit: 0 })].join("\n")}\n`);
    b.out.printed.length = 0;
    b.clock.now = T0 + 30 * MINUTE;
    assert.equal(b.run("list"), 0);
    assert.deepEqual(b.out.printed, [
        'schedule 0a1b2c3d: "shop-api: lint", every 1h, enabled; next: 2031-05-06 11:00 UTC; last: ran, exit 1',
        'schedule 4e5f6a7b: "shop-api: suite", cron 0 2 * * 1-5, disabled; next: none; last: none',
    ]);
    writeFileSync(b.files.schedule, "{");
    assert.equal(b.run("list"), 1);
    assert.match(b.out.said.at(-1), /^schedule: .*schedule\.json cannot be used: it is not valid JSON; fix or remove it$/);
});

test("lastText and jobLine: the newest line of the job, missed and busy lines included", () => {
    const rows = [{ scheduled: "0a1b2c3d", outcome: "ran", exit: 0 }, { scheduled: "0a1b2c3d", outcome: "missed", missed: 3, exit: null }];
    assert.equal(lastText(rows, "0a1b2c3d"), "missed 3 runs");
    assert.equal(lastText([{ scheduled: "0a1b2c3d", outcome: "busy", exit: null }], "0a1b2c3d"), "busy");
    assert.equal(lastText([{ scheduled: "0a1b2c3d", outcome: "missed", missed: 1 }], "0a1b2c3d"), "missed 1 run");
    assert.equal(lastText(rows, "4e5f6a7b"), "none");
    const job = { id: "0a1b2c3d", label: "docs-site: build", cron: "30 6 * * *", enabled: true, createdAt: iso(T0) };
    assert.equal(jobLine(job, [], T0, { wall: zoneWall("Asia/Kolkata"), zone: "Asia/Kolkata" }),
        'schedule 0a1b2c3d: "docs-site: build", cron 30 6 * * *, enabled; next: 2031-05-07 06:30 GMT+5:30; last: none');
});

test("remove, enable and disable: change the one job, say so, and refuse an unknown id or extra words with exit 2", () => {
    const b = bench({ installed: true });
    b.run("add", "--label", "shop-api: lint", "--every", "1h", "--", "npm", "run", "lint");
    b.run("add", "--label", "shop-api: suite", "--every", "1d", "--", "npm", "test");
    b.out.printed.length = 0;
    assert.equal(b.run("disable", "0a1b2c3d"), 0);
    assert.equal(b.jobs()[0].enabled, false);
    b.clock.now = T0 + 5 * 60 * MINUTE;
    assert.equal(b.run("enable", "0a1b2c3d"), 0);
    assert.deepEqual([b.jobs()[0].enabled, b.jobs()[0].lastDue], [true, iso(T0 + 5 * 60 * MINUTE)], "times while disabled are not missed");
    assert.equal(b.run("enable", "0a1b2c3d"), 0);
    assert.equal(b.jobs()[0].lastDue, iso(T0 + 5 * 60 * MINUTE), "enabling an enabled job changes nothing");
    assert.equal(b.run("remove", "0a1b2c3d"), 0);
    assert.deepEqual(b.jobs().map((j) => j.id), ["4e5f6a7b"]);
    assert.deepEqual(b.out.printed, [
        'schedule: disabled 0a1b2c3d, "shop-api: lint"',
        'schedule: enabled 0a1b2c3d, "shop-api: lint"; next: 2031-05-06 16:00 UTC',
        'schedule: enabled 0a1b2c3d, "shop-api: lint"; next: 2031-05-06 16:00 UTC',
        'schedule: removed 0a1b2c3d, "shop-api: lint"',
    ]);
    const before = readFileSync(b.files.schedule, "utf8");
    const refusals = [
        [["remove", "0a1b2c3d"], "schedule remove: no job 0a1b2c3d; schedule list shows the ids"],
        [["enable"], "schedule enable: needs the id of a job; schedule list shows the ids"],
        [["disable", "--all"], "schedule disable: needs the id of a job; schedule list shows the ids"],
        [["disable", "4e5f6a7b", "now"], 'schedule disable: unexpected word "now"'],
        [["list", "--all"], "schedule list: unknown option --all"],
        [["tick", "--dry"], "schedule tick: unknown option --dry"],
        [[], "schedule: needs one of add, list, remove, enable, disable, tick, install, uninstall; dotime-queue help shows each"],
        [["start"], 'schedule: "start" is not one of add, list, remove, enable, disable, tick, install, uninstall; dotime-queue help shows each'],
    ];
    for (const [words, message] of refusals) {
        b.out.said.length = 0;
        assert.equal(b.run(...words), 2, words.join(" "));
        assert.deepEqual(b.out.said, [message]);
    }
    assert.equal(readFileSync(b.files.schedule, "utf8"), before);
});

test("changes wait for a tick that holds the lock, and give up with exit 1 when it stays taken", () => {
    const b = bench({ installed: true });
    writeFileSync(b.files.scheduleLock, JSON.stringify({ pid: process.pid, born: BORN }));
    let pauses = 0;
    const deps = { ...b.deps, isGone: () => false, pause: () => { pauses++; } };
    assert.equal(cmdSchedule(["add", "--label", "a: b", "--every", "1h", "--", "make"], b.files, deps), 1);
    assert.equal(pauses, 100);
    assert.match(b.out.said.at(-1), /^schedule: .*schedule\.lock stayed taken by another tick or change; try again$/);
    assert.equal(existsSync(b.files.schedule), false);
    rmSync(b.files.scheduleLock);
});

test("cli: schedule add, list, disable, remove and the exit codes, through the real command", () => {
    const home = tempDir("schedule-cli-home"), work = realpathSync(tempDir("schedule-cli-work"));
    // A made-up home folder, so the check for an installed tick looks at no real LaunchAgents or timers, and stand-ins
    // for systemctl and crontab first on PATH that say "not here", so the test is the same on any Linux computer.
    const probes = tempDir("schedule-cli-probes"), asked = join(probes, "asked");
    for (const name of ["systemctl", "crontab"]) {
        writeFileSync(join(probes, name), `#!/bin/sh\necho ${name} "$@" >> '${asked}'\nexit 1\n`);
        chmodSync(join(probes, name), 0o755);
    }
    const env = cleanEnv(home, { HOME: tempDir("schedule-cli-user"), PATH: `${probes}:${process.env.PATH}` });
    const cli = (...args) => spawnSync(process.execPath, [CLI, "schedule", ...args], { cwd: work, env, encoding: "utf8" });
    const added = cli("add", "--label", "shop-api: lint", "--every", "2h", "--", "npm", "run", "lint");
    assert.equal(added.status, 0, added.stderr);
    const id = /^schedule: added ([0-9a-f]{8}), "shop-api: lint", every 2h; next: \d{4}-\d\d-\d\d \d\d:\d\d \S+\n$/.exec(added.stdout)?.[1];
    assert.ok(id, added.stdout);
    assert.match(added.stderr, /^dotime-queue: hint: nothing runs the tick yet; dotime-queue schedule install starts it every minute/);
    const probed = existsSync(asked) ? readFileSync(asked, "utf8") : "";
    assert.equal(probed, process.platform === "linux" ? "systemctl --user show-environment\ncrontab -l\n" : "", "only the stand-ins are asked");
    const listed = cli("list");
    assert.match(listed.stdout, new RegExp(`^schedule ${id}: "shop-api: lint", every 2h, enabled; next: .+; last: none\\n$`));
    assert.equal(JSON.parse(readFileSync(join(home, "schedule.json"), "utf8")).jobs[0].cwd, work);
    assert.deepEqual([cli("disable", id).status, cli("list").stdout.includes("disabled; next: none")], [0, true]);
    const tick = cli("tick");
    assert.deepEqual([tick.status, tick.stdout, tick.stderr], [0, "", ""], "nothing due: quiet");
    assert.deepEqual([cli("remove", id).stdout, cli("list").stdout], [`schedule: removed ${id}, "shop-api: lint"\n`, "schedule: none\n"]);
    const unknown = cli("enable", id);
    assert.deepEqual([unknown.status, unknown.stderr], [2, `dotime-queue: schedule enable: no job ${id}; schedule list shows the ids\n`]);
    const bad = cli("add", "--label", "shop-api: lint", "--cron", "*/0 * * * *", "--", "make");
    assert.deepEqual([bad.status, bad.stdout], [2, ""]);
    assert.equal(bad.stderr, 'dotime-queue: schedule add: --cron: minute field "*/0" has a step of 0; a step is 1 or more\n');
    assert.equal(cli("add", "--label", "a: b", "--every", "1h", "--wat", "--", "make").status, 2);
});
