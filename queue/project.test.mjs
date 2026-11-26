import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { git, isolateProcess, makeRepo, tempDir } from "./testkit.mjs";

isolateProcess("project");
const { folderProject, jobProject, labelProject, readOnlyGit } = await import("./project.mjs");

test("readOnlyGit: no index lock, no watcher program, and the caller's own settings kept", () => {
    assert.deepEqual(readOnlyGit({ KEEP: "1" }), { KEEP: "1", GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "false" });
    const added = readOnlyGit({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.pager", GIT_CONFIG_VALUE_0: "cat" });
    assert.deepEqual([added.GIT_CONFIG_COUNT, added.GIT_CONFIG_KEY_0, added.GIT_CONFIG_KEY_1, added.GIT_CONFIG_VALUE_1], ["2", "core.pager", "core.fsmonitor", "false"]);
});

test("the queue's git calls do not start a watcher program named in the repository's settings", async () => {
    const { gitState } = await import("./journal.mjs");
    const repo = makeRepo(tempDir("project")), marker = join(tempDir("project-marker"), "watcher-ran");
    git(repo, "config", "core.fsmonitor", `touch '${marker}'; false`);
    folderProject(repo);
    gitState(repo);
    assert.equal(existsSync(marker), false);
});

test("labelProject: the text in front of the first colon", () => {
    assert.equal(labelProject("mobile-app: integration suite"), "mobile-app");
    assert.equal(labelProject("docs-site:link check"), "docs-site");
    assert.equal(labelProject("shop-api : build: prod"), "shop-api");
    assert.equal(labelProject("nightly bundle"), null);
    assert.equal(labelProject(":"), null);
    assert.equal(labelProject(null), null);
});

test("folderProject: the folder name outside git", () => {
    const plain = join(tempDir("project"), "scratch-area", "drafts");
    mkdirSync(plain, { recursive: true });
    assert.equal(folderProject(plain), "drafts");
});

test("folderProject: the repository name from any folder inside it", () => {
    const repo = makeRepo(join(tempDir("project"), "docs-site"), { "pages/guide/intro.md": "# intro\n" });
    assert.equal(folderProject(repo), "docs-site");
    assert.equal(folderProject(join(repo, "pages", "guide")), "docs-site");
});

test("folderProject: a linked worktree reports its main repository", () => {
    const root = tempDir("project"), repo = makeRepo(join(root, "shop-api")), linked = join(root, "shop-api-hotfix");
    git(repo, "worktree", "add", "-q", linked, "-b", "hotfix");
    assert.equal(folderProject(linked), "shop-api");
});

test("jobProject: label first, then the given project, then the folder name", () => {
    assert.equal(jobProject({ label: "docs-site: build", project: "monorepo", cwd: "/srv/monorepo" }), "docs-site");
    assert.equal(jobProject({ label: "build", project: "monorepo", cwd: "/srv/elsewhere" }), "monorepo");
    assert.equal(jobProject({ label: "build", cwd: "/srv/mobile-app" }), "mobile-app");
    assert.equal(jobProject({ label: "build" }), "unknown");
    assert.equal(jobProject(), "unknown");
});
