# Frontend follow-up: certificate template access

When creating or updating a certificate template, `accessId` must identify an
access item from that template's event. The API rejects missing or cross-event
access IDs with HTTP 400 (`VAL_2001`); use the access list for the selected
event when populating the editor.
