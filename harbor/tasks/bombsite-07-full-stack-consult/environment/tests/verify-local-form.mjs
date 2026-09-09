/*
 * Seeded behavioral check for bombsite-07. Plain node, no DOM.
 *
 * FAILS until the contact form stores successful submissions in localStorage
 * and the page renders a running count, AND the page loads visit-slot data
 * from data/schedule.js via a plain <script> tag (no fetch/XHR, so it works
 * when the page is opened straight from disk over file://).
 *
 * A correct implementation passes; an incomplete one FAILS, exercising
 * Factory's repair path (the run must fix the failing check and retry).
 */
import fs from "node:fs";

const script = fs.readFileSync("script.js", "utf8");
const html = fs.readFileSync("index.html", "utf8");
const failures = [];

const check = (name, condition) => {
  if (!condition) failures.push(name);
};

// --- localStorage persistence of successful submissions ---
check(
  "uses-localStorage",
  /localStorage/.test(script),
);
// Reads back a stored count (not just writes blindly).
check(
  "reads-back-count",
  /localStorage\.getItem/.test(script) && /parseInt|Number\(|>>|~~/.test(script),
);
// The count is rendered into the page (a target element or result text).
check(
  "renders-count",
  /textContent|innerText|\.value/.test(script) && /count|messages|visits|submitted/i.test(script),
);

// --- file://-safe data load (no fetch / XHR) ---
check(
  "no-fetch",
  !/\bfetch\s*\(/.test(script),
);
check(
  "no-xhr",
  !/XMLHttpRequest|ActiveXObject/.test(script),
);
check(
  "schedule-data-script-included",
  /<script[^>]+src=["']data\/schedule\.js/.test(html),
);
check(
  "schedule-data-file-created",
  fs.existsSync("data/schedule.js"),
);

if (failures.length > 0) {
  console.error(`FAIL: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("ok: local form persistence and file://-safe schedule data are present");
