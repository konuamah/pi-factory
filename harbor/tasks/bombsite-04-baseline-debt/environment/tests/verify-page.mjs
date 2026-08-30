/*
 * Repository smoke check that ships with the task. Plain node, no DOM, no
 * dependencies: it gives Factory's configured `test` command something real to
 * execute, so verification produces evidence instead of an empty set.
 *
 * It asserts structural invariants only — no layout choices — so a correct
 * rework of the navigation still passes.
 */
import fs from "node:fs";

const html = fs.readFileSync("index.html", "utf8");
const failures = [];

const check = (name, condition) => {
  if (!condition) failures.push(name);
};

const sectionIds = [...html.matchAll(/<section\s+id="([^"]+)"/g)].map((match) => match[1]);
const navLinks = [...html.matchAll(/<a\s+href="#([^"]+)"/g)].map((match) => match[1]);

check("page has sections to navigate", sectionIds.length >= 3);
check("every in-page link resolves to a real section", navLinks.every((target) => sectionIds.includes(target)));
check("contact form fields are present", ["contact-form", "contact-name", "contact-email", "contact-message"].every((id) => html.includes(`id="${id}"`)));
check("script.js is referenced", html.includes('src="script.js"'));
check("no CSS files are referenced", !/<link[^>]+stylesheet/i.test(html) && !fs.existsSync("styles.css"));
check("no inline style attributes", !/\sstyle="/i.test(html));
check("no <style> blocks", !/<style/i.test(html));

if (failures.length > 0) {
  console.error(`FAIL: ${failures.join("; ")}`);
  process.exit(1);
}
console.log(`ok: ${sectionIds.length} sections, ${navLinks.length} in-page links`);
