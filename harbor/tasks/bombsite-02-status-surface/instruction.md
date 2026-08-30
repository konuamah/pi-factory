# Add a status surface to the doctor's page

The doctor's portfolio page in `index.html` has sections for about, services,
credentials, experience, and contact. It needs a small, always-visible status
surface that a patient can read at a glance.

What exactly the surface shows, where it lives on the page, and what it says is
**not specified here** — it will be decided in the interview, and your plan and
implementation must match those decisions exactly.

General constraints:

- plain HTML and JavaScript only, no build step, no dependencies;
- no CSS at all: no `.css` file, no `<style>` block, no `style="..."`
  attribute, no stylesheet link or CDN asset;
- the existing sections, their wording, and the contact form must keep working;
- keep the page consistent with how it currently looks and behaves;
- do not touch `.factory/` or `factory.yaml`.
