import { Chalk, type ChalkInstance } from "chalk";

import { formatTokenCount } from "../../cli/token-count.js";
import { redactSensitiveInformation } from "../../memory/sensitive.js";
import type { SubagentStatus, SubagentView } from "../../subagents/types.js";
import type { TaskGraphView } from "../../tasks/task-graph.js";
import type {
  UIOverlayState,
  UIProgressStatus,
  UISessionInfo,
  UIState,
  UIThinkingPanelState,
} from "../contracts.js";
import {
  displayWidth,
  sanitizeTerminalText,
  truncateToWidth,
  wrapToWidth,
} from "./layout.js";

export const DEFAULT_VIEW_COLUMNS = 80;
export const MAX_COMPACT_TASK_ROWS = 5;
export const MAX_COMPACT_AGENT_ROWS = 5;
export const MAX_THINKING_PANEL_ROWS = 12;

export const ACTIVITY_SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

/** Shared, process-independent settings for all pure terminal views. */
export interface RenderViewOptions {
  /** Terminal display cells. `width` is accepted as a descriptive alias. */
  readonly columns?: number;
  readonly width?: number;
  /** Emit EASY CODE-owned SGR styles. `colors` is accepted as an alias. */
  readonly color?: boolean;
  readonly colors?: boolean;
  /** Both compact lists have a hard safety ceiling of five rows. */
  readonly maxTasks?: number;
  readonly maxTaskRows?: number;
  readonly maxAgents?: number;
  readonly maxAgentRows?: number;
  readonly maxProgress?: number;
  readonly maxProgressRows?: number;
  readonly maxThinkingLines?: number;
  readonly maxThinkingRows?: number;
  readonly maxOverlayRows?: number;
  /** Override the effort-derived child capacity shown in the Agents heading. */
  readonly agentConcurrencyLimit?: number;
  readonly concurrencyLimit?: number;
  /** Deterministic spinner override, useful for a renderer-owned animation tick. */
  readonly spinnerFrame?: number | string;
  readonly busyPlaceholder?: string;
}

/** Naming aliases for integrations that group these helpers under the UI view. */
export type ViewRenderOptions = RenderViewOptions;
export type UIViewRenderOptions = RenderViewOptions;

/** Render the stable EASY CODE session card shown above terminal scrollback. */
export function renderSessionHeader(
  state: Readonly<UIState>,
  options: RenderViewOptions = {},
): string {
  const columns = viewColumns(options);
  const palette = viewPalette(options);
  const session = state.header.session;
  const body: string[] = [];

  if (!session) {
    body.push(palette.gray("Starting session…"));
  } else {
    const context = formatContext(session);
    body.push([
      palette.cyan(safeInline(session.mode) || "auto"),
      palette.bold(formatProviderModel(session, true)),
      palette.gray(`thinking:${safeInline(session.thinkingEffort) || "none"}`),
      palette.gray(`context:${context}`),
    ].join(palette.gray(" · ")));
    body.push([
      safeInline(session.workspaceRoot) || ".",
      palette.gray(`thread: ${safeInline(session.threadId) || "unknown"}`),
    ].join(palette.gray(" · ")));
  }

  return renderBox(
    safeInline(state.header.title) || "EASY CODE",
    body,
    columns,
    palette,
  );
}

/**
 * Render the redrawable bottom region. An overlay is modal and therefore hides
 * progress, activity, Thinking, composer, and status until it is dismissed.
 */
export function renderLiveRegion(
  state: Readonly<UIState>,
  nowMs: number,
  options: RenderViewOptions = {},
): string {
  if (state.overlay) return renderOverlay(state.overlay, options);

  const blocks: string[] = [];
  const activityRegion = renderLiveActivityRegion(state, nowMs, options);
  const statusRegion = renderComposerStatusRegion(state, options);
  if (activityRegion) blocks.push(activityRegion);
  if (state.composer.busy) blocks.push(renderComposerPrompt(state, options));
  if (statusRegion) blocks.push(statusRegion);
  return blocks.join("\n\n");
}

/**
 * Render transient work above the composer. Thinking stays first so its live
 * expansion remains adjacent to the stable marker that introduced it. During
 * active input, readline renders the same panel immediately above Request.
 */
export function renderLiveActivityRegion(
  state: Readonly<UIState>,
  nowMs: number,
  options: RenderViewOptions = {},
): string {
  const blocks: string[] = [];
  const progress = renderProgress(state, options);
  const activity = renderActivity(state, nowMs, options);
  const thinking = state.composer.busy && state.live.thinking
    ? renderThinkingPanel(state.live.thinking, options)
    : "";
  if (thinking) blocks.push(thinking);
  if (progress) blocks.push(progress);
  if (activity) blocks.push(activity);
  return blocks.join("\n\n");
}

/** Render Tasks and Agents below the composer, followed by the final footer. */
export function renderComposerStatusRegion(
  state: Readonly<UIState>,
  options: RenderViewOptions = {},
): string {
  const blocks: string[] = [];
  const tasks = renderTasks(state.live.tasks, options);
  const agents = renderAgents(state, options);
  if (tasks) blocks.push(tasks);
  if (agents) blocks.push(agents);
  blocks.push(renderComposerFooter(state, options));
  return blocks.join("\n\n");
}

/** Render the persistent, multiline input card (without a trailing newline). */
export function renderComposerPrompt(
  state: Readonly<UIState>,
  options: RenderViewOptions = {},
): string {
  const columns = viewColumns(options);
  const palette = viewPalette(options);
  const innerWidth = boxContentWidth(columns);
  const composer = state.composer;
  const hasText = composer.text.length > 0;
  const customPlaceholder = safeInline(composer.placeholder);
  const defaultBusyPlaceholder = customPlaceholder &&
      customPlaceholder !== "Type your request…"
    ? customPlaceholder
    : "Working…";
  const mainText = hasText
    ? safeMultiline(composer.text)
    : composer.busy
      ? safeInline(options.busyPlaceholder ?? defaultBusyPlaceholder)
      : customPlaceholder || "Type your request…";
  const imageBadges = composer.images
    .map((image) => `[${safeInline(image.label) || "Image"}]`)
    .join(" ");
  const payload = `${mainText}${mainText && imageBadges ? " " : ""}${imageBadges}`;
  const contentColumns = Math.max(1, innerWidth - 2);
  const wrapped = wrapToWidth(payload, contentColumns, { preserveAnsi: false });
  const lines = wrapped.map((line, index) => {
    const prefixed = `${index === 0 ? "> " : "  "}${line}`;
    if (hasText) return prefixed;
    return composer.busy ? palette.yellow(prefixed) : palette.gray(prefixed);
  });
  return renderBox("", lines, columns, palette);
}

/** Render the compact one-line mode/model/context/task/agent status bar. */
export function renderComposerFooter(
  state: Readonly<UIState>,
  options: RenderViewOptions = {},
): string {
  const palette = viewPalette(options);
  const session = state.header.session;
  const graph = state.live.tasks;
  const task = graph ? taskPosition(graph) : undefined;
  const activeAgents = state.live.subagents.filter((agent) =>
    isActiveAgent(agent.status)
  ).length;
  const segments: string[] = [];

  if (session) {
    segments.push(palette.cyan(safeInline(session.mode) || "auto"));
    segments.push(palette.bold(formatProviderModel(session, false)));
    segments.push(safeInline(session.thinkingEffort) || "none");
    segments.push(palette.gray(`ctx ${formatContext(session)}`));
  } else {
    segments.push(palette.gray("starting"));
  }
  segments.push(palette.gray(
    task ? `task ${task.current}/${task.total}` : "task –",
  ));
  segments.push(palette.gray(`agents ${activeAgents}`));

  return truncateToWidth(segments.join("  "), viewColumns(options), {
    preserveAnsi: viewColor(options),
  });
}

/** Render one expanded, bounded Thinking block inside the redrawable region. */
export function renderThinkingPanel(
  panel: Readonly<UIThinkingPanelState>,
  options: RenderViewOptions = {},
): string {
  const columns = viewColumns(options);
  const palette = viewPalette(options);
  const innerWidth = Math.max(1, boxContentWidth(columns));
  const maximumRows = boundedOption(
    options.maxThinkingRows ?? options.maxThinkingLines,
    MAX_THINKING_PANEL_ROWS,
    1,
    40,
  );
  const content = panel.body || "(No visible Thinking text.)";
  const wrapped = limitedWrappedLineResult(content, innerWidth, maximumRows);
  const body = wrapped.lines.map((line) =>
    palette.gray(line)
  );
  if (wrapped.truncated) {
    body.push(palette.gray(
      `… ${wrapped.totalLines - maximumRows} more wrapped row(s).`,
    ));
    body.push(palette.gray(
      `/thinking ${panel.id} shows all retained content.`,
    ));
  }
  if (panel.truncated) {
    const source = panel.sourceLines !== undefined && panel.sourceChars !== undefined
      ? ` from ${panel.sourceLines} lines / ${panel.sourceChars} chars`
      : panel.sourceLines !== undefined
        ? ` from ${panel.sourceLines} lines`
        : panel.sourceChars !== undefined
          ? ` from ${panel.sourceChars} chars`
          : "";
    body.push(palette.gray(`… [Thinking truncated${source}.]`));
  }
  body.push("");
  body.push(palette.gray(
    `↕ Thinking #${panel.id} · /thinking ${panel.id}`,
  ));
  body.push(palette.gray(
    "  VS Code Ctrl/Cmd+click the Thinking label to close",
  ));
  return renderBox(
    `Thinking #${panel.id}`,
    body,
    columns,
    palette,
    "gray",
  );
}

/** Render a modal picker card. All request/model/plan strings remain data. */
export function renderOverlay(
  overlay: Readonly<UIOverlayState>,
  options: RenderViewOptions = {},
): string {
  const columns = viewColumns(options);
  const palette = viewPalette(options);
  const innerWidth = Math.max(1, boxContentWidth(columns));
  const body: string[] = [];
  const detail = overlay.detail ??
    (overlay.kind === "approval"
      ? overlay.request.description
      : overlay.kind === "plan-review"
        ? overlay.proposal.overview
        : undefined);

  if (detail) {
    body.push(...limitedWrappedLines(detail, innerWidth, 3).map((line) =>
      palette.gray(line)
    ));
    body.push("");
  }
  if (overlay.kind === "approval" && overlay.request.commandPreview) {
    const command = safeInline(overlay.request.commandPreview);
    body.push(palette.gray(truncateToWidth(
      `Command: ${command}`,
      innerWidth,
      { preserveAnsi: false },
    )));
    body.push("");
  }

  const selectedIndex = overlay.rows.length === 0
    ? 0
    : clampInteger(overlay.selectedIndex, 0, overlay.rows.length - 1);
  const maximumRows = boundedOption(
    options.maxOverlayRows,
    8,
    1,
    20,
  );
  const window = compactWindow(overlay.rows.length, selectedIndex, maximumRows);
  if (window.start > 0) {
    body.push(palette.gray(`  ↑ ${window.start} more`));
  }
  if (overlay.rows.length === 0) {
    body.push(palette.gray("  No choices available."));
  } else {
    for (let index = window.start; index < window.end; index += 1) {
      const row = overlay.rows[index];
      if (!row) continue;
      const selected = index === selectedIndex;
      const label = safeInline(row.label) || "(unnamed)";
      const detailText = row.detail ? ` · ${safeInline(row.detail)}` : "";
      const disabled = row.disabled ? " (disabled)" : "";
      const line = truncateToWidth(
        `${selected ? "›" : " "} ${label}${detailText}${disabled}`,
        innerWidth,
        { preserveAnsi: false },
      );
      body.push(selected ? palette.white.bold(line) : palette.gray(line));
    }
  }
  if (window.end < overlay.rows.length) {
    body.push(palette.gray(`  ↓ ${overlay.rows.length - window.end} more`));
  }
  const hint = safeInline(overlay.hint);
  if (hint) {
    body.push("");
    body.push(...limitedWrappedLines(hint, innerWidth, 2).map((line) =>
      palette.gray(line)
    ));
  }

  return renderBox(
    safeInline(overlay.title) || "Select",
    body,
    columns,
    palette,
  );
}

function renderProgress(
  state: Readonly<UIState>,
  options: RenderViewOptions,
): string {
  const progress = state.live.progress;
  if (progress.length === 0) return "";
  const palette = viewPalette(options);
  const columns = viewColumns(options);
  const maximum = boundedOption(
    options.maxProgressRows ?? options.maxProgress,
    8,
    1,
    20,
  );
  const start = Math.max(0, progress.length - maximum);
  const lines = [palette.bold("Progress")];
  if (start > 0) lines.push(palette.gray(`  … ${start} earlier`));
  const known = new Map(progress.map((item) => [item.id, item]));
  for (let index = start; index < progress.length; index += 1) {
    const item = progress[index];
    if (!item) continue;
    const depth = progressDepth(item.parentId, known);
    const detail = item.detail ? ` · ${safeInline(item.detail)}` : "";
    const text = `${"  ".repeat(depth + 1)}${progressIcon(item.status)} ` +
      `${safeInline(item.label) || "Working"}${detail}`;
    lines.push(styleProgressStatus(
      item.status,
      truncateToWidth(text, columns, { preserveAnsi: false }),
      palette,
    ));
  }
  return lines.join("\n");
}

function renderTasks(
  graph: Readonly<TaskGraphView> | null,
  options: RenderViewOptions,
): string {
  if (!graph || graph.tasks.length === 0) return "";
  const palette = viewPalette(options);
  const columns = viewColumns(options);
  const position = taskPosition(graph);
  const maximum = boundedOption(
    options.maxTaskRows ?? options.maxTasks,
    MAX_COMPACT_TASK_ROWS,
    1,
    MAX_COMPACT_TASK_ROWS,
  );
  const focusIndex = Math.max(0, position.current - 1);
  const window = compactWindow(graph.tasks.length, focusIndex, maximum);
  const lines = [palette.bold(`Tasks ${position.current}/${position.total}`)];
  if (window.start > 0) lines.push(palette.gray(`  … ${window.start} earlier`));

  for (let index = window.start; index < window.end; index += 1) {
    const task = graph.tasks[index];
    if (!task) continue;
    const blocker = task.status === "blocked" && task.blocker
      ? ` · ${safeInline(task.blocker)}`
      : "";
    const text = `  ${taskIcon(task.status)} ${index + 1}. ` +
      `${safeInline(task.title) || safeInline(task.id) || "Task"}${blocker}`;
    lines.push(styleTaskStatus(
      task.status,
      truncateToWidth(text, columns, { preserveAnsi: false }),
      palette,
    ));
  }
  if (window.end < graph.tasks.length) {
    lines.push(palette.gray(`  … ${graph.tasks.length - window.end} more`));
  }
  return lines.join("\n");
}

function renderAgents(
  state: Readonly<UIState>,
  options: RenderViewOptions,
): string {
  const agents = state.live.subagents;
  if (agents.length === 0) return "";
  const palette = viewPalette(options);
  const columns = viewColumns(options);
  const maximum = boundedOption(
    options.maxAgentRows ?? options.maxAgents,
    MAX_COMPACT_AGENT_ROWS,
    1,
    MAX_COMPACT_AGENT_ROWS,
  );
  const visible = agents.slice(0, maximum);
  const active = agents.filter((agent) => isActiveAgent(agent.status)).length;
  const capacity = boundedOption(
    options.agentConcurrencyLimit ?? options.concurrencyLimit,
    effortAgentCapacity(state.header.session?.thinkingEffort),
    1,
    99,
  );
  const lines = [palette.bold(`Agents ${active}/${capacity}`)];
  for (const agent of visible) {
    // Full UUIDs consume the entire row in ordinary terminals and hide the
    // assignment the user actually needs to monitor. Keep a stable short
    // identity while reserving the row for the task title/status detail.
    const label = shortAgentLabel(agent.id);
    const detail = agentDetail(agent);
    const text = `  ${agentIcon(agent.status)} ${label}` +
      `${detail ? `  ${detail}` : ""}`;
    lines.push(styleAgentStatus(
      agent.status,
      truncateToWidth(text, columns, { preserveAnsi: false }),
      palette,
    ));
  }
  if (visible.length < agents.length) {
    lines.push(palette.gray(`  … ${agents.length - visible.length} more`));
  }
  return lines.join("\n");
}

function renderActivity(
  state: Readonly<UIState>,
  nowMs: number,
  options: RenderViewOptions,
): string {
  const activity = state.live.activity;
  if (!activity) return "";
  const palette = viewPalette(options);
  const startedAt = finiteNumber(activity.startedAt, finiteNumber(nowMs, 0));
  const elapsedMs = Math.max(0, finiteNumber(nowMs, startedAt) - startedAt);
  const frame = spinnerFrame(options.spinnerFrame, elapsedMs);
  const detail = activity.detail ? ` · ${safeInline(activity.detail)}` : "";
  const line = `${frame} ${safeInline(activity.label) || "Working"}` +
    `${detail} · ${formatElapsed(elapsedMs)}`;
  return palette.gray(truncateToWidth(line, viewColumns(options), {
    preserveAnsi: false,
  }));
}

function renderBox(
  title: string,
  body: readonly string[],
  columns: number,
  palette: ChalkInstance,
  tone: "cyan" | "gray" = "cyan",
): string {
  const border = tone === "gray"
    ? (value: string): string => palette.gray(value)
    : (value: string): string => palette.cyan(value);
  if (columns < 6) {
    const styledTitle = tone === "gray"
      ? palette.gray.bold(title)
      : palette.bold(title);
    const flat = [...(title ? [styledTitle] : []), ...body];
    return flat.map((line) => truncateToWidth(line, columns, {
      preserveAnsi: true,
    })).join("\n");
  }

  const availableTitleWidth = columns - 3;
  const titlePart = title
    ? truncateToWidth(` ${safeInline(title)} `, availableTitleWidth, {
        preserveAnsi: false,
      })
    : "";
  const titleFill = "─".repeat(Math.max(
    0,
    availableTitleWidth - displayWidth(titlePart),
  ));
  const top = border(`╭─${titlePart}${titleFill}╮`);
  const bottom = border(`╰${"─".repeat(columns - 2)}╯`);
  const innerWidth = boxContentWidth(columns);
  const rows = body.length > 0 ? body : [""];
  const content = rows.map((line) => {
    const fitted = truncateToWidth(line, innerWidth, { preserveAnsi: true });
    const padding = " ".repeat(Math.max(0, innerWidth - displayWidth(fitted)));
    return `${border("│")} ${fitted}${padding} ${border("│")}`;
  });
  return [top, ...content, bottom].join("\n");
}

function formatProviderModel(
  session: Readonly<UISessionInfo>,
  titledProvider: boolean,
): string {
  const provider = safeInline(session.provider).toLowerCase() || "provider";
  const model = safeInline(session.model) || "model";
  const prefix = `${provider}-`;
  const compactModel = model.toLowerCase().startsWith(prefix)
    ? model.slice(prefix.length)
    : model.toLowerCase().startsWith(`${provider}/`)
      ? model.slice(provider.length + 1)
      : model;
  const providerLabel = titledProvider
    ? provider === "deepseek"
      ? "DeepSeek"
      : provider === "glm"
        ? "GLM"
        : provider === "qwen"
          ? "Qwen"
          : provider
    : provider;
  return `${providerLabel}/${compactModel || "model"}`;
}

function formatContext(session: Readonly<UISessionInfo>): string {
  const current = session.contextTokens;
  const limit = session.contextLimitTokens;
  if (current === undefined && limit === undefined) return "—";
  if (current === undefined) return `?/${formatTokenCount(limit ?? 0)}`;
  if (limit === undefined) return formatTokenCount(current);
  return `${formatTokenCount(current)}/${formatTokenCount(limit)}`;
}

function taskPosition(
  graph: Readonly<TaskGraphView>,
): { current: number; total: number } {
  const total = Math.max(0, graph.total || graph.tasks.length);
  const currentIndex = graph.currentTask
    ? graph.tasks.findIndex((task) => task.id === graph.currentTask)
    : graph.tasks.findIndex((task) => task.status === "in_progress");
  if (currentIndex >= 0) return { current: currentIndex + 1, total };
  if (graph.status === "completed") return { current: total, total };
  if (total === 0) return { current: 0, total: 0 };
  return { current: Math.min(total, Math.max(1, graph.completed + 1)), total };
}

function taskIcon(status: TaskGraphView["tasks"][number]["status"]): string {
  switch (status) {
    case "completed": return "✓";
    case "in_progress": return "▶";
    case "blocked": return "⊠";
    case "pending": return "□";
  }
}

function styleTaskStatus(
  status: TaskGraphView["tasks"][number]["status"],
  text: string,
  palette: ChalkInstance,
): string {
  switch (status) {
    case "completed": return palette.green(text);
    case "in_progress": return palette.cyan(text);
    case "blocked": return palette.yellow(text);
    case "pending": return palette.gray(text);
  }
}

function progressIcon(status: UIProgressStatus): string {
  switch (status) {
    case "completed": return "✓";
    case "running": return "▶";
    case "failed": return "✗";
    case "blocked": return "⊠";
    case "stopped": return "■";
    case "pending": return "□";
  }
}

function styleProgressStatus(
  status: UIProgressStatus,
  text: string,
  palette: ChalkInstance,
): string {
  switch (status) {
    case "completed": return palette.green(text);
    case "running": return palette.cyan(text);
    case "failed": return palette.red(text);
    case "blocked": return palette.yellow(text);
    case "stopped":
    case "pending": return palette.gray(text);
  }
}

function progressDepth(
  parentId: string | undefined,
  known: ReadonlyMap<string, { readonly parentId?: string }>,
): number {
  let depth = 0;
  let current = parentId;
  const seen = new Set<string>();
  while (current && depth < 3 && !seen.has(current)) {
    seen.add(current);
    depth += 1;
    current = known.get(current)?.parentId;
  }
  return depth;
}

function shortAgentLabel(value: string): string {
  const original = safeInline(value);
  if (original && !/^subagent[_-]/iu.test(original) && displayWidth(original) <= 20) {
    return original;
  }
  const safe = original.replace(/^subagent[_-]?/iu, "");
  if (!safe) return "agent";
  return `agent-${safe.slice(0, 8)}`;
}

function agentIcon(status: SubagentStatus): string {
  switch (status) {
    case "running": return "●";
    case "stopping": return "◌";
    case "completed": return "✓";
    case "blocked": return "⊠";
    case "failed": return "✗";
    case "stopped": return "■";
    case "interrupted": return "!";
  }
}

function styleAgentStatus(
  status: SubagentStatus,
  text: string,
  palette: ChalkInstance,
): string {
  switch (status) {
    case "running": return palette.cyan(text);
    case "stopping":
    case "blocked": return palette.yellow(text);
    case "completed": return palette.green(text);
    case "failed":
    case "interrupted": return palette.red(text);
    case "stopped": return palette.gray(text);
  }
}

function isActiveAgent(status: SubagentStatus): boolean {
  return status === "running" || status === "stopping";
}

function agentDetail(agent: Readonly<SubagentView>): string {
  const taskTitle = safeInline(agent.taskTitle);
  switch (agent.status) {
    case "running": return taskTitle;
    case "stopping": return `Stopping${taskTitle ? ` · ${taskTitle}` : ""}`;
    case "completed":
      return safeInline(agent.result?.summary ?? "Completed");
    case "blocked":
      return safeInline(
        agent.result?.outcome === "blocked"
          ? agent.result.blocker
          : agent.error ?? "Blocked",
      );
    case "failed": return safeInline(agent.error ?? "Failed");
    case "stopped": return taskTitle ? `Stopped · ${taskTitle}` : "Stopped";
    case "interrupted": return safeInline(agent.error ?? "Interrupted");
  }
}

function effortAgentCapacity(
  effort: UISessionInfo["thinkingEffort"] | undefined,
): number {
  if (effort === "high") return 8;
  if (effort === "medium") return 4;
  return 2;
}

function limitedWrappedLines(
  value: string,
  columns: number,
  maximumLines: number,
): string[] {
  return limitedWrappedLineResult(value, columns, maximumLines).lines;
}

function limitedWrappedLineResult(
  value: string,
  columns: number,
  maximumLines: number,
): { lines: string[]; truncated: boolean; totalLines: number } {
  const lines = wrapToWidth(safeMultiline(value), columns, {
    preserveAnsi: false,
  });
  if (lines.length <= maximumLines) {
    return { lines, truncated: false, totalLines: lines.length };
  }
  const visible = lines.slice(0, maximumLines);
  const last = visible.length - 1;
  visible[last] = truncateToWidth(visible[last] ?? "", columns, {
    ellipsis: "…",
    preserveAnsi: false,
  });
  if (displayWidth(visible[last] ?? "") < columns) {
    visible[last] = truncateToWidth(`${visible[last] ?? ""}…`, columns, {
      preserveAnsi: false,
    });
  }
  return { lines: visible, truncated: true, totalLines: lines.length };
}

function compactWindow(
  length: number,
  focus: number,
  maximum: number,
): { start: number; end: number } {
  if (length <= maximum) return { start: 0, end: length };
  const normalizedFocus = clampInteger(focus, 0, Math.max(0, length - 1));
  const proposed = normalizedFocus - Math.floor(maximum / 2);
  const start = clampInteger(proposed, 0, length - maximum);
  return { start, end: start + maximum };
}

function spinnerFrame(
  requested: number | string | undefined,
  elapsedMs: number,
): string {
  if (typeof requested === "string") {
    return truncateToWidth(safeInline(requested), 2, { preserveAnsi: false }) ||
      ACTIVITY_SPINNER_FRAMES[0];
  }
  const index = requested === undefined
    ? Math.floor(elapsedMs / 80)
    : Math.floor(finiteNumber(requested, 0));
  const normalized = ((index % ACTIVITY_SPINNER_FRAMES.length) +
    ACTIVITY_SPINNER_FRAMES.length) % ACTIVITY_SPINNER_FRAMES.length;
  return ACTIVITY_SPINNER_FRAMES[normalized] ?? "⠋";
}

function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${String(remainingSeconds).padStart(2, "0")}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function safeInline(value: string): string {
  return sanitizeExternal(value).replace(/\s+/gu, " ").trim();
}

function safeMultiline(value: string): string {
  return sanitizeExternal(value)
    .replace(/[^\S\n]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function sanitizeExternal(value: string): string {
  // Remove controls before redaction so escape bytes cannot split a credential
  // pattern and evade the second pass.
  return redactSensitiveInformation(
    sanitizeTerminalText(value, { allowSgr: false }),
  );
}

function viewPalette(options: RenderViewOptions): ChalkInstance {
  return new Chalk({ level: viewColor(options) ? 1 : 0 });
}

function viewColor(options: RenderViewOptions): boolean {
  return options.color ?? options.colors ?? false;
}

function viewColumns(options: RenderViewOptions): number {
  return boundedOption(options.columns ?? options.width, DEFAULT_VIEW_COLUMNS, 1, 10_000);
}

function boxContentWidth(columns: number): number {
  return columns >= 6 ? columns - 4 : columns;
}

function boundedOption(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function finiteNumber(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}
