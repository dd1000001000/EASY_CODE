"use strict";

// Guards against oversized functions and source files under src/.
//
// Existing offenders are recorded in scripts/size-baseline.json with their current size as a cap.
// A capped entry may shrink but never grow; new offenders fail outright. After splitting an
// offender, run with --update to lower its cap (or drop it once it is within the limit). --update
// never raises a cap or adds an entry, so the baseline can only ratchet down.

const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const MAX_FUNCTION_LINES = 300;
const MAX_FILE_LINES = 2000;
const projectRoot = path.resolve(__dirname, "..");
const sourceRoot = path.join(projectRoot, "src");
const baselinePath = path.join(__dirname, "size-baseline.json");
const excludedFiles = new Set(["src/prompt-bundle/generated.ts"]);

function sourceFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(target));
    else if (/\.(?:ts|vue)$/u.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(target);
  }
  return files;
}

function relativePath(file) {
  return path.relative(projectRoot, file).split(path.sep).join("/");
}

function propertyName(name) {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

/** A stable, line-independent name so that edits elsewhere in a file do not orphan a baseline entry. */
function functionName(node) {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  const own = propertyName(node.name);
  if (own) return own;
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent))
    return propertyName(parent.name) ?? "<anonymous>";
  return "<anonymous>";
}

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function lineCount(source, node) {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
  const end = source.getLineAndCharacterOfPosition(node.getEnd()).line;
  return end - start + 1;
}

function measureFunctions(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const measured = [];
  const seen = new Map();
  const visit = (node, scope) => {
    let childScope = scope;
    if (ts.isClassLike(node)) childScope = [...scope, node.name?.text ?? "<class>"];
    if (isFunctionLike(node)) {
      childScope = [...scope, functionName(node)];
      let key = childScope.join(".");
      const occurrence = (seen.get(key) ?? 0) + 1;
      seen.set(key, occurrence);
      if (occurrence > 1) key = `${key}#${occurrence}`;
      measured.push({ key, lines: lineCount(source, node) });
    }
    ts.forEachChild(node, (child) => visit(child, childScope));
  };
  visit(source, []);
  return measured;
}

function vueScript(text) {
  return /<script\b[^>]*>([\s\S]*?)<\/script>/u.exec(text)?.[1];
}

function measure() {
  const found = [];
  for (const file of sourceFiles(sourceRoot)) {
    const relative = relativePath(file);
    if (excludedFiles.has(relative)) continue;
    const text = fs.readFileSync(file, "utf8");
    const fileLines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    if (fileLines > MAX_FILE_LINES) found.push({ key: relative, kind: "file", lines: fileLines });
    const script = file.endsWith(".vue") ? vueScript(text) : text;
    if (script === undefined) continue;
    for (const fn of measureFunctions(file, script))
      if (fn.lines > MAX_FUNCTION_LINES)
        found.push({ key: `${relative}#${fn.key}`, kind: "function", lines: fn.lines });
  }
  return found;
}

function readBaseline() {
  if (!fs.existsSync(baselinePath)) return {};
  return JSON.parse(fs.readFileSync(baselinePath, "utf8"));
}

function main() {
  const update = process.argv.includes("--update");
  const baseline = readBaseline();
  const found = measure();
  const current = new Map(found.map((item) => [item.key, item]));
  const failures = [];
  const shrinkable = [];

  for (const item of found) {
    const limit = item.kind === "file" ? MAX_FILE_LINES : MAX_FUNCTION_LINES;
    const cap = baseline[item.key];
    if (cap === undefined) failures.push(`${item.key}: ${item.lines} lines exceeds the ${item.kind} limit of ${limit}`);
    else if (item.lines > cap) failures.push(`${item.key}: ${item.lines} lines exceeds its baseline cap of ${cap}`);
    else if (item.lines < cap) shrinkable.push(item.key);
  }
  const resolved = Object.keys(baseline).filter((key) => !current.has(key));

  if (update) {
    const next = {};
    for (const key of Object.keys(baseline).sort()) {
      const item = current.get(key);
      if (item) next[key] = Math.min(baseline[key], item.lines);
    }
    fs.writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`Updated ${relativePath(baselinePath)}: ${Object.keys(next).length} capped entries.`);
  } else {
    for (const key of shrinkable)
      console.log(`note: ${key} is now ${current.get(key).lines} lines; run with --update to lower its cap.`);
    for (const key of resolved) console.log(`note: ${key} is within the limit; run with --update to drop it.`);
  }

  if (failures.length > 0) {
    console.error(
      `Size check failed (functions > ${MAX_FUNCTION_LINES} lines, files > ${MAX_FILE_LINES} lines):\n  ${failures.join("\n  ")}`,
    );
    console.error("Split the code rather than raising a cap.");
    process.exitCode = 1;
    return;
  }
  console.log(`Size check passed (${found.length} baseline offenders within their caps).`);
}

main();
