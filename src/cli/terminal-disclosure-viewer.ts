import chalk from "chalk";
import type { UIState } from "../ui/contracts.js";
import type { CurrentRequestOptions } from "../ui/interaction-port.js";
import { ScreenWriter } from "../ui/render/screen-writer.js";
import { renderFixedBottomRegions, renderLiveRegion } from "../ui/render/view.js";
import { applyEvent } from "../ui/store.js";
import {
  FullScreenWriter,
  applyDisclosureViewCommand,
  clearDisclosureViewTarget,
  createDisclosureViewState,
  renderDisclosureView,
  replaceDisclosureViewNodes,
  resizeDisclosureView,
  toggleDisclosureView,
  updateDisclosureViewChrome,
  type DisclosureViewState,
} from "../ui/tui/index.js";
import { AdjustmentRegistry } from "./adjustment.js";
import {
  disclosureAnchorScreenRow,
  disclosureComposerLines,
  disclosureDocumentNodes,
  disclosureEditorInput,
  disclosureFooterLines,
  disclosureHeaderLines,
  disclosureTarget,
  registryIdFromVirtualNode,
  renderDisclosureFrameWithPosition,
  type DisclosureKind,
  type TerminalViewOptions,
} from "./disclosure-render.js";
import { ModelStreamRenderer } from "./model-stream-renderer.js";
import { type PromptInput, type PromptInputSession } from "./prompt-input.js";
import { ReasoningRegistry, type ReasoningBlock } from "./reasoning.js";
import type {
  ActiveDisclosureViewer,
  BusyInputOwner,
  CurrentTurnDisclosure,
  StableStatusKind,
} from "./terminal-types.js";
import { TuiInputCore, type TuiInputEvent } from "./tui-input.js";

/** Live state and callbacks supplied by Terminal. */
export interface TerminalDisclosureViewerContext {
  readonly activePromptController: AbortController | undefined;
  activePromptSession: PromptInputSession | undefined;
  readonly adjustments: AdjustmentRegistry;
  readonly busyInputOwner: BusyInputOwner | undefined;
  readonly closed: boolean;
  readonly currentRequestOptions: Readonly<CurrentRequestOptions> | undefined;
  readonly currentTurnDisclosures: CurrentTurnDisclosure[];
  disclosureViewer: ActiveDisclosureViewer | undefined;
  readonly externalOperationController: AbortController | undefined;
  readonly failTerminalUi: (stage: string, value: unknown) => void;
  readonly guardedInputActive: boolean;
  readonly inlineShellActive: boolean;
  readonly input: PromptInput;
  readonly isInteractive: () => boolean;
  readonly output: NodeJS.WritableStream;
  readonly physicalColumns: () => number;
  readonly physicalRows: () => number;
  promptActive: boolean;
  readonly reasoning: ReasoningRegistry;
  readonly refresh: () => void;
  readonly retainedReasoningDisclosures: Map<string, Readonly<ReasoningBlock>>;
  readonly screen: ScreenWriter | undefined;
  readonly setTerminalCursorVisible: (visible: boolean) => void;
  readonly signalCurrentRequestInterrupt: () => void;
  readonly startBusyInputOwner: () => void;
  readonly stopBusyInputOwner: () => void;
  readonly streams: ModelStreamRenderer;
  terminalCursorVisible: boolean;
  uiState: UIState;
  readonly viewOptions: () => TerminalViewOptions;
  readonly writeStableStatus: (text: string, kind: StableStatusKind) => void;
}

export class TerminalDisclosureViewer {
  constructor(private readonly ctx: TerminalDisclosureViewerContext) {}

  /**
   * Current host-integration boundary for opening a retained disclosure.
   * VS Code invokes it through the authenticated bridge; tests and future UI
   * hosts can invoke the same semantic action without injecting terminal bytes.
   */
  handleDisclosureToggle(kind: DisclosureKind, id: number): boolean {
    if (!Number.isSafeInteger(id) || id <= 0) return false;
    // A modal owns both the pixels and the input decision until it closes.
    if (this.ctx.uiState.overlay || this.ctx.guardedInputActive) return false;
    return this.openDisclosureViewer(kind, id);
  }

  /**
   * Open one complete Thinking/Adjustment body in a managed alternate-screen
   * transcript. The primary terminal remains untouched, so closing the viewer
   * can restore the collapsed marker at exactly the same logical position.
   */
  openDisclosureViewer(kind: DisclosureKind, id: number): boolean {
    if (this.ctx.uiState.overlay || this.ctx.guardedInputActive) return false;
    if (!this.ctx.inlineShellActive || !this.ctx.isInteractive() || this.ctx.closed) {
      return false;
    }
    if (!this.disclosureAvailable(kind, id)) {
      const label = kind === "thinking" ? "Thinking block" : "Queued adjustment";
      this.ctx.writeStableStatus(`${label} #${id} is historical or unavailable in the current terminal view.`, "info");
      return false;
    }

    const current = this.ctx.disclosureViewer;
    if (current) return this.switchDisclosureViewer(current, kind, id);

    return this.startPersistentViewer(undefined, { kind, id });
  }

  /**
   * Start the single full-screen shell projection.
   *
   * The ordinary conversation and expanded disclosures share this writer;
   * opening Thinking therefore changes only a virtual transcript node and
   * never enters a second alternate screen.
   */
  startPersistentViewer(
    promptSession?: PromptInputSession,
    initialDisclosure?: Readonly<{ kind: DisclosureKind; id: number }>,
  ): boolean {
    const existing = this.ctx.disclosureViewer;
    if (existing) {
      const attached = promptSession ? this.attachDisclosurePromptSession(existing, promptSession) : true;
      if (!attached) return false;
      return initialDisclosure
        ? this.switchDisclosureViewer(existing, initialDisclosure.kind, initialDisclosure.id)
        : true;
    }

    const rows = this.ctx.physicalRows();
    if (rows < 9) {
      if (initialDisclosure) {
        this.ctx.writeStableStatus(
          "The terminal needs at least 9 rows to open the managed conversation view.",
          "warning",
        );
      }
      return false;
    }

    const priorBusyOwner = this.ctx.busyInputOwner;
    const wasRaw = priorBusyOwner?.wasRaw ?? Boolean(this.ctx.input.isRaw);
    const wasFlowing = priorBusyOwner?.wasFlowing ?? this.ctx.input.readableFlowing === true;
    const suspendedSession = promptSession ?? this.ctx.activePromptSession;
    const sessionSuspended =
      suspendedSession?.suspendInput({
        // A completed idle prompt can remain byte-for-byte intact in the hidden
        // primary buffer. Busy UI is expected to keep changing, so retain its
        // existing erase/redraw lifecycle.
        preserveDisplay: !this.ctx.uiState.composer.busy,
      }) ?? false;
    if (suspendedSession && !sessionSuspended) return false;
    if (sessionSuspended) {
      if (this.ctx.activePromptSession === suspendedSession) {
        this.ctx.activePromptSession = undefined;
      }
      this.ctx.promptActive = false;
    } else {
      this.ctx.stopBusyInputOwner();
    }

    const columns = this.ctx.physicalColumns();
    const target = initialDisclosure ? disclosureTarget(initialDisclosure.kind, initialDisclosure.id) : undefined;
    const nodes = disclosureDocumentNodes(
      this.ctx.uiState.transcript,
      this.ctx.retainedReasoningDisclosures,
      this.ctx.streams,
      initialDisclosure?.kind,
      initialDisclosure?.id,
    );
    const headerLines = disclosureHeaderLines(this.ctx.uiState, this.ctx.viewOptions(), columns);
    const composerLines = disclosureComposerLines(this.ctx.uiState, this.ctx.viewOptions(), columns, rows);
    const footerLines = disclosureFooterLines(this.ctx.uiState, this.ctx.viewOptions(), columns, rows, composerLines);
    let state: DisclosureViewState;
    try {
      state = createDisclosureViewState({
        nodes,
        ...(target ? { target } : {}),
        columns,
        rows,
        headerLines,
        composerLines,
        footerLines,
        ...(target
          ? {
              anchorScreenRow: disclosureAnchorScreenRow({
                nodes,
                target,
                columns,
                rows,
                headerLines,
                composerLines,
                footerLines,
              }),
              expanded: true,
            }
          : {}),
        preserveAnsi: true,
      });
    } catch (error) {
      if (sessionSuspended && suspendedSession) {
        this.ctx.promptActive = true;
        this.ctx.activePromptSession = suspendedSession;
        suspendedSession.resumeInput({ discardLeadingModalControls: true });
      } else {
        this.ctx.startBusyInputOwner();
      }
      this.ctx.writeStableStatus(
        `Unable to open disclosure view: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return false;
    }

    const writer = new FullScreenWriter({
      output: this.ctx.output as import("../ui/render/screen-writer.js").ScreenOutput,
      columns: () => this.ctx.physicalColumns(),
      rows: () => this.ctx.physicalRows(),
      onFailure: (error) => this.ctx.failTerminalUi("full-screen renderer", error),
    });
    const tuiInput = new TuiInputCore({ focus: "viewer", mouseWheelLines: 3 });
    let viewer!: ActiveDisclosureViewer;
    const onData = (chunk: Buffer | string): void => {
      if (this.ctx.disclosureViewer !== viewer || viewer.closing) return;
      try {
        const decoded = viewer.input.feed(chunk);
        this.scheduleDisclosureInputFlush(viewer);
        for (const event of decoded.events) {
          this.handleDisclosureInput(viewer, event);
          if (this.ctx.disclosureViewer !== viewer) break;
        }
      } catch (error) {
        this.ctx.failTerminalUi("conversation input", error);
      }
    };
    const onError = (error: Error): void => {
      this.ctx.failTerminalUi("conversation input", error);
    };
    const rendered = renderDisclosureFrameWithPosition(state, this.ctx.uiState, this.ctx.viewOptions());
    state = rendered.state;
    const frame = rendered.frame;
    viewer = {
      writer,
      input: tuiInput,
      state,
      frame,
      ...(initialDisclosure
        ? {
            kind: initialDisclosure.kind,
            registryId: initialDisclosure.id,
          }
        : {}),
      ...(sessionSuspended && suspendedSession ? { suspendedSession } : {}),
      sessionReleased: false,
      wasRaw,
      wasFlowing,
      onData,
      onError,
      deferredCommits: [],
      primaryDisplayDirty: false,
      closing: false,
    };
    this.ctx.disclosureViewer = viewer;
    if (initialDisclosure?.kind === "thinking") {
      const block = this.ctx.reasoning.get(initialDisclosure.id);
      if (block && this.ctx.uiState.live.thinking?.id !== initialDisclosure.id) {
        this.ctx.uiState = applyEvent(this.ctx.uiState, {
          type: "thinking.toggle",
          panel: block,
        });
      }
    } else if (initialDisclosure?.kind === "adjustment") {
      this.ctx.uiState = applyEvent(this.ctx.uiState, { type: "thinking.hide" });
    }

    try {
      this.ctx.input.pause();
      this.ctx.input.setRawMode?.(true);
      this.ctx.input.on("data", onData);
      this.ctx.input.on("error", onError);
      writer.render(frame.rows);
      writer.enter();
      if (this.ctx.closed) return false;
      // FullScreenWriter owns DEC cursor visibility while the alternate
      // buffer is active. Keep our cache synchronized with its hidden cursor.
      this.ctx.terminalCursorVisible = false;
      this.ctx.input.resume();
      return true;
    } catch (error) {
      this.closeDisclosureViewer();
      this.ctx.writeStableStatus(
        `Unable to start disclosure view: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return false;
    }
  }

  /** Attach a newly-created readline editor to the already-running shell. */
  private attachDisclosurePromptSession(viewer: ActiveDisclosureViewer, session: PromptInputSession): boolean {
    if (this.ctx.disclosureViewer !== viewer || viewer.closing) return false;
    if (viewer.suspendedSession === session && !viewer.sessionReleased) {
      return true;
    }
    if (viewer.suspendedSession && !viewer.sessionReleased) return false;
    if (!session.suspendInput({ preserveDisplay: true })) return false;
    viewer.suspendedSession = session;
    viewer.sessionReleased = false;
    if (this.ctx.activePromptSession === session) this.ctx.activePromptSession = undefined;
    this.ctx.promptActive = false;
    viewer.primaryDisplayDirty = true;
    // suspendInput() pauses the shared readable after disconnecting readline.
    // The persistent viewer is now the sole physical owner, so resume it here
    // or the first paste/keypress after attachment would never be delivered.
    this.ctx.input.resume();
    this.refreshDisclosureViewer();
    return true;
  }

  /** Detach a readline lifecycle that completed while the shell stays alive. */
  releaseDisclosurePromptSession(session: PromptInputSession | undefined): void {
    if (!session) return;
    const viewer = this.ctx.disclosureViewer;
    if (!viewer || viewer.suspendedSession !== session) return;
    viewer.sessionReleased = true;
    viewer.suspendedSession = undefined;
    // readPrompt restores the Raw Mode it observed before the session was
    // created. The permanent shell outlives that readline lifecycle, so take
    // physical ownership back immediately for the next click/paste/keypress.
    try {
      this.ctx.input.setRawMode?.(true);
    } catch {
      // A disappearing terminal will be handled by the viewer's error path.
    }
    this.ctx.input.resume();
    this.refreshDisclosureViewer();
  }

  /** Reassert ownership after readline restores the Raw Mode it inherited. */
  reclaimPersistentViewerInput(): void {
    const viewer = this.ctx.disclosureViewer;
    if (!viewer || viewer.closing || this.ctx.closed) return;
    try {
      this.ctx.input.setRawMode?.(true);
    } catch {
      return;
    }
    this.ctx.input.resume();
  }

  closeDisclosureViewer(): void {
    const viewer = this.ctx.disclosureViewer;
    if (!viewer || viewer.closing) return;
    viewer.closing = true;
    this.ctx.disclosureViewer = undefined;
    this.ctx.uiState = applyEvent(this.ctx.uiState, { type: "thinking.hide" });
    if (viewer.idleTimer) clearTimeout(viewer.idleTimer);
    viewer.idleTimer = undefined;
    if (viewer.repaintTimer) clearTimeout(viewer.repaintTimer);
    viewer.repaintTimer = undefined;

    // A completed idle turn normally has no primary-buffer mutations while
    // its disclosure is open. In that common path the prompt that was already
    // present before DEC 1049 remains authoritative; repainting it after the
    // buffer switch would make VS Code follow the cursor to scrollback bottom.
    const preservePrimaryDisplay = Boolean(
      viewer.suspendedSession &&
      !viewer.sessionReleased &&
      !this.ctx.closed &&
      !this.ctx.uiState.composer.busy &&
      !viewer.primaryDisplayDirty &&
      viewer.deferredCommits.length === 0,
    );

    try {
      this.ctx.input.pause();
      this.ctx.input.removeListener("data", viewer.onData);
      this.ctx.input.removeListener("error", viewer.onError);
      viewer.writer.close();
      // Clear the hidden primary buffer only after leaving the alternate one,
      // before restoring the editor. Never replay text discarded by /clear.
      if (viewer.clearPrimaryOnClose) this.ctx.screen?.clearScreen();
      // The writer's paired exit sequence restores the physical cursor.
      this.ctx.terminalCursorVisible = true;
    } finally {
      try {
        this.ctx.input.setRawMode?.(viewer.wasRaw);
      } catch {
        // A disappearing terminal must not prevent prompt restoration.
      }

      if (viewer.suspendedSession && !viewer.sessionReleased && !this.ctx.closed) {
        this.ctx.promptActive = true;
        this.ctx.activePromptSession = viewer.suspendedSession;
        viewer.suspendedSession.resumeInput({
          discardLeadingModalControls: true,
          preserveDisplay: preservePrimaryDisplay,
          reacquireTerminalModes: true,
        });
        this.ctx.setTerminalCursorVisible(true);
      } else {
        if (viewer.wasFlowing) this.ctx.input.resume();
        else this.ctx.input.pause();
        if (!this.ctx.closed) this.ctx.startBusyInputOwner();
      }

      // Stable output produced while the alternate buffer was visible must be
      // committed exactly once. When an editor session survived, route it
      // through that session after restoration so its preserved draft is
      // erased/redrawn around the output instead of being overwritten.
      if (!this.ctx.closed) {
        for (const commit of viewer.deferredCommits) {
          if (this.ctx.activePromptSession) {
            this.ctx.activePromptSession.writeAbove(commit.text);
          } else {
            this.ctx.screen?.commit(commit.text);
          }
        }
      }
      // With an untouched primary prompt there is nothing to redraw. Avoiding
      // even a decorative footer refresh is what preserves the user's VS Code
      // terminal scroll position on collapse.
      if (!this.ctx.closed && !preservePrimaryDisplay) this.ctx.refresh();
    }
  }

  refreshDisclosureViewer(nodesChanged = false): void {
    if (this.ctx.streams.deferDocumentRefresh(nodesChanged)) return;
    const viewer = this.ctx.disclosureViewer;
    if (!viewer || viewer.closing) return;
    if (viewer.repaintTimer) clearTimeout(viewer.repaintTimer);
    viewer.repaintTimer = undefined;
    try {
      // Keep the canonical document current even while a modal temporarily
      // replaces its pixels. The overlay's close callback refreshes without a
      // `nodesChanged` hint, so deferring this replacement would permanently
      // lose any transcript rows committed during approval/model selection.
      if (nodesChanged) {
        const nodes = disclosureDocumentNodes(
          this.ctx.uiState.transcript,
          this.ctx.retainedReasoningDisclosures,
          this.ctx.streams,
          viewer.state.targetExpanded ? viewer.kind : undefined,
          viewer.state.targetExpanded ? viewer.registryId : undefined,
        );
        const selected = viewer.state.target;
        if (selected && !nodes.some((node) => node.id === selected.id && node.kind === selected.kind)) {
          viewer.state = clearDisclosureViewTarget(viewer.state);
          delete viewer.kind;
          delete viewer.registryId;
        }
        viewer.state = replaceDisclosureViewNodes(viewer.state, nodes);
      }
      if (this.ctx.uiState.overlay) {
        const columns = viewer.state.columns;
        const rows = viewer.state.rows;
        const headerLines = disclosureHeaderLines(this.ctx.uiState, this.ctx.viewOptions(), columns);
        const footerLines = renderFixedBottomRegions(
          this.ctx.uiState,
          { ...this.ctx.viewOptions(), columns, rows },
          Date.now(),
          { totalRows: 1, detailRows: 0 },
        ).lines;
        const overlayRows = Math.max(1, rows - headerLines.length - footerLines.length);
        const overlayText = renderLiveRegion(this.ctx.uiState, Date.now(), {
          ...this.ctx.viewOptions(),
          columns,
          rows: overlayRows,
        });
        const overlayState = createDisclosureViewState({
          nodes: [{ id: "overlay", kind: "text", text: overlayText }],
          columns,
          rows,
          headerLines,
          composerLines: [],
          footerLines,
          preserveAnsi: true,
        });
        viewer.frame = renderDisclosureView(overlayState);
        viewer.writer.render(viewer.frame.rows);
        return;
      }
      viewer.state = updateDisclosureViewChrome(viewer.state, {
        headerLines: disclosureHeaderLines(this.ctx.uiState, this.ctx.viewOptions(), viewer.state.columns),
        composerLines: disclosureComposerLines(
          this.ctx.uiState,
          this.ctx.viewOptions(),
          viewer.state.columns,
          viewer.state.rows,
        ),
      });
      const rendered = renderDisclosureFrameWithPosition(viewer.state, this.ctx.uiState, this.ctx.viewOptions());
      viewer.state = rendered.state;
      viewer.frame = rendered.frame;
      viewer.writer.render(viewer.frame.rows);
    } catch (error) {
      this.ctx.failTerminalUi("conversation renderer", error);
    }
  }

  resizeDisclosureViewer(): void {
    const viewer = this.ctx.disclosureViewer;
    if (!viewer || viewer.closing) return;
    if (viewer.repaintTimer) clearTimeout(viewer.repaintTimer);
    viewer.repaintTimer = undefined;
    viewer.primaryDisplayDirty = true;
    try {
      const columns = this.ctx.physicalColumns();
      const rows = this.ctx.physicalRows();
      if (rows < 9) {
        if (this.ctx.guardedInputActive || this.ctx.uiState.overlay) {
          viewer.writer.resize(columns, rows);
          viewer.writer.render([
            chalk.cyan("EASY CODE"),
            chalk.yellow("Enlarge the terminal to continue this selection."),
          ]);
          return;
        }
        this.closeDisclosureViewer();
        return;
      }
      viewer.writer.resize(columns, rows);
      const headerLines = disclosureHeaderLines(this.ctx.uiState, this.ctx.viewOptions(), columns);
      const composerLines = disclosureComposerLines(this.ctx.uiState, this.ctx.viewOptions(), columns, rows);
      const footerLines = disclosureFooterLines(this.ctx.uiState, this.ctx.viewOptions(), columns, rows, composerLines);
      viewer.state = resizeDisclosureView(viewer.state, columns, rows, {
        headerLines,
        composerLines,
        footerLines,
      });
      if (this.ctx.uiState.overlay) {
        this.refreshDisclosureViewer();
        return;
      }
      const rendered = renderDisclosureFrameWithPosition(viewer.state, this.ctx.uiState, this.ctx.viewOptions());
      viewer.state = rendered.state;
      viewer.frame = rendered.frame;
      viewer.writer.render(viewer.frame.rows);
    } catch (error) {
      this.ctx.failTerminalUi("conversation resize", error);
    }
  }

  /** Accumulate viewport movement immediately, but paint a burst only once. */
  private scheduleDisclosureRepaint(viewer: ActiveDisclosureViewer): void {
    if (viewer.repaintTimer || viewer.closing || this.ctx.disclosureViewer !== viewer) return;
    viewer.repaintTimer = setTimeout(() => {
      viewer.repaintTimer = undefined;
      if (this.ctx.disclosureViewer === viewer && !viewer.closing) this.refreshDisclosureViewer();
    }, 16);
    viewer.repaintTimer.unref();
  }

  private handleDisclosureInput(viewer: ActiveDisclosureViewer, event: Readonly<TuiInputEvent>): void {
    if (event.type === "input-error") {
      this.ctx.writeStableStatus(event.message, "warning");
      return;
    }
    if (event.type === "mouse") {
      const mouse = event;
      if (mouse.action === "wheel-up" || mouse.action === "wheel-down") {
        viewer.state = applyDisclosureViewCommand(viewer.state, {
          type: "scroll-lines",
          lines: mouse.action === "wheel-up" ? -3 : 3,
        });
        this.scheduleDisclosureRepaint(viewer);
        return;
      }
      if (mouse.action !== "press" || mouse.button !== "left") return;
      // Hit testing must use the frame corresponding to the accumulated scroll.
      if (viewer.repaintTimer) this.refreshDisclosureViewer();
      if (this.ctx.disclosureViewer !== viewer) return;
      const row = viewer.frame.visibleRows[mouse.row - 1];
      if (!row || row.part !== "title" || !row.nodeId) return;
      if (row.nodeKind !== "thinking" && row.nodeKind !== "adjustment") return;
      const id = registryIdFromVirtualNode(row.nodeId, row.nodeKind);
      if (id !== undefined) {
        this.toggleDisclosureFromViewer(viewer, row.nodeKind, id);
      }
      return;
    }
    if (event.type === "key" && event.key === "page-up") {
      viewer.state = applyDisclosureViewCommand(viewer.state, {
        type: "page-up",
      });
      this.scheduleDisclosureRepaint(viewer);
      return;
    }
    if (event.type === "key" && (event.key === "up" || event.key === "down")) {
      // DEC alternate-scroll mode translates wheel movement into cursor keys
      // without capturing mouse buttons. Treat those keys as viewport motion
      // while the disclosure owns the screen; native drag selection remains
      // entirely controlled by the terminal.
      viewer.state = applyDisclosureViewCommand(viewer.state, {
        type: "scroll-lines",
        lines: event.key === "up" ? -1 : 1,
      });
      this.scheduleDisclosureRepaint(viewer);
      return;
    }
    if (event.type === "key" && event.key === "page-down") {
      viewer.state = applyDisclosureViewCommand(viewer.state, {
        type: "page-down",
      });
      this.scheduleDisclosureRepaint(viewer);
      return;
    }
    if (event.type === "key" && event.key === "interrupt") {
      if (this.ctx.externalOperationController) {
        if (!this.ctx.externalOperationController.signal.aborted) {
          const error = new Error("External authorization canceled by user");
          error.name = "AbortError";
          this.ctx.externalOperationController.abort(error);
        }
      } else if (this.ctx.currentRequestOptions?.onInterrupt) {
        this.ctx.signalCurrentRequestInterrupt();
      } else {
        this.ctx.activePromptController?.abort();
      }
      return;
    }

    const raw = disclosureEditorInput(event);
    if (!raw) return;
    if (viewer.suspendedSession?.feedInput(raw)) {
      viewer.primaryDisplayDirty = true;
    } else {
      // A session can finish synchronously when Enter is forwarded. The
      // permanent shell remains active while the next idle/busy editor is
      // created and attached to the same viewport.
      if (this.ctx.disclosureViewer === viewer && viewer.sessionReleased) {
        this.refreshDisclosureViewer();
      }
    }
  }

  private toggleDisclosureFromViewer(viewer: ActiveDisclosureViewer, kind: DisclosureKind, id: number): void {
    if (this.ctx.disclosureViewer !== viewer) return;
    this.openDisclosureViewer(kind, id);
  }

  private switchDisclosureViewer(viewer: ActiveDisclosureViewer, kind: DisclosureKind, id: number): boolean {
    if (this.ctx.disclosureViewer !== viewer || !this.disclosureAvailable(kind, id)) {
      return false;
    }
    if (viewer.repaintTimer) clearTimeout(viewer.repaintTimer);
    viewer.repaintTimer = undefined;
    try {
      const target = disclosureTarget(kind, id);
      const sameTarget = viewer.kind === kind && viewer.registryId === id;
      const nextExpanded = sameTarget ? !viewer.state.targetExpanded : true;
      const nodes = disclosureDocumentNodes(
        this.ctx.uiState.transcript,
        this.ctx.retainedReasoningDisclosures,
        this.ctx.streams,
        nextExpanded ? kind : undefined,
        nextExpanded ? id : undefined,
      );
      const selected = viewer.state.target;
      if (selected && !nodes.some((node) => node.id === selected.id && node.kind === selected.kind)) {
        viewer.state = clearDisclosureViewTarget(viewer.state);
      }
      viewer.state = replaceDisclosureViewNodes(viewer.state, nodes);
      viewer.state = toggleDisclosureView(viewer.state, target, nextExpanded);
      viewer.kind = kind;
      viewer.registryId = id;
      if (kind === "thinking" && viewer.state.targetExpanded) {
        const block = this.ctx.reasoning.get(id);
        this.ctx.uiState = applyEvent(this.ctx.uiState, { type: "thinking.hide" });
        if (block) {
          this.ctx.uiState = applyEvent(this.ctx.uiState, {
            type: "thinking.toggle",
            panel: block,
          });
        }
      } else {
        this.ctx.uiState = applyEvent(this.ctx.uiState, { type: "thinking.hide" });
      }
      const rendered = renderDisclosureFrameWithPosition(viewer.state, this.ctx.uiState, this.ctx.viewOptions());
      viewer.state = rendered.state;
      viewer.frame = rendered.frame;
      viewer.writer.render(viewer.frame.rows);
      return true;
    } catch (error) {
      this.ctx.failTerminalUi("disclosure renderer", error);
      return false;
    }
  }

  private scheduleDisclosureInputFlush(viewer: ActiveDisclosureViewer): void {
    if (viewer.idleTimer) clearTimeout(viewer.idleTimer);
    viewer.idleTimer = undefined;
    if (!viewer.input.decoder.awaitingInput) return;
    viewer.idleTimer = setTimeout(() => {
      viewer.idleTimer = undefined;
      if (this.ctx.disclosureViewer !== viewer || viewer.closing) return;
      // Discard an incomplete OSC/paste packet so the next click or wheel
      // packet starts from a clean boundary instead of freezing the viewer.
      const flushed = viewer.input.flushIncomplete();
      for (const event of flushed.events) {
        this.handleDisclosureInput(viewer, event);
        if (this.ctx.disclosureViewer !== viewer) break;
      }
    }, 1_500);
    viewer.idleTimer.unref();
  }

  private disclosureAvailable(kind: DisclosureKind, id: number): boolean {
    const retained = kind === "thinking" ? this.ctx.reasoning.get(id) : this.ctx.adjustments.get(id);
    if (!retained) return false;
    if (kind === "thinking") return this.ctx.retainedReasoningDisclosures.has(`thinking_${id}`);
    return this.ctx.currentTurnDisclosures.some((segment) => segment.adjustment?.id === id);
  }
}
