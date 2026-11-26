// Importing testkit alone, without isolateProcess(), already gives the test file a state folder of its own.
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { sep } from "node:path";
import "./testkit.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

test("testkit: importing it points DOTIME_HOME at a temp folder and keeps notices in the log", () => {
    const home = realpathSync(process.env.DOTIME_HOME);
    assert.equal(home.startsWith(realpathSync(tmpdir()) + sep), true);
    assert.equal(process.env.DOTIME_NOTIFY, "log");
});
