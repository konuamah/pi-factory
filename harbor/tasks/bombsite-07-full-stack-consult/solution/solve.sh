#!/bin/bash
# Reference solution for local/factory-bombsite-07-full-stack-consult.
#
# Harbor's Oracle agent runs this to prove the task is solvable and that the
# verifier recognizes a correct solution. It writes the real implementation and
# touches no verifier file. The fixture's own lint (node tools/lint.mjs) is
# stale on purpose; the oracle validates syntax directly with node --check.
set -euo pipefail

cd "${BENCHMARK_APP_DIR:-/app}"

mkdir -p data
cat > data/schedule.js <<'JS'
/* Visit availability data — plain global, loaded via <script src> so the page
 * works over file:// (no fetch/XHR). */
var VISIT_SLOTS = [
  'Monday-Friday 9:00-17:00',
  'Saturday 10:00-14:00',
  'Next available: Tuesday 9:00 AM'
];
JS

node - <<'NODE'
const fs = require('fs');
let html = fs.readFileSync('index.html', 'utf8');
let script = fs.readFileSync('script.js', 'utf8');

// 1. Include data/schedule.js before script.js.
const scheduleTag = '  <script src="data/schedule.js"></script>\n';
if (!html.includes('data/schedule.js')) {
  html = html.replace('  <script src="script.js"></script>', scheduleTag + '  <script src="script.js"></script>');
}

// 2. Render the next available visit into the About section.
const visitLine = '\n      <p id="visit-availability">' +
  '</p>\n';
if (!html.includes('id="visit-availability"')) {
  html = html.replace('    </section>\n\n    <!-- ======================= SERVICES ======================= -->', visitLine + '    </section>\n\n    <!-- ======================= SERVICES ======================= -->');
}

// 3. script.js: localStorage count + render schedule data.
script = script.replace(
  "        result.textContent = 'Message ready — your mail client should open to send it.';",
  [
    "        // Persist and show a running count of successful submissions.",
    "        var sent = parseInt(localStorage.getItem('slamm_form_sent') || '0', 10) || 0;",
    "        sent += 1;",
    "        localStorage.setItem('slamm_form_sent', String(sent));",
    "        result.textContent = 'Message ready — your mail client should open to send it. You have sent ' + sent + ' message' + (sent === 1 ? '' : 's') + ' on this device.';",
  ].join('\n'),
);

script += `
(function () {
  'use strict';
  // Render the first available visit slot from data/schedule.js (file://-safe).
  var availability = document.getElementById('visit-availability');
  if (availability && typeof VISIT_SLOTS !== 'undefined' && VISIT_SLOTS.length > 0) {
    availability.textContent = 'Next available: ' + VISIT_SLOTS[0];
  }
})();
`;

fs.writeFileSync('index.html', html);
fs.writeFileSync('script.js', script);
NODE

node --check script.js
node tests/verify-page.mjs
node tests/verify-local-form.mjs
