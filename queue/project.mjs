// Works out which project a job counts under: the part of its label in front of the colon, else the name of the
// repository folder it runs in, else the name of the folder itself.
import { spawnSync } from "node:child_process";
import { basename, dirname } from "node:path";

/** The label prefix: "shop-api" for "shop-api: unit tests", null without one. */
export function labelProject(label) {
    return String(label ?? "").match(/^([^:]{1,40}):/)?.[1].trim() || null;
}

/** The environment for the queue's own git calls, which only look. GIT_OPTIONAL_LOCKS=0: the index lock is never
 *  taken, so an agent's own `git add` or `git commit` at the same moment cannot fail because of the queue.
 *  core.fsmonitor=false: a watcher program named in a repository's settings is not started. */
export function readOnlyGit(env = process.env) {
    const n = Number(env.GIT_CONFIG_COUNT) || 0;
    return { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: "core.fsmonitor", [`GIT_CONFIG_VALUE_${n}`]: "false" };
}

/** The repository folder name for a working directory. A linked worktree reports its main repository. */
export function folderProject(cwd) {
    try {
        const asked = spawnSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", timeout: 3000, env: readOnlyGit() });
        const gitDir = asked.status === 0 ? asked.stdout.trim() : "";
        if (gitDir) return basename(gitDir.endsWith("/.git") ? dirname(gitDir) : gitDir);
    } catch { /* treated as a plain folder */ }
    return basename(cwd) || "unknown";
}

export function jobProject({ label, project, cwd } = {}) {
    return labelProject(label) || project || (cwd ? basename(cwd) : null) || "unknown";
}
