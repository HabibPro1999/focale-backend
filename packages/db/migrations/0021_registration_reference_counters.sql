-- migrate: transaction per-file
-- One sequence per registration reference-number prefix ("YY-SLUGCODE-"), so
-- numbering no longer locks the event row or scans registrations FOR UPDATE.
-- Events whose truncated slugs share a prefix share its sequence. A row is
-- created on the prefix's first allocation, seeded from the largest numeric
-- suffix already stored for that prefix.
CREATE TABLE registration_reference_counters (
 prefix TEXT PRIMARY KEY,
 last_value INTEGER NOT NULL
);
