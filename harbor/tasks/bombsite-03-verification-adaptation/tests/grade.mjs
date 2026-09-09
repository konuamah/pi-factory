#!/usr/bin/env node
/*
 * Scoring rubric for local/factory-bombsite-03-verification-adaptation.
 *
 * Lives OUTSIDE environment/ so the agent never sees it. The task:
 * - the interview decides three credentials (M.D., University of Ghana Medical
 *   School; Board Certified, Family Medicine; 12 years of clinical experience)
 *   in a ul under the Experience heading, and they must survive to the build;
 * - the fixture's configured lint command is STALE (node tools/lint.mjs, which
 *   does not exist). The agent must adapt around it: the repo still has to be
 *   green (script.js parses, smoke test passes) without blindly running the
 *   broken lint or inventing an ungrounded replacement.
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

// --- the interview-decided credentials ---
const three = [
  "M.D., University of Ghana Medical School",
  "Board Certified, Family Medicine",
  "12 years of clinical experience",
];
check(
  "all-three-credentials-present",
  three.every((credential) => html.includes(credential)),
  "not all interview-decided credentials are present",
);

const expStart = html.indexOf('id="experience"');
const expEnd = expStart === -1 ? -1 : html.indexOf("</section>", expStart);
const expBlock = expStart !== -1 && expEnd !== -1 ? html.slice(expStart, expEnd) : "";
check(
  "credentials-inside-experience",
  three.every((credential) => expBlock.includes(credential)),
  "a credential is outside the Experience section",
);
check("credentials-are-a-list", /<ul>/.test(expBlock), "credentials are not in a list (ul)");

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

// --- verification adaptation: the stale lint must not have been blindly kept ---
// The configured lint points at tools/lint.mjs which does not exist. A correct
// adaptation keeps the repo green anyway. (The repo's real smoke check above
// already proves greenness; this just asserts the agent did not leave a broken
// tools/ dir or a config that still can't run.)
check("no-ghost-lint-target", !fs.existsSync(path.join(APP, "tools", "lint.mjs")), "tools/lint.mjs still does not exist and was not created");

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
      taskId: "local/factory-bombsite-03-verification-adaptation",
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
