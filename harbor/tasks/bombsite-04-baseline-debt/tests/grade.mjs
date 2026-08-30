#!/usr/bin/env node
/*
 * Scoring rubric for local/factory-bombsite-04-baseline-debt.
 *
 * Lives OUTSIDE environment/. The task:
 * - the interview scopes the work to the contact form feedback only (success
 *   message more prominent + announced, invalid-input blocking unchanged,
 *   wording unchanged);
 * - the repo contains UNRELATED debt (legacy/old-script.js is broken JS).
 *   The grader enforces the scope boundary: the debt file must be left exactly
 *   as found (still broken), and no unrelated file may be changed.
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

// --- the contact-form feedback change (interview-decided) ---
check("form-result-has-role-status", /id="form-result"[^>]*role="status"/.test(html), "form-result did not get role=status");
check("form-result-has-aria-live", /id="form-result"[^>]*aria-live="polite"/.test(html), "form-result did not get aria-live=polite");
check(
  "success-wording-unchanged",
  /Message ready — your mail client should open to send it/.test(script),
  "the success message wording was changed",
);
check(
  "invalid-input-still-blocked",
  /isValidEmail/.test(script) && /mailto/.test(script) && /preventDefault/.test(script),
  "invalid-input blocking was removed",
);

// --- the scope boundary: unrelated debt preserved ---
check("debt-file-still-present", fs.existsSync(path.join(APP, "legacy", "old-script.js")), "legacy/old-script.js was deleted");
check(
  "debt-still-broken",
  !run("node", ["--check", "legacy/old-script.js"]),
  "the unrelated debt was 'fixed' (out of scope)",
);

// The only allowed change to index.html is the added role/aria-live on
// form-result; removing those must restore the original markup shape.
const withoutAddition = html.replace(/ role="status" aria-live="polite"/g, "");
check(
  "only-form-result-changed-in-html",
  withoutAddition.includes('id="form-result"') && !withoutAddition.includes('role="status"'),
  "index.html changed beyond the form-result element",
);
check(
  "no-new-files",
  files.filter((file) => !["index.html", "script.js", "tests/verify-page.mjs", "legacy/old-script.js", ".factory/config.yaml", ".gitignore", "factory.yaml"].includes(file)).length === 0,
  "a new file was created",
);
// --- shared invariants ---
check("repo-smoke-check-passes", run("node", ["tests/verify-page.mjs"]), "the repository's own smoke check failed");
const cssIntroduced =
  files.some((file) => /\.(css|scss|sass|less)$/i.test(file)) ||
  /<style[\s>]/i.test(html) ||
  /\sstyle="[^"]*"/i.test(html) ||
  /stylesheet|cdn\.|unpkg|jsdelivr|fonts\.googleapis/i.test(html);
check("no-css-introduced", !cssIntroduced, "CSS was introduced despite the stated constraint");

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
      taskId: "local/factory-bombsite-04-baseline-debt",
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
