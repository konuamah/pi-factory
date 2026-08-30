#!/bin/bash
# Reference solution for local/factory-bombsite-02-status-surface.
# Harbor's Oracle agent runs this to prove the task is solvable and the
# verifier recognizes a correct solution. It implements exactly what the
# interview.json decides: an Availability surface under the nav, id=availability,
# heading + one-line status, no CSS, no extra files.
set -euo pipefail
cd "${BENCHMARK_APP_DIR:-/app}"

node - <<'NODE'
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');

// The status surface sits right below the navigation, before <main>.
const navEnd = html.indexOf('</nav>');
if (navEnd < 0) throw new Error('solve.sh: navigation block not found');

const block = [
  '  <!-- availability status surface (decided in interview) -->',
  '  <section id="availability">',
  '    <h2>Availability</h2>',
  '    <p>Currently accepting new patients</p>',
  '  </section>',
  '',
].join('\n');

const insertAt = html.indexOf('<main>');
if (insertAt < 0) throw new Error('solve.sh: main block not found');
const rewritten = html.slice(0, insertAt) + block + html.slice(insertAt);
fs.writeFileSync('index.html', rewritten);
NODE

# The reference change must keep the repo's own checks green.
node tests/verify-page.mjs
grep -q 'id="availability"' index.html
grep -q 'Currently accepting new patients' index.html
grep -q '<h2>Availability</h2>' index.html
