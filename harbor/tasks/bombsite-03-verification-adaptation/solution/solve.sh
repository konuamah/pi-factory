#!/bin/bash
# Reference solution for local/factory-bombsite-03-verification-adaptation.
# Adds the interview-decided Credentials highlights under the Experience
# section, keeping the repo green. The stale configured lint (node tools/lint.mjs)
# does not exist here, so this reference checks syntax with node --check directly
# and runs the repo's real smoke test.
set -euo pipefail
cd "${BENCHMARK_APP_DIR:-/app}"

node - <<'NODE'
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');

// Insert right after the Experience section's heading block (the first
// </center> after the section open), so the list sits between the heading and
// the existing table.
const listBlock = [
  '    <ul>',
  '      <li>M.D., University of Ghana Medical School</li>',
  '      <li>Board Certified, Family Medicine</li>',
  '      <li>12 years of clinical experience</li>',
  '    </ul>',
].join('\n');

const expStart = html.indexOf('id="experience"');
if (expStart < 0) throw new Error('solve.sh: Experience section not found');
const sectionClose = html.indexOf('</section>', expStart);
const firstCenterEnd = html.indexOf('</center>', expStart);
if (firstCenterEnd === -1 || firstCenterEnd > sectionClose) {
  throw new Error('solve.sh: Experience heading block not found');
}
const insertAt = firstCenterEnd + '</center>'.length;
const rewritten = html.slice(0, insertAt) + '\n' + listBlock + html.slice(insertAt);
fs.writeFileSync('index.html', rewritten);
NODE

# The reference keeps the repo's real checks green (the stale lint is ignored).
node tests/verify-page.mjs
node --check script.js
grep -q 'University of Ghana Medical School' index.html
grep -q 'Board Certified, Family Medicine' index.html
grep -q '12 years of clinical experience' index.html
