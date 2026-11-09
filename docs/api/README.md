# The Management API for scripts

WebCraft's Management API is the same set of procedures the admin uses. The public ones answer at `/api/v1` on the Install's admin host, for scripts, CI jobs and AI clients acting as a person through an API token. `openapi.json` in this folder is the OpenAPI 3.1 document of this version with the first-party Modules; an Install serves its own at `https://<admin host>/api/v1/openapi.json`.

## Tokens

Make a token in the admin under Your account › API tokens. A token:

- acts as you, never with more access than you have at the time of each request, within one Workspace and, if you choose, some of its Sites;
- can be read-only: it then calls only procedures marked `x-webcraft-access: read`;
- lasts 30, 90 (the default) or 365 days, or never, and stops at once when you revoke it or lose access to its Workspace (or to every Site it lists);
- is shown once. WebCraft keeps only a keyed hash of it. Rotating the Install's Master key ends every token.

Making a token needs your password (it is a Sensitive action). Every change a token makes is recorded in the Audit log under your name and the token's name.

## Calling a procedure

Every procedure is `POST /api/v1/<path>`, where the path is the procedure's name with slashes: `entries.publish` is `POST /api/v1/entries/publish`, and a Module's procedure `m.redirects.rules.list` is `POST /api/v1/m/redirects/rules/list`. Send the input as a JSON body, or as multipart form data when it holds a file (`media.upload`):

```sh
curl -X POST "https://admin.example.com/api/v1/sites/list" \
  -H "Authorization: Bearer $WEBCRAFT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"workspaceId":"…"}'
```

Answers are JSON. Dates are ISO 8601 strings, in answers and inputs.

A refusal has the status that fits and a body `{ "code", "status", "message", "data" }`. Codes a script should expect besides each procedure's own:

| Code | Status | Meaning |
| --- | --- | --- |
| `TOKEN_INVALID` | 401 | No token, or one that doesn't work: `data.problem` is `missing`, `unknown`, `expired`, `revoked` or `locked` (its person's account is locked for now; `Retry-After` says for how long). |
| `TOKEN_READ_ONLY` | 403 | A read-only token called a procedure that may change something. |
| `FORBIDDEN` | 403 | The token's person may not do this (`data.permission`). |
| `SENSITIVE_ACTION_REFUSED` | 403 | A Sensitive action (`x-webcraft-sensitive`): only a person in the admin takes it. |
| `WORKSPACE_NOT_FOUND`, `SITE_NOT_FOUND`, … | 404 | Not there, or outside the token's reach. |
| `NOT_FOUND` | 404 | No public procedure at that path. |
| `CONFIRMATION_INVALID` | 409 | The confirmation id is unknown or used (`data.problem`: `unknown`), `expired`, or what it confirmed `changed`: ask again. |
| `TOO_MANY_REQUESTS` | 429 | Past a limit (`data.limit`: `requests` or `writes`): wait `Retry-After` seconds. |

## Limits

Each token makes at most 300 requests a minute, and of them at most 30 calls to procedures marked `x-webcraft-access: write`. Every answer says what is left of the limit closest to running out: `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` (seconds until it starts over).

## Two steps for lasting changes

Procedures marked `x-webcraft-confirmation` publish, delete or change many things at once. Their first call changes nothing: it answers what would happen and a confirmation id, valid for 5 minutes and once:

```json
{ "confirmation": { "id": "…", "expiresAt": "2026-11-09T13:05:00.000Z" }, "preview": { … } }
```

Some of these procedures answer more beside it (`"deleted": false` and what would go; `publishing.publishAll` answers `"published": false` and the items in the order they would go live). Publish all goes live all or none: an item that can't be published yet stops them all with `PUBLISH_ALL_REFUSED` (409, naming the item and its own refusal in `data`). Show the preview to whoever asked for the change, then call the procedure again with the same input and `"confirmation": "<id>"`. If what the preview showed changed in between (someone saved the Draft again), the call is refused with `CONFIRMATION_INVALID`, `data.problem: "changed"`, and nothing happens.

## Versions

`/api/v1` changes only by adding: new procedures, new optional inputs, new fields in answers. A breaking change comes as `/api/v2`, served next to `/api/v1` for at least 12 months, during which `/api/v1` answers carry a `Deprecation` header (ADR 0029).
