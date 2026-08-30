#!/usr/bin/env node
/*
 * Scoring rubric for local/factory-bombsite-01-ui-shell.
 *
 * This file lives OUTSIDE environment/, so it never reaches the agent's image:
 * Harbor copies tests/ into the container at /tests when verification starts,
 * after the agent has finished. The instruction describes the goal, never these
 * checks.
 *
 * Gate 4 (Oracle) semantics: task_success is 1.0 only when every check passes.
 * The partial-credit ratio and per-check detail go to metrics.json as a
 * diagnostic. Six-pillar Factory scoring is not attempted here, because the
 * Oracle path produces no Factory run artifacts to score.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const APP = process.env.BENCHMARK_APP_DIR ?? "/app";
const OUT = process.env.BENCHMARK_LOG_DIR ?? "/logs/verifier";

const read = (file) => {
  try {
    return fs.readFileSync(path.join(APP, file), "utf8");
  } catch {
    return "";
  }
};

const run = (command, args) => {
  try {
    execFileSync(command, args, { cwd: APP, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
};

const walk = (dir = APP, acc = []) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else acc.push(path.relative(APP, full).replace(/\\/g, "/"));
  }
  return acc;
};

const files = walk();
const html = read("index.html");
const script = read("script.js");
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

check(
  "every-js-file-parses",
  files.filter((file) => file.endsWith(".js")).every((file) => run("node", ["--check", file])),
  "a JavaScript file no longer parses",
);
check("repo-smoke-check-passes", run("node", ["tests/verify-page.mjs"]), "the repository's own smoke check failed");

const navBlock = /<nav[\s\S]*?<\/nav>/i.exec(html)?.[0] ?? "";
check("nav-is-a-list", /<(ul|ol|menu)[\s>]/i.test(navBlock), "navigation is not a list of section names");

const sectionIds = [...html.matchAll(/<section\s+id="([^"]+)"/g)].map((match) => match[1]);
const hiddenSections = [...html.matchAll(/<section\s+id="[^"]+"[^>]*\bhidden\b[^>]*>/gi)].map((match) => match[0]);
const scriptHidesSections = /\.hidden\s*=|setAttribute\(\s*['"]hidden/.test(script);
check(
  "one-section-visible",
  sectionIds.length >= 3 && (hiddenSections.length >= 1 || scriptHidesSections),
  "sections are not reduced to a single visible surface",
);

const navTargets = [...navBlock.matchAll(/<a\s+href="#([^"]+)"/g)].map((match) => match[1]);
check(
  "nav-links-resolve",
  navTargets.length >= 3 && navTargets.every((target) => sectionIds.includes(target)),
  "navigation links do not point at real sections",
);

const activeMarked =
  /aria-current/i.test(html) ||
  /class="[^"]*\b(active|current|selected)\b/i.test(html) ||
  /<strong>|<b>/i.test(navBlock) ||
  /aria-current|classList|className|active|<strong>|<b>/i.test(script);
check("active-section-distinguishable", activeMarked, "the current section is not distinguishable");

const cssIntroduced =
  files.some((file) => /\.(css|scss|sass|less)$/i.test(file)) ||
  /<style[\s>]/i.test(html) ||
  /\sstyle="[^"]*"/i.test(html) ||
  /stylesheet|cdn\.|unpkg|jsdelivr|fonts\.googleapis/i.test(html);
check("no-css-introduced", !cssIntroduced, "CSS was introduced despite the stated constraint");

check(
  "contact-form-intact",
  ["contact-form", "contact-name", "contact-email", "contact-message"].every((id) => html.includes(`id="${id}"`)) &&
    /contact-form/.test(script) &&
    /mailto|isValidEmail|preventDefault/.test(script),
  "contact form wiring was removed or weakened",
);

check(
  "medical-content-preserved",
  /About/.test(html) && /Services/.test(html) && /Credentials/.test(html) && /Experience/.test(html) && /Contact/.test(html),
  "section content was dropped",
);

check("config-untouched", /finalMerge: required/.test(read(".factory/config.yaml")), ".factory/config.yaml was altered");

const total = checks.length;
const passed = checks.filter((item) => item.ok).length;
const allPassed = total > 0 && passed === total;
const failed = checks.filter((item) => !item.ok);

fs.mkdirSync(OUT, { recursive: true });
const reward = { task_success: allPassed ? 1.0 : 0.0 };
fs.writeFileSync(path.join(OUT, "reward.json"), `${JSON.stringify(reward)}\n`);
fs.writeFileSync(path.join(OUT, "reward.txt"), `${reward.task_success}\n`);
fs.writeFileSync(
  path.join(OUT, "metrics.json"),
  `${JSON.stringify(
    {
      taskId: "local/factory-bombsite-01-ui-shell",
      checksPassed: passed,
      checksTotal: total,
      partialCredit: total ? Number((passed / total).toFixed(4)) : 0,
      failed: failed.map((item) => ({ name: item.name, detail: item.detail })),
      note: "oracle validates task + verifier only; six-pillar Factory scoring applies to agent trials",
    },
    null,
    2,
  )}\n`,
);

for (const item of checks) {
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.ok ? "" : `  - ${item.detail}`}`);
}
console.log(`verifier: ${passed}/${total} checks, task_success=${reward.task_success}`);
process.exit(allPassed ? 0 : 1);
