# Frontend follow-up: access edits under concurrency (5.1, access races)

No new endpoint, response shape or error code. The admin already translates
every code below (`errors.json`: `ACC_7001`, `ACC_7002`, `ACC_7007`).

`PATCH /api/events/access/:id` (update an access item) now decides from the item
as it is under a row lock, so a request can meet a change that another
request committed just before it:

- **Lowering `maxCapacity`**: if a payment commits while the edit waits, the
  edit sees the new paid count. It gets the existing 409
  `ACCESS_CAPACITY_EXCEEDED` (`ACC_7002`) with
  `details: { paidCount, requestedMaxCapacity }`, where `paidCount` now
  includes that payment. Before, the edit could be saved below the paid count.
  A payment that arrives while the edit is saving meets the new capacity and
  gets the same 409 it gets on any full item.
- **Setting `requiredAccessIds`**: if another admin's edit to the same event
  commits first and the two edits together would form a cycle, the second
  gets the existing 400 `ACCESS_CIRCULAR_DEPENDENCY` (`ACC_7007`). Before,
  both could be saved and the cycle stored.
- **Item deleted meanwhile**: if the item is deleted between the request's
  first read and its lock, the request gets 404 `ACCESS_NOT_FOUND`
  (`ACC_7001`). Before, it could return 200 with a `null` body.

Unrelated to concurrency: a `PATCH` whose only field is `requiredAccessIds`
used to fail with a 500 ("No values to set"). It now saves the prerequisites.
The admin access form sends every field, so it never hit this.

Admin registration creation now retries database deadlocks/restarts using the
same bounded policy as public creation. A successful retry returns the usual
response; failed attempts leave no registration, counter increment or audit.

**Admin**: nothing to change as long as the access form shows the API error
for these codes. After a 409 on a capacity edit, refetch the item so the
form shows the current paid count.
