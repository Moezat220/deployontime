// Job kinds and command stems. The kind groups similar jobs for the run limit; the stem tells runs of one command
// apart from runs of another. Both are read from the label and the command line only.
import { SHELLS, TEST_KIND_RE } from "./commands.mjs";
import { labelTask } from "./project.mjs";

/** The label a job gets when --label is missing. The repeated-failure stop never takes two such jobs for one check. */
export const UNLABELLED = "unnamed";

const DEBUG_WORDS = "debug|repro|bisect|probe";
export const DEBUG_LABEL_RE = new RegExp(`\\b(${DEBUG_WORDS})\\b|\\?`, "i");
// In a command the word must not be followed by "=", so setting a DEBUG variable does not make a debug job.
export const DEBUG_CMD_RE = new RegExp(`\\b(${DEBUG_WORDS})\\b(?!=)`, "i");

// Ordered from heaviest to lightest; the first match wins.
export const KINDS = [
    ["deploy", /\b(deploy|release|publish)\b/i],
    ["test", TEST_KIND_RE],
    ["build", /\b(build|bundle|compile)\b/i],
    ["lint", /\b(lint|typecheck|tsc|format)\b/i],
];
/** A given kind wins. Otherwise the label's task part is read first, then the command, and in each a debug word
 *  comes before KINDS; "other" when nothing matches. */
export function kindOf(label, command, given) {
    if (given) return String(given).toLowerCase();
    for (const [text, debugRe] of [[labelTask(label), DEBUG_LABEL_RE], [String(command ?? ""), DEBUG_CMD_RE]]) {
        if (debugRe.test(text)) return "debug";
        const hit = KINDS.find(([, pattern]) => pattern.test(text));
        if (hit) return hit[0];
    }
    return "other";
}

// Words that make or ship output, matched anywhere inside a word, so prebuild, esbuild, deploy_prod.sh and
// deployProd all count. Matching too much only means a check runs again; matching too little loses output.
const MAKES_WITHIN_WORDS = /build|bundle|compile|deploy|release|publish|webpack|rollup|parcel/i;
// tsc writes its output unless told not to; vercel and netlify ship with --prod.
const TSC_RE = /(^|[^a-z0-9])tsc([^a-z0-9]|$)/i;
const NO_EMIT_RE = /--noEmit\b/i;
const SHIPS_RE = /\b(vercel|netlify)\b[^&|;]*--prod\b/i;
/** Does the label's task part or the command also name a build or a deploy, whatever kind won? "build and test" is a
 *  test job by the order of KINDS, but its build output may still be needed. Besides the build and deploy words, even
 *  inside other words, this counts webpack, rollup and parcel, tsc without --noEmit, and vercel or netlify with
 *  --prod. When in doubt it answers true. */
export function alsoBuilds(label, command) {
    return [labelTask(label), String(command ?? "")].some((text) => MAKES_WITHIN_WORDS.test(text)
        || (TSC_RE.test(text) && !NO_EMIT_RE.test(text)) || SHIPS_RE.test(text));
}

// The stem is what stays the same between two runs of one command: the program and the task it is given, without
// paths, flags or variable assignments. Runs are compared with earlier runs that have the same stem.

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn"]);
const TOOL_RUNNERS = new Set(["npx", "pnpx", "bunx"]);
const INTERPRETERS = new Set(["node", "tsx", "ts-node", "vite-node", "bun", "deno", "python", "python3", ...SHELLS]);
const INLINE_CODE_FLAGS = new Set(["-e", "-c", "--eval"]);
const baseName = (word) => String(word).split("/").pop();
const isPlainWord = (word) => /^[a-z][\w:.-]*$/i.test(word);

function splitWords(line) {
    const words = String(line ?? "").match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? [];
    return words.map((word) => {
        if (!word.startsWith('"')) return word;
        try { return JSON.parse(word); } catch { return word; }
    });
}
function stemOfWords(words) {
    let first = 0;
    while (first < words.length && (words[first] === "env" || /^[A-Za-z_]\w*=/.test(words[first]))) first++;
    const program = baseName(words[first] ?? "");
    if (!program) return null;
    const args = words.slice(first + 1).filter((word) => !word.startsWith("-") || INLINE_CODE_FLAGS.has(word));
    if (SHELLS.has(program) && args[0] === "-c") {
        // sh -c "a && b": stem each chained command, then join.
        const parts = String(args[1] ?? "").split(/&&|\|\||[;|]/).map((part) => stemOfWords(splitWords(part.trim())));
        return parts.filter(Boolean).join(" && ") || null;
    }
    if (INLINE_CODE_FLAGS.has(args[0])) return null;
    if (PACKAGE_MANAGERS.has(program)) {
        const words = args[0] === "run" || args[0] === "exec" ? 2 : 1;
        return [program, ...args.slice(0, words)].join(" ");
    }
    if (TOOL_RUNNERS.has(program)) {
        if (INTERPRETERS.has(args[0])) return [program, args[0], ...args.slice(1, 2).map(baseName)].join(" ");
        return [program, ...args.slice(0, 1), ...args.slice(1, 2).filter(isPlainWord)].join(" ");
    }
    if (INTERPRETERS.has(program)) return [program, ...args.slice(0, 1).map(baseName)].join(" ");
    return [program, ...args.slice(0, 1).filter(isPlainWord)].join(" ");
}
const stemCache = new Map();
/** The stem of a command line as written by cmdString(), or null when it has none (inline code, empty line). */
export function cmdStem(command) {
    const line = String(command ?? "");
    if (!stemCache.has(line)) stemCache.set(line, stemOfWords(splitWords(line)) || null);
    return stemCache.get(line);
}
