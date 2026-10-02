import assert from "node:assert/strict";

import {
  MentionIndex,
  mentionReferences,
  mentionSuggestions,
  removeMentionReference,
} from "../src/cli/mention-suggestions.js";
import { describe, it } from "./harness.js";

const FILES = [
  "README.md",
  "package.json",
  "src/app.ts",
  "src/ui/ink/composer.tsx",
  "src/ui/ink/ink-app.tsx",
  "src/ui/store.ts",
  "tests/app.test.ts",
  "docs/with space.md",
];

function suggest(text: string, cursor = text.length) {
  return mentionSuggestions(text, cursor, new MentionIndex(() => FILES));
}

describe("@ file mentions", () => {
  it("lists top-level folders before files for a bare @", () => {
    // docs/ only holds a path with a space, which an @ reference cannot name.
    assert.deepEqual(
      suggest("@").map((item) => item.label),
      ["src/", "tests/", "package.json", "README.md"],
    );
  });

  it("drills into a folder and fills in files with a trailing space", () => {
    assert.deepEqual(
      suggest("look at @src/ui/").map((item) => item.label),
      ["src/ui/ink/", "src/ui/store.ts"],
    );
    const [folder] = suggest("look at @src/u");
    assert.equal(folder?.replacement, "look at @src/ui/");
    assert.equal(folder?.submit, false);

    const [file] = suggest("open @compo");
    assert.equal(file?.label, "src/ui/ink/composer.tsx");
    assert.equal(file?.replacement, "open @src/ui/ink/composer.tsx ");
    assert.equal(file?.cursor, file?.replacement.length);
  });

  it("ranks file-name prefixes, then shallower and shorter paths, before other matches", () => {
    assert.deepEqual(
      suggest("@app").map((item) => item.label),
      ["src/app.ts", "tests/app.test.ts", "src/ui/ink/ink-app.tsx"],
    );
  });

  it("completes a reference in the middle of the draft and keeps the rest", () => {
    const text = "compare @sto and the tests";
    const [item] = suggest(text, "compare @sto".length);
    assert.equal(item?.replacement, "compare @src/ui/store.ts and the tests");
    assert.equal(item?.cursor, "compare @src/ui/store.ts ".length);
  });

  it("ignores e-mail addresses, finished references and paths with spaces", () => {
    assert.deepEqual(suggest("mail me@example"), []);
    assert.deepEqual(suggest("@src/app.ts "), []);
    assert.equal(
      suggest("@with").some((item) => item.label.includes("with space")),
      false,
    );
  });

  it("asks for the workspace listing again while it is still empty", () => {
    let calls = 0;
    const index = new MentionIndex(() => (++calls === 1 ? [] : FILES));
    assert.deepEqual(mentionSuggestions("@READ", 5, index), []);
    assert.equal(mentionSuggestions("@READ", 5, index)[0]?.label, "README.md");
    mentionSuggestions("@pack", 5, index);
    assert.equal(calls, 2);
  });

  it("finds the files and folders a draft references, once each", () => {
    const index = new MentionIndex(() => FILES);
    const text = "Compare @SRC/app.ts with @src/ui/, then @src/app.ts again; @missing.ts and me@example.com stay text.";
    const references = mentionReferences(text, index);
    assert.deepEqual(
      references.map(({ path, directory }) => ({ path, directory })),
      [
        { path: "src/app.ts", directory: false },
        { path: "src/ui", directory: true },
      ],
    );
    // Offsets cover the token as written, without the trailing comma.
    assert.equal(text.slice(references[1]!.start, references[1]!.end), "@src/ui/");
    assert.deepEqual(index.find("./src\\ui\\store.ts"), { path: "src/ui/store.ts", directory: false });
    assert.equal(index.find("src/nothing.ts"), undefined);
  });

  it("removes one reference and the space after it", () => {
    const index = new MentionIndex(() => FILES);
    const text = "open @README.md and @src/app.ts now";
    const [readme, app] = mentionReferences(text, index);
    assert.equal(removeMentionReference(text, readme!), "open and @src/app.ts now");
    assert.equal(removeMentionReference(text, app!), "open @README.md and now");
  });
});
