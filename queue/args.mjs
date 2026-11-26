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
 *  `run` only the words in front of "--" are looked at. */
export function flagError(args) {
    const allowed = FLAGS[args[0]];
    if (!allowed) return null;
    const cut = args.indexOf("--"), words = args.slice(1, args[0] === "run" && cut >= 0 ? cut : args.length);
    for (let i = 0; i < words.length; i++) {
        const word = words[i], name = word.split("=")[0];
        if (allowed.values.includes(name)) {
            if (word.includes("=")) continue;
            if (i + 1 >= words.length) return `option ${name} needs a value`;
            i++;
            continue;
        }
        if (allowed.switches.includes(word)) continue;
        if (allowed.switches.includes(name)) return `option ${name} takes no value`;
        return word.startsWith("-") ? `unknown option ${name}` : `unexpected word "${word}"`;
    }
    return null;
}
