# Drafts are co-edited live as shared documents

Two people can edit the same Draft at once: Entry forms, the block editor, Inline editing in Edit mode, the visual builder and Code mode. Each Draft is a shared document that merges everyone's edits as they type. We use Yjs, a CRDT library. Sync runs over a WebSocket served by the web process. Postgres stores the document state, and Postgres LISTEN/NOTIFY passes updates between processes, so no new service is needed. The Draft rows that the renderer, the Staging address and the API read are written from the document every few seconds and on every publish. The server is the only authority: it checks every incoming update with `can()` before applying it, so Authors, Page layout limits and the Structure line still hold. AI clients, API calls and Automatic translation write through the same document as named participants. Site settings have no Draft and stay last-save-wins.

## Considered Options

- **A hard lock per item**: simplest, but a client and the agency can't work on one page together, and a forgotten tab blocks everyone.
- **A soft lock with Take over**: cheaper to build, but every clash costs someone their flow, and Edit mode pages touch several items at once (Entry, Globals, Components).
- **Automerge, or our own operational-transform server**: Automerge has fewer editor bindings, and our own server is a lot to build and get right. Yjs has bindings for the rich-text and code editors we need.
