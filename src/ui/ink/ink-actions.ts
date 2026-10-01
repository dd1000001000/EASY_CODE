import type { UserSubmission } from "../interaction-port.js";
import type { ComposerDraft } from "./composer.js";
import type { EditorHistory } from "./composer-editor.js";
import type { InkStore } from "./ink-store.js";

/** What the Ink tree may ask of the interaction port; the tree never reaches the Runtime directly. */
export interface InkActions {
  readonly store: InkStore;
  /** Shared by every composer so Up/Down recalls earlier requests across prompts. */
  readonly history: EditorHistory;
  colorEnabled(): boolean;
  /** The draft kept for one prompt or request, so redrawing the screen never loses typed text. */
  draftFor(owner: object): ComposerDraft;
  /** Ctrl+T: print the most recent Thinking block in full. */
  showLatestThinking(): void;
  /** Keep keys typed while no editor is open; backspace (\b) removes the last one. */
  bufferTypeAhead(text: string): void;
  /** Hand buffered keys to a newly opened prompt (empties the buffer). */
  takeTypeAhead(): string;
  /** Resolve the idle `readPrompt`. */
  submitPrompt(submission: UserSubmission): void;
  /** Ctrl+C / Ctrl+D on an empty idle editor: end the session like closing the input. */
  closePrompt(): void;
  /** Queue one steering adjustment for the running request; false when admission is closed. */
  steer(submission: UserSubmission): boolean;
  /** Ctrl+C while a request runs, or an external authorization is pending. */
  interrupt(): void;
  /** Esc / Ctrl+C inside a modal: resolves it as cancelled. */
  cancelModal(): void;
}
