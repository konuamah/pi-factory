#!/bin/bash
# Reference solution for local/factory-bombsite-01-ui-shell.
#
# Harbor's Oracle agent runs this to prove the task is solvable and that the
# verifier recognizes a correct solution. It is a real implementation of the
# request; it writes no expected outputs and touches no verifier file.
set -euo pipefail

# /app in the Harbor container; overridable so the reference solution can be
# exercised by the local regression test in tests/benchmark-pack.test.mjs.
cd "${BENCHMARK_APP_DIR:-/app}"

node - <<'NODE'
const fs = require('fs');

const html = fs.readFileSync('index.html', 'utf8');
const script = fs.readFileSync('script.js', 'utf8');

// 1. Navigation becomes a list of section names, with the current one marked.
//    No styling involved: <ul>/<li> and aria-current are semantics, and the
//    page's look still comes from the existing font/align markup.
const navStart = html.indexOf('<nav');
const navEnd = html.indexOf('</nav>', navStart);
if (navStart < 0 || navEnd < 0) {
  throw new Error('solve.sh: navigation block not found');
}
const navBlock = html.slice(navStart, navEnd);
const links = [...navBlock.matchAll(/<a href="#([^"]+)">([^<]+)<\/a>/g)];
if (links.length < 3) {
  throw new Error('solve.sh: navigation links not found');
}
const items = links
  .map((match, index) => {
    const current = index === 0 ? ' aria-current="page"' : '';
    return `      <li><a href="#${match[1]}" data-section="${match[1]}"${current}>${match[2]}</a></li>`;
  })
  .join('\n');
const nextNav =
  `<nav aria-label="Sections">\n` +
  `    <font face="Georgia, serif" size="4">\n` +
  `    <ul>\n${items}\n    </ul>\n` +
  `    </font>\n  </nav>`;

// 2. Only the first section starts visible; the rest begin hidden so the page
//    opens as a tabbed page instead of one long scroll.
let isFirstSection = true;
const rewritten = [
  html.slice(0, navStart),
  nextNav,
  html.slice(navEnd + '</nav>'.length),
]
  .join('')
  .replace(/<section id="([^"]+)">/g, (_all, id) => {
    if (isFirstSection) {
      isFirstSection = false;
      return `<section id="${id}">`;
    }
    return `<section id="${id}" hidden>`;
  });

fs.writeFileSync('index.html', rewritten);

// 3. The existing toggle keeps working; extend it so the active marker follows
//    the section that is now showing.
const withMarker = script.replace(
  '  function showSection(id) {',
  [
    '  function markActive(id) {',
    "    var links = document.querySelectorAll('nav a[data-section]');",
    '    for (var m = 0; m < links.length; m += 1) {',
    "      if (links[m].getAttribute('data-section') === id) {",
    "        links[m].setAttribute('aria-current', 'page');",
    '      } else {',
    "        links[m].removeAttribute('aria-current');",
    '      }',
    '    }',
    '  }',
    '',
    '  function showSection(id) {',
  ].join('\n'),
);
const wired = withMarker.replace(
  '      showSection(targetId);',
  '      showSection(targetId);\n      markActive(targetId);',
);
if (wired === script) {
  throw new Error('solve.sh: section toggling not found in script.js');
}
fs.writeFileSync('script.js', wired);
NODE

# The reference change must keep the repository's own checks green.
node --check script.js
node tests/verify-page.mjs
grep -q 'aria-current' index.html
grep -q '<ul>' index.html
grep -Eq '<section id="[^"]+" hidden>' index.html
