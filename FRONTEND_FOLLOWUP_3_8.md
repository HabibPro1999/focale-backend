# Frontend follow-up: certificate render pipeline (3.8)

For the admin app (`src/features/certificates`: template list/editor and the
image upload). No request changes; the response changes are additive.

- **Certificate template objects gain three nullable fields:**
  `renderImageKey` (string), `renderImageWidth` and `renderImageHeight`
  (numbers). They appear wherever a template is returned (list, get, create,
  update, image upload). They describe the flattened JPEG copy the server
  embeds in certificate PDFs; the admin app does not need them. Keep using
  `templateUrl`, `templateWidth` and `templateHeight` for the editor: zones are
  still percentages of the original image and the PDF page keeps the
  original's size, so nothing moves. They are `null` on templates uploaded
  before 3.8 until the backfill script runs (those templates still render, from
  the original image).
- **Upload refuses images whose pixels cannot be decoded.**
  `POST /api/events/certificates/:id/image` now decodes the whole image once
  (to make the render copy). A PNG or JPEG with a valid header but corrupt or
  truncated pixel data now gets 400 `VALIDATION_ERROR` "Invalid image. Upload a
  valid PNG or JPEG of at most 20 megapixels." (the same error as an image over
  20 MP). Before, it was accepted and every certificate using it failed at send
  time. The upload also takes a little longer for large images (one decode and
  JPEG encode, typically well under a second).
- **Certificate PDFs look slightly different on some templates** (no API
  change): the background is a JPEG at most 3508 px on its long edge, quality
  88 with full chroma. Transparent PNG areas print white (as before on a blank
  page), CMYK JPEGs are converted to sRGB, and originals larger than 3508 px
  are scaled down. Worth a look on real templates before release (see the PR's
  visual QA note).
