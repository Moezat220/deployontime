// The queue's own git calls. They only look at a repository: no index lock is taken, and no watcher program named
// in a repository's settings is started. Every call has a time limit, and a call that fails answers null.
import { spawnSync } from "node:child_process";
import { basename, dirname } from "node:path";

/** The environment for the queue's git calls. GIT_OPTIONAL_LOCKS=0: the index lock is never taken, so an agent's
 *  own `git add` or `git commit` at the same moment cannot fail because of the queue. core.fsmonitor=false: a
 *  watcher program named in a repository's settings is not started. */
export function readOnlyGit(env = process.env) {
    const n = Number(env.GIT_CONFIG_COUNT) || 0;
    return {
        ...env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_CONFIG_COUNT: String(n + 1),
        [`GIT_CONFIG_KEY_${n}`]: "core.fsmonitor",
        [`GIT_CONFIG_VALUE_${n}`]: "false",
    };
}

/** The output of `git -C <cwd> <args>`, or null when git is missing, fails, or runs out of time or buffer.
 *  opts: timeout in ms (10 s), maxBuffer in bytes, encoding "utf8" or "buffer". Without maxBuffer the key is left
 *  out, so Node's default of 1 MB applies: a maxBuffer of undefined would mean no limit at all. */
export function git(cwd, args, { timeout = 10_000, maxBuffer, encoding = "utf8" } = {}) {
    const options = { encoding, timeout, ...(maxBuffer === undefined ? {} : { maxBuffer }), env: readOnlyGit() };
    try {
        const ran = spawnSync("git", ["-C", cwd, ...args], options);
        return ran.status === 0 ? ran.stdout : null;
    } catch { return null; }
}

/** Is `git status --porcelain` output free of changes? The one line it forgives is a link named `node_modules`
 *  that git lists as untracked: a `node_modules/` ignore rule matches folders only, and that link is no source. */
export function porcelainClean(status) {
    return String(status).split("\n").filter(Boolean).every((entry) => /^\?\? (.*\/)?node_modules$/.test(entry));
}

/** Returns { head, clean }, each null when git has no answer. */
export function gitState(cwd) {
    const head = git(cwd, ["rev-parse", "HEAD"])?.trim() || null;
    const status = head ? git(cwd, ["status", "--porcelain"]) : null;
    return { head, clean: status == null ? null : porcelainClean(status) };
}

/** Is the folder inside a git repository? True also for a repository that has no commits yet. */
export function isRepository(cwd) {
    return git(cwd, ["rev-parse", "--git-dir"], { timeout: 3000 }) !== null;
}

/** The folder name of the repository a folder belongs to, or null outside git. A linked worktree reports its main
 *  repository. */
export function repoName(cwd) {
    const gitDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { timeout: 3000 })?.trim();
    if (!gitDir) return null;
    return basename(gitDir.endsWith("/.git") ? dirname(gitDir) : gitDir);
}
