// `dotime-queue setup`: puts the queue instruction into a project's agent instruction files, between a begin and an
// end marker, so a second run updates that block and leaves the rest of each file as it was. Without --write it only
// says what it would do. It writes inside the project folder only, and only the files it names.
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The shared agent instruction files looked for, in this order. AGENTS.md is the one created when none exists. */
export const AGENT_FILES = Object.freeze(["AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md"]);
/** The files Claude Code reads in place of AGENTS.md: when one of them is in the folder or above it, Claude Code does
 *  not read AGENTS.md. */
export const CLAUDE_FILES = Object.freeze(["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"]);
/** A personal file for one person's Claude Code. It gets the block only when no shared Claude Code file exists, or
 *  when it holds the block already. */
export const LOCAL_FILE = "CLAUDE.local.md";
export const BEGIN = "<!-- dotime-queue setup: begin; `dotime-queue setup --write` updates this block -->";
export const END = "<!-- dotime-queue setup: end -->";
const BEGIN_RE = /^<!-- dotime-queue setup: begin\b.*-->[ \t]*\r?$/;
const END_RE = /^<!-- dotime-queue setup: end\b.*-->[ \t]*\r?$/;

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
    "124 means it was stopped at its run limit. Exit 3 means the same check already failed twice on unchanged code",
    "and was not run: change the code first, or, when the failure was not caused by the code, add",
    '--after-fix "<what changed>" in front of the --.',
]);

/** The whole block, markers included, with the given line ending and none after the end marker. */
export const blockText = (eol = "\n") => [BEGIN, ...BLOCK_LINES, END].join(eol);

/** For each line, whether it is part of a fenced code block: a fence line of three or more backticks or tildes, the
 *  lines after it, and the line that closes it. */
export function fencedLines(lines) {
    let open = null;
    return lines.map((line) => {
        const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
        if (open) {
            if (fence && fence[0] === open[0] && fence.length >= open.length && /^ {0,3}[`~]+[ \t]*\r?$/.test(line)) {
                open = null;
            }
            return true;
        }
        if (fence) open = fence;
        return Boolean(fence);
    });
}

/** The paths a Claude Code instruction file imports with `@path`, outside code blocks and code spans. A path with
 *  spaces is written with a backslash before each space. */
export function importedPaths(text) {
    const lines = text.split("\n");
    const fenced = fencedLines(lines);
    return lines.flatMap((line, i) => {
        if (fenced[i]) return [];
        const plain = line.replace(/(`+)[^`]*?\1/g, " ");
        return [...plain.matchAll(/(?:^|\s)@((?:\\ |\S)+)/g)].map((m) => m[1].replaceAll("\\ ", " "));
    });
}

/** What setup does to one file's text: { action, text } with action "create", "add", "update" or "unchanged", or
 *  { error }. text is the file's text (null when there is no file). The block takes the file's line ending: CRLF
 *  when its first line ends in CRLF. Only the lines from the begin marker to the end marker are replaced; a file
 *  without a block gets it at the end, after a blank line, and every byte before it stays as it was. Marker lines
 *  inside a fenced code block are not counted; spaces after a marker are. */
export function planText(text) {
    if (text === null) return { action: "create", text: `${blockText()}\n` };
    const eol = /^[^\n]*\r\n/.test(text) ? "\r\n" : "\n";
    const lines = text.split("\n");
    // Marker lines inside a fenced code block are an example, not the block.
    const fenced = fencedLines(lines);
    const begins = lines.flatMap((line, i) => (!fenced[i] && BEGIN_RE.test(line) ? [i] : []));
    const ends = lines.flatMap((line, i) => (!fenced[i] && END_RE.test(line) ? [i] : []));
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

/** Does the file at `shown` (inside root) import the file at `target` with `@path`? */
function importsFile(text, shown, target) {
    return importedPaths(text).some((path) => {
        if (path.startsWith("~")) return false;
        const named = resolve(dirname(shown), path);
        try {
            return realpathSync(named) === target;
        } catch {
            return false;
        }
    });
}

/** The first Claude Code instruction file in a folder above root, or null. */
function claudeFileAbove(root) {
    for (let dir = dirname(root); ; dir = dirname(dir)) {
        for (const file of CLAUDE_FILES) if (existsSync(join(dir, file))) return join(dir, file);
        if (dirname(dir) === dir) return null;
    }
}

/** Reads one agent file: { file, path, text }, null when there is none, or { error }. */
function readAgentFile(root, file) {
    let path;
    try {
        path = realpathSync(join(root, file));
    } catch (err) {
        if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
        return { error: `${file}: cannot be read (${err.code})` };
    }
    if (!inside(root, path)) return { error: `${file}: is a link to ${path}, outside the project folder` };
    try {
        const stat = statSync(path);
        if (!stat.isFile()) return { error: `${file}: is not a file` };
        // Another name of a hard link may be outside the project folder, and nothing tells where it is.
        if (stat.nlink > 1) {
            const why = "setup does not write through one; replace it by a plain file";
            return { error: `${file}: has ${stat.nlink} hard links; ${why}` };
        }
        return { file, path, text: readFileSync(path, "utf8") };
    } catch (err) {
        return { error: `${file}: cannot be read (${err.code})` };
    }
}

/** The plan for a project folder: { root, changes: [{ file, action, text, path }], notes }, or { error } with
 *  folder: true when dir is no folder. file is the name as shown, path the real path written. A file that is a
 *  link is followed only when it ends inside the project folder; a second name for a file already planned is left
 *  out, and a file with more than one hard link is refused. A file that cannot be read or written is an error,
 *  found before anything is written.
 *
 *  Claude Code does not read AGENTS.md when the folder or one above it has a CLAUDE.md, a .claude/CLAUDE.md or a
 *  CLAUDE.local.md, so those get the block too. A CLAUDE.local.md gets it only when neither shared one exists (or
 *  it holds the block already), since it is one person's own file. A Claude Code file without the block that
 *  imports AGENTS.md with `@AGENTS.md` is skipped (action "imported"): it reads the block from AGENTS.md. notes
 *  are lines that explain the plan. */
export function planFolder(dir) {
    let root;
    try {
        root = realpathSync(dir);
        if (!statSync(root).isDirectory()) return { error: `${dir} is not a folder`, folder: true };
    } catch {
        return { error: `${dir}: no such folder`, folder: true };
    }
    const found = [];
    const seen = new Set();
    for (const file of [...AGENT_FILES, LOCAL_FILE]) {
        const one = readAgentFile(root, file);
        if (one === null) continue;
        if (one.error) return one;
        if (seen.has(one.path)) continue;
        seen.add(one.path);
        found.push(one);
    }
    const shared = found.filter((one) => one.file !== LOCAL_FILE);
    const notes = [];
    const planned = [];
    for (const one of found) {
        const plan = planText(one.text);
        if (plan.error) return { error: `${one.file}: ${plan.error}` };
        if (one.file === LOCAL_FILE && plan.action === "add" && shared.some((s) => s.file !== "AGENTS.md")) continue;
        planned.push({ ...one, plan });
    }
    if (!shared.length) {
        try {
            accessSync(root, constants.W_OK);
        } catch (err) {
            return { error: `${root}: cannot create AGENTS.md in it (${err.code})` };
        }
        planned.unshift({ file: AGENT_FILES[0], path: join(root, AGENT_FILES[0]), plan: planText(null) });
    }
    const agents = planned.find((one) => one.file === AGENT_FILES[0]);
    const changes = [];
    for (const one of planned) {
        let plan = one.plan;
        const imports = agents && one !== agents && importsFile(one.text ?? "", join(root, one.file), agents.path);
        if (imports && plan.action === "add") plan = { action: "imported", text: one.text };
        if (one.text !== undefined && !["unchanged", "imported"].includes(plan.action)) {
            try {
                accessSync(one.path, constants.W_OK);
            } catch (err) {
                return { error: `${one.file}: cannot be written (${err.code}); make it writable and run setup again` };
            }
        }
        if (one.file === LOCAL_FILE && plan.action === "add") {
            notes.push(`note: ${LOCAL_FILE} gets the block because Claude Code reads it and not AGENTS.md; it is your`,
                "own file, so for everyone else's Claude Code add a CLAUDE.md with the line @AGENTS.md");
        }
        changes.push({ file: relative(root, one.path) || one.file, path: one.path, ...plan });
    }
    const claudeSees = changes.some((c) => CLAUDE_FILES.includes(c.file));
    const above = claudeSees ? null : claudeFileAbove(root);
    if (above) {
        notes.push(`note: Claude Code reads ${above} and not AGENTS.md; to give it the block, add the`,
            `line @${join(relative(dirname(above), root), "AGENTS.md")} to that file, or run setup in its folder`);
    }
    return { root, changes, notes };
}

const DONE = {
    create: "created", add: "added the block to", update: "updated the block in", unchanged: "unchanged:",
    imported: "skipped",
};
const WOULD = {
    create: "would create", add: "would add the block to", update: "would update the block in", unchanged: "unchanged:",
    imported: "would skip",
};
const WRITES = new Set(["create", "add", "update"]);

/** Carries out a plan: writes each changed file and returns the lines to print and the files changed, as
 *  { lines, changed } or, when a write fails, { lines, changed, error } with the files written before it. */
export function applyPlan({ changes }, { write = false, writeFile = writeFileSync } = {}) {
    const lines = [], changed = [];
    for (const change of changes) {
        if (write && WRITES.has(change.action)) {
            try {
                writeFile(change.path, change.text, change.action === "create" ? { flag: "wx" } : undefined);
            } catch (err) {
                return { lines, changed, error: `${change.file}: cannot be written (${err.code ?? err.message})` };
            }
            changed.push(change.file);
        }
        const why = change.action === "imported" ? `: it imports ${AGENT_FILES[0]}, which holds the block` : "";
        lines.push(`${(write ? DONE : WOULD)[change.action]} ${change.file}${why}`);
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
