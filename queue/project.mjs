// Works out which project a job counts under: the part of its label in front of the colon, else the name of the
// repository folder it runs in, else the name of the folder itself.
import { basename } from "node:path";
import { repoName } from "./git.mjs";

/** The label prefix: "shop-api" for "shop-api: unit tests", null without one. */
export function labelProject(label) {
    return String(label ?? "").match(/^([^:]{1,40}):/)?.[1].trim() || null;
}

/** The repository folder name for a working directory. A linked worktree reports its main repository. */
export function folderProject(cwd) {
    return repoName(cwd) || basename(cwd) || "unknown";
}

export function jobProject({ label, project, cwd } = {}) {
    return labelProject(label) || project || (cwd ? basename(cwd) : null) || "unknown";
}
