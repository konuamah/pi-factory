#!/usr/bin/env node
/*
 * Scoring rubric for local/factory-bombsite-05-repair-verification.
 *
 * Lives OUTSIDE environment/. The task: the interview decides the contact-form
 * success message must be personalized with the visitor's name, and the seeded
 * verify-personalization check fails until that is done. The run must reach a
 * green verification (recovering via repair if needed), and the interview
 * constraints must hold.
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
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".factory" || entry.name === ".pi") continue;
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

// --- the interview-decided personalization ---
check(
  "success-message-personalized",
  /nameField\.value|\.value/.test(script) && /visitorName|nameField|fullName|userName/.test(script),
  "the success message is not built from the name field",
);
check(
  "existing-wording-kept",
  /Message ready|mail client should open/.test(script),
  "the existing success wording was replaced",
);
check(
  "generic-message-removed",
  !/result\.textContent\s*=\s*['"]Message ready/.test(script),
  "the generic hardcoded message is still the success branch",
);

// --- the seeded check is green (repair succeeded) ---
check("verify-personalization-passes", run("node", ["tests/verify-personalization.mjs"]), "the seeded personalization check still fails");

// --- invalid input still blocked ---
check(
  "invalid-input-still-blocked",
  /isValidEmail/.test(script) && /mailto/.test(script) && /preventDefault/.test(script),
  "invalid-input blocking was removed",
);

// --- shared invariants ---
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
  ["contact-form", "contact-name", "contact-email", "contact-message"].every((id) => html.includes(`id="${id}"`)),
  "contact form fields were removed",
);

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
      taskId: "local/factory-bombsite-05-repair-verification",
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
