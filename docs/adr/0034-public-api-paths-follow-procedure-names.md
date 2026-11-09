# The public Management API is POST /api/v1/<procedure path>, listed in one catalogue

Every public procedure answers `POST /api/v1/<its router path with slashes>`: `entries.publish` is `POST /api/v1/entries/publish`, a Module's `m.redirects.rules.list` is `POST /api/v1/m/redirects/rules/list`. Inputs are plain JSON (multipart form data for files) and answers plain JSON, served by oRPC's OpenAPI handler, with an OpenAPI 3.1 document at `/api/v1/openapi.json` whose operation ids are the dotted procedure names. The MCP server and the CLI are generated from that document's operations (ADR 0030), so a tool's or command's name follows from the procedure's.

Which procedures are public is one typed catalogue in `packages/api` (`PROCEDURES`): every procedure is internal to the admin or a public read or write, and adding a procedure fails the typecheck until it has a line there. Module procedures are all public and say whether they read. The document of a build is checked in, so every change to the public API shows in review. Sensitive actions and two-step procedures are read from the procedures themselves and marked in the document (`x-webcraft-sensitive`, `x-webcraft-confirmation`), and so are reads and writes (`x-webcraft-access`).

## Considered Options

- **REST resources** (`GET /api/v1/sites/{siteId}/entries`, `DELETE …`): rejected because 170 procedures would each need a hand-written route that has to be kept in step with the procedure, and many procedures (publish, saveDraft, checkUpdates) aren't resource verbs. The procedure name already is the stable contract the admin, MCP tools and CLI commands share.
- **oRPC's RPC protocol at `/api/v1`, with the document beside it**: rejected because its envelope (`{ json, meta }`) isn't what scripts, curl or other languages' clients expect; plain JSON is.
- **GET for reads**: rejected because many reads take nested inputs that don't fit a query string, and one method keeps generated clients simple. Whether a procedure reads is in the document instead, which is also what read-only tokens and the write limit use.
- **Marking public procedures where they are written** (oRPC metadata on each): rejected for now because one list is easier to review as a whole, and the typecheck still forces a decision for every new procedure.
