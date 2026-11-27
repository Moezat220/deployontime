import "./testkit.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./testkit.mjs";
import { appendLine, dropOldTemps, readJson, STALE_TEMP_MS, tempName, writeJsonAtomic } from "./files.mjs";

test("readJson: the content, or the fallback; only a file that exists but is unusable is reported", () => {
    const dir = tempDir("files"), seen = [], problem = (...args) => seen.push(args);
    writeFileSync(join(dir, "good.json"), '{"slots":3}');
    writeFileSync(join(dir, "broken.json"), "{");
    mkdirSync(join(dir, "folder.json"));
    assert.deepEqual(readJson(join(dir, "good.json"), {}, problem), { slots: 3 });
    assert.deepEqual(readJson(join(dir, "absent.json"), { none: true }, problem), { none: true });
    assert.equal(readJson(join(dir, "broken.json"), null, problem), null);
    assert.equal(readJson(join(dir, "folder.json"), null, problem), null);
    assert.deepEqual(seen, [["invalid"], ["unreadable", "EISDIR"]]);
    assert.equal(readJson(join(dir, "broken.json")), null);
});

test("writeJsonAtomic: creates the folder, writes the whole value and leaves no temporary file", () => {
    const dir = tempDir("files"), file = join(dir, "deep", "state.json");
    writeJsonAtomic(file, { streak: 2 });
    writeJsonAtomic(file, { streak: 3 }, 1);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { streak: 3 });
    assert.deepEqual(readdirSync(join(dir, "deep")), ["state.json"]);
    assert.equal(tempName(file).endsWith(".json"), false);
});

test("writeJsonAtomic: throws when the file cannot be written", () => {
    const blocker = join(tempDir("files"), "plain-file");
    writeFileSync(blocker, "");
    assert.throws(() => writeJsonAtomic(join(blocker, "state.json"), {}));
});

test("writeJsonAtomic: removes its temporary file when the move into place fails", () => {
    const dir = tempDir("files"), file = join(dir, "health.json");
    mkdirSync(join(file, "taken"), { recursive: true });
    assert.throws(() => writeJsonAtomic(file, { at: 1 }));
    assert.deepEqual(readdirSync(dir), ["health.json"]);
});

test("appendLine: adds to the end, creating the folder, and is false instead of throwing on failure", () => {
    const dir = tempDir("files"), file = join(dir, "logs", "notify.log");
    assert.equal(appendLine(file, "one\n"), true);
    assert.equal(appendLine(file, "two\n"), true);
    assert.equal(readFileSync(file, "utf8"), "one\ntwo\n");
    const blocker = join(dir, "plain-file");
    writeFileSync(blocker, "");
    assert.equal(appendLine(join(blocker, "notify.log"), "three\n"), false);
});

test("dropOldTemps: removes only the temporary files of that file that are older than STALE_TEMP_MS", () => {
    const dir = tempDir("files-temp"), file = join(dir, "settings.json");
    const now = Date.now(), old = new Date(now - STALE_TEMP_MS - 1000);
    for (const name of ["settings.json", "settings.json.tmp-501", "settings.json.tmp-502", "journal.json.tmp-503"]) {
        writeFileSync(join(dir, name), "{}");
    }
    for (const name of ["settings.json", "settings.json.tmp-501", "journal.json.tmp-503"]) utimesSync(join(dir, name), old, old);
    dropOldTemps(file, now);
    assert.deepEqual(readdirSync(dir).sort(), ["journal.json.tmp-503", "settings.json", "settings.json.tmp-502"]);
    dropOldTemps(join(dir, "absent", "settings.json"), now);
});
