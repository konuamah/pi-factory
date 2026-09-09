---
name: explain-diff-html
description: Use when the user asks for a rich explanation of a code change, diff, branch, or PR. Produces HTML output.
---

# Explain Diff (HTML)

Produce a rich, interactive explanation of the specified code change as a single self-contained HTML file.

## Output Location And Filename

- Write the file to a global location outside any code repo, e.g. `/tmp/`.
- Filename must start with today's date in `YYYY-MM-DD-` format (time-sorted, out of version control), e.g. `/tmp/2026-01-12-explanation-<topic>.html`.

## Required Sections

One long page with section headers and a table of contents. No tabs for top-level structure.

1. **Background**: Explain the existing system relevant to this change. Broadly explore surrounding code first. Include a deep background for beginners (marked as skippable for familiar readers), then a narrower background directly relevant to the change.
2. **Intuition**: The core intuition — essence, not full details. Use concrete examples with toy data. Use figures and diagrams liberally.
3. **Code**: High-level walkthrough of the changes, grouped and ordered for understanding.
4. **Quiz**: Five medium-difficulty multiple-choice questions testing real understanding of the change (not gotchas). Interactive: clicking an answer shows whether it was correct and gives feedback.

## Style

- Write with the clarity and flow of Martin Kleppmann — engaging, classic style.
- Smooth transitions between sections.

## Format Rules

- Single self-contained HTML file including CSS and JavaScript.
- Basic responsive styling so it is readable on a phone.
- Diagrams: pick a small number of reusable diagram families, e.g.:
  - A simplified version of the UI the user sees, to explain UI changes.
  - A system diagram showing data flow or component communication — include example data.
- No ASCII diagrams. Use simple HTML designs for diagrams, HTML lists for lists.
- Code blocks: always use `<pre>` tags. If a custom styled `div` is used instead, its CSS must include `white-space: pre-wrap`. Before saving, scan every code block in the HTML source and confirm its CSS includes `white-space: pre` or `pre-wrap`.
- Use callouts for key concepts, definitions, and important edge cases.
