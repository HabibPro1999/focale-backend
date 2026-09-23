# Frontend follow-up: public link origins

Public abstract submissions and registrations may send `linkBaseUrl` only when
its HTTP(S) origin is listed in the API's comma-separated
`PUBLIC_LINK_ALLOWED_ORIGINS` setting. The API requires that setting in
production. A submitted origin outside the allow-list is rejected with HTTP 422
(`VAL_2001`), so deployments must include the public form origins used by the
frontend.
