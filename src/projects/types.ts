/** One host folder attached to a logical EASY CODE project. */
export interface ProjectFolder {
  readonly id: string;
  readonly projectId: string;
  /** Stable, human-readable namespace used by tools, for example `api/src/main.ts`. */
  readonly key: string;
  readonly path: string;
  readonly active: boolean;
  readonly addedRevision: number;
  readonly removedRevision?: number;
  readonly sortOrder: number;
}

/** Immutable workspace membership captured by a thread/turn. */
export interface ProjectWorkspace {
  readonly projectId: string;
  readonly revision: number;
  readonly primaryFolderId: string;
  readonly folders: readonly ProjectFolder[];
}

export interface ProjectRecord {
  readonly id: string;
  readonly name: string;
  readonly workspaceRevision: number;
  readonly primaryFolderId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly folders: readonly ProjectFolder[];
}

export function projectPrimaryFolder(project: Pick<ProjectRecord, "primaryFolderId" | "folders">): ProjectFolder | undefined {
  return project.folders.find(folder => folder.active && folder.id === project.primaryFolderId)
    ?? project.folders.find(folder => folder.active);
}

export function projectWorkspace(project: Pick<ProjectRecord, "id" | "workspaceRevision" | "primaryFolderId" | "folders">): ProjectWorkspace {
  const active = project.folders.filter(folder => folder.active)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
  const primary = projectPrimaryFolder({ ...project, folders: active });
  if (!primary) throw new Error("Attach at least one folder before using this project.");
  return {
    projectId: project.id,
    revision: project.workspaceRevision,
    primaryFolderId: primary.id,
    folders: active,
  };
}
