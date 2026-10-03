import { translate } from "../i18n/catalog.js";
import type { Language } from "../i18n/language.js";
import { workspaceRootProblem, type WorkspaceRootProblem } from "../workspace/path-guard.js";
import type { ProjectFolder, ProjectWorkspace } from "./types.js";

/** A project folder that cannot be found now. It stays in the project and comes back when it can be found again. */
export interface UnavailableProjectFolder {
  readonly id: string;
  readonly key: string;
  readonly path: string;
  readonly problem: WorkspaceRootProblem;
}

/** The active folders of a project, split by whether they can be used now. */
export function checkProjectFolders(folders: readonly ProjectFolder[]): {
  readonly available: ProjectFolder[];
  readonly unavailable: UnavailableProjectFolder[];
} {
  const available: ProjectFolder[] = [];
  const unavailable: UnavailableProjectFolder[] = [];
  for (const folder of folders) {
    if (!folder.active) continue;
    const problem = workspaceRootProblem(folder.path);
    if (problem) unavailable.push({ id: folder.id, key: folder.key, path: folder.path, problem });
    else available.push(folder);
  }
  return { available, unavailable };
}

export function folderProblemText(language: Language, problem: WorkspaceRootProblem): string {
  switch (problem) {
    case "missing":
      return translate(language, "ui.folderMissing");
    case "not_directory":
      return translate(language, "ui.folderNotDirectory");
    case "link":
      return translate(language, "ui.folderLink");
    case "inaccessible":
      return translate(language, "ui.folderInaccessible");
  }
}

/** Without its primary folder a project cannot be used. */
export class PrimaryFolderUnavailableError extends Error {
  constructor(
    readonly folder: UnavailableProjectFolder,
    message: string,
  ) {
    super(message);
    this.name = "PrimaryFolderUnavailableError";
  }
}

/** The primary folder of `workspace` when it cannot be found now. */
export function unavailablePrimaryFolder(workspace: ProjectWorkspace): UnavailableProjectFolder | undefined {
  const primary = workspace.folders.find((folder) => folder.active && folder.id === workspace.primaryFolderId);
  return primary ? checkProjectFolders([primary]).unavailable[0] : undefined;
}

export function primaryFolderUnavailableError(
  language: Language,
  folder: UnavailableProjectFolder,
  fix: "web" | "cli",
): PrimaryFolderUnavailableError {
  const message = [
    translate(language, "cli.primaryFolderUnavailable", {
      key: folder.key,
      path: folder.path,
      reason: folderProblemText(language, folder.problem),
    }),
    translate(language, fix === "web" ? "cli.primaryFolderFixWeb" : "cli.primaryFolderFixCli"),
  ].join(" ");
  return new PrimaryFolderUnavailableError(folder, message);
}

/** Refuse a project whose primary folder cannot be found, saying how to fix it. */
export function assertPrimaryFolderAvailable(
  workspace: ProjectWorkspace,
  language: Language,
  fix: "web" | "cli" = "web",
): void {
  const folder = unavailablePrimaryFolder(workspace);
  if (folder) throw primaryFolderUnavailableError(language, folder, fix);
}
