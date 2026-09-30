import type { UIProgressItem, UITranscriptEntry, UITranscriptKind } from "../ui/contracts.js";
import { FullScreenWriter, type DisclosureViewFrame, type DisclosureViewState } from "../ui/tui/index.js";
import { type AdjustmentBlock } from "./adjustment.js";
import { type DisclosureKind } from "./disclosure-render.js";
import { PrivateOscInputFilter, type PromptInputSession } from "./prompt-input.js";
import { type ReasoningBlock } from "./reasoning.js";
import { TuiInputCore } from "./tui-input.js";
export interface BusyInputOwner {
  readonly filter: PrivateOscInputFilter;
  readonly wasRaw: boolean;
  readonly wasFlowing: boolean;
  readonly onError: () => void;
}

export interface CurrentTurnDisclosure {
  readonly entry: Readonly<UITranscriptEntry>;
  readonly reasoning?: Readonly<ReasoningBlock>;
  readonly adjustment?: Readonly<AdjustmentBlock>;
}

export interface DeferredTranscriptCommit {
  readonly id?: string;
  text: string;
}

export interface ActiveDisclosureViewer {
  readonly writer: FullScreenWriter;
  readonly input: TuiInputCore;
  state: DisclosureViewState;
  frame: DisclosureViewFrame;
  /** The disclosure currently selected inside the permanent conversation. */
  kind?: DisclosureKind;
  registryId?: number;
  /** Canonical readline editor whose pixels are projected by this view. */
  suspendedSession?: PromptInputSession;
  /** The readline lifecycle ended while its alternate-screen view was open. */
  sessionReleased: boolean;
  readonly wasRaw: boolean;
  readonly wasFlowing: boolean;
  readonly onData: (chunk: Buffer | string) => void;
  readonly onError: (error: Error) => void;
  readonly deferredCommits: DeferredTranscriptCommit[];
  /** Primary prompt/composer changed while hidden by the alternate buffer. */
  primaryDisplayDirty: boolean;
  clearPrimaryOnClose?: boolean;
  idleTimer?: NodeJS.Timeout;
  repaintTimer?: NodeJS.Timeout;
  closing: boolean;
}

export type StableStatusKind = Extract<UITranscriptKind, "info" | "success" | "warning" | "error">;

export type StatusPresentation =
  | { readonly destination: "live"; readonly kind: UIProgressItem["kind"] }
  | { readonly destination: "stable"; readonly kind: StableStatusKind };
