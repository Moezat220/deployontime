import "./testkit.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { LAUNCHER_RE, SHELL_PROGRAM_RE, SHELLS, STRAY_TEST_RE, TEST_KIND_RE, TEST_RUN_RE } from "./commands.mjs";

test("node --test: a test kind and a one-shot test, but never a process of a stray run", () => {
    assert.deepEqual([TEST_KIND_RE.test("node --test queue/"), TEST_RUN_RE.test("node --test queue/")], [true, true]);
    assert.equal(STRAY_TEST_RE.test("node --test queue/"), false);
});

test("SHELL_PROGRAM_RE: a shell as the program, in any folder, and not a word further along", () => {
    for (const cmd of ["sh -c jest", "/bin/zsh", "/opt/homebrew/bin/bash -lc vitest"]) assert.equal(SHELL_PROGRAM_RE.test(cmd), true, cmd);
    for (const cmd of ["node shell.js", "make sh", "bashful run", "/srv/sh/tool"]) assert.equal(SHELL_PROGRAM_RE.test(cmd), false, cmd);
    assert.deepEqual([...SHELLS], ["sh", "bash", "zsh"]);
});

test("LAUNCHER_RE: package managers, the script node runs for one, and a shell with -c", () => {
    for (const cmd of ["npm run dev", "/usr/local/bin/pnpm dev", "node /opt/tools/lib/pnpm/bin/pnpm.cjs dev", "sh -c vite", "/bin/bash -c next dev"]) {
        assert.equal(LAUNCHER_RE.test(cmd), true, cmd);
    }
    for (const cmd of ["make -C /srv/npm watch-all", "bash script.sh", "node server.js"]) assert.equal(LAUNCHER_RE.test(cmd), false, cmd);
});

test("TEST_RUN_RE: matches test commands that exit by themselves", () => {
    for (const command of [
        "npx vitest run", "npx vitest --run", "node --test queue/", "npx playwright test --project mobile",
        "node node_modules/.bin/jest",
    ]) assert.equal(TEST_RUN_RE.test(command), true, command);
    for (const command of ["npx vitest", "node node_modules/.bin/jest --watch", "node server.js"]) assert.equal(TEST_RUN_RE.test(command), false, command);
});

test("STRAY_TEST_RE: recognises test runner and worker processes", () => {
    for (const cmd of [
        "node node_modules/.bin/vitest run",
        "node node_modules/jest-worker/build/workers/processChild.js",
        "node node_modules/.bin/jest --runInBand",
        "npx playwright test",
        "node node_modules/@playwright/test/cli.js test",
    ]) assert.equal(STRAY_TEST_RE.test(cmd), true, cmd);
    for (const cmd of ["node api/server.js", "node node_modules/.bin/vite", "git status"]) assert.equal(STRAY_TEST_RE.test(cmd), false, cmd);
});
