import chalk from "chalk";
import readline from "node:readline";
import { formatCommandApprovalPrefix } from "../command/approval.js";
import { sanitizeCommandOutput } from "../command/output-stream.js";
import { readSecretInput } from "../config/secret-input.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ImageAttachment,
  PlanProposal,
  ThinkingEffort,
} from "../core/types.js";
import { redactSensitiveInformation } from "../memory/sensitive.js";
import { sanitizePlanText } from "../plans/plan.js";
import type { UIOverlayState, UIState } from "../ui/contracts.js";
import { DECISION_TIMEOUT_MS } from "../ui/decision-timeout.js";
import type {
  InteractionChoice,
  PlanReviewDecision,
  PlanReviewInputOptions,
  TimedChoiceOptions,
} from "../ui/interaction-port.js";
import { stripAnsi } from "../ui/render/layout.js";
import { ScreenWriter } from "../ui/render/screen-writer.js";
import { applyEvent } from "../ui/store.js";
import { scrollDisclosureViewToEnd } from "../ui/tui/index.js";
import { selectApproval } from "./approval-selector.js";
import { formatSubmittedRequest, formatUserTranscriptEntry, type DisclosureKind } from "./disclosure-render.js";
import { renderMenu, selectMenuIndex, type MenuSelectorOverlay } from "./menu-selector.js";
import {
  selectModel,
  selectProvider,
  selectThinkingEffort,
  type ModelSelectorChoice,
  type ModelSelectorInput,
  type ModelSelectorOutput,
  type ProviderSelectorChoice,
  type ThinkingEffortSelectorChoice,
} from "./model-selector.js";
import {
  PrivateOscInputFilter,
  readPrompt,
  type PromptInput,
  type PromptInputSession,
  type PromptSubmission,
} from "./prompt-input.js";
import { completeSlashCommandPrefix } from "./slash-command.js";
import type { ActiveDisclosureViewer } from "./terminal-types.js";
import { createVsCodeMenuBridge } from "./vscode-menu-bridge.js";

/** Live state and callbacks supplied by Terminal. */
export interface TerminalDecisionsContext {
  readonly recordAcceptedPlanFeedback: (feedback: string) => void;
  activeApprovalController: AbortController | undefined;
  activePromptController: AbortController | undefined;
  activePromptSession: PromptInputSession | undefined;
  readonly busyPromptSession: PromptInputSession | undefined;
  closed: boolean;
  readonly colorEnabled: () => boolean;
  readonly composerPromptPrefix: () => string;
  readonly composerPromptSuffix: () => string;
  readonly disclosureViewer: ActiveDisclosureViewer | undefined;
  readonly freezeCurrentTurnDisclosures: () => void;
  readonly guardedInputActive: boolean;
  readonly info: (text: string) => void;
  readonly inlineShellActive: boolean;
  readonly input: PromptInput;
  readonly isInteractive: () => boolean;
  readonly lastPlan: Readonly<PlanProposal> | undefined;
  readonly output: NodeJS.WritableStream;
  pendingRequestTranscriptStart: number | undefined;
  promptActive: boolean;
  readonly question: (prompt: string) => Promise<string | null>;
  readonly reclaimPersistentViewerInput: () => void;
  readonly refresh: () => void;
  readonly refreshDisclosureViewer: (nodesChanged?: boolean) => void;
  readonly releaseDisclosurePromptSession: (session: PromptInputSession | undefined) => void;
  readonly rl: readline.Interface | undefined;
  readonly screen: ScreenWriter | undefined;
  secretInputActive: boolean;
  readonly setTerminalCursorVisible: (visible: boolean) => void;
  readonly showLatestReasoning: () => boolean;
  readonly showReasoning: (id: number | "last") => boolean;
  readonly startPersistentViewer: (
    promptSession?: PromptInputSession,
    initialDisclosure?: Readonly<{ kind: DisclosureKind; id: number }>,
  ) => boolean;
  uiState: UIState;
  readonly vscodeMenuBridge: ReturnType<typeof createVsCodeMenuBridge>;
  readonly withPrivateProtocolFilteredInput: <T>(action: (input: PrivateOscInputFilter) => Promise<T>) => Promise<T>;
  readonly write: (text: string) => void;
  readonly warning: (text: string) => void;
}

export class TerminalDecisions {
  constructor(private readonly ctx: TerminalDecisionsContext) {}

  async readPrompt(
    prompt: string,
    options: {
      initialImageCount?: number;
      captureImage: (index: number, signal?: AbortSignal) => Promise<ImageAttachment>;
      captureText?: (signal?: AbortSignal) => Promise<string | undefined>;
    },
  ): Promise<PromptSubmission | null> {
    if (this.ctx.closed) return null;
    if (this.ctx.rl || this.ctx.promptActive || this.ctx.guardedInputActive) {
      throw new Error("A terminal prompt is already active.");
    }
    if (
      !(this.ctx.input as NodeJS.ReadStream).isTTY ||
      !(this.ctx.output as NodeJS.WriteStream).isTTY ||
      typeof (this.ctx.input as NodeJS.ReadStream).setRawMode !== "function"
    ) {
      const text = await this.ctx.question(prompt);
      return text === null ? null : { text, images: [], pasteErrors: [] };
    }
    this.ctx.promptActive = true;
    if (this.ctx.inlineShellActive) {
      if (!this.ctx.disclosureViewer) this.ctx.screen?.clearLive();
      this.ctx.uiState = applyEvent(this.ctx.uiState, {
        type: "composer.patch",
        patch: {
          busy: false,
          text: "",
          cursor: 0,
          placeholder: "Type your request…",
          images: [],
        },
      });
    }
    const promptController = new AbortController();
    this.ctx.activePromptController = promptController;
    let ownedSession: PromptInputSession | undefined;
    try {
      const result = await readPrompt({
        input: this.ctx.input as import("./prompt-input.js").PromptInput,
        output: this.ctx.output as import("./prompt-input.js").PromptOutput,
        prompt: this.ctx.inlineShellActive ? this.ctx.composerPromptPrefix() : prompt,
        initialImageCount: options.initialImageCount,
        signal: promptController.signal,
        captureImage: options.captureImage,
        captureText: options.captureText,
        completionProvider: (draft) => completeSlashCommandPrefix(draft.text, draft.cursor),
        startSuspended: this.ctx.inlineShellActive,
        onSessionReady: (session) => {
          if (session) {
            ownedSession = session;
            this.ctx.activePromptSession = session;
            if (this.ctx.inlineShellActive) {
              if (!this.ctx.startPersistentViewer(session) && this.ctx.disclosureViewer) {
                throw new Error("The persistent Request editor could not claim terminal input.");
              }
            } else {
              this.ctx.setTerminalCursorVisible(true);
            }
            return;
          }
          this.ctx.releaseDisclosurePromptSession(ownedSession);
          if (this.ctx.activePromptSession === ownedSession) {
            this.ctx.activePromptSession = undefined;
          }
        },
        onDraftChange: (draft) => {
          if (!this.ctx.inlineShellActive) return;
          this.ctx.uiState = applyEvent(this.ctx.uiState, {
            type: "composer.patch",
            patch: {
              text: draft.text,
              cursor: draft.cursor,
              images: draft.images,
              ...(draft.completionSuffix ? { completionSuffix: draft.completionSuffix } : {}),
            },
          });
          this.ctx.refresh();
          if (!this.ctx.disclosureViewer) this.ctx.setTerminalCursorVisible(true);
        },
        ...(this.ctx.inlineShellActive
          ? {
              renderPrompt: () => this.ctx.composerPromptPrefix(),
              renderBelow: () => this.ctx.composerPromptSuffix(),
              clearOnSubmit: true,
            }
          : {}),
        onShowThinking: (id) => {
          const shown = id === "last" ? this.ctx.showLatestReasoning() : this.ctx.showReasoning(id);
          if (!shown) {
            this.ctx.info(
              id === "last"
                ? "No Thinking content is available in this thread."
                : `Thinking block #${id} is not available in this thread.`,
            );
          }
        },
      });
      if (result === null) this.ctx.closed = true;
      if (this.ctx.inlineShellActive && result !== null) {
        // Close the previous expansion before printing the new input, without
        // revoking retained Thinking links or moving their transcript entries.
        this.ctx.freezeCurrentTurnDisclosures();
        this.ctx.pendingRequestTranscriptStart = this.ctx.uiState.transcript.length;
        this.ctx.uiState = applyEvent(this.ctx.uiState, {
          type: "transcript.append",
          entry: {
            kind: "user",
            text: result.text,
            images: result.images,
          },
        });
        const rendered = `${formatUserTranscriptEntry({
          text: result.text,
          images: result.images,
        })}\n\n`;
        if (this.ctx.disclosureViewer) {
          this.ctx.disclosureViewer.state = scrollDisclosureViewToEnd(this.ctx.disclosureViewer.state);
          this.ctx.disclosureViewer.deferredCommits.push({ text: rendered });
          this.ctx.refreshDisclosureViewer(true);
        } else {
          this.ctx.screen?.commit(rendered);
        }
      }
      return result;
    } finally {
      this.ctx.activePromptSession = undefined;
      if (this.ctx.activePromptController === promptController) {
        this.ctx.activePromptController = undefined;
      }
      this.ctx.promptActive = false;
      this.ctx.reclaimPersistentViewerInput();
      if (!this.ctx.closed) this.ctx.refresh();
    }
  }

  async selectProvider(
    choices: readonly ProviderSelectorChoice[],
    initialProvider: ProviderSelectorChoice["provider"],
  ): Promise<ProviderSelectorChoice["provider"] | undefined> {
    if (this.ctx.closed) return Promise.resolve(undefined);
    if (this.ctx.rl || this.ctx.promptActive || this.ctx.guardedInputActive)
      throw new Error("Provider selection cannot start while a prompt is active.");
    return this.ctx.withPrivateProtocolFilteredInput((input) =>
      selectProvider(choices, {
        input: input as ModelSelectorInput,
        output: this.ctx.output as ModelSelectorOutput,
        initialProvider,
        color: this.ctx.colorEnabled(),
        ...(this.ctx.inlineShellActive
          ? {
              overlay: this.menuOverlay("provider-picker", "picker"),
              ...(this.ctx.vscodeMenuBridge ? { navigation: this.ctx.vscodeMenuBridge } : {}),
            }
          : {}),
      }),
    );
  }

  async selectModel(
    providerName: string,
    choices: readonly ModelSelectorChoice[],
    initialModel?: string,
  ): Promise<string | undefined> {
    if (this.ctx.closed) return Promise.resolve(undefined);
    if (this.ctx.rl || this.ctx.promptActive || this.ctx.guardedInputActive)
      throw new Error("Model selection cannot start while a prompt is active.");
    return this.ctx.withPrivateProtocolFilteredInput((input) =>
      selectModel(providerName, choices, {
        input: input as ModelSelectorInput,
        output: this.ctx.output as ModelSelectorOutput,
        initialModel,
        color: this.ctx.colorEnabled(),
        ...(this.ctx.inlineShellActive
          ? {
              overlay: this.menuOverlay("model-picker", "picker"),
              ...(this.ctx.vscodeMenuBridge ? { navigation: this.ctx.vscodeMenuBridge } : {}),
            }
          : {}),
      }),
    );
  }

  async selectThinkingEffort(
    providerName: string,
    model: string,
    choices: readonly ThinkingEffortSelectorChoice[],
    initialEffort: ThinkingEffort,
  ): Promise<ThinkingEffort | undefined> {
    if (this.ctx.closed) return Promise.resolve(undefined);
    if (this.ctx.rl || this.ctx.promptActive || this.ctx.guardedInputActive)
      throw new Error("Thinking effort selection cannot start while a prompt is active.");
    return this.ctx.withPrivateProtocolFilteredInput((input) =>
      selectThinkingEffort(providerName, model, choices, {
        input: input as ModelSelectorInput,
        output: this.ctx.output as ModelSelectorOutput,
        initialEffort,
        color: this.ctx.colorEnabled(),
        ...(this.ctx.inlineShellActive
          ? {
              overlay: this.menuOverlay("thinking-picker", "picker"),
              ...(this.ctx.vscodeMenuBridge ? { navigation: this.ctx.vscodeMenuBridge } : {}),
            }
          : {}),
      }),
    );
  }

  async readSecret(prompt: string): Promise<string> {
    if (this.ctx.closed) return Promise.reject(new Error("Terminal input is closed."));
    if (this.ctx.rl || this.ctx.promptActive || this.ctx.guardedInputActive || this.ctx.secretInputActive)
      throw new Error("Secret input must be read before the prompt is opened.");
    this.ctx.secretInputActive = true;
    if (this.ctx.inlineShellActive) this.ctx.screen?.clearLive();
    try {
      return await this.ctx.withPrivateProtocolFilteredInput((input) =>
        readSecretInput(input as ModelSelectorInput, this.ctx.output, prompt),
      );
    } finally {
      this.ctx.secretInputActive = false;
      // readSecretInput necessarily writes masked input directly. When the
      // permanent frame owns the alternate buffer, force a cache-invalidating
      // repaint so those direct pixels cannot remain embedded in the UI.
      const viewer = this.ctx.disclosureViewer;
      if (viewer && !viewer.closing) viewer.writer.clear();
      this.ctx.refresh();
    }
  }

  async approve(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (request.signal?.aborted) return "reject";
    // Background approvals share the parent's UI even when the main agent has
    // returned to its editable prompt. Preserve its draft and transfer stdin.
    while (!this.ctx.closed && this.ctx.guardedInputActive && !request.signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (this.ctx.closed || request.signal?.aborted) return "reject";
    const idleSession = request.source && !this.ctx.busyPromptSession ? this.ctx.activePromptSession : undefined;
    if (idleSession && idleSession.suspendInput()) {
      this.ctx.activePromptSession = undefined;
      this.ctx.promptActive = false;
      try {
        return await this.approve(request);
      } finally {
        if (!this.ctx.closed) {
          this.ctx.activePromptSession = idleSession;
          this.ctx.promptActive = true;
          idleSession.resumeInput({ discardLeadingModalControls: true });
        }
      }
    }
    const title = redactSensitiveInformation(sanitizeCommandOutput(request.title)).replace(/\s+/gu, " ").trim();
    const description = redactSensitiveInformation(sanitizeCommandOutput(request.description));
    const preview = request.commandPreview
      ? redactSensitiveInformation(sanitizeCommandOutput(request.commandPreview)).replace(/[\r\n]+/gu, " ")
      : undefined;
    // Approval is a security decision. Its complete description and resolved
    // command are durable scrollback; the bounded selector card below is only
    // a navigation aid and must never be the sole copy the user can inspect.
    this.ctx.write(
      chalk.yellow(`\nApproval required: ${title}\n`) +
        `${description}\n` +
        (request.network
          ? `Network effect: ${request.network.effect}; destination: ${sanitizeCommandOutput(request.network.destination ?? "resolved when the command connects")}\n`
          : "") +
        (request.network
          ? `Optional saved grant scope: ${sanitizeCommandOutput(formatCommandApprovalPrefix(request.commandPrefix))}\n`
          : "") +
        (preview ? chalk.gray(`Command: ${preview}\n`) : ""),
    );

    if (
      this.ctx.closed ||
      !this.ctx.isInteractive() ||
      this.ctx.rl ||
      (this.ctx.promptActive && !this.ctx.busyPromptSession) ||
      this.ctx.guardedInputActive
    ) {
      return "reject";
    }
    const controller = new AbortController();
    this.ctx.activeApprovalController = controller;
    const onRequestAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onRequestAbort, { once: true });
    if (request.signal?.aborted) controller.abort();
    try {
      return await this.ctx.withPrivateProtocolFilteredInput((input) =>
        selectApproval(request.commandPrefix, {
          signal: controller.signal,
          input: input as ModelSelectorInput,
          output: this.ctx.output as ModelSelectorOutput,
          color: this.ctx.colorEnabled(),
          ...(this.ctx.inlineShellActive
            ? {
                overlay: this.menuOverlay(request.id, "approval", request),
                ...(this.ctx.vscodeMenuBridge ? { navigation: this.ctx.vscodeMenuBridge } : {}),
              }
            : {}),
        }),
      );
    } catch {
      return "reject";
    } finally {
      request.signal?.removeEventListener("abort", onRequestAbort);
      if (this.ctx.activeApprovalController === controller) this.ctx.activeApprovalController = undefined;
    }
  }

  async reviewPlan(options: Readonly<PlanReviewInputOptions> = {}): Promise<PlanReviewDecision> {
    if (!this.ctx.isInteractive()) return { action: "defer" };
    const plan = options.plan ?? this.ctx.lastPlan;
    if (
      plan &&
      this.ctx.input.isTTY &&
      (this.ctx.output as NodeJS.WriteStream).isTTY &&
      typeof this.ctx.input.setRawMode === "function"
    ) {
      const choices = ["Yes, use Auto mode", "No, reject plan", "Adjust plan with feedback"];
      const selection = await this.ctx.withPrivateProtocolFilteredInput((input) =>
        selectMenuIndex(
          choices.length,
          0,
          (selectedIndex) => renderMenu("Review proposed plan", choices, selectedIndex, this.ctx.colorEnabled()),
          {
            input,
            output: this.ctx.output as ModelSelectorOutput,
            color: this.ctx.colorEnabled(),
            idleTimeoutMs: options.idleTimeoutMs ?? DECISION_TIMEOUT_MS,
            idleSelectionIndex: 0,
            ...(this.ctx.inlineShellActive ? { overlay: this.menuOverlay(plan.id, "plan-review", plan) } : {}),
            ...(this.ctx.vscodeMenuBridge ? { navigation: this.ctx.vscodeMenuBridge } : {}),
          },
          "No plan review choices are available.",
        ),
      );
      if (selection === undefined) return { action: "defer" };
      if (selection === 0) return { action: "approve" };
      if (selection === 1) return { action: "reject" };
      const feedback = await this.planTextQuestion("Plan feedback > ", options.captureText);
      if (feedback === null) return { action: "defer" };
      const sanitized = sanitizePlanText(feedback);
      if (!sanitized) return { action: "defer" };
      this.ctx.recordAcceptedPlanFeedback(sanitized);
      return { action: "adjust", feedback: sanitized };
    }
    while (!this.ctx.closed) {
      this.ctx.write("\nWhat would you like to do?\n\n");
      this.ctx.write("1. Yes, use Auto mode\n");
      this.ctx.write("2. No, reject plan\n");
      this.ctx.write("3. Type feedback and press Enter to adjust the plan\n\n");
      const response = await this.planTextQuestion("Choose 1/2, or type feedback to adjust > ", options.captureText);
      if (response === null) return { action: "defer" };
      const answer = sanitizePlanText(response);
      if (!answer) continue;
      const normalized = answer.toLowerCase();
      if (normalized === "1" || normalized === "y" || normalized === "yes") {
        return { action: "approve" };
      }
      if (normalized === "2" || normalized === "n" || normalized === "no") {
        return { action: "reject" };
      }
      if (normalized === "3") {
        const feedback = await this.planTextQuestion("Plan feedback > ", options.captureText);
        if (feedback === null) return { action: "defer" };
        const sanitized = sanitizePlanText(feedback);
        if (!sanitized) continue;
        this.ctx.recordAcceptedPlanFeedback(sanitized);
        return { action: "adjust", feedback: sanitized };
      }
      this.ctx.recordAcceptedPlanFeedback(answer);
      return { action: "adjust", feedback: answer };
    }
    return { action: "defer" };
  }

  async selectChoice(
    title: string,
    choices: readonly InteractionChoice[],
    initialId?: string,
    timed?: Readonly<TimedChoiceOptions>,
  ): Promise<string | undefined> {
    if (this.ctx.closed || choices.length === 0) return undefined;
    if (
      !this.ctx.isInteractive() ||
      (this.ctx.promptActive && !this.ctx.busyPromptSession) ||
      this.ctx.guardedInputActive
    ) {
      return undefined;
    }
    const initialIndex = Math.max(
      0,
      choices.findIndex((choice) => choice.id === initialId),
    );
    const selection = await this.ctx.withPrivateProtocolFilteredInput((input) =>
      selectMenuIndex(
        choices.length,
        initialIndex,
        (selectedIndex) =>
          renderMenu(
            title,
            choices.map((choice) => `${choice.label}${choice.detail ? `  [${choice.detail}]` : ""}`),
            selectedIndex,
            this.ctx.colorEnabled(),
            512,
          ),
        {
          input,
          output: this.ctx.output as ModelSelectorOutput,
          color: this.ctx.colorEnabled(),
          ...(timed?.signal ? { signal: timed.signal } : {}),
          ...(timed
            ? {
                idleTimeoutMs: timed.idleTimeoutMs,
                idleSelectionIndex: choices.findIndex((choice) => choice.id === timed.idleChoiceId && !choice.disabled),
              }
            : {}),
          ...(this.ctx.inlineShellActive
            ? {
                overlay: this.menuOverlay(`choice-${Date.now()}`, "picker"),
                ...(this.ctx.vscodeMenuBridge ? { navigation: this.ctx.vscodeMenuBridge } : {}),
              }
            : {}),
        },
        `No choices are available for ${title}.`,
      ),
    );
    const choice = selection === undefined ? undefined : choices[selection];
    return choice?.disabled ? undefined : choice?.id;
  }

  private menuOverlay(
    id: string,
    kind: UIOverlayState["kind"],
    payload?: Readonly<ApprovalRequest> | Readonly<PlanProposal>,
  ): MenuSelectorOverlay {
    return {
      render: (lines) => {
        // A picker has no text caret. Hide the physical cursor before painting
        // it so ScreenWriter's live-region anchor is not exposed as a white
        // block/dot inside Progress when the VS Code terminal loses focus.
        this.ctx.setTerminalCursorVisible(false);
        const plain = lines.map((line) => stripAnsi(line));
        const renderedRows = plain.slice(1, -1);
        const selectedIndex = Math.max(
          0,
          renderedRows.findIndex((line) => /^\s*›/u.test(line)),
        );
        const rows = renderedRows.map((line, index) => ({
          id: `${id}-${index}`,
          label: line.replace(/^\s*[› ]\s?/u, "").trim(),
        }));
        const common = {
          id,
          title: plain[0]?.trim() || "Select",
          rows,
          selectedIndex,
          hint: plain[plain.length - 1]?.trim() || "Use ↑/↓ to move, Enter to confirm, or Esc to cancel",
        };
        let overlay: UIOverlayState;
        if (kind === "approval") {
          overlay = {
            ...common,
            kind,
            request: payload as Readonly<ApprovalRequest>,
          };
        } else if (kind === "plan-review") {
          overlay = {
            ...common,
            kind,
            proposal: payload as Readonly<PlanProposal>,
          };
        } else {
          overlay = { ...common, kind: "picker" };
        }
        this.ctx.uiState = applyEvent(this.ctx.uiState, {
          type: "overlay.show",
          overlay,
        });
        this.ctx.refresh();
      },
      clear: () => {
        this.ctx.uiState = applyEvent(this.ctx.uiState, {
          type: "overlay.hide",
          id,
        });
        this.ctx.refresh();
      },
    };
  }

  /**
   * Read text that may contain a bracketed multiline paste. Plain readline
   * treats every pasted newline as an immediate submission, so plan feedback
   * must use the same atomic paste transport as the main composer. Images are
   * intentionally rejected here; the optional clipboard-text fallback keeps
   * native paste shortcuts useful across supported terminals.
   */
  private async multilineTextQuestion(
    prompt: string,
    captureText?: PlanReviewInputOptions["captureText"],
  ): Promise<Pick<PromptSubmission, "text" | "pasteErrors"> | null> {
    if (this.ctx.closed) return null;
    if (this.ctx.rl || this.ctx.promptActive || this.ctx.guardedInputActive) {
      throw new Error("A terminal prompt is already active.");
    }
    if (!this.ctx.input.isTTY || !(this.ctx.output as NodeJS.WriteStream).isTTY) {
      const text = await this.ctx.question(prompt);
      return text === null ? null : { text, pasteErrors: [] };
    }
    if (typeof this.ctx.input.setRawMode !== "function") {
      this.ctx.warning("Multiline plan feedback requires terminal Raw Mode support.");
      return null;
    }

    if (this.ctx.inlineShellActive) {
      if (!this.ctx.disclosureViewer) this.ctx.screen?.clearLive();
      this.ctx.uiState = applyEvent(this.ctx.uiState, {
        type: "composer.patch",
        patch: {
          busy: false,
          text: "",
          cursor: 0,
          placeholder: prompt.trim() || "Plan feedback…",
          images: [],
        },
      });
    }
    this.ctx.promptActive = true;
    const promptController = new AbortController();
    this.ctx.activePromptController = promptController;
    let ownedSession: PromptInputSession | undefined;
    try {
      const result = await readPrompt({
        input: this.ctx.input,
        output: this.ctx.output as import("./prompt-input.js").PromptOutput,
        prompt: this.ctx.inlineShellActive ? this.ctx.composerPromptPrefix() : prompt,
        signal: promptController.signal,
        captureImage: async () => {
          throw new Error("Images are not supported in plan feedback.");
        },
        captureText,
        textOnlyPaste: true,
        clearOnSubmit: this.ctx.inlineShellActive,
        startSuspended: this.ctx.inlineShellActive,
        onSessionReady: (session) => {
          if (session) {
            ownedSession = session;
            this.ctx.activePromptSession = session;
            if (this.ctx.inlineShellActive && !this.ctx.startPersistentViewer(session) && this.ctx.disclosureViewer) {
              throw new Error("The persistent Request editor could not claim terminal input.");
            }
            return;
          }
          this.ctx.releaseDisclosurePromptSession(ownedSession);
          if (this.ctx.activePromptSession === ownedSession) {
            this.ctx.activePromptSession = undefined;
          }
        },
        onDraftChange: (draft) => {
          if (!this.ctx.inlineShellActive) return;
          this.ctx.uiState = applyEvent(this.ctx.uiState, {
            type: "composer.patch",
            patch: {
              text: draft.text,
              cursor: draft.cursor,
              images: [],
            },
          });
          this.ctx.refresh();
        },
        ...(this.ctx.inlineShellActive
          ? {
              renderPrompt: () => this.ctx.composerPromptPrefix(),
              renderBelow: () => this.ctx.composerPromptSuffix(),
            }
          : {}),
      });
      if (result === null) {
        this.ctx.closed = true;
        return null;
      }
      return { text: result.text, pasteErrors: result.pasteErrors };
    } finally {
      this.ctx.activePromptSession = undefined;
      if (this.ctx.activePromptController === promptController) {
        this.ctx.activePromptController = undefined;
      }
      this.ctx.promptActive = false;
      this.ctx.reclaimPersistentViewerInput();
      if (!this.ctx.closed) this.ctx.refresh();
    }
  }

  private async planTextQuestion(
    prompt: string,
    captureText?: PlanReviewInputOptions["captureText"],
  ): Promise<string | null> {
    while (!this.ctx.closed) {
      const submission = await this.multilineTextQuestion(prompt, captureText);
      if (submission === null) return null;
      if (submission.pasteErrors.length === 0) return submission.text;
      this.ctx.warning(`Plan feedback paste failed: ${submission.pasteErrors.join("; ")}`);
    }
    return null;
  }

  recordAcceptedPlanFeedback(feedback: string): void {
    if (!this.ctx.inlineShellActive) return;
    this.ctx.freezeCurrentTurnDisclosures();
    // The next executePrompt receives an internal plan-revision instruction,
    // but the user-authored feedback is the actual request row for the turn.
    // Mark it as pending so setCurrentRequest neither excludes it nor exposes
    // the internal control prompt in the disclosure transcript.
    this.ctx.pendingRequestTranscriptStart = this.ctx.uiState.transcript.length;
    this.ctx.uiState = applyEvent(this.ctx.uiState, {
      type: "transcript.append",
      entry: {
        kind: "user",
        text: feedback,
        images: [],
      },
    });
    const rendered = `${formatSubmittedRequest(feedback)}\n\n`;
    if (this.ctx.disclosureViewer) {
      this.ctx.disclosureViewer.state = scrollDisclosureViewToEnd(this.ctx.disclosureViewer.state);
      this.ctx.disclosureViewer.deferredCommits.push({ text: rendered });
      this.ctx.refreshDisclosureViewer(true);
    } else {
      this.ctx.screen?.commit(rendered);
    }
  }
}
