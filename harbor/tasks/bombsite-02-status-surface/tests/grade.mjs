#!/usr/bin/env node
/*
 * Scoring rubric for local/factory-bombsite-02-status-surface.
 *
 * This file lives OUTSIDE environment/, so it never reaches the agent's image.
 * The instruction + interview describe the goal, never these checks.
 *
 * The task: a status surface decided entirely in the interview (Availability
 * heading, id="availability", one-line "Currently accepting new patients",
 * under the nav) must survive into the plan and the implementation. The grader
 * checks the surface exists with the exact interview-decided content, that the
 * rest of the page still works, and that no CSS was introduced.
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

// --- the interview-decided surface ---
check("availability-surface-exists", /id="availability"/.test(html), "the availability surface was not added");
check(
  "availability-heading",
  /<h2[^>]*>Availability<\/h2>/.test(html),
  "the Availability heading is missing or not an h2",
);
check(
  "availability-status-text",
  /Currently accepting new patients/.test(html),
  "the interview-decided status text is missing",
);
const avBlock = /<section[^>]*id="availability"[\s\S]*?<\/section>/i.exec(html)?.[0] ?? "";
check("availability-is-a-section", /^<section/i.test(avBlock), "availability is not a section element");

// --- the shared page invariants ---
check(
  "every-js-file-parses",
  files.filter((file) => file.endsWith(".js")).every((file) => run("node", ["--check", file])),
  "a JavaScript file no longer parses",
);
check("repo-smoke-check-passes", run("node", ["tests/verify-page.mjs"]), "the repository's own smoke check failed");

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
  "existing-sections-preserved",
  ["about", "services", "credentials", "experience", "contact"].every((id) => html.includes(`id="${id}"`)),
  "an existing section was removed",
);

check(
  "availability-above-content",
  (() => {
    const av = html.indexOf('id="availability"');
    const main = html.indexOf("<main");
    return av !== -1 && main !== -1 && av < main;
  })(),
  "availability is not above the main content",
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
      taskId: "local/factory-bombsite-02-status-surface",
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
