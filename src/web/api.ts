import type { PlanProposal } from "../core/types.js";
import type { WebHistoryPage, WebHistoryState, WebPatch, WebView } from "../web-contracts.js";
import type { Language } from "../i18n/language.js";

export interface ThreadItem {
  threadId: string;
  workspaceId: string;
  workspaceRoot: string;
  title: string;
  canRename: boolean;
  goal?: string;
  mode: string;
  provider: string;
  model: string;
  updatedAt: string;
}
export interface ProjectFolderItem {
  id: string; projectId: string; key: string; path: string; active: boolean;
  addedRevision: number; removedRevision?: number; sortOrder: number;
}
export interface ProjectItem {
  id: string; root: string; name: string; ready?: boolean; workspaceRevision?: number;
  primaryFolderId?: string; folders?: ProjectFolderItem[];
}
export interface WebSnapshot {
  language: Language;
  sequence: number;
  view: WebView;
  plan: PlanProposal | null;
  threads: ThreadItem[];
  projects: ProjectItem[];
  runningThreadIds: string[];
  history: WebHistoryState;
}

export interface FetchedHistoryPage extends WebHistoryPage { threadId: string; epoch: string }

export async function fetchHistoryPage(threadId: string, epoch: string,
  cursor: { before?: string; after?: string; around?: string }): Promise<FetchedHistoryPage> {
  const query = new URLSearchParams({ threadId, epoch });
  if (cursor.before) query.set("before", cursor.before);
  if (cursor.after) query.set("after", cursor.after);
  if (cursor.around) query.set("around", cursor.around);
  return request<FetchedHistoryPage>(`/api/history?${query.toString()}`);
}

export async function request<T>(route: string, data?: unknown): Promise<T> {
  const response = await fetch(route, {
    method: data === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: data === undefined ? undefined : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`);
  return payload as T;
}

export async function bootstrap(): Promise<WebSnapshot> {
  const token = new URLSearchParams(location.hash.replace(/^#/, "")).get("token");
  if (token) {
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    await request("/api/bootstrap", { token });
  }
  return request<WebSnapshot>("/api/state");
}

export async function uploadImage(file: File, threadId: string): Promise<{ id: string; label: string; mediaType: string }> {
  const response = await fetch("/api/image", {
    method: "POST", body: file, credentials: "same-origin",
    headers: { "Content-Type": file.type, "X-Easy-Code-Thread-Id": threadId },
  });
  const result = await response.json() as { image?: { id: string; label: string; mediaType: string }; error?: string };
  if (!response.ok || !result.image) throw new Error(result.error ?? `Image upload failed (${response.status})`);
  return result.image;
}

export async function discardImage(id: string, threadId: string): Promise<void> {
  await request("/api/image/discard", { id, threadId });
}

export interface UploadedResource { id: string; filename: string; kind: "document" | "webpage"; mediaType: string; uri: string; byteSize: number }
export async function uploadResource(file: File, threadId: string): Promise<UploadedResource> {
  const response = await fetch("/api/resource", {
    method: "POST", body: file, credentials: "same-origin",
    headers: { "Content-Type": file.type || "application/octet-stream", "X-Easy-Code-Thread-Id": threadId,
      "X-Easy-Code-Filename": encodeURIComponent(file.name) },
  });
  const result = await response.json() as { resource?: UploadedResource; error?: string };
  if (!response.ok || !result.resource) throw new Error(result.error ?? `Document upload failed (${response.status})`);
  return result.resource;
}

export async function discardResource(id: string, threadId: string): Promise<void> {
  await request("/api/resource/discard", { id, threadId });
}

export type { WebPatch };
