# Make the contact form remember submissions and show visit availability

The doctor's page in `index.html` has a contact form. Right now, when a visitor
submits successfully, it just shows a one-time confirmation message and the
page forgets it happened.

Make the form **remember successful submissions on this device** and show the
visitor a **running count** of messages they have sent (for example, "You have
sent 3 messages"). The count must survive a page reload — closing and reopening
the page (or the whole browser) should not reset it.

The page also needs to show, in the About section, a short line about **visit
availability** — e.g. the next few available visit slots or the practice's
visiting hours — so a patient scanning the page gets that at a glance.

Important constraints:

- plain HTML and JavaScript only, no build step, no dependencies;
- **the page must keep working when opened straight from disk** (double-clicked
  `index.html`, `file://`) — do not use `fetch()` or `XMLHttpRequest` to load
  data, because those fail on `file://`;
- no CSS at all: no `.css` file, no `<style>` block, no `style="..."`
  attribute, no stylesheet link or CDN asset;
- the existing sections, their wording, the section-toggling behavior, and the
  contact form (field ids, validation, mailto behavior) must keep working;
- invalid input must still be blocked exactly as it is now;
- do not touch `.factory/` or `factory.yaml`.
