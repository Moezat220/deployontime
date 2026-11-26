// Checks on the shape of the code itself. Settings, file locations and the time zone are read in the entry points
// only (the modules that end by running main() when started as a script), and handed down from there: a library
// function that read them by itself would read config.json again on every call. Lines stay short enough to read,
// in the tests as well.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanEnv, tempDir } from "./testkit.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PRODUCTION = readdirSync(HERE)
    .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs") && name !== "testkit.mjs");
const ALL_CODE = readdirSync(HERE).filter((name) => name.endsWith(".mjs"));
const source = (name) => readFileSync(join(HERE, name), "utf8");
const isEntryPoint = (text) => text.includes("isMainModule(import.meta.url)");
// Comments may name the functions; only code counts.
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const HIDDEN_READ = /(?<![\w.])(loadSettings|paths|timeZone|homeDir)\s*\(/g;

/** The hidden reads in a module's code, as "name: call()". In an entry point only the body of main() may read; code
 *  above main() and code below its closing brace may not. */
function hiddenReads(name, text) {
    const body = code(text);
    const mainAt = isEntryPoint(body) ? body.search(/^(export )?(async )?function main\(/m) : -1;
    const mainEnd = mainAt < 0 ? -1 : body.indexOf("\n}", mainAt);
    const inMain = (at) => mainAt >= 0 && at > mainAt && at < mainEnd;
    return [...body.matchAll(HIDDEN_READ)].filter((hit) => !inMain(hit.index)).map((hit) => `${name}: ${hit[1]}()`);
}

test("layout: only an entry point's main() reads the settings, the state folder or the zone", () => {
    assert.equal(PRODUCTION.includes("settings.mjs") && PRODUCTION.includes("cli.mjs"), true);
    const found = PRODUCTION.filter((file) => file !== "settings.mjs").flatMap((name) => hiddenReads(name, source(name)));
    assert.deepEqual(found, []);
});

test("layout: a read above main(), or in a helper below it, is found", () => {
    const entry = [
        "const early = paths();",
        "async function main() {",
        "    const files = paths();",
        "    return helper(files);",
        "}",
        "function helper() { return timeZone(); }",
        "if (isMainModule(import.meta.url)) await main();",
    ].join("\n");
    assert.deepEqual(hiddenReads("entry.mjs", entry), ["entry.mjs: paths()", "entry.mjs: timeZone()"]);
    assert.deepEqual(hiddenReads("library.mjs", "export const zone = () => timeZone();"), ["library.mjs: timeZone()"]);
});

test("layout: importing every module reads no config file", () => {
    const home = tempDir("layout-home");
    mkdirSync(join(home, "config.json"));
    const imports = PRODUCTION.map((name) => `await import(${JSON.stringify(join(HERE, name))});`).join(" ");
    const options = { env: cleanEnv(home), encoding: "utf8", timeout: 60_000 };
    const ran = spawnSync(process.execPath, ["--input-type=module", "-e", imports], options);
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stderr, "");
});

test("layout: no line of code or tests is longer than 160 characters", () => {
    const long = [];
    for (const name of ALL_CODE) {
        source(name).split("\n").forEach((line, i) => {
            if (line.length > 160) long.push(`${name}:${i + 1} (${line.length})`);
        });
    }
    assert.deepEqual(long, []);
});

test("layout: no file has two blank lines in a row", () => {
    const doubled = ALL_CODE.filter((name) => /\n\s*\n\s*\n/.test(source(name).replace(/[ \t]+\n/g, "\n")));
    assert.deepEqual(doubled, []);
});

test("layout: the code layout table in the README has one row per module, and no other", () => {
    const rows = [...source("README.md").matchAll(/^\| `([\w-]+\.mjs)` \|/gm)].map((m) => m[1]).sort();
    assert.deepEqual(rows, [...PRODUCTION, "testkit.mjs"].sort());
});
