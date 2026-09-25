# Frontend follow-up: abstract locks and final-status guards (2.9)

For the admin app, the committee (reviewer) pages and the form app's abstract
edit page. No response shape changes; success bodies are unchanged.

- **Assigning reviewers to a finalized abstract is refused (admin).**
  `POST /api/events/:eventId/abstracts/:abstractId/assign` now answers 409
  `STT_12001` (INVALID_STATUS_TRANSITION) when the abstract is ACCEPTED,
  REJECTED or PENDING, and nothing changes. Before, it returned 200 and
  changed the review rows of a decided abstract (the admin page already
  disables the button for final abstracts, so this is only seen on a stale
  page or when another admin decides at the same moment). Show the error and
  reload the abstract; reopening it allows assignment again.
- **A score sent while a decision is being saved is refused (committee).**
  `PUT /api/abstracts/committee/abstracts/:id/review` can now answer 409
  `STT_12001` ("Abstract is not open for scoring") when the abstract was
  finalized after the page loaded, and 403 `AUTH_1004` (FORBIDDEN)
  ("You are not an active assigned reviewer for this abstract") when the
  reviewer was removed from it meanwhile. These are the same codes the
  endpoint already used for these cases; they now also cover the race. The
  score is not saved in either case.
- **A public edit racing a decision is refused (form app).**
  `PATCH /api/public/abstracts/:id` can now answer 409 `ABS_18008`
  (ABSTRACT_NOT_EDITABLE) with the message "Abstract cannot be edited after a
  decision" when the decision was saved after the edit was checked. Before,
  the edit was saved on top of the decision. The code is the one the endpoint
  already returns for an abstract that is final when the request arrives.
