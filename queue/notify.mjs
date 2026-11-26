// Sends a notice three ways: a line in $DOTIME_HOME/notify.log (always), a desktop notice, and the command in
// $DOTIME_NOTIFY_CMD. DOTIME_NOTIFY=log limits it to the log line. Nothing here throws.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { paths } from "./settings.mjs";
import { showDesktopNotice } from "./probes.mjs";

// The home folder, but not a longer folder name that starts the same way ("/h/ann" must not turn "/h/anna" into "~a").
// An empty or "/" home gives null: nothing is shortened, so no text is mangled.
const homeRe = () => {
    const home = homedir();
    return home.length < 2 ? null : new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.-])`, "g");
};

/** One line of printable text with the home folder shortened to ~, cut to a length. */
export function cleanText(text, maxLength) {
    const home = homeRe(), raw = String(text ?? "");
    return (home ? raw.replace(home, "~") : raw).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/** Runs the notify command in a shell. The texts are handed over as environment variables, not as shell code. */
export function runNotifyCommand(command, title, message, env = process.env) {
    try {
        const ran = spawnSync("/bin/sh", ["-c", command], { env: { ...env, DOTIME_TITLE: title, DOTIME_MESSAGE: message }, stdio: "ignore", timeout: 15_000 });
        return ran.status === 0;
    } catch { return false; }
}

/** Returns { logged, desktop, command }; command is null when no command is set. */
export function notify(title, message, { env = process.env, desktop = showDesktopNotice, command = runNotifyCommand, logFile = paths(env).notifyLog, now = Date.now() } = {}) {
    const head = cleanText(title, 80), body = cleanText(message, 900), sent = { logged: false, desktop: false, command: null };
    try {
        mkdirSync(dirname(logFile), { recursive: true });
        appendFileSync(logFile, `${new Date(now).toISOString()}\t${head}\t${body}\n`);
        sent.logged = true;
    } catch { /* the other channels are still tried */ }
    if (env.DOTIME_NOTIFY === "log") return sent;
    try { sent.desktop = !!desktop(head, cleanText(body, 240)); } catch { /* stays false */ }
    if (env.DOTIME_NOTIFY_CMD) {
        try { sent.command = !!command(env.DOTIME_NOTIFY_CMD, head, body, env); } catch { sent.command = false; }
    }
    return sent;
}
