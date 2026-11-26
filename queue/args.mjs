// The flags each subcommand accepts. Anything else on the command line, in front of the `--` for `run`, is refused
// with a usage error, so a misspelled flag never changes what a command does without a word.

/** Per subcommand: flags that take a value, and flags that stand alone. */
export const FLAGS = Object.freeze({
    run: { values: ["--label", "--max-wait", "--max-run", "--kind", "--after-fix"], switches: ["--priority"] },
    status: { values: [], switches: [] },
    passed: { values: ["--match", "--cwd"], switches: [] },
    history: { values: ["--days", "--day"], switches: [] },
});

/** null when every word fits the subcommand's flags, else the message to print. args[0] is the subcommand; for
 *  `run` only the words in front of "--" are looked at. A value may not be empty or start with "--", and no flag may
 *  be given twice. */
export function flagError(args) {
    const allowed = FLAGS[args[0]];
    if (!allowed) return null;
    const cut = args.indexOf("--"), words = args.slice(1, args[0] === "run" && cut >= 0 ? cut : args.length);
    const seen = new Set();
    for (let i = 0; i < words.length; i++) {
        const word = words[i], eq = word.indexOf("="), name = eq < 0 ? word : word.slice(0, eq);
        const known = allowed.values.includes(name) || allowed.switches.includes(name);
        if (known && seen.has(name)) return `option ${name} is given twice`;
        seen.add(name);
        if (allowed.values.includes(name)) {
            const value = eq < 0 ? words[++i] : word.slice(eq + 1);
            if (value === undefined || value === "" || value.startsWith("--")) return `option ${name} needs a value`;
            continue;
        }
        if (allowed.switches.includes(word)) continue;
        if (allowed.switches.includes(name)) return `option ${name} takes no value`;
        return word.startsWith("-") ? `unknown option ${name}` : `unexpected word "${word}"`;
    }
    return null;
}
