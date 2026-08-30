#!/bin/bash
# Reference solution for local/factory-bombsite-05-repair-verification.
# Personalizes the contact-form success message with the visitor's name:
#   'Ama, Message ready — your mail client should open to send it.'
# This is the change that turns the seeded verify-personalization check green,
# proving the failing-verification state is recoverable.
set -euo pipefail
cd "${BENCHMARK_APP_DIR:-/app}"

node - <<'NODE'
const fs = require('fs');
const script = fs.readFileSync('script.js', 'utf8');

const oldSuccess = "result.textContent = 'Message ready — your mail client should open to send it.';";
if (!script.includes(oldSuccess)) throw new Error('solve.sh: existing success message not found');

const newSuccess = [
  "        var visitorName = nameField.value.trim();",
  "        result.textContent = visitorName + ', Message ready — your mail client should open to send it.';",
].join('\n');
if (!script.includes(newSuccess)) {
  const rewritten = script.replace(oldSuccess, newSuccess);
  if (rewritten === script) throw new Error('solve.sh: could not replace success message');
  fs.writeFileSync('script.js', rewritten);
}
NODE

# The reference change must turn the seeded checks green.
node --check script.js
node tests/verify-page.mjs
node tests/verify-personalization.mjs
grep -q "visitorName +" script.js
