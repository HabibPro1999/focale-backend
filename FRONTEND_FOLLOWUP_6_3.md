# Frontend follow-up: export correctness (6.3)

No endpoint or error-code change. The downloaded files change as follows.

- **Dates are in the event time zone (Africa/Tunis).** Human-readable dates and
  times in the XLSX reports (event summary, access registrants, sponsorships,
  check-in ZIP, abstracts, modular registrations export) and the dates in
  export file names used the server's UTC clock. A check-in at 00:30 local time
  showed as 23:30 the previous day. The format is now `dd/mm/yyyy HH:MM` (per
  export language) everywhere, so the sponsorship report's date-times lose
  their seconds. Machine-readable ISO instants (registrations CSV/XLSX
  `Submitted At` / `Paid At`, networking exports) are unchanged.
- **XLSX text is written as typed.** Cells no longer get an apostrophe prefix
  when they start with `=`, `+`, `-` or `@` (it was visible in Excel, e.g.
  `'-` for a name starting with a dash). XLSX text cells are never evaluated,
  so this is safe.
- **CSV exports share one policy.** Registrations CSV
  (`GET /api/events/:eventId/reports/registrations?format=csv`)
  now matches the networking CSVs:
  - every cell is quoted;
  - text that a spreadsheet would read as a formula (also after leading spaces
    or control characters) gets an apostrophe prefix;
  - amounts are plain numbers;
  - lines end with CRLF and the file starts with a UTF-8 BOM;
  - `Content-Type` is `text/csv; charset=utf-8`.

  A client that parses the CSV itself must strip the BOM and accept quoted
  cells.
- **Access registrants report:** every access item gets its own sheet, even
  when names collide after Excel's 31-character limit (the second one gets
  " (2)"). Names with `[]:*?/\` are cleaned instead of failing. An event with no
  access items returns a workbook with one "Accès" sheet instead of a file
  Excel cannot open.
- **Check-in ZIP:** each access item gets its own file. Accents are folded
  (`Déjeuner` → `dejeuner-checkin.xlsx`), names with no Latin letters (e.g.
  Arabic) become `access-checkin.xlsx`, `access-2-checkin.xlsx`…, and
  duplicates get `-2`, `-3` instead of overwriting each other.
