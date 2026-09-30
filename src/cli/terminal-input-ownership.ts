import readline from "node:readline";
import type { UIState } from "../ui/contracts.js";
import type { CurrentRequestOptions } from "../ui/interaction-port.js";
import { ScreenWriter } from "../ui/render/screen-writer.js";
import { applyEvent } from "../ui/store.js";
import { type DisclosureKind } from "./disclosure-render.js";
import {
  PrivateOscInputFilter,
  readPrompt,
  type PromptInput,
  type PromptInputSession,
  type PromptSubmission,
} from "./prompt-input.js";
import type { ActiveDisclosureViewer, BusyInputOwner, StableStatusKind } from "./terminal-types.js";

const INPUT_OWNER_WATCHDOG_INTERVAL_MS = 250;
const INPUT_OWNER_GRACE_MS = 1_500;

/** Live state and callbacks supplied by Terminal. */
export interface TerminalInputOwnershipContext {
  activePromptSession: PromptInputSession | undefined;
  busyInputOwner: BusyInputOwner | undefined;
  busyPromptController: AbortController | undefined;
  busyPromptGeneration: number;
  busyPromptSession: PromptInputSession | undefined;
  readonly closed: boolean;
  readonly composerPromptPrefix: () => string;
  readonly composerPromptSuffix: () => string;
  currentRequestInterruptSignaled: boolean;
  readonly currentRequestOptions: Readonly<CurrentRequestOptions> | undefined;
  readonly disclosureViewer: ActiveDisclosureViewer | undefined;
  readonly failTerminalUi: (stage: string, value: unknown) => void;
  guardedInputActive: boolean;
  readonly info: (text: string) => void;
  readonly inlineShellActive: boolean;
  readonly input: PromptInput;
  inputOwnerMissingSince: number | undefined;
  inputOwnerWatchdog: NodeJS.Timeout | undefined;
  readonly output: NodeJS.WritableStream;
  promptActive: boolean;
  readlineInputFilter: PrivateOscInputFilter | undefined;
  readonly refresh: () => void;
  readonly releaseDisclosurePromptSession: (session: PromptInputSession | undefined) => void;
  readonly resizeDisclosureViewer: () => void;
  rl: readline.Interface | undefined;
  readonly screen: ScreenWriter | undefined;
  readonly setTerminalCursorVisible: (visible: boolean) => void;
  readonly showLatestReasoning: () => boolean;
  readonly showReasoning: (id: number | "last") => boolean;
  readonly startPersistentViewer: (
    promptSession?: PromptInputSession,
    initialDisclosure?: Readonly<{ kind: DisclosureKind; id: number }>,
  ) => boolean;
  readonly steeringAdmissionPaused: boolean;
  steeringDeliveryQueue: Promise<void>;
  uiState: UIState;
  readonly writeStableStatus: (text: string, kind: StableStatusKind) => void;
}

export class TerminalInputOwnership {
  constructor(private readonly ctx: TerminalInputOwnershipContext) {}

  ensureReadline(): readline.Interface {
    if (this.ctx.closed) throw new Error("Terminal input is closed.");
    if (!this.ctx.rl) {
      const inputFilter = new PrivateOscInputFilter(this.ctx.input);
      try {
        // readline enables Raw Mode through the filter. Create it before
        // piping process.stdin so Windows ConPTY never starts a cooked-mode
        // read that would swallow the first arrow keys until Enter arrives.
        const rl = readline.createInterface({
          input: inputFilter,
          output: this.ctx.output,
          terminal: Boolean(this.ctx.input.isTTY) && Boolean((this.ctx.output as NodeJS.WriteStream).isTTY),
        });
        this.ctx.input.pipe(inputFilter);
        this.ctx.rl = rl;
        this.ctx.readlineInputFilter = inputFilter;
      } catch (error) {
        this.ctx.input.unpipe(inputFilter);
        inputFilter.destroy();
        throw error;
      }
    }
    return this.ctx.rl;
  }

  releaseReadlineInput(rl: readline.Interface): void {
    if (this.ctx.rl !== rl) return;
    this.ctx.rl = undefined;
    const inputFilter = this.ctx.readlineInputFilter;
    this.ctx.readlineInputFilter = undefined;
    if (!inputFilter) return;
    this.ctx.input.unpipe(inputFilter);
    if (!inputFilter.destroyed) inputFilter.destroy();
  }

  /**
   * Keep the extension's no-newline protocol responsive while a model
   * request owns the visible composer. All ordinary input is deliberately
   * drained; only Thinking toggles and Ctrl+C have busy-phase semantics.
   */
  startBusyComposer(): void {
    const requestOptions = this.ctx.currentRequestOptions;
    if (
      !requestOptions?.onSteer ||
      this.ctx.steeringAdmissionPaused ||
      this.ctx.busyPromptController ||
      !this.ctx.inlineShellActive ||
      this.ctx.closed ||
      this.ctx.promptActive ||
      this.ctx.guardedInputActive ||
      this.ctx.rl
    ) {
      return;
    }

    const generation = this.ctx.busyPromptGeneration + 1;
    this.ctx.busyPromptGeneration = generation;
    const controller = new AbortController();
    this.ctx.busyPromptController = controller;
    this.ctx.promptActive = true;
    if (!this.ctx.disclosureViewer) this.ctx.screen?.clearLive();
    let ownedSession: PromptInputSession | undefined;

    const pendingCount = (delta: number): void => {
      if (this.ctx.busyPromptGeneration !== generation) return;
      this.ctx.uiState = applyEvent(this.ctx.uiState, {
        type: "composer.patch",
        patch: {
          pendingSubmissions: Math.max(0, this.ctx.uiState.composer.pendingSubmissions + delta),
        },
      });
      this.ctx.refresh();
    };

    const deliver = (submission: Readonly<PromptSubmission>): void => {
      for (const error of submission.pasteErrors) {
        this.ctx.writeStableStatus(`Steering paste failed: ${error}`, "error");
      }
      if (submission.text.trim().length === 0 && submission.images.length === 0) {
        return;
      }
      pendingCount(1);
      const queued = this.ctx.steeringDeliveryQueue
        .catch(() => undefined)
        .then(() => requestOptions.onSteer?.(submission));
      this.ctx.steeringDeliveryQueue = queued.then(
        () => pendingCount(-1),
        (error: unknown) => {
          pendingCount(-1);
          this.ctx.writeStableStatus(
            `Unable to queue steering input: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        },
      );
    };

    void readPrompt({
      input: this.ctx.input as import("./prompt-input.js").PromptInput,
      output: this.ctx.output as import("./prompt-input.js").PromptOutput,
      prompt: this.ctx.composerPromptPrefix(),
      initialImageCount: requestOptions.initialImageCount ?? 0,
      signal: controller.signal,
      captureImage:
        requestOptions.captureImage ??
        (async () => {
          throw new Error("Image steering is unavailable for this request.");
        }),
      captureText: requestOptions.captureText,
      keepOpen: true,
      onSubmit: (submission) => deliver(submission),
      onInterrupt: () => this.signalCurrentRequestInterrupt(),
      onDiscardImages: requestOptions.onDiscardImages,
      renderPrompt: () => this.ctx.composerPromptPrefix(),
      renderBelow: () => this.ctx.composerPromptSuffix(),
      clearOnSubmit: true,
      startSuspended: this.ctx.inlineShellActive,
      onDraftChange: (draft) => {
        if (this.ctx.busyPromptGeneration !== generation || this.ctx.currentRequestOptions !== requestOptions) return;
        this.ctx.uiState = applyEvent(this.ctx.uiState, {
          type: "composer.patch",
          patch: {
            text: draft.text,
            cursor: draft.cursor,
            images: draft.images,
          },
        });
        this.ctx.refresh();
        if (!this.ctx.disclosureViewer) this.ctx.setTerminalCursorVisible(true);
      },
      onSessionReady: (session) => {
        if (!session) {
          // Abort/cleanup can complete after stopBusyComposer advances the
          // generation. The old session must still release its viewer lease;
          // otherwise the next Request editor cannot be claimed synchronously.
          this.ctx.releaseDisclosurePromptSession(ownedSession);
          if (this.ctx.busyPromptSession === ownedSession) {
            this.ctx.busyPromptSession = undefined;
          }
          if (this.ctx.activePromptSession === ownedSession) {
            this.ctx.activePromptSession = undefined;
          }
          return;
        }
        if (this.ctx.busyPromptGeneration !== generation || this.ctx.currentRequestOptions !== requestOptions) {
          throw new Error("The busy Request editor is no longer current.");
        }
        ownedSession = session;
        this.ctx.busyPromptSession = session;
        this.ctx.activePromptSession = session;
        if (this.ctx.inlineShellActive) {
          if (!this.ctx.startPersistentViewer(session) && this.ctx.disclosureViewer) {
            throw new Error("The persistent Request editor could not claim terminal input.");
          }
        } else {
          this.ctx.setTerminalCursorVisible(true);
        }
      },
      onShowThinking: (id) => {
        const shown = id === "last" ? this.ctx.showLatestReasoning() : this.ctx.showReasoning(id);
        if (!shown) this.ctx.info("No Thinking content is available in this thread.");
      },
    })
      .catch((error: unknown) => {
        if (this.ctx.busyPromptGeneration !== generation || this.ctx.closed) return;
        this.ctx.writeStableStatus(
          `Busy input editor failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      })
      .finally(() => {
        if (this.ctx.busyPromptGeneration !== generation) return;
        this.ctx.busyPromptController = undefined;
        if (this.ctx.busyPromptSession === ownedSession) this.ctx.busyPromptSession = undefined;
        if (this.ctx.activePromptSession === ownedSession) this.ctx.activePromptSession = undefined;
        this.ctx.promptActive = false;
        if (this.ctx.currentRequestOptions === requestOptions && !this.ctx.closed) {
          // Preserve Ctrl+C/Thinking controls if the richer editor becomes
          // unavailable on a particular terminal.
          this.startBusyInputOwner();
        }
      });
  }

  stopBusyComposer(): void {
    const controller = this.ctx.busyPromptController;
    const session = this.ctx.busyPromptSession;
    if (!controller && !session) return;
    this.ctx.busyPromptGeneration += 1;
    this.ctx.busyPromptController = undefined;
    this.ctx.busyPromptSession = undefined;
    if (this.ctx.activePromptSession === session) this.ctx.activePromptSession = undefined;
    controller?.abort();
    this.ctx.promptActive = false;
  }

  startBusyInputOwner(): void {
    if (
      this.ctx.busyInputOwner ||
      this.ctx.disclosureViewer ||
      !this.ctx.currentRequestOptions ||
      !this.ctx.inlineShellActive ||
      this.ctx.closed ||
      this.ctx.promptActive ||
      this.ctx.guardedInputActive ||
      this.ctx.rl
    ) {
      return;
    }

    const wasRaw = Boolean(this.ctx.input.isRaw);
    const wasFlowing = this.ctx.input.readableFlowing === true;
    let filter!: PrivateOscInputFilter;
    const onError = (): void => {
      if (this.ctx.busyInputOwner?.filter !== filter) return;
      this.ctx.failTerminalUi("request input owner", new Error("The busy input stream failed."));
    };
    filter = new PrivateOscInputFilter(this.ctx.input, () => {
      if (
        this.ctx.busyInputOwner?.filter !== filter ||
        !this.ctx.currentRequestOptions ||
        this.ctx.guardedInputActive ||
        this.ctx.promptActive ||
        this.ctx.rl
      ) {
        return;
      }
      this.signalCurrentRequestInterrupt();
    });
    this.ctx.busyInputOwner = { filter, wasRaw, wasFlowing, onError };
    filter.on("error", onError);

    try {
      this.ctx.input.setRawMode?.(true);
      this.ctx.input.pipe(filter);
      // The control owner has no downstream UI. Flowing the readable side
      // drains ordinary keys after the filter has inspected controls.
      filter.resume();
      this.ctx.input.resume();
    } catch (error) {
      this.stopBusyInputOwner();
      this.ctx.failTerminalUi("request input owner", error);
    }
  }

  stopBusyInputOwner(): void {
    const owner = this.ctx.busyInputOwner;
    if (!owner) return;
    this.ctx.busyInputOwner = undefined;
    owner.filter.removeListener("error", owner.onError);
    this.ctx.input.unpipe(owner.filter);
    if (!owner.filter.destroyed) owner.filter.destroy();
    try {
      this.ctx.input.setRawMode?.(owner.wasRaw);
    } catch {
      // A disappearing TTY must not prevent the remaining cleanup.
    }
    if (owner.wasFlowing) this.ctx.input.resume();
    else this.ctx.input.pause();
  }

  async withPrivateProtocolFilteredInput<T>(action: (input: PrivateOscInputFilter) => Promise<T>): Promise<T> {
    if (this.ctx.guardedInputActive) {
      throw new Error("A terminal input operation is already active.");
    }

    // A modal selector is another projection inside the permanent shell, not
    // a reason to leave its alternate buffer. Transfer stdin from the shell
    // decoder to the selector while keeping the FullScreenWriter alive. This
    // preserves the viewport and prevents VS Code from following a restored
    // primary-buffer cursor to an unrelated scrollback position.
    const persistentViewer = this.ctx.disclosureViewer;
    if (persistentViewer && !persistentViewer.closing) {
      this.ctx.guardedInputActive = true;
      const wasRaw = Boolean(this.ctx.input.isRaw);
      const wasFlowing = this.ctx.input.readableFlowing === true;
      const inputFilter = new PrivateOscInputFilter(this.ctx.input);
      let pending: Promise<T> | undefined;

      if (persistentViewer.idleTimer) clearTimeout(persistentViewer.idleTimer);
      persistentViewer.idleTimer = undefined;
      persistentViewer.input.decoder.reset();

      try {
        this.ctx.input.pause();
        this.ctx.input.removeListener("data", persistentViewer.onData);
        this.ctx.input.removeListener("error", persistentViewer.onError);
        // `action` installs its selector synchronously and reasserts Raw Mode
        // before its first read. Do not toggle it once here and once there:
        // duplicate Windows console transitions can themselves lose a key.
        pending = action(inputFilter);
        this.ctx.input.pipe(inputFilter);
        this.ctx.input.resume();
        return await pending;
      } finally {
        this.ctx.input.pause();
        this.ctx.input.unpipe(inputFilter);
        if (!inputFilter.destroyed) inputFilter.destroy();
        this.ctx.guardedInputActive = false;

        if (this.ctx.disclosureViewer === persistentViewer && !persistentViewer.closing && !this.ctx.closed) {
          // Modal escape/control fragments belong to the selector and must
          // never become text in the Request editor after ownership returns.
          persistentViewer.input.decoder.reset();
          persistentViewer.suspendedSession?.discardLeadingModalControls();
          this.ctx.input.setRawMode?.(true);
          this.ctx.input.on("data", persistentViewer.onData);
          this.ctx.input.on("error", persistentViewer.onError);
          // A resize may have been deferred while the modal owned stdin.
          // Reconcile physical dimensions only after its filter is detached;
          // if the terminal is now too short, close without dual consumers.
          this.ctx.resizeDisclosureViewer();
          this.ctx.input.resume();
        } else {
          try {
            this.ctx.input.setRawMode?.(wasRaw);
          } catch {
            // A disappearing terminal must not prevent ownership cleanup.
          }
          if (wasFlowing) this.ctx.input.resume();
          else this.ctx.input.pause();
          if (!this.ctx.closed) this.startBusyInputOwner();
        }
      }
    }

    this.ctx.guardedInputActive = true;

    // A busy steering editor is the sole normal stdin owner. Freeze its
    // readline buffer before a modal selector attaches, then restore the same
    // session after the selector has removed every listener. This preserves
    // draft text/images/cursor without ever piping stdin to two consumers.
    const suspendedBusySession = this.ctx.busyPromptSession;
    const busyEditorSuspended = suspendedBusySession?.suspendInput() ?? false;
    if (busyEditorSuspended) {
      if (this.ctx.activePromptSession === suspendedBusySession) {
        this.ctx.activePromptSession = undefined;
      }
      this.ctx.promptActive = false;
    }

    // A command approval normally interrupts the busy request owner. Borrow
    // its already-piped raw input filter instead of tearing process.stdin down
    // and immediately rebuilding it. Rapid raw-mode/pipe transitions can lose
    // the first key on real Windows ConPTY terminals even though PassThrough
    // tests look correct. The modal selector pauses the drain, owns the same
    // filter temporarily, and hands it back after cleanup; extra key repeats
    // are then drained by the busy owner rather than leaking into a later
    // composer.
    const borrowedOwner = this.ctx.busyInputOwner;
    if (borrowedOwner && !borrowedOwner.filter.destroyed) {
      borrowedOwner.filter.pause();
      borrowedOwner.filter.resetPendingInput();
      try {
        return await action(borrowedOwner.filter);
      } finally {
        this.ctx.guardedInputActive = false;
        if (
          this.ctx.busyInputOwner === borrowedOwner &&
          this.ctx.currentRequestOptions &&
          !this.ctx.closed &&
          !borrowedOwner.filter.destroyed
        ) {
          borrowedOwner.filter.resume();
        } else {
          // The request may have been replaced while the modal was open. Its
          // setter cannot start a new owner while guarded input is active, so
          // re-establish the current request's owner after releasing the guard.
          this.startBusyInputOwner();
        }
      }
    }

    this.stopBusyInputOwner();
    const wasRaw = Boolean(this.ctx.input.isRaw);
    const wasFlowing = this.ctx.input.readableFlowing === true;
    const inputFilter = new PrivateOscInputFilter(this.ctx.input);
    let pending: Promise<T> | undefined;
    try {
      // A Windows console read inherits cooked/raw behavior when the read is
      // first issued. Piping before Raw Mode therefore makes the first menu
      // ignore arrows until Enter completes that cooked read. Acquire Raw Mode
      // first, synchronously let the modal install its data listener, and only
      // then start source flow into the filter.
      this.ctx.input.pause();
      if (!wasRaw) this.ctx.input.setRawMode?.(true);
      pending = action(inputFilter);
      this.ctx.input.pipe(inputFilter);
      this.ctx.input.resume();
      return await pending;
    } finally {
      this.ctx.input.pause();
      this.ctx.input.unpipe(inputFilter);
      if (!inputFilter.destroyed) inputFilter.destroy();
      try {
        if (!wasRaw) this.ctx.input.setRawMode?.(false);
      } catch {
        // Input restoration is best effort if the terminal disappeared.
      }
      if (wasFlowing) this.ctx.input.resume();
      this.ctx.guardedInputActive = false;
      if (
        busyEditorSuspended &&
        suspendedBusySession !== undefined &&
        this.ctx.busyPromptSession === suspendedBusySession &&
        this.ctx.currentRequestOptions?.onSteer &&
        !this.ctx.closed
      ) {
        // The overlay cleanup may briefly paint the static busy card through
        // ScreenWriter. Remove it before readline restores its saved rows.
        this.ctx.screen?.clearLive();
        this.ctx.promptActive = true;
        this.ctx.activePromptSession = suspendedBusySession;
        suspendedBusySession.resumeInput({
          discardLeadingModalControls: true,
        });
      } else {
        this.startBusyInputOwner();
      }
    }
  }

  signalCurrentRequestInterrupt(): void {
    if (this.ctx.currentRequestInterruptSignaled) return;
    const interrupt = this.ctx.currentRequestOptions?.onInterrupt;
    if (!interrupt) return;
    this.ctx.currentRequestInterruptSignaled = true;
    interrupt();
  }

  /**
   * Every active request must have exactly one semantic input path (editor,
   * viewer, modal, or the Ctrl+C-only busy owner). Catching a lost hand-off is
   * safer than leaving a live Runtime behind an inert terminal.
   */
  startInputOwnerWatchdog(): void {
    this.stopInputOwnerWatchdog();
    if (!this.ctx.inlineShellActive || !this.ctx.currentRequestOptions || this.ctx.closed) return;
    this.ctx.inputOwnerWatchdog = setInterval(() => {
      if (this.ctx.closed || !this.ctx.currentRequestOptions) {
        this.stopInputOwnerWatchdog();
        return;
      }
      if (this.ctx.guardedInputActive) {
        this.ctx.inputOwnerMissingSince = undefined;
        return;
      }
      const hasOwner = Boolean(
        this.ctx.disclosureViewer || this.ctx.promptActive || this.ctx.busyInputOwner || this.ctx.rl,
      );
      if (hasOwner) {
        this.ctx.inputOwnerMissingSince = undefined;
        if ((this.ctx.disclosureViewer || this.ctx.busyInputOwner) && this.ctx.input.readableFlowing !== true) {
          try {
            this.ctx.input.resume();
          } catch (error) {
            this.ctx.failTerminalUi("input ownership", error);
          }
        }
        return;
      }
      const now = Date.now();
      this.ctx.inputOwnerMissingSince ??= now;
      if (now - this.ctx.inputOwnerMissingSince >= INPUT_OWNER_GRACE_MS) {
        this.ctx.failTerminalUi(
          "input ownership",
          new Error("No terminal input owner remained for the active request."),
        );
      }
    }, INPUT_OWNER_WATCHDOG_INTERVAL_MS);
    this.ctx.inputOwnerWatchdog.unref();
  }

  stopInputOwnerWatchdog(): void {
    if (this.ctx.inputOwnerWatchdog) clearInterval(this.ctx.inputOwnerWatchdog);
    this.ctx.inputOwnerWatchdog = undefined;
    this.ctx.inputOwnerMissingSince = undefined;
  }
}
