// `dotime-queue setup`: puts the queue instruction into a project's agent instruction files, between a begin and an
// end marker, so a second run updates that block and leaves the rest of each file as it was. Without --write it only
// says what it would do. It writes inside the project folder only, and only the files it names.
import { accessSync, constants, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The agent instruction files looked for, in this order. AGENTS.md is the one created when none exists. */
export const AGENT_FILES = Object.freeze(["AGENTS.md", "CLAUDE.md"]);
export const BEGIN = "<!-- dotime-queue setup: begin; `dotime-queue setup --write` updates this block -->";
export const END = "<!-- dotime-queue setup: end -->";
const BEGIN_RE = /^<!-- dotime-queue setup: begin\b.*-->\r?$/;
const END_RE = /^<!-- dotime-queue setup: end\b.*-->\r?$/;

/** The lines between the markers. */
export const BLOCK_LINES = Object.freeze([
    "## Heavy commands",
    "",
    "Start every test run, build and other heavy command through the queue:",
    "",
    "```",
    'dotime-queue run --label "<project>: <task>" -- <command>',
    "```",
    "",
    'A test or lint run that prints "skipped:" already passed on this exact commit and exits 0; add --no-skip in front',
    "of the -- only to run it again on purpose. Exit 75 means the job gave up waiting for a slot, not a failure; exit",
    "124 means it was stopped at its run limit.",
]);

/** The whole block, markers included, with the given line ending and none after the end marker. */
export const blockText = (eol = "\n") => [BEGIN, ...BLOCK_LINES, END].join(eol);

/** What setup does to one file's text: { action, text } with action "create", "add", "update" or "unchanged", or
 *  { error }. text is the file's text (null when there is no file). The block takes the file's line ending: CRLF
 *  when its first line ends in CRLF. Only the lines from the begin marker to the end marker are replaced; a file
 *  without a block gets it at the end, after a blank line, and every byte before it stays as it was. */
export function planText(text) {
    if (text === null) return { action: "create", text: `${blockText()}\n` };
    const eol = /^[^\n]*\r\n/.test(text) ? "\r\n" : "\n";
    const lines = text.split("\n");
    const begins = lines.flatMap((line, i) => (BEGIN_RE.test(line) ? [i] : []));
    const ends = lines.flatMap((line, i) => (END_RE.test(line) ? [i] : []));
    if (begins.length === 0 && ends.length === 0) {
        const gap = text === "" ? "" : text.endsWith("\n") ? eol : `${eol}${eol}`;
        return { action: "add", text: `${text}${gap}${blockText(eol)}${eol}` };
    }
    if (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0]) {
        return { error: "its dotime-queue setup markers do not form one begin and one end; fix them by hand" };
    }
    const before = lines.slice(0, begins[0]).join("\n");
    const after = lines.slice(ends[0] + 1).join("\n");
    const endLine = lines[ends[0]];
    // The end marker's own line ending stays with the text after it.
    const tail = endLine.endsWith("\r") ? "\r" : "";
    const head = begins[0] ? `${before}\n` : "";
    const rest = ends[0] < lines.length - 1 ? `\n${after}` : "";
    const next = `${head}${blockText(eol)}${tail}${rest}`;
    return next === text ? { action: "unchanged", text } : { action: "update", text: next };
}

const inside = (root, path) => path === root || path.startsWith(root + sep);

/** The plan for a project folder: { root, changes: [{ file, action, text, path }] }, or { error } with folder: true
 *  when dir is no folder. file is the name
 *  as shown, path the real path written. A file that is a link is followed only when it ends inside the project
 *  folder; a second name for a file already planned is left out. A file that cannot be read or written is an
 *  error, found before anything is written. */
export function planFolder(dir) {
    let root;
    try {
        root = realpathSync(dir);
        if (!statSync(root).isDirectory()) return { error: `${dir} is not a folder`, folder: true };
    } catch {
        return { error: `${dir}: no such folder`, folder: true };
    }
    const changes = [];
    const seen = new Set();
    for (const file of AGENT_FILES) {
        let path;
        try {
            path = realpathSync(join(root, file));
        } catch (err) {
            if (err.code === "ENOENT") continue;
            return { error: `${file}: cannot be read (${err.code})` };
        }
        if (!inside(root, path)) return { error: `${file}: is a link to ${path}, outside the project folder` };
        if (seen.has(path)) continue;
        seen.add(path);
        let text;
        try {
            if (!statSync(path).isFile()) return { error: `${file}: is not a file` };
            text = readFileSync(path, "utf8");
        } catch (err) {
            return { error: `${file}: cannot be read (${err.code})` };
        }
        const plan = planText(text);
        if (plan.error) return { error: `${file}: ${plan.error}` };
        if (plan.action !== "unchanged") {
            try {
                accessSync(path, constants.W_OK);
            } catch (err) {
                return { error: `${file}: cannot be written (${err.code}); make it writable and run setup again` };
            }
        }
        changes.push({ file: relative(root, path) || file, path, ...plan });
    }
    if (!changes.length) {
        try {
            accessSync(root, constants.W_OK);
        } catch (err) {
            return { error: `${root}: cannot create AGENTS.md in it (${err.code})` };
        }
        changes.push({ file: AGENT_FILES[0], path: join(root, AGENT_FILES[0]), ...planText(null) });
    }
    return { root, changes };
}

const DONE = { create: "created", add: "added the block to", update: "updated the block in", unchanged: "unchanged:" };
const WOULD = {
    create: "would create", add: "would add the block to", update: "would update the block in", unchanged: "unchanged:",
};

/** Carries out a plan: writes each changed file and returns the lines to print and the files changed, as
 *  { lines, changed } or, when a write fails, { lines, changed, error } with the files written before it. */
export function applyPlan({ changes }, { write = false, writeFile = writeFileSync } = {}) {
    const lines = [], changed = [];
    for (const change of changes) {
        if (write && change.action !== "unchanged") {
            try {
                writeFile(change.path, change.text, change.action === "create" ? { flag: "wx" } : undefined);
            } catch (err) {
                return { lines, changed, error: `${change.file}: cannot be written (${err.code ?? err.message})` };
            }
            changed.push(change.file);
        }
        lines.push(`${(write ? DONE : WOULD)[change.action]} ${change.file}`);
    }
    return { lines, changed };
}

const SERVER_PATH = fileURLToPath(new URL("../mcp/server.mjs", import.meta.url));

/** The lines --mcp prints: the generic entry, the Claude Code command, and the form without `npm link`. */
export function mcpLines(serverPath = SERVER_PATH) {
    const entry = { mcpServers: { "dotime-queue": { command: "dotime-mcp" } } };
    const unlinked = { mcpServers: { "dotime-queue": { command: "node", args: [resolve(serverPath)] } } };
    return [
        "MCP server: dotime-mcp, on standard input and output",
        "",
        "Generic entry for a client's MCP server settings:",
        JSON.stringify(entry, null, 2),
        "",
        "Claude Code: run the command below, or put the generic entry in .mcp.json at the project root to share it",
        "with everyone in the project (an entry without a type is read as a stdio server):",
        "claude mcp add --transport stdio dotime-queue -- dotime-mcp",
        "",
        "Without npm link:",
        JSON.stringify(unlinked, null, 2),
    ];
}
