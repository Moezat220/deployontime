import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isolateProcess, makeRepo, tempDir } from "./testkit.mjs";

isolateProcess("fingerprint");
const { fingerprint: fingerprintIn, UNTRACKED } = await import("./fingerprint.mjs");
const { DEFAULTS } = await import("./settings.mjs");
// The output folders the shipped settings name, unless a test gives its own.
const fingerprint = (cwd, command = [], ignoreDirs = DEFAULTS.outputDirs) => fingerprintIn(cwd, command, ignoreDirs);

const write = (dir, name, text) => { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), text); };

test("fingerprint: stable while nothing changes, different after an edit to tracked or untracked code", () => {
    const repo = makeRepo(join(tempDir("limits"), "shop-api"), { "src/cart.js": "export const items = [];\n" });
    const start = fingerprint(repo, ["pnpm", "test"]);
    assert.equal(/^[0-9a-f]{16}$/.test(start), true);
    assert.equal(fingerprint(repo, ["pnpm", "test"]), start);
    write(repo, "src/cart.js", "export const items = [1];\n");
    const edited = fingerprint(repo, ["pnpm", "test"]);
    write(repo, "src/cart.test.js", "// first draft\n");
    const added = fingerprint(repo, ["pnpm", "test"]);
    write(repo, "src/cart.test.js", "// second draft\n");
    assert.equal(new Set([start, edited, added, fingerprint(repo, ["pnpm", "test"])]).size, 4);
});

test("fingerprint: output folders and binary files do not count as code", () => {
    const repo = makeRepo(join(tempDir("limits"), "docs-site"));
    const rewrite = (round) => {
        for (const name of [
            "dist/site.js", ".next/cache/page.json", "coverage/lcov.info", "packages/ui/.turbo/build.log",
            ".wrangler/state.txt", "report.pdf", "screens/home.png",
        ]) write(repo, name, `output ${round}`);
        return fingerprint(repo);
    };
    const withOutput = rewrite(1);
    assert.equal(rewrite(2), withOutput);
    write(repo, "packages/ui/index.js", "export {};\n");
    assert.notEqual(fingerprint(repo), withOutput);
});

test("fingerprint: the list of output folders can be replaced", () => {
    const repo = makeRepo(join(tempDir("limits"), "mobile-app"));
    write(repo, "generated/api.js", "v1");
    const [counted, skipped] = [fingerprint(repo), fingerprint(repo, [], ["generated"])];
    write(repo, "generated/api.js", "v2");
    assert.notEqual(fingerprint(repo), counted);
    assert.equal(fingerprint(repo, [], ["generated"]), skipped);
    assert.equal(UNTRACKED.maxFiles > 0 && UNTRACKED.maxFileBytes > 0, true);
});

test("fingerprint: a script named in the command counts, also outside git", () => {
    const dir = tempDir("limits");
    write(dir, "task.mjs", "console.log(1);\n");
    const before = fingerprint(dir, ["node", "task.mjs"]);
    assert.equal(fingerprint(dir, ["node", "task.mjs"]), before);
    write(dir, "task.mjs", "console.log(2);\n");
    assert.notEqual(fingerprint(dir, ["node", "task.mjs"]), before);
    assert.equal(/^[0-9a-f]{16}$/.test(fingerprint(dir, ["node", join(dir, "absent.mjs")])), true);
});
