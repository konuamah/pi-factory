#!/usr/bin/env node
/*
 * Scoring rubric for local/factory-bombsite-07-full-stack-consult.
 *
 * Lives OUTSIDE environment/. The task: the contact form persists successful
 * submissions in localStorage with a running count that survives reload, the
 * page renders visit availability from a NEW data/schedule.js loaded via a
 * plain <script> tag (file://-safe, no fetch/XHR), and every existing behavior
 * + constraint survives. The seeded verify-local-form check FAILS until the
 * work is done, exercising Factory's repair path.
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
const scheduleData = read("data/schedule.js");
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

// Comment-aware source for behavior checks: strip // and /* */ comments so a
// comment that merely mentions "fetch()" (e.g. "no fetch()/XHR is involved")
// cannot false-positive a behavioral check.
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
}
const scriptCode = stripComments(script);
const scheduleCode = stripComments(scheduleData);

// --- the seeded behavioral checks are green (implementation complete) ---
check("local-form-verifier-passes", run("node", ["tests/verify-local-form.mjs"]), "the seeded localStorage/schedule check still fails");
check("repo-smoke-check-passes", run("node", ["tests/verify-page.mjs"]), "the repository's own smoke check failed");

// --- interview decision A1/A2: localStorage running count ---
// Behavior-based and naming-agnostic: any correct implementation may use a
// string key or a named constant, and may call getItem/setItem with either.
check(
  "persists-to-localStorage",
  /localStorage\.(setItem|getItem)/.test(script),
  "no localStorage persistence in script.js",
);
check(
  "increments-and-writes-count",
  (() => {
    const hasSetItem = /localStorage\.setItem/.test(script);
    // Accept any counter shape: a "+= 1" / "++" / "= x + 1" anywhere near
    // localStorage write, OR a variable that is read, incremented, and written.
    // Naming-agnostic (real agents use _n, stored, sent, count, ...).
    const increments = /\+=\s*1|\+\+|=\s*[^;]*\+\s*1\s*;/.test(script);
    const setItemHasCountValue = /setItem\([^)]*(?:count|sent|message|submit|stored|\+)/i.test(script);
    return hasSetItem && (increments || setItemHasCountValue);
  })(),
  "the stored count is not incremented and written back on successful submit",
);
check(
  "reads-stored-count-on-load",
  (() => {
    const hasGetItem = /localStorage\.getItem/.test(script);
    const parses = /parseInt|Number\(|\|\|\s*0|\|\|\s*['"]0/.test(script);
    return hasGetItem && parses;
  })(),
  "the stored count is not read back on load",
);
check(
  "renders-count-in-success",
  /You have sent|You've sent|sent \d|submitted \d|messages? on this device/i.test(script),
  "the success message does not render the running count",
);

// --- interview decision A3: file://-safe schedule data ---
check(
  "schedule-data-file-created",
  fs.existsSync("data/schedule.js"),
  "data/schedule.js was not created",
);
check(
  "schedule-file-is-plain-data",
  (() => {
    // The file must be plain data the page can read synchronously over file://
    // — no fetch/XHR, no module imports, no network. Case-insensitive on the
    // data-key names (officeHours, nextSlots, VISIT_SLOTS, scheduleData, ...).
    const hasData = /hours|slots|schedule|visit|available/.test(scheduleCode.toLowerCase());
    const isPlain = !/fetch\(|xmlhttprequest|import\s+|require\(|module\.exports/.test(scheduleCode);
    return hasData && isPlain;
  })(),
  "data/schedule.js is not plain visit-slot data",
);
check(
  "schedule-loaded-via-script-tag",
  /<script[^>]+src=["']data\/schedule\.js["']/.test(html),
  "data/schedule.js is not included via a plain <script src> tag",
);
check(
  "schedule-rendered-in-about",
  (() => {
    // The schedule data must be rendered into the About area. Accept any
    // naming and either a static placeholder or dynamic append from script.
    const scriptLower = script.toLowerCase();
    const htmlLower = html.toLowerCase();
    const referencesSchedule =
      /visit[-_ ]?schedule|visit[-_ ]?slot|schedule|availability|VISIT_SCHEDULE|doctorSchedule/i.test(script)
      || /\bid="visit[-_ ]?availability"/.test(htmlLower);
    const rendersDynamically =
      /(createelement|appendchild|insertadjacenthtml|innerhtml|textcontent)/.test(script)
      && /about|visit|schedule|availability/i.test(scriptLower);
    return referencesSchedule || rendersDynamically;
  })(),
  "visit availability is not rendered from the schedule data",
);

// --- file:// safety: no async data loading ---
check("no-fetch", !/\bfetch\s*\(/.test(scriptCode + " " + scheduleCode), "fetch() was introduced (breaks file://)");
check("no-xhr", !/XMLHttpRequest|ActiveXObject/.test(scriptCode + " " + scheduleCode), "XMLHttpRequest was introduced (breaks file://)");

// --- shared invariants (all preserved) ---
check(
  "every-js-file-parses",
  files.filter((file) => file.endsWith(".js")).every((file) => run("node", ["--check", file])),
  "a JavaScript file no longer parses",
);
check(
  "contact-form-fields-intact",
  ["contact-form", "contact-name", "contact-email", "contact-message"].every((id) => html.includes(`id="${id}"`)),
  "contact form field ids were removed",
);
check(
  "form-still-validates",
  /isValidEmail/.test(script) && /preventDefault/.test(script),
  "form validation / invalid-input blocking was removed",
);
check(
  "mailto-kept",
  /mailto|action=["']mailto/i.test(html) && /mailto|preventDefault/.test(script),
  "the mailto form action was removed",
);
check(
  "section-toggle-kept",
  /showSection|\.hidden\s*=/.test(script),
  "the section toggling behavior was removed",
);
check(
  "sections-preserved",
  ["about", "services", "credentials", "experience", "contact"].every((id) => html.includes(`id="${id}"`)),
  "a section was dropped",
);
const cssIntroduced =
  files.some((file) => /\.(css|scss|sass|less)$/i.test(file)) ||
  /<style[\s>]/i.test(html) ||
  /\sstyle="[^"]*"/i.test(html) ||
  /stylesheet|cdn\.|unpkg|jsdelivr|fonts\.googleapis/i.test(html);
check("no-css-introduced", !cssIntroduced, "CSS was introduced despite the stated constraint");
check(
  "no-tests-modified",
  (() => {
    // The fixture ships tests/ committed in git (the Docker image runs
    // `git init` at build). Detect agent edits by diffing the working tree
    // against HEAD; when no git repo exists (local pack-test workspace) the
    // check is skipped rather than failed — the real image always has git.
    try {
      const isRepo = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: APP, stdio: "pipe", encoding: "utf8",
      }).trim() === "true";
      if (!isRepo) return true;
      const diff = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "tests/"], {
        cwd: APP, stdio: "pipe", encoding: "utf8",
      });
      return diff.trim().length === 0;
    } catch {
      return true;
    }
  })(),
  "the tests/ directory was modified",
);
check("config-untouched", /finalMerge: required/.test(read(".factory/config.yaml")), ".factory/config.yaml was altered");

const total = checks.length;
const passed = checks.filter((item) => item.ok).length;
const allPassed = total > 0 && passed === total;
const failed = checks.filter((item) => !item.ok);

// --- Scope-handoff diagnostics (never gate task_success) ---
const scopeDiag = { present: false, checks: {} };
const runsDir = path.join(APP, ".factory", "runs");
let latestRunDir = null;
if (fs.existsSync(runsDir)) {
  const dirs = fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(runsDir, entry.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (dirs.length > 0) latestRunDir = dirs[0];
}
if (latestRunDir) {
  scopeDiag.present = true;
  const readRun = (file) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(latestRunDir, file), "utf8"));
    } catch {
      return null;
    }
  };
  const plan = readRun("plan.json");
  const landing = readRun("landing-plan.json");
  const nonGoals = plan?.implementationContract?.nonGoals ?? [];
  scopeDiag.checks = {
    planDeclaresNonGoals: nonGoals.length > 0,
    planTargetFiles: plan?.implementationContract?.targetFiles ?? [],
    planNonGoals: nonGoals.slice(0, 10),
    landingExpectedFiles: landing?.expectedFiles ?? [],
    landingNonGoalHits: (landing?.expectedFiles ?? []).filter((file) =>
      nonGoals.some((nonGoal) => file === nonGoal || file.startsWith(`${nonGoal}/`)),
    ),
  };
}

fs.mkdirSync(OUT, { recursive: true });
const reward = { task_success: allPassed ? 1.0 : 0.0 };
fs.writeFileSync(path.join(OUT, "reward.json"), `${JSON.stringify(reward)}\n`);
fs.writeFileSync(path.join(OUT, "reward.txt"), `${reward.task_success}\n`);
fs.writeFileSync(
  path.join(OUT, "metrics.json"),
  `${JSON.stringify(
    {
      taskId: "local/factory-bombsite-07-full-stack-consult",
      checksPassed: passed,
      checksTotal: total,
      partialCredit: total ? Number((passed / total).toFixed(4)) : 0,
      failed: failed.map((item) => ({ name: item.name, detail: item.detail })),
      scopeHandoff: scopeDiag,
      note: "oracle validates task + verifier only; six-pillar Factory scoring applies to agent trials; scopeHandoff is diagnostic and never gates task_success",
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
