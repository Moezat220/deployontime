// The code fingerprint: a hash that moves when the code under test moves. It runs read-only git commands and reads
// files, and is what the repeated-failure stop compares between runs.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.mjs";

// A hash that moves when the code under test moves. Tracked files always count. Small untracked files are hashed
// whole, big ones as size plus modification time. Untracked files in output folders, and untracked media, archive
// and log files, stay out of it: a check rewrites those on every run.

export const UNTRACKED = { maxFileBytes: 1024 * 1024, maxFiles: 2000, maxTotalBytes: 32 * 1024 * 1024 };
const SKIPPED_UNTRACKED_RE = /\.(png|jpe?g|gif|webp|avif|ico|bmp|mp4|webm|mov|pdf|zip|t?gz|log)$/i;
const SCRIPT_MAX_BYTES = 4 * 1024 * 1024;

function addUntracked(hash, cwd, ignoreDirs) {
    const top = git(cwd, ["rev-parse", "--show-toplevel"])?.trim();
    if (!top) return;
    const excludes = ignoreDirs.map((dir) => `:(top,exclude,glob)**/${dir}/**`);
    const listArgs = ["ls-files", "-o", "--exclude-standard", "-z", "--", ".", ...excludes];
    const listed = git(top, listArgs, { timeout: 15_000, maxBuffer: 64 * 1024 * 1024 });
    if (listed === null) {
        hash.update("untracked-unknown");
        return;
    }
    const counted = (name) => name && !SKIPPED_UNTRACKED_RE.test(name);
    const files = listed.split("\0").filter(counted).sort().slice(0, UNTRACKED.maxFiles);
    let bytesRead = 0;
    for (const name of files) {
        try {
            const path = join(top, name);
            const info = statSync(path);
            if (!info.isFile()) continue;
            hash.update(`\0${name}\0`);
            const whole = info.size <= UNTRACKED.maxFileBytes && bytesRead + info.size <= UNTRACKED.maxTotalBytes;
            if (whole) {
                hash.update(readFileSync(path));
                bytesRead += info.size;
            } else hash.update(`${info.size}:${info.mtimeMs}`);
        } catch { /* the file went away */ }
    }
}
/** A short hash over uncommitted changes, untracked files and any file named in the command. ignoreDirs: the
 *  outputDirs setting. Never throws. */
export function fingerprint(cwd, command, ignoreDirs) {
    const hash = createHash("sha1");
    try {
        // --no-ext-diff --no-textconv: a diff program configured in the repository is never started by the queue
        for (const args of [["status", "--porcelain"], ["diff", "--no-ext-diff", "--no-textconv", "HEAD"]]) {
            const out = git(cwd, args, { encoding: "buffer", timeout: 15_000, maxBuffer: 256 * 1024 * 1024 });
            hash.update(out ?? Buffer.from("git-unknown"));
        }
        addUntracked(hash, cwd, ignoreDirs);
    } catch { hash.update("git-unknown"); }
    for (const arg of command) {
        try {
            const path = arg.startsWith("/") ? arg : join(cwd, arg);
            const info = statSync(path);
            if (info.isFile() && info.size < SCRIPT_MAX_BYTES) hash.update(readFileSync(path));
        } catch { /* not a file */ }
    }
    return hash.digest("hex").slice(0, 16);
}
