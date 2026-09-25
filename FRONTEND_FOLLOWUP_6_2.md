# Frontend follow-up: Abstract Book fonts (6.2)

No endpoint, shape or error-code change.

- **The Abstract Book prints every script.** Greek, math symbols (`≤`, `≥`,
  `−`), Arabic and Hebrew now print as written instead of `?`. Arabic and Hebrew
  are drawn right to left, and a paragraph that starts with Arabic or Hebrew
  (a title or an abstract body) is right-aligned. The text can be selected,
  copied and searched in PDF viewers.
- **`bookFontFamily` maps to DejaVu faces.** The free-text field in the
  abstract settings (`AbstractConfigForm`) keeps its meaning, but the book no
  longer uses the PDF built-in fonts:
  - a value containing "times" uses DejaVu Serif;
  - a value containing "courier" uses DejaVu Sans Mono;
  - anything else uses DejaVu Sans.

  Text the chosen face cannot draw (Arabic/Hebrew in DejaVu Serif) falls back
  to DejaVu Sans. If the admin labels or hints name Helvetica/Times/Courier,
  describe them as sans / serif / monospace instead.
- The metrics differ from the old built-in fonts, so line breaks and page
  counts of a regenerated book change slightly.
