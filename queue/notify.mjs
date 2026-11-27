// Sends a notice three ways: a line in $DOTIME_HOME/notify.log (always), a desktop notice, and the command in
// $DOTIME_NOTIFY_CMD. DOTIME_NOTIFY=log limits it to the log line. Nothing here throws.
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { showDesktopNotice } from "./probes.mjs";
import { appendLine } from "./files.mjs";

// The home folder, but not a longer folder name that starts the same way ("/h/ann" must not turn "/h/anna" into "~a").
// An empty or "/" home gives null: nothing is shortened, so no text is mangled.
const homeRe = () => {
    const home = homedir();
    return home.length < 2 ? null : new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.-])`, "g");
};

/** One line of printable text with the home folder shortened to ~, cut to a length. */
export function cleanText(text, maxLength) {
    const home = homeRe();
    const raw = String(text ?? "");
    const shortened = home ? raw.replace(home, "~") : raw;
    return shortened.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/** How long the notify command may run before it is stopped and counted as failed. */
export const NOTIFY_TIMEOUT_MS = 15_000;

/** Runs the notify command in a shell. The texts are handed over as environment variables, not as shell code. */
export function runNotifyCommand(command, title, message, env = process.env, timeoutMs = NOTIFY_TIMEOUT_MS) {
    try {
        const withTexts = { ...env, DOTIME_TITLE: title, DOTIME_MESSAGE: message };
        const ran = spawnSync("/bin/sh", ["-c", command], { env: withTexts, stdio: "ignore", timeout: timeoutMs });
        return ran.status === 0;
    } catch { return false; }
}

/** Returns { logged, desktop, command }; command is null when no command is set. env selects the channels; logFile
 *  is the notify.log of the state folder. */
export function notify(title, message, channels) {
    const { env, logFile, desktop = showDesktopNotice, command = runNotifyCommand, now = Date.now() } = channels;
    const head = cleanText(title, 80);
    const body = cleanText(message, 900);
    const sent = { logged: false, desktop: false, command: null };
    // A log line that cannot be written does not stop the other channels.
    sent.logged = appendLine(logFile, `${new Date(now).toISOString()}\t${head}\t${body}\n`);
    if (env.DOTIME_NOTIFY === "log") return sent;
    try { sent.desktop = !!desktop(head, cleanText(body, 240)); } catch { /* stays false */ }
    if (env.DOTIME_NOTIFY_CMD) {
        try { sent.command = !!command(env.DOTIME_NOTIFY_CMD, head, body, env); } catch { sent.command = false; }
    }
    return sent;
}
