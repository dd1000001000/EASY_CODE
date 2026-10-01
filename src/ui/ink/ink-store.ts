import type { ImageAttachment, PlanProposal } from "../../core/types.js";
import type { Language } from "../../i18n/language.js";
import type { UIEvent, UIState } from "../contracts.js";
import type { CurrentRequestOptions, UserSubmission } from "../interaction-port.js";
import { applyEvent, createUIState } from "../store.js";
import type { ApprovalRequest } from "../../core/types.js";

/** An idle `readPrompt` waiting for the user's next message. */
export interface PromptRequest {
  readonly initialImageCount: number;
  readonly captureImage: (index: number, signal?: AbortSignal) => Promise<ImageAttachment>;
  readonly captureText?: (signal?: AbortSignal) => Promise<string | undefined>;
  readonly resolve: (submission: UserSubmission | null) => void;
}

/** The running request whose composer accepts steering adjustments. */
export interface BusyRequest {
  readonly options: Readonly<CurrentRequestOptions>;
  /** Frozen while the final-answer steering barrier or automatic compaction owns the editor. */
  readonly paused: boolean;
}

export interface MenuModal {
  readonly kind: "menu";
  readonly id: string;
  readonly variant: "picker" | "approval" | "plan-review";
  readonly title: string;
  readonly rows: readonly { readonly label: string; readonly detail?: string; readonly disabled?: boolean }[];
  readonly initialIndex: number;
  readonly hint: string;
  readonly request?: Readonly<ApprovalRequest>;
  readonly proposal?: Readonly<PlanProposal>;
  /** Unattended timeout: selects `index` after the user has been idle for `timeoutMs`. */
  readonly idle?: { readonly timeoutMs: number; readonly index: number };
  readonly resolve: (index: number | undefined) => void;
}

export interface SecretModal {
  readonly kind: "secret";
  readonly prompt: string;
  readonly resolve: (value: string | undefined) => void;
}

export interface TextModal {
  readonly kind: "text";
  readonly prompt: string;
  readonly resolve: (value: string | undefined) => void;
}

export type InkModal = MenuModal | SecretModal | TextModal;

export interface InkSnapshot {
  readonly ui: UIState;
  /**
   * Leading transcript entries that can no longer change. They are written once
   * into terminal scrollback; later entries stay in the redrawable region.
   */
  readonly settled: number;
  readonly prompt: PromptRequest | null;
  readonly busy: BusyRequest | null;
  readonly modal: InkModal | null;
  /** Bumped when the display is cleared so the Ink tree restarts with a fresh scrollback. */
  readonly epoch: number;
  /** The live region is being torn down; render nothing so no editor frame lingers in scrollback. */
  readonly closing: boolean;
  readonly language: Language;
  readonly agentConcurrencyLimit: number | undefined;
}

type Listener = () => void;

/**
 * Observable state container behind the Ink tree. React reads it through
 * `useSyncExternalStore`; the interaction port mutates it. UI state itself still
 * goes through the shared pure reducer, so Web and CLI stay one model.
 */
export class InkStore {
  private snapshot: InkSnapshot;
  private readonly listeners = new Set<Listener>();

  constructor(language: Language) {
    this.snapshot = {
      ui: createUIState(),
      settled: 0,
      prompt: null,
      busy: null,
      modal: null,
      epoch: 0,
      closing: false,
      language,
      agentConcurrencyLimit: undefined,
    };
  }

  readonly getSnapshot = (): InkSnapshot => this.snapshot;

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get ui(): UIState {
    return this.snapshot.ui;
  }

  dispatch(event: Readonly<UIEvent>): void {
    this.set({ ui: applyEvent(this.snapshot.ui, event) });
  }

  /** Replace UI state wholesale (display clear, new thread). */
  replaceUi(ui: UIState): void {
    this.set({ ui });
  }

  set(patch: Partial<InkSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}
