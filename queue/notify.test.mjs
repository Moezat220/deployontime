// The desktop channel is always a stand-in here, so no real notice appears.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { tempDir } from "./testkit.mjs";
import { cleanText, notify, runNotifyCommand } from "./notify.mjs";

const AT = Date.UTC(2032, 1, 2, 3, 4, 5);
function channels() {
    const calls = [];
    return {
        calls,
        desktop: (...args) => { calls.push(["desktop", ...args]); return true; },
        command: (...args) => { calls.push(["command", ...args.slice(0, 3)]); return true; }
    };
}

test("cleanText: one printable line, limited in length", () => {
    assert.equal(cleanText("  first\r\nsecond\u0000\tthird  ", 80), "first second third");
    assert.equal(cleanText("0123456789", 4), "0123");
    assert.equal(cleanText(undefined, 10), "");
});

test("cleanText: shortens the home folder to ~", () => {
    const shortened = cleanText(`cd ${homedir()}/code/shop-api && ls ${homedir()}`, 200);
    assert.equal(shortened === "cd ~/code/shop-api && ls ~", true, "home folder was not shortened");
});

test("runNotifyCommand: the shell sees the texts as variables, not as code", () => {
    const out = join(tempDir("notify"), "seen.txt");
    const trap = join(dirname(out), "nope"); // if the quoting ever broke, the file would appear here, inside temp
    const message = `\`touch ${trap}\` $(touch ${trap}) ; touch ${trap}`;
    const sent = runNotifyCommand(`printf '%s / %s' "$DOTIME_TITLE" "$DOTIME_MESSAGE" > "${out}"`, "dotime: disk space low", message, {});
    assert.equal(sent, true);
    assert.equal(readFileSync(out, "utf8"), `dotime: disk space low / ${message}`);
    assert.equal(existsSync(trap), false);
});

test("runNotifyCommand: false when the command fails", () => {
    assert.equal(runNotifyCommand("exit 9", "title", "message", {}), false);
    assert.equal(runNotifyCommand("dotime-command-that-is-not-installed", "title", "message", {}), false);
});

test("notify: writes the log line and uses both other channels", () => {
    const home = tempDir("notify"), c = channels();
    const sent = notify("dotime: job running long", "mobile-app: bundle\nstill going", {
        env: { DOTIME_NOTIFY_CMD: "relay --quiet" }, logFile: join(home, "notify.log"),
        desktop: c.desktop, command: c.command, now: AT
    });
    assert.deepEqual(sent, { logged: true, desktop: true, command: true });
    assert.deepEqual(c.calls, [
        ["desktop", "dotime: job running long", "mobile-app: bundle still going"],
        ["command", "relay --quiet", "dotime: job running long", "mobile-app: bundle still going"],
    ]);
    assert.equal(readFileSync(join(home, "notify.log"), "utf8"), "2032-02-02T03:04:05.000Z\tdotime: job running long\tmobile-app: bundle still going\n");
});

test("notify: DOTIME_NOTIFY=log stops after the log line", () => {
    const home = tempDir("notify"), c = channels();
    const sent = notify("first", "one", {
        env: { DOTIME_NOTIFY: "log", DOTIME_NOTIFY_CMD: "relay" }, logFile: join(home, "notify.log"),
        desktop: c.desktop, command: c.command, now: AT
    });
    assert.deepEqual(sent, { logged: true, desktop: false, command: null });
    assert.deepEqual(c.calls, []);
});

test("notify: without DOTIME_NOTIFY_CMD no command runs", () => {
    const c = channels();
    const sent = notify("second", "two", { env: {}, logFile: join(tempDir("notify"), "notify.log"), desktop: () => false, command: c.command, now: AT });
    assert.deepEqual(sent, { logged: true, desktop: false, command: null });
    assert.deepEqual(c.calls, []);
});

test("notify: a long message is cut to 900 characters, and to 240 for the desktop", () => {
    const home = tempDir("notify"), c = channels(), long = "x".repeat(1200);
    notify("third", long, { env: { DOTIME_NOTIFY_CMD: "relay" }, logFile: join(home, "notify.log"), desktop: c.desktop, command: c.command, now: AT });
    assert.deepEqual(c.calls.map((call) => call.at(-1).length), [240, 900]);
});

test("notify: a channel that throws does not stop the others", () => {
    const blocker = join(tempDir("notify"), "plain-file");
    writeFileSync(blocker, "");
    const boom = () => { throw new Error("channel down"); };
    const c = channels();
    assert.deepEqual(
        notify("fourth", "four", {
            env: { DOTIME_NOTIFY_CMD: "relay" }, logFile: join(blocker, "notify.log"), desktop: boom, command: c.command
        }),
        { logged: false, desktop: false, command: true }
    );
    assert.deepEqual(
        notify("fifth", "five", {
            env: { DOTIME_NOTIFY_CMD: "relay" }, logFile: join(blocker, "notify.log"), desktop: c.desktop, command: boom
        }),
        { logged: false, desktop: true, command: false }
    );
});

test("cleanText: an empty home folder setting leaves the text alone", () => {
    const saved = process.env.HOME;
    process.env.HOME = "";
    try {
        assert.equal(cleanText("job a/b done", 80), "job a/b done");
        assert.equal(cleanText("", 80), "");
    } finally {
        if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
    }
});
