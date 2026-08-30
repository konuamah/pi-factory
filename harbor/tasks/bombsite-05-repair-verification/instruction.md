# Personalize the form success message

The doctor's page in `index.html` has a contact form. When a visitor submits
it successfully, the page shows a confirmation message in `#form-result`.

Personalize that confirmation so it addresses the visitor by name — instead of
the generic message, it should include the name the visitor typed into the
name field.

Constraints:

- plain HTML and JavaScript only, no build step, no dependencies;
- no CSS at all: no `.css` file, no `<style>` block, no `style="..."`
  attribute, no stylesheet link or CDN asset;
- invalid input must still be blocked exactly as it is now;
- do not touch `.factory/` or `factory.yaml`.
