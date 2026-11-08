# Sites are rendered on request by the Install, not built as static files

The Install serves every Site itself: it finds the Site from the request's hostname, renders the page from the database, and caches the HTML until something on that Site is published. A CDN can sit in front of the Install as a caching proxy, but WebCraft never builds static files or pushes a Site to a separate host. Templates are already data (ADR 0002), so rendering is cheap, and drafts, Inline editing, forms and Webhooks all need a live path to the Install anyway.

## Considered Options

- **Static build pushed to a CDN host on every publish**: rejected because each Site would need a build pipeline, there is no incremental rebuild, drafts could not be previewed or inline edited on the published Site, and forms would need a separate route back to the Install.
- **Both, with static export as a per-Site option**: rejected for v1 because it doubles the publishing paths to build and test for little gain over a CDN in front.
