// The file helpers of the modules that keep state on disk: a JSON read that tells a missing file from a broken one,
// a JSON write that no reader ever sees half done, the removal of temporary files a dead process left behind, and an
// append that creates the folder first.
import {
    appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { MINUTE } from "./units.mjs";

/** How old a temporary file must be before it counts as abandoned by a process that died while writing it. */
export const STALE_TEMP_MS = MINUTE;

/** The name a file is written under before it is moved into place. It does not end in ".json", so a reader that
 *  lists entries by that ending skips it. */
export const tempName = (file) => `${file}.tmp-${process.pid}`;

/** Removes a temporary file that is older than STALE_TEMP_MS; a younger one is a write still in progress. */
export function dropOldTemp(file, now = Date.now()) {
    try {
        if (now - statSync(file).mtimeMs > STALE_TEMP_MS) rmSync(file, { force: true });
    } catch { /* already gone */ }
}

/** Removes the abandoned temporary files of one file, the ones tempName() gave it in any process. */
export function dropOldTemps(file, now = Date.now()) {
    const prefix = `${basename(file)}.tmp-`;
    let names = [];
    try { names = readdirSync(dirname(file)); } catch { return; }
    for (const name of names) if (name.startsWith(prefix)) dropOldTemp(join(dirname(file), name), now);
}

/** The parsed content of a JSON file, or fallback when there is none. A missing file is silent. For a file that
 *  exists but cannot be read, problem("unreadable", code) is called; for one that is not JSON, problem("invalid"). */
export function readJson(file, fallback = null, problem = null) {
    let text;
    try {
        text = readFileSync(file, "utf8");
    } catch (e) {
        if (e.code !== "ENOENT") problem?.("unreadable", e.code ?? e.message);
        return fallback;
    }
    try {
        return JSON.parse(text);
    } catch {
        problem?.("invalid");
        return fallback;
    }
}

/** Writes JSON under a temporary name and then moves it into place, creating the folder first. Throws when the
 *  file cannot be written; the temporary file is removed again in that case. mode: the permissions of the new file,
 *  by default those the umask leaves. */
export function writeJsonAtomic(file, value, space = undefined, mode = undefined) {
    mkdirSync(dirname(file), { recursive: true });
    const temp = tempName(file);
    try {
        rmSync(temp, { force: true });
        writeFileSync(temp, JSON.stringify(value, null, space), mode === undefined ? undefined : { mode });
        renameSync(temp, file);
    } catch (e) {
        rmSync(temp, { force: true });
        throw e;
    }
}

/** Appends text to a file, creating its folder first. Returns false, without throwing, when that fails. */
export function appendLine(file, text) {
    try {
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, text);
        return true;
    } catch { return false; }
}
