#!/bin/bash
# Reference solution for local/factory-bombsite-04-baseline-debt.
# Makes the contact form's success message clearer without CSS:
#   - index.html: give #form-result role="status" + aria-live="polite"
#   - script.js:  (already shows the message; leave wording as-is)
# The repo deliberately contains unrelated debt (legacy/old-script.js is broken
# JS). The reference scopes its checks to the changed files only, proving the
# task is solvable without touching the debt.
set -euo pipefail
cd "${BENCHMARK_APP_DIR:-/app}"

node - <<'NODE'
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
if (!html.includes('id="form-result"')) throw new Error('solve.sh: form-result element not found');
const marked = html.replace(
  'id="form-result"',
  'id="form-result" role="status" aria-live="polite"',
);
if (marked === html) throw new Error('solve.sh: form-result not updated');
fs.writeFileSync('index.html', marked);
NODE

# Only the changed file must parse; the unrelated legacy debt is left alone.
node --check script.js
node tests/verify-page.mjs
grep -q 'role="status"' index.html
grep -q 'aria-live="polite"' index.html
