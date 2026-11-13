# Templates and Components are built in the admin and stored as data

Staff build Templates and Components in a visual builder inside the admin (Page layouts are arranged on the live page, see ADR 0035), and WebCraft stores them as element trees in the database, with an escape hatch for custom HTML, CSS and code. Sites are served from the database by hostname, so a per-Site code build and deploy would not fit a multi-tenant Install, and both Inline editing and client-editable Page layouts need the component tree to be data that WebCraft can read and change.

## Considered Options

- **Components as code files in a per-Site repo** (built and deployed per Site): rejected because every Site would need its own build pipeline, and clients could not change Page layouts without a rebuild.
- **A code editor with a template language, no visual builder**: rejected because Staff lose the visual workflow and WebCraft cannot reliably map rendered elements back to editable Fields for Inline editing.
