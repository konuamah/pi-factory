/*
 * Seeded verification for bombsite-05. Plain node, no DOM.
 *
 * Asserts that script.js personalizes the contact-form success message: it
 * must build the message from the trimmed name field (concatenation with the
 * wording), not hardcode the generic string. A correct implementation passes;
 * an un-personalized one FAILS, which is what exercises Factory's repair path
 * (the run must fix the failing check and retry, not give up).
 */
import fs from "node:fs";

const script = fs.readFileSync("script.js", "utf8");
const failures = [];

const check = (name, condition) => {
  if (!condition) failures.push(name);
};

// The success message must be assembled from the name field value.
check(
  "uses-name-field-value",
  /nameField\.value|name\.value/.test(script),
);
// It must concatenate that value with the existing wording, not replace it.
check(
  "keeps-existing-wording",
  /Message ready|mail client should open/.test(script),
);
// The generic hardcoded message must be gone from the success branch.
check(
  "not-hardcoded-generic",
  !/result\.textContent\s*=\s*['"]Message ready/.test(script),
);

if (failures.length > 0) {
  console.error(`FAIL: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("ok: success message is personalized from the name field");
