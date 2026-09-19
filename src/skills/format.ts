import { parseDocument, stringify } from "yaml";

export const SKILL_DIRECTORY_NAME = ".easy_code_skills";
export const SKILL_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;

export interface SkillMetadata {
  readonly name: string;
  readonly description: string;
}

export function assertSkillName(name: string): void {
  if (!SKILL_NAME_PATTERN.test(name) || name === "trash") {
    throw new Error("Skill name must be 1–64 lowercase letters, digits, underscores or hyphens, starting with a letter");
  }
}

/** Parse only routing metadata; preserve any other frontmatter verbatim. */
export function parseSkillMarkdown(markdown: string, expectedName?: string): SkillMetadata {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(markdown);
  if (!match) throw new Error("SKILL.md requires YAML frontmatter with name and description");
  const document = parseDocument(match[1]!, { uniqueKeys: true });
  if (document.errors.length) throw new Error(`Invalid SKILL.md frontmatter: ${document.errors[0]?.message}`);
  const value = document.toJS();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("SKILL.md frontmatter must be a mapping");
  }
  const fields = value as Record<string, unknown>;
  if (typeof fields.name !== "string") throw new Error("SKILL.md name must be text");
  assertSkillName(fields.name);
  if (expectedName && fields.name !== expectedName) {
    throw new Error("SKILL.md name must match its directory name");
  }
  if (typeof fields.description !== "string" || !fields.description.trim()) {
    throw new Error("SKILL.md description must be non-empty text");
  }
  if (!markdown.slice(match[0].length).trim()) {
    throw new Error("SKILL.md needs workflow instructions after the frontmatter");
  }
  return { name: fields.name, description: fields.description.trim() };
}

export function createSkillMarkdown(name: string, description: string, instructions: string): string {
  assertSkillName(name);
  if (!description.trim() || !instructions.trim()) {
    throw new Error("Skill description and instructions must be non-empty");
  }
  const markdown = `---\n${stringify({ name, description: description.trim() }).trimEnd()}\n---\n\n${instructions.trim()}\n`;
  parseSkillMarkdown(markdown, name);
  return markdown;
}
