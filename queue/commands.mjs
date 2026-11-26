// The command-line patterns the queue judges processes and jobs by, kept together so their differences are on
// purpose. Each answers a different question, so each matches a different set of commands.

/** Shells. A shell in front of a command only starts it, so it is looked through: its `-c` text is what runs. */
export const SHELLS = new Set(["sh", "bash", "zsh"]);
const SHELL_NAMES = [...SHELLS].join("|");

/** A process whose program is a shell, in any folder: "sh -c jest" names a test tool but is only its launcher. */
export const SHELL_PROGRAM_RE = new RegExp(`^(\\S*\\/)?(${SHELL_NAMES})(\\s|$)`);

/** Job kind "test": the words of a label or command that make a test job. Wide on purpose, because a wrong kind
 *  only means a less fitting run limit. `node --test` counts. */
export const TEST_KIND_RE = /\b(tests?|check|suite|spec|e2e|vitest|jest|playwright)\b|node --test/i;

/** One-shot test commands: they exit by themselves, so the reaper never takes them for an idle dev server even
 *  when they match its server pattern (vitest without "run" is a watcher, jest with --watch too). `node --test`
 *  counts. */
export const TEST_RUN_RE = /\bvitest (--)?run\b|\bnode --test\b|playwright test|jest(?!.*--watch)/;

/** Processes of a large test run outside the queue: test runners and their workers, by the names they show in the
 *  process table. `node --test` is left out on purpose: the files it runs appear as plain `node <file>` processes
 *  that name no test tool, so the size of such a run cannot be read from the table. */
export const STRAY_TEST_RE = /jest-worker|\/jest(\.js)?(\s|$)|\bjest\s|\bvitest(\.mjs)?(\s|$)|vitest\/dist|playwright test|@playwright\/test/;

/** Programs that only start a script, so a dev server's process group may hold them above the server: a package
 *  manager or runner (also as the script node runs, as pnpm and yarn appear), or a shell with `-c`. The program
 *  itself must be the launcher: a folder named npm further along a command line does not count. */
export const LAUNCHER_RE = new RegExp([
    "^(\\S*\\/)?(npm|npx|pnpm|yarn|bun)(\\s|$)",
    "^(\\S*\\/)?node \\S*\\/(npm|npx|pnpm|yarn)(-cli)?(\\.c?js)?(\\s|$)",
    `^(\\S*\\/)?(${SHELL_NAMES}) -c `,
].join("|"));
