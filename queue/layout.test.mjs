// Checks on the shape of the code itself. Settings, file locations and the time zone are read in the entry points
// only (the modules that end by running main() when started as a script), and handed down from there: a library
// function that read them by itself would read config.json again on every call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanEnv, tempDir } from "./testkit.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PRODUCTION = readdirSync(HERE).filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs") && name !== "testkit.mjs");
const source = (name) => readFileSync(join(HERE, name), "utf8");
const isEntryPoint = (text) => text.includes("isMainModule(import.meta.url)");
// Comments may name the functions; only code counts.
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const HIDDEN_READ = /(?<![\w.])(loadSettings|paths|timeZone|homeDir)\s*\(/g;

test("layout: only an entry point's main() reads the settings, the state folder or the zone", () => {
    assert.equal(PRODUCTION.includes("settings.mjs") && PRODUCTION.includes("cli.mjs"), true);
    const found = [];
    for (const name of PRODUCTION.filter((file) => file !== "settings.mjs")) {
        const text = code(source(name));
        const mainAt = isEntryPoint(text) ? text.search(/^(export )?(async )?function main\(/m) : Infinity;
        for (const hit of text.matchAll(HIDDEN_READ)) if (hit.index < mainAt) found.push(`${name}: ${hit[1]}()`);
    }
    assert.deepEqual(found, []);
});

test("layout: importing every module reads no config file", () => {
    const home = tempDir("layout-home");
    mkdirSync(join(home, "config.json"));
    const imports = PRODUCTION.map((name) => `await import(${JSON.stringify(join(HERE, name))});`).join(" ");
    const ran = spawnSync(process.execPath, ["--input-type=module", "-e", imports], { env: cleanEnv(home), encoding: "utf8", timeout: 60_000 });
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stderr, "");
});
