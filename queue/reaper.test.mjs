// reap() works on made-up process tables here. Real signals go only to processes that this file starts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanEnv, isolateProcess, tempDir, track, until } from "./testkit.mjs";

const HOME = isolateProcess("reaper");
const { checkIdleServers, checkIdleSlots, checkLowDisk, checkOverload, checkStrayRuns, groupRows, reap, serverOnly, shortCommand } = await import("./reaper.mjs");
const { snapshot } = await import("./slots.mjs");
const { addNotice, readNotices } = await import("./notices.mjs");
const { DEFAULTS } = await import("./settings.mjs");

const MINUTE = 60_000, HOUR = 60 * MINUTE, MB = 1024, NOW = Date.UTC(2031, 10, 8, 18, 0);
const SERVER = "node /srv/shop-api/node_modules/.bin/next dev -p 4100";
const serverGroup = (cpu, fields = {}) => [
    { pid: 2400, ppid: 1, pgid: 2400, age: 95 * MINUTE, cpu, pcpu: 0.2, rss: 256 * MB, cmd: SERVER, ...fields },
    { pid: 2401, ppid: 2400, pgid: 2400, age: 94 * MINUTE, cpu: 0, pcpu: 0, rss: 128 * MB, cmd: "node /srv/shop-api/node_modules/next/dist/server/lib/start-server.js" },
];
// The thresholds these tests work with, set here so that the shipped defaults can change freely.
const SETTINGS = {
    ...DEFAULTS,
    idle: { serverIdleMin: 25, serverCpuS: 6, slotIdleMin: 10, slotCpuS: 5 },
    reaper: { ...DEFAULTS.reaper, overloadPerCore: 3, overloadSwapPct: 75, overloadMemPct: 8, overloadDiskGB: 4, lowDiskGB: 25 },
};
const SAMPLE_AGE = SETTINGS.idle.serverIdleMin + 2;
const sampledBefore = (cpu, minutesAgo = SAMPLE_AGE) => ({ samples: { 2400: [{ t: NOW - minutesAgo * MINUTE, cpu }] } });
async function pass(rows, state = {}, options = {}) {
    const stops = [], notices = [];
    const result = await reap({ rows, state: structuredClone(state), now: NOW, settings: SETTINGS, tz: "UTC", record: (key, entry) => addNotice(key, entry, join(HOME, "notices")), notify: (title, text) => notices.push([title, text]), stop: async (pgid, procs) => stops.push([pgid, procs.length]), ...options });
    return { ...result, stops, notices };
}

test("groupRows: collects rows under their process group", () => {
    const groups = groupRows([...serverGroup(1), { pid: 2500, ppid: 1, pgid: 2500, cmd: "sleep 60" }]);
    assert.deepEqual([...groups].map(([pgid, rows]) => [pgid, rows.map((r) => r.pid)]), [[2400, [2400, 2401]], [2500, [2500]]]);
});

test("groupRows: time grows in step with the rows, also when one group holds them all", () => {
    const rows = Array.from({ length: 50_000 }, (_, i) => ({ pid: 10_000 + i, ppid: 1, pgid: 4200, cmd: "node worker.js" }));
    const began = performance.now(), groups = groupRows(rows);
    assert.equal(groups.get(4200).length, 50_000);
    assert.ok(performance.now() - began < 1500, "50000 rows took too long");
});

test("shortCommand: program name and first argument without their folders", () => {
    assert.equal(shortCommand(SERVER), "node next");
    assert.equal(shortCommand("/opt/tools/bin/python3 -m http.server"), "python3 -m");
    assert.equal(shortCommand("  pnpm   run   dev "), "pnpm run");
    assert.equal(shortCommand("nodemon"), "nodemon");
    assert.equal(shortCommand(""), "");
});

test("reap: stops a dev-server group that stayed idle for the window and says so", async () => {
    const early = await pass(serverGroup(300), {}, { now: NOW - SAMPLE_AGE * MINUTE });
    assert.deepEqual([early.stops, early.notices, early.state.samples[2400].length], [[], [], 1]);
    const late = await pass(serverGroup(302), early.state);
    assert.deepEqual(late.stops, [[2400, 2]]);
    assert.deepEqual(late.stopped, [`node next (process group 2400, 2.0 s of CPU in ${SAMPLE_AGE} min, 384 MB of memory)`]);
    assert.equal(late.lines[0], `stopped after idling: ${late.stopped[0]}`);
    assert.deepEqual(late.notices, [["dotime: dev servers stopped", late.stopped[0]]]);
    assert.deepEqual(late.state.samples, {});
});

test("serverOnly: a group is the server's own when it holds only the server, its children and launchers above it", () => {
    const row = (pid, ppid, cmd) => ({ pid, ppid, pgid: 3000, cmd });
    const vite = row(3002, 3001, "node /srv/docs-site/node_modules/.bin/vite");
    assert.equal(serverOnly([row(3000, 1, "npm run dev"), row(3001, 3000, "sh -c vite"), vite, row(3003, 3002, "esbuild --service")], vite), true);
    assert.equal(serverOnly([row(3000, 1, "node /opt/tools/agent.js --task docs"), row(3001, 3000, "sh -c vite"), vite], vite), false);
    assert.equal(serverOnly([row(3001, 1, "sh -c vite"), vite, row(3004, 3001, "make watch-css")], vite), false);
    assert.equal(serverOnly([row(3001, 1, "make -C /srv/npm watch-all"), vite], vite), false, "a folder named npm does not make a launcher");
    assert.equal(serverOnly([row(3000, 1, "node /opt/tools/lib/pnpm/bin/pnpm.cjs dev"), row(3001, 3000, "sh -c vite"), vite], vite), true);
});

test("reap: a launcher that names the server is not taken for it, so its other program is never stopped", async () => {
    const both = [
        { pid: 2400, ppid: 1, pgid: 2400, age: 95 * MINUTE, cpu: 1, pcpu: 0, rss: 4 * MB, cmd: "sh -c vite & make watch-css" },
        { pid: 2401, ppid: 2400, pgid: 2400, age: 95 * MINUTE, cpu: 300, pcpu: 0, rss: 128 * MB, cmd: "node /srv/docs-site/node_modules/.bin/vite" },
        { pid: 2402, ppid: 2400, pgid: 2400, age: 95 * MINUTE, cpu: 1, pcpu: 0, rss: 16 * MB, cmd: "make watch-css" },
    ];
    const run = await pass(both.map((p, i) => (i === 1 ? { ...p, cpu: 302 } : p)), sampledBefore(302));
    assert.deepEqual(run.stops, []);
    assert.ok(run.lines.some((l) => l.includes("shares its group with another program")), "the vite process is the server, the launcher is not");
});

test("reap: launchers of other shapes are never taken for the server either", async () => {
    const group = (top, extra) => [
        { pid: 2400, ppid: 1, pgid: 2400, age: 95 * MINUTE, cpu: 1, pcpu: 0, rss: 4 * MB, cmd: top },
        { pid: 2401, ppid: 2400, pgid: 2400, age: 95 * MINUTE, cpu: 302, pcpu: 0, rss: 128 * MB, cmd: "node /srv/docs-site/node_modules/.bin/vite" },
        ...(extra ? [{ pid: 2402, ppid: 2400, pgid: 2400, age: 95 * MINUTE, cpu: 1, pcpu: 0, rss: 16 * MB, cmd: extra }] : []),
    ];
    for (const top of ["sh -ec vite & make watch-css", "bash -lc vite & make watch-css", "/usr/bin/env bash -c vite & make watch-css", "node /srv/docs-site/node_modules/.bin/concurrently vite make watch-css"]) {
        const run = await pass(group(top, "make watch-css"), sampledBefore(302));
        assert.deepEqual(run.stops, [], `${top}: the other program must keep running`);
        assert.ok(run.lines.some((l) => l.includes("shares its group with another program")), top);
    }
    const alone = await pass(group("bash -lc vite"), sampledBefore(302));
    assert.deepEqual(alone.stops, [[2400, 2]], "a launcher that holds only the server is part of the server's group");
});

test("reap: an idle dev server that shares its group with another program is reported, not stopped", async () => {
    const shared = [...serverGroup(302), { pid: 2399, ppid: 1, pgid: 2400, age: 95 * MINUTE, cpu: 0, pcpu: 0, rss: 64 * MB, cmd: "node /opt/tools/agent.js --task docs" }];
    shared[0] = { ...shared[0], ppid: 2399 };
    const run = await pass(shared, sampledBefore(300));
    assert.deepEqual([run.stops, run.notices], [[], []]);
    assert.ok(run.lines.some((l) => l.includes("shares its group with another program: left running")));
});

test("reap: leaves a server alone while it is busy, new, or protected", async () => {
    const idle = serverGroup(302), state = sampledBefore(300);
    const cases = {
        "busy": [serverGroup(390), {}],
        "started a few minutes ago": [serverGroup(302, { age: 9 * MINUTE }).slice(0, 1), {}],
        "holds a slot by pid": [idle, { holders: [{ pid: 2401, label: "shop-api: e2e" }] }],
        "holds a slot by group": [idle, { holders: [{ pid: 77, pgid: 2400, label: "shop-api: e2e" }] }],
        "matches the keep pattern": [serverGroup(302, { cmd: "/Applications/Studio.app/Contents/Helpers/node next dev" }), {}],
        "is the reaper's own group": [idle, { myPgid: 2400 }],
        "runs a one-shot test in the group": [[...idle, { pid: 2402, ppid: 2400, pgid: 2400, age: MINUTE, cpu: 0, pcpu: 0, rss: MB, cmd: "npx playwright test" }], {}],
    };
    for (const [name, [rows, options]] of Object.entries(cases)) assert.deepEqual((await pass(rows, state, options)).stops, [], name);
    assert.equal((await pass(idle, state)).stops.length, 1);
});

test("reap: a custom keep pattern replaces the default one", async () => {
    const keeping = (keepPattern) => ({ ...SETTINGS, reaper: { ...SETTINGS.reaper, keepPattern } });
    assert.deepEqual((await pass(serverGroup(302), sampledBefore(300), { settings: keeping("start-server\\.js$") })).stops, []);
    const inApps = serverGroup(302, { cmd: "/Applications/Studio.app/Contents/Helpers/node next dev" });
    assert.equal((await pass(inApps, sampledBefore(300), { settings: keeping("^preview-only ") })).stops.length, 1);
});

test("reap: a dry run lists the servers and stops nothing", async () => {
    const dry = await pass(serverGroup(302), sampledBefore(300), { dry: true });
    assert.deepEqual([dry.stops, dry.notices], [[], []]);
    assert.deepEqual(dry.lines, [
        "server group 2400: node next, 95 min old, 302 s of CPU so far, state idle",
        `dry run, would stop after idling: node next (process group 2400, 2.0 s of CPU in ${SAMPLE_AGE} min, 384 MB of memory)`,
    ]);
});

test("reap: samples of vanished groups are dropped, and a calm run says so", async () => {
    const calm = await pass(serverGroup(302), { samples: { 2400: [{ t: NOW - 5 * MINUTE, cpu: 301 }], 8800: [{ t: NOW - 5 * MINUTE, cpu: 4 }] } }, { load: 1.25, swapPct: 3.4 });
    assert.deepEqual(Object.keys(calm.state.samples), ["2400"]);
    assert.deepEqual(calm.lines, ["quiet: dev-server groups under watch 1, 3% of swap in use, load 1.3"]);
});

test("reap: a longer idle window still stops the server once it has passed", async () => {
    const settings = { ...SETTINGS, idle: { ...SETTINGS.idle, serverIdleMin: 60 } };
    let state = {}, stoppedAt = [];
    for (let minute = -75; minute <= 0 && !stoppedAt.length; minute += 5) {
        const run = await pass(serverGroup(302, { age: 4 * HOUR }), state, { settings, now: NOW + minute * MINUTE });
        state = run.state;
        if (run.stops.length) stoppedAt.push(minute);
    }
    assert.deepEqual(stoppedAt, [-15]);
});

const testRun = (rootPid, ppid) => [
    { pid: rootPid, ppid, pgid: rootPid, age: 3 * MINUTE, cpu: 30, pcpu: 80, rss: 200 * MB, cmd: "node /srv/docs-site/node_modules/.bin/jest --ci" },
    ...[1, 2, 3, 4].map((n) => ({ pid: rootPid + n, ppid: rootPid, pgid: rootPid, age: 3 * MINUTE, cpu: 20, pcpu: 95, rss: 700 * MB, cmd: "node /srv/docs-site/node_modules/jest-worker/build/workers/processChild.js" })),
];

test("reap: five jest processes using 3 GB with no queue job above them: noticed once, never stopped", async () => {
    const first = await pass(testRun(5200, 1));
    assert.deepEqual(first.stops, []);
    assert.deepEqual(first.notices, [["dotime: unqueued test run", 'unqueued test run: node jest, pid 5200, 5 test processes, 2.9 GB of memory, left running; hint: start large runs with dotime-queue run --label "<project>: <task>" -- <command>']]);
    const again = await pass(testRun(5200, 1), first.state, { now: NOW + 3 * HOUR });
    assert.deepEqual([again.notices, again.lines.filter((l) => l.startsWith("unqueued test run")).length], [[], 1]);
});

test("reap: a second unqueued run is held back until an hour has passed", async () => {
    const first = await pass(testRun(5200, 1));
    const soon = await pass([...testRun(5200, 1), ...testRun(5300, 1)], first.state, { now: NOW + 20 * MINUTE });
    assert.deepEqual(soon.notices, []);
    const later = await pass([...testRun(5200, 1), ...testRun(5300, 1)], soon.state, { now: NOW + 61 * MINUTE });
    assert.deepEqual(later.notices.map(([, text]) => text.includes("pid 5300")), [true]);
});

test("reap: a test run started by a slot holder is not reported", async () => {
    const queueProcess = { pid: 5100, ppid: 1, pgid: 5100, age: 4 * MINUTE, cpu: 1, pcpu: 0, rss: 50 * MB, cmd: "node queue/cli.mjs run --kind test -- yarn jest --ci" };
    const queued = await pass([queueProcess, ...testRun(5200, 5100)], {}, { holders: [{ pid: 5100, pgid: 5200, label: "docs-site: unit suite", startedAt: NOW - 3 * MINUTE }] });
    assert.deepEqual([queued.notices, queued.lines.some((l) => l.startsWith("unqueued"))], [[], false]);
    assert.equal((await pass([queueProcess, ...testRun(5200, 5100)])).notices.length, 1);
});

test("reap: overload is reported on the second run in a row, then at most once an hour", async () => {
    const busy = { load: 14, cores: 4, swapPct: 15.4, health: { freePct: 35, diskGB: 80 } };
    const rows = [{ pid: 9100, ppid: 1, pgid: 9100, age: HOUR, cpu: 900, pcpu: 310, rss: MB, cmd: "/opt/tools/bin/node build.mjs" }, { pid: 9101, ppid: 1, pgid: 9101, age: HOUR, cpu: 200, pcpu: 45, rss: MB, cmd: "postgres -D /srv/db" }];
    const first = await pass(rows, {}, busy);
    assert.deepEqual([first.notices, first.state.streak, first.lines], [[], 1, ["overload seen: run 1 in a row, no notice this time"]]);
    const second = await pass(rows, first.state, { ...busy, now: NOW + 5 * MINUTE });
    assert.deepEqual(second.notices, [["dotime: machine overloaded", "overloaded: busiest programs node 310%, postgres 45%; 4 cores at load 14.0, 80.0 GB of disk free, 35% of memory free, 15% of swap in use"]]);
    const third = await pass(rows, second.state, { ...busy, now: NOW + 10 * MINUTE });
    assert.deepEqual([third.notices, third.state.streak], [[], 3]);
    const afterAnHour = await pass(rows, third.state, { ...busy, now: NOW + 70 * MINUTE });
    assert.equal(afterAnHour.notices.length, 1);
});

test("reap: a calm run in between resets the overload count", async () => {
    const busy = { load: 14, cores: 4 };
    const first = await pass([], {}, busy), calm = await pass([], first.state, { load: 2, cores: 4 }), third = await pass([], calm.state, busy);
    assert.deepEqual([calm.state.streak, third.state.streak, third.notices], [0, 1, []]);
});

test("reap: swap, memory and disk each count as overload, with unknown readings spelled out", async () => {
    for (const reading of [{ swapPct: 95 }, { health: { freePct: 5, diskGB: null } }, { health: { freePct: null, diskGB: 0 } }]) {
        const first = await pass([], {}, reading), second = await pass([], first.state, reading);
        assert.equal(second.notices.some(([title]) => title === "dotime: machine overloaded"), true, JSON.stringify(reading));
    }
    const unknown = await pass([], { streak: 1 }, { swapPct: 95 });
    assert.equal(unknown.notices[0][1], "overloaded: busiest programs not known; 1 cores at load 0.0, no disk reading, no memory reading, 95% of swap in use");
});

test("reap: low disk space is reported early, at most every six hours", async () => {
    const health = { freePct: 50, diskGB: 18.5 };
    const first = await pass([], {}, { health });
    assert.deepEqual(first.notices, [["dotime: disk space low", `disk low: 18.5 GB free, notice level ${SETTINGS.reaper.lowDiskGB} GB`]]);
    assert.deepEqual((await pass([], first.state, { health, now: NOW + 5 * HOUR })).notices, []);
    assert.equal((await pass([], first.state, { health, now: NOW + 6 * HOUR + MINUTE })).notices.length, 1);
    assert.deepEqual((await pass([], {}, { health: { freePct: 50, diskGB: SETTINGS.reaper.lowDiskGB } })).notices, []);
});

test("reap: sends the notice for a slot whose job uses almost no CPU", async () => {
    const holder = { pid: 6100, pgid: 6101, label: "mobile-app: bundle", project: "mobile-app", startedAt: NOW - 50 * MINUTE, killMin: 120 };
    const state = { slotIdle: { [`6100:${holder.startedAt}`]: { samples: [{ t: NOW - 15 * MINUTE, cpu: 33 }] } } };
    const run = await pass([], state, { holders: [holder], queue: [{ pid: 6200, label: "docs-site: build", at: NOW - 4 * MINUTE }], cpuPs: () => "6101 6100 6101 0:33.20\n" });
    assert.deepEqual(run.notices.map(([title]) => title), ["dotime: slot held by a quiet job"]);
    assert.equal(run.notices[0][1].includes(', holding up "docs-site: build" (4 min), '), true);
    assert.equal(run.state.slotIdle[`6100:${holder.startedAt}`].told, true);
    assert.deepEqual(Object.keys(readNotices(join(HOME, "notices"))), [`idle-slot:6100:${holder.startedAt}`]);
});

test("main: runs when the script is started through a symlink", () => {
    const link = join(tempDir("reaper-link"), "reaper-link.mjs");
    symlinkSync(fileURLToPath(new URL("./reaper.mjs", import.meta.url)), link);
    const home = tempDir("reaper-home");
    const ran = spawnSync(process.execPath, [link, "--dry"], { env: cleanEnv(home), encoding: "utf8", timeout: 60_000 });
    assert.equal(ran.status, 0, "the reaper did not exit cleanly");
    assert.equal(/ reaper: /.test(ran.stdout), true, "the reaper printed no report line");
    assert.deepEqual(readdirSync(home), []);
});

test("main: a dry run leaves the slot file of a dead holder in place", () => {
    const home = tempDir("reaper-home"), slot = join(home, "slots", "slot-0.json");
    mkdirSync(join(home, "slots"));
    writeFileSync(slot, JSON.stringify({ pid: 2 ** 30 + 7, label: "docs-site: build", at: NOW }));
    const script = fileURLToPath(new URL("./reaper.mjs", import.meta.url));
    const ran = spawnSync(process.execPath, [script, "--dry"], { env: cleanEnv(home), encoding: "utf8", timeout: 60_000 });
    assert.equal(ran.status, 0, "the reaper did not exit cleanly");
    assert.deepEqual([existsSync(slot), readdirSync(home)], [true, ["slots"]]);
    // The same file is cleared away by a pruning snapshot, which shows that the holder does count as dead.
    assert.deepEqual(snapshot({ dirs: { slots: join(home, "slots"), waitingLine: join(home, "line") }, prune: true }).holders, []);
    assert.equal(existsSync(slot), false);
});

test("reap: an idle server whose stop was refused is reported as a failed stop, not as stopped", async () => {
    const early = await pass(serverGroup(300), {}, { now: NOW - SAMPLE_AGE * MINUTE });
    const refused = async () => ({ stopped: false, why: "TERM refused (EPERM)" });
    const late = await pass(serverGroup(302), early.state, { stop: refused });
    const text = `stop failed: idle dev server node next (process group 2400, 2.0 s of CPU in ${SAMPLE_AGE} min, 384 MB of memory), TERM refused (EPERM)`;
    assert.deepEqual(late.stopped, []);
    assert.deepEqual(late.lines, [text]);
    assert.equal(late.state.samples[2400].length, 2, "the server stays under watch");
    assert.deepEqual(late.notices, [["dotime: dev server stop failed", text]]);
    // One notice per group within the hour, and the next after it.
    const again = await pass(serverGroup(303), late.state, { stop: refused, now: NOW + 30 * MINUTE });
    assert.deepEqual([again.lines.length, again.notices], [1, []]);
    const later = await pass(serverGroup(304), again.state, { stop: refused, now: NOW + 61 * MINUTE });
    assert.equal(later.notices.length, 1);
    // A group that is gone is forgotten.
    assert.deepEqual((await pass([], later.state)).state.stopFailedTold, {});
});

test("reap checks: each one returns only the state keys it owns", async () => {
    const ctx = {
        rows: [], groups: new Map(), holders: [], queue: [], now: NOW, dry: false, settings: SETTINGS, tz: "UTC",
        health: { freePct: 50, diskGB: 3 }, load: 0, cores: 4, swapPct: 0, myPgid: null, notify: () => {}, record: () => {},
        cpuPs: () => "", keep: null, isDevServer: () => false, stopIdle: assert.fail,
    };
    const state = { samples: {}, streak: 0, lastOverload: 0 };
    assert.deepEqual(Object.keys((await checkIdleServers(ctx, state)).state), ["samples", "stopFailedTold"]);
    assert.deepEqual(Object.keys(checkStrayRuns(ctx, state).state), ["strayTold"]);
    assert.deepEqual(Object.keys(checkIdleSlots(ctx, state).state), ["slotIdle"]);
    assert.deepEqual(Object.keys(checkOverload(ctx, state).state), ["streak", "lastOverload"]);
    assert.deepEqual(checkLowDisk(ctx, state), { state: { lastLowDisk: NOW }, lines: [`disk low: 3.0 GB free, notice level ${SETTINGS.reaper.lowDiskGB} GB`] });
});

test("main: an option it does not know is refused with exit 2, and nothing runs", () => {
    const home = tempDir("reaper-home"), script = fileURLToPath(new URL("./reaper.mjs", import.meta.url));
    const ran = spawnSync(process.execPath, [script, "--dry", "--verbose"], { env: cleanEnv(home), encoding: "utf8", timeout: 60_000 });
    assert.deepEqual([ran.status, ran.stdout, ran.stderr], [2, "", "reaper: unknown option --verbose; usage: reaper.mjs [--dry]\n"]);
    assert.deepEqual(readdirSync(home), []);
});
