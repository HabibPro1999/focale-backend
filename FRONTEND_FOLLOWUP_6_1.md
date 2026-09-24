# Frontend follow-up: email subjects without HTML entities (6.1)

No endpoint, shape or error-code change.

- **Email log subjects are plain text.** The `subject` stored on email logs
  (admin email-log lists, detail, realtime `emailLog` events) is now the text
  the recipient sees: a registrant named "Dupont & Fils" gives
  `Bienvenue Dupont & Fils`, not `Bienvenue Dupont &amp; Fils`. Always render
  it as text, never as HTML. The admin `EventEmailLogsTable` already does.
  Rows written before this change keep their escaped subjects.
- **Plain-text bodies** (template plain content, custom sends, fallbacks) no
  longer contain HTML entities or `<div>` markup from `{{sponsoredItems}}` /
  `{{beneficiaryList}}`; those lists become one line of `•` items.
- **`{{certificateList}}` is escaped in HTML bodies** like any other value (it
  used to be inserted as trusted HTML), so a certificate name such as
  `Q&A <Workshop>` now displays literally.
