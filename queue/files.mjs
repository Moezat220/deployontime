// The file helpers of the modules that keep state on disk: a JSON read that tells a missing file from a broken one,
// a JSON write that no reader ever sees half done, and an append that creates the folder first.
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The name a file is written under before it is moved into place. It does not end in ".json", so a reader that
 *  lists entries by that ending skips it. */
export const tempName = (file) => `${file}.tmp-${process.pid}`;

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
 *  file cannot be written. */
export function writeJsonAtomic(file, value, space = undefined) {
    mkdirSync(dirname(file), { recursive: true });
    const temp = tempName(file);
    writeFileSync(temp, JSON.stringify(value, null, space));
    renameSync(temp, file);
}

/** Appends text to a file, creating its folder first. Returns false, without throwing, when that fails. */
export function appendLine(file, text) {
    try {
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, text);
        return true;
    } catch { return false; }
}
