"use strict";

/**
 * Serialize asynchronous paste commands independently for each terminal.
 *
 * VS Code may invoke the same keybinding again before an earlier command has
 * finished probing the clipboard. Keeping a settled tail per terminal avoids
 * concurrent platform helpers and duplicate private paste events without
 * making unrelated terminals wait for one another.
 *
 * @returns {{
 *   enqueue<T>(terminal: object, task: () => Promise<T> | T): Promise<T>
 * }}
 */
function createTerminalPasteQueue() {
  /** @type {WeakMap<object, Promise<void>>} */
  const tails = new WeakMap();

  return {
    enqueue(terminal, task) {
      if (
        (typeof terminal !== "object" && typeof terminal !== "function") ||
        terminal === null
      ) {
        return Promise.reject(new TypeError("A terminal object is required."));
      }
      if (typeof task !== "function") {
        return Promise.reject(new TypeError("A paste task function is required."));
      }

      const previous = tails.get(terminal) ?? Promise.resolve();
      const execution = previous.then(() => task());
      // Store a tail that always fulfills. A failed clipboard operation is
      // still returned to its caller, but can never poison later paste work.
      const settledTail = execution.then(
        () => undefined,
        () => undefined,
      );
      tails.set(terminal, settledTail);
      void settledTail.then(() => {
        if (tails.get(terminal) === settledTail) tails.delete(terminal);
      });
      return execution;
    },
  };
}

module.exports = {
  createTerminalPasteQueue,
};
