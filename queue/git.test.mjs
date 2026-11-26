import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git as testGit, isolateProcess, makeRepo, tempDir } from "./testkit.mjs";

isolateProcess("git");
const { git, gitState, porcelainClean, readOnlyGit, repoName } = await import("./git.mjs");
const { folderProject } = await import("./project.mjs");

test("git: the output as text or bytes, and null when git fails", () => {
    const repo = makeRepo(join(tempDir("git"), "shop-api"));
    assert.equal(/^[0-9a-f]{40}\n$/.test(git(repo, ["rev-parse", "HEAD"])), true);
    assert.equal(Buffer.isBuffer(git(repo, ["status", "--porcelain"], { encoding: "buffer" })), true);
    assert.equal(git(repo, ["rev-parse", "no-such-revision"]), null);
    assert.equal(git(tempDir("git"), ["rev-parse", "HEAD"]), null);
    assert.equal(git(repo, ["status", "--porcelain"], { timeout: 1 }), null, "a call that runs out of time");
});

test("git: output above 1 MB gives null unless a larger maxBuffer is given", () => {
    const big = "0123456789abcdef\n".repeat(80_000);
    const repo = makeRepo(join(tempDir("git-big"), "media-site"), { "big.txt": big });
    assert.equal(git(repo, ["show", "HEAD:big.txt"]), null, "the default cap of 1 MB, as gitState uses it");
    assert.equal(git(repo, ["show", "HEAD:big.txt"], { maxBuffer: 4 * 1024 * 1024 }), big);
});

test("repoName: the repository folder, the main one for a linked worktree, null outside git", () => {
    const root = tempDir("git"), repo = makeRepo(join(root, "docs-site"), { "pages/intro.md": "# intro\n" });
    assert.equal(repoName(join(repo, "pages")), "docs-site");
    testGit(repo, "worktree", "add", "-q", join(root, "docs-site-preview"), "-b", "preview");
    assert.equal(repoName(join(root, "docs-site-preview")), "docs-site");
    const plain = join(tempDir("git"), "scratch");
    mkdirSync(plain);
    assert.equal(repoName(plain), null);
});

test("porcelainClean: clean for no output and for untracked node_modules links only", () => {
    for (const status of ["?? notes.txt\n", "A  node_modules\n", "?? node_modules.bak\n", " D node_modules\n", "?? node_modules\n M lib/price.js\n", " M lib/price.js\n", "?? tools/cache/node_modules/\n"]) {
        assert.equal(porcelainClean(status), false, JSON.stringify(status));
    }
    for (const status of ["?? packages/ui/node_modules\n", "?? packages/ui/node_modules\n?? node_modules\n", "?? node_modules\n", ""]) assert.equal(porcelainClean(status), true, JSON.stringify(status));
});

test("gitState: null answers outside a repository", () => {
    assert.deepEqual(gitState(tempDir("journal")), { head: null, clean: null });
});

test("gitState: reports the commit, and clean until a file changes or appears", () => {
    const repo = makeRepo(join(tempDir("journal"), "shop-api"), { "lib/price.js": "export const vat = 0.2;\n" });
    const before = gitState(repo);
    assert.equal(/^[0-9a-f]{40}$/.test(before.head), true);
    assert.equal(before.clean, true);
    writeFileSync(join(repo, "lib", "tax.js"), "export const rate = 0.1;\n");
    assert.deepEqual(gitState(repo), { head: before.head, clean: false });
});

test("gitState: a node_modules symlink escapes the `node_modules/` ignore rule, and the tree still counts as clean", () => {
    const repo = makeRepo(join(tempDir("journal"), "docs-site"), { ".gitignore": "node_modules/\n", "index.md": "# docs\n" });
    symlinkSync(tempDir("shared-modules"), join(repo, "node_modules"));
    assert.equal(gitState(repo).clean, true);
    writeFileSync(join(repo, "index.md"), "# docs, edited\n");
    assert.equal(gitState(repo).clean, false);
});

test("readOnlyGit: no index lock, no watcher program, and the caller's own settings kept", () => {
    assert.deepEqual(readOnlyGit({ KEEP: "1" }), { KEEP: "1", GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "false" });
    const added = readOnlyGit({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.pager", GIT_CONFIG_VALUE_0: "cat" });
    assert.deepEqual([added.GIT_CONFIG_COUNT, added.GIT_CONFIG_KEY_0, added.GIT_CONFIG_KEY_1, added.GIT_CONFIG_VALUE_1], ["2", "core.pager", "core.fsmonitor", "false"]);
});

test("the queue's git calls do not start a watcher program named in the repository's settings", async () => {
    const repo = makeRepo(tempDir("project")), marker = join(tempDir("project-marker"), "watcher-ran");
    testGit(repo, "config", "core.fsmonitor", `touch '${marker}'; false`);
    assert.equal(testGit(repo, "config", "core.fsmonitor").trim(), `touch '${marker}'; false`);
    folderProject(repo);
    gitState(repo);
    assert.equal(existsSync(marker), false);
});
