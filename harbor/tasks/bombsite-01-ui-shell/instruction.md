# Make the portfolio usable on a phone

The doctor's page in `index.html` shows its entire content stack at once. On a
phone you have to scroll through everything to reach the contact form, and the
navigation is one row of five links that wraps badly on a narrow screen.

Make the page behave like a tabbed page:

- the navigation should read as a list of section names, and the section you
  are currently looking at should be obvious;
- clicking a section name shows that section and hides the others;
- the page should be usable at a narrow phone width;
- the contact form must keep working exactly as it does now.

`script.js` already has section-toggling logic — build on it rather than
replacing it.

Constraints:

- plain HTML and JavaScript only;
- no CSS at all: no `.css` file, no `<style>` block, no `style="..."`
  attributes, no stylesheet link or CDN asset;
- no dependencies and no build step — the page is opened straight from disk;
- do not change the wording of the medical content;
- do not edit `.factory/` or `factory.yaml`.

The repository checks configured in `.factory/config.yaml` (`node --check
script.js` and `node tests/verify-page.mjs`) must keep passing.
