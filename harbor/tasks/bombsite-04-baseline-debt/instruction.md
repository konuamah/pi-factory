# Make the contact form results clearer

The doctor's page in `index.html` has a contact form. When a visitor submits
it, the page shows a confirmation message in a small element
(`id="form-result"`). Right now that message is easy to miss.

Improve the form feedback so it is clearer:

- after a successful submit, the confirmation message should be more
  prominent and should be read aloud to screen readers;
- invalid input should still be blocked the same way it is now (a message is
  shown, the mailto navigation is prevented);
- the success message wording should stay the same.

Constraints:

- plain HTML and JavaScript only, no build step, no dependencies;
- no CSS at all: no `.css` file, no `<style>` block, no `style="..."`
  attribute, no stylesheet link or CDN asset;
- do not change the behavior of the other sections;
- do not touch `.factory/` or `factory.yaml`.
