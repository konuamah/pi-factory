#!/usr/bin/env node
// Complexity guard — fails if any function in packages/** exceeds the
// cyclomatic-complexity threshold. Runs in CI on changed code to stop
// high-complexity hotspots from coming back.
//
// Usage:
//   node scripts/complexity-guard.mjs            # default threshold 40
//   node scripts/complexity-guard.mjs --threshold 35
//   node scripts/complexity-guard.mjs --changed-only   # only git-changed files
//
// Exit 0 = pass (all functions at or under threshold), 1 = fail.

import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const THRESHOLD_DEFAULT = 40;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage", ".factory", ".worktrees"]);

function parseArgs(argv) {
  let threshold = THRESHOLD_DEFAULT;
  let changedOnly = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--threshold") threshold = Number.parseInt(argv[i + 1], 10);
    if (argv[i] === "--changed-only") changedOnly = true;
  }
  return { threshold, changedOnly };
}

async function walk(dir, out) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
}

function changedFiles() {
  try {
    const base = process.env.GITHUB_BASE_REF
      ? execSync(`git merge-base origin/${process.env.GITHUB_BASE_REF} HEAD`, { cwd: ROOT }).toString().trim()
      : "HEAD";
    return execSync(`git diff --name-only ${base}`, { cwd: ROOT })
      .toString().split("\n").map((line) => line.trim()).filter(Boolean)
      .filter((line) => line.endsWith(".ts"));
  } catch {
    return [];
  }
}

/**
 * Cyclomatic-ish complexity per function, counted with brace tracking so
 * multi-line signatures and class/object methods are handled correctly.
 * Counts decision points: if/else-if/for/while/catch/switch/case plus
 * && || ?? ?. operators.
 *
 * Detects: function decls (incl. multi-line), arrow consts (incl.
 * single-param and multi-line bodies), async/regular methods (class or
 * object shorthand).
 */
function scoreFile(source) {
  const lines = source.split("\n");
  const functions = [];
  let cur = null;
  const startFn = (name, startLine) => {
    if (cur) functions.push(cur);
    cur = { name, score: 1, inFn: false, depth: 0, startLine };
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // function declarations (may span lines)
    let fm = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_]+)\s*\(/);
    // arrow consts: const f = (a) => { | const f = a => { | const f = async (a) => {
    if (!fm) fm = line.match(/^\s*(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?(?:\s*\([^)]*\)|[A-Za-z0-9_]+)\s*=>/);
    // class / object methods (indented): async foo( | foo(  (shorthand)
    // Negative lookahead excludes control-flow keywords (if/for/while/...) and
    // call expressions (return foo() is not a method definition).
    if (!fm) fm = line.match(/^\s+(?:async\s+)?(?!if\b|for\b|while\b|switch\b|catch\b|return\b|throw\b|new\b|delete\b|typeof\b|instanceof\b|case\b|else\b|do\b|try\b|finally\b|with\b|yield\b|await\b|function\b|const\b|let\b|var\b)([A-Za-z0-9_]+)\s*\(/);
    // async method shorthand in objects (indented, no paren on same line handled above)
    if (fm) {
      startFn(fm[1], i + 1);
      continue;
    }
    if (!cur) continue;
    const opens = (line.match(/{/g) || []).length;
    const closes = (line.match(/}/g) || []).length;
    if (!cur.inFn) {
      if (line.includes("{")) { cur.inFn = true; cur.depth = opens - closes; }
    } else {
      cur.depth += opens - closes;
    }
    if (cur.inFn && !/^\s*[{}]\s*$/.test(line)) {
      cur.score += (line.match(/\b(if|else\s+if|for|while|catch|switch|case)\b/g) || []).length
        + (line.match(/&&|\|\||\?\?|\?\./g) || []).length;
    }
    if (cur.inFn && cur.depth <= 0) { functions.push(cur); cur = null; }
  }
  if (cur) functions.push(cur);
  return functions;
}

async function main() {
  const { threshold, changedOnly } = parseArgs(process.argv.slice(2));
  const files = [];
  if (changedOnly) {
    files.push(...changedFiles().map((f) => path.join(ROOT, f)));
  } else {
    await walk(path.join(ROOT, "packages"), files);
  }

  const over = [];
  let scanned = 0;
  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    for (const fn of scoreFile(source)) {
      scanned += 1;
      if (fn.score > threshold) {
        over.push({ file: path.relative(ROOT, file), ...fn });
      }
    }
  }

  over.sort((a, b) => b.score - a.score);
  if (over.length > 0) {
    console.error(`Complexity guard FAILED (threshold ${threshold}):`);
    for (const fn of over) {
      console.error(`  ${fn.score}  ${fn.file}:${fn.startLine}  ${fn.name}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`Complexity guard PASS: ${scanned} functions in ${files.length} files, none over ${threshold}.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
