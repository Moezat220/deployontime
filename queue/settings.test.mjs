import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { settingEnv, tempDir } from "./testkit.mjs";
import { DEFAULTS, defaultHome, homeDir, isMainModule, loadSettings, paths, timeZone } from "./settings.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const collect = () => { const seen = []; return { seen, warn: (text) => seen.push(text) }; };
const load = (config, env = {}) => {
    const c = collect();
    return { settings: loadSettings(env, { configText: JSON.stringify(config), warn: c.warn }), warnings: c.seen };
};

test("homeDir: uses DOTIME_HOME, else the default folder", () => {
    const dir = tempDir("settings");
    assert.equal(homeDir({ DOTIME_HOME: dir }), dir);
    assert.equal(homeDir({}), defaultHome());
    assert.ok(defaultHome().endsWith(".dotime"));
});

test("isMainModule: compares real paths, so a symlink to the script still matches", () => {
    const script = join(HERE, "cli.mjs"), link = join(tempDir("settings"), "linked-cli.mjs");
    symlinkSync(script, link);
    const url = pathToFileURL(script).href;
    assert.equal(isMainModule(url, script), true);
    assert.equal(isMainModule(url, link), true);
    assert.equal(isMainModule(url, join(HERE, "reaper.mjs")), false);
    assert.equal(isMainModule(url, undefined), false);
});

test("paths: every file lies inside the state folder", () => {
    const dir = tempDir("settings"), all = paths({ DOTIME_HOME: dir });
    assert.equal(all.home, dir);
    assert.equal(all.journal, join(dir, "journal.jsonl"));
    assert.equal(all.notices, join(dir, "notices"));
    assert.equal(Object.values(all).every((p) => p === dir || p.startsWith(dir + sep)), true);
});

test("timeZone: DOTIME_TZ when it is a known zone, else UTC", () => {
    assert.equal(timeZone({ DOTIME_TZ: "Africa/Nairobi" }), "Africa/Nairobi");
    assert.equal(timeZone({ DOTIME_TZ: "Atlantis/Central" }), "UTC");
    assert.equal(timeZone({}), "UTC");
});

test("loadSettings: gives the defaults when there is no config file", () => {
    const c = collect();
    assert.deepEqual(loadSettings({ DOTIME_HOME: tempDir("settings") }, { warn: c.warn }), DEFAULTS);
    assert.deepEqual(c.seen, []);
});

test("loadSettings: a config.json that exists but cannot be read is reported, and the defaults are used", () => {
    const home = tempDir("settings"), c = collect();
    mkdirSync(join(home, "config.json"));
    assert.deepEqual(loadSettings({ DOTIME_HOME: home }, { warn: c.warn }), DEFAULTS);
    assert.deepEqual(c.seen, ["config.json ignored: it could not be read (EISDIR), defaults kept"]);
});

test("loadSettings: config.json replaces single values and leaves the rest", () => {
    const dir = tempDir("settings");
    writeFileSync(join(dir, "config.json"), JSON.stringify({ slots: 4, maxWaitMin: 0, idle: { slotIdleMin: 25 }, outputDirs: ["target"] }));
    const s = loadSettings({ DOTIME_HOME: dir }, { warn: assert.fail });
    assert.equal(s.slots, 4);
    assert.equal(s.maxWaitMin, 0);
    assert.equal(s.idle.slotIdleMin, 25);
    assert.equal(s.idle.serverIdleMin, DEFAULTS.idle.serverIdleMin);
    assert.deepEqual(s.outputDirs, ["target"]);
    assert.deepEqual(s.health, DEFAULTS.health);
});

test("loadSettings: environment variables cannot change a setting", () => {
    // No variable name is special: one is made up for every setting, so a setting added later is covered too.
    const env = settingEnv(DEFAULTS, 987654);
    assert.equal(env.DOTIME_HEALTH_MINFREEDISKGB, "987654");
    assert.equal(Object.keys(env).length > 25, true);
    assert.deepEqual(loadSettings({ ...env, DOTIME_HOME: tempDir("settings") }, { warn: assert.fail }), DEFAULTS);
});

test("loadSettings: a zero or negative limit falls back to its default with a warning", () => {
    const bad = {
        slots: 0,
        pollMs: -50,
        idle: { serverIdleMin: 0, slotIdleMin: -3 },
        limits: { defaultMin: 0, debugMin: -1, floorMin: 0, priorityGrace: 0.5, minSamples: 0 },
    };
    const { settings, warnings } = load(bad);
    assert.deepEqual(settings, DEFAULTS);
    assert.equal(warnings.length, 9);
    assert.equal(warnings.includes(`setting ignored: idle.serverIdleMin is 0, needs a number above 0, default ${DEFAULTS.idle.serverIdleMin} kept`), true);
    assert.equal(warnings.includes(`setting ignored: slots is 0, needs a number of 1 or more, default ${DEFAULTS.slots} kept`), true);
});

test("loadSettings: a time in milliseconds longer than one timer can hold falls back to its default", () => {
    const { settings, warnings } = load({ pollMs: 2 ** 31, limits: { killGraceMs: 1e12, orphanCheckMs: 2 ** 31 - 1 } });
    assert.deepEqual(
        [settings.pollMs, settings.limits.killGraceMs, settings.limits.orphanCheckMs],
        [DEFAULTS.pollMs, DEFAULTS.limits.killGraceMs, 2 ** 31 - 1],
    );
    assert.equal(warnings.length, 2);
    assert.equal(warnings.includes(`setting ignored: pollMs is ${2 ** 31}, `
        + `needs a number above 0 and at most ${2 ** 31 - 1}, default ${DEFAULTS.pollMs} kept`), true);
});

test("loadSettings: health.busyCpuPct is a percentage above 0 and at most 100", () => {
    assert.equal(DEFAULTS.health.busyCpuPct, 90);
    for (const value of [1, 75.5, 100]) {
        const { settings, warnings } = load({ health: { busyCpuPct: value } });
        assert.deepEqual([settings.health.busyCpuPct, warnings], [value, []]);
    }
    for (const value of [0, -5, 100.5, 250, "90", null]) {
        const { settings, warnings } = load({ health: { busyCpuPct: value } });
        assert.equal(settings.health.busyCpuPct, 90);
        assert.deepEqual(warnings, [`setting ignored: health.busyCpuPct is ${JSON.stringify(value)}, `
            + "needs a number above 0 and at most 100, default 90 kept"]);
    }
});

test("loadSettings: zero stays allowed where it switches a check off", () => {
    const { settings, warnings } = load({ maxWaitMin: 0, health: { minFreeDiskGB: 0, minBatteryPct: 0 }, limits: { killGraceMs: 0 } });
    assert.deepEqual(warnings, []);
    assert.equal(settings.health.minFreeDiskGB, 0);
    assert.equal(settings.limits.killGraceMs, 0);
});

test("loadSettings: wrong types, unknown names and bad patterns are named and ignored", () => {
    const { settings, warnings } = load({
        slots: "three",
        health: 5,
        limit: { defaultMin: 5 },
        reaper: { serverPattern: "(unclosed", keepPattern: "" },
        outputDirs: ["a/b"],
    });
    assert.deepEqual(settings, DEFAULTS);
    assert.deepEqual(
        warnings.map((w) => w.split(":")[1].trim().split(" ")[0]).sort(),
        ["health", "limit", "outputDirs", "reaper.keepPattern", "reaper.serverPattern", "slots"],
    );
});

test("loadSettings: a config file that is not a JSON object is ignored as a whole", () => {
    for (const text of ["{ slots: 4", "[1, 2]", "7"]) {
        const c = collect();
        assert.deepEqual(loadSettings({}, { configText: text, warn: c.warn }), DEFAULTS);
        assert.equal(c.seen.length, 1);
    }
});

test("loadSettings: a fractional slot count is rounded down", () => {
    assert.equal(load({ slots: 3.8 }).settings.slots, 3);
});

test("loadSettings: the built-in warning is printed once per process for the same value", () => {
    const written = [], original = process.stderr.write;
    process.stderr.write = (text) => { written.push(String(text)); return true; };
    try {
        for (let i = 0; i < 3; i++) loadSettings({}, { configText: '{"limits":{"defaultMin":-7}}' });
    } finally { process.stderr.write = original; }
    assert.deepEqual(written, [`dotime-queue: setting ignored: limits.defaultMin is -7, needs a number above 0, default ${DEFAULTS.limits.defaultMin} kept\n`]);
});

test("DEFAULTS: output folders and dev-server pattern cover the common tools", () => {
    for (const dir of ["dist", "build", "coverage", ".cache", ".next", ".turbo", ".wrangler", ".vercel"]) {
        assert.equal(DEFAULTS.outputDirs.includes(dir), true, dir);
    }
    const server = new RegExp(DEFAULTS.reaper.serverPattern);
    for (const command of ["node bin/vite", "next dev", "wrangler dev --port 8800", "webpack serve", "nodemon api.js"]) {
        assert.equal(server.test(command), true, command);
    }
});

test("README settings table: every number setting has a row, and each row's marking is what the code enforces", async () => {
    const { readFileSync } = await import("node:fs");
    const rows = readFileSync(join(HERE, "README.md"), "utf8").split("\n").map((l) => /^\| `([\w.]+)` \| ([\d.]+) \| (.*) \|$/.exec(l)).filter(Boolean);
    const numberKeys = Object.entries(DEFAULTS).flatMap(([k, v]) => (typeof v === "number"
        ? [k]
        : v && typeof v === "object" && !Array.isArray(v)
            ? Object.entries(v).filter(([, x]) => typeof x === "number").map(([n]) => `${k}.${n}`)
            : []));
    assert.deepEqual(rows.map(([, key]) => key).sort(), numberKeys.sort());
    const refused = (key, value) => {
        const config = {}, path = key.split(".");
        path.reduce((node, part, i) => (node[part] = i === path.length - 1 ? value : {}), config);
        return load(config).warnings.length > 0;
    };
    for (const [, key, , meaning] of rows) {
        // [value, refused?] pairs that tell the three markings apart
        const probes = /At least 1[.;]/.test(meaning) ? [[0, true], [0.5, true], [1.5, false]]
            : /Above 0\./.test(meaning) ? [[0, true], [0.5, false], [-1, true]]
            : /Above 0, at most 100\./.test(meaning) ? [[0, true], [0.5, false], [100, false], [100.5, true]]
            : [[0, false], [-1, true]];
        for (const [value, no] of probes) assert.equal(refused(key, value), no, `${key} = ${value}: README marking "${meaning}"`);
    }
});
