# Outside scripts never run in Edit mode; the Site's own scripts do

Edit mode runs on the Site's own domain, in the same page as the Site (ADR 0016). The edit cookie is `HttpOnly`, but any script on that page can still send edit requests that carry it, so whatever runs in Edit mode can act as the signed-in person. WebCraft splits scripts by who controls their code. WebCraft's own scripts, Libraries (copies kept by WebCraft at a fixed version) and the Site and page scripts Staff write all run in Edit mode, for Staff and Members alike, because Staff already control the Site's Structure and clients need to see the page working. Outside scripts (anything loaded live from another host, or pasted as a third-party snippet) never run there, and embeds made of a script show a placeholder instead. Iframe embeds still show, since they can't reach the page. Edit requests also need a per-session header token and a same-origin check, and Safe mode loads Edit mode with no Site scripts at all, so a broken script can't lock anyone out.

## Considered Options

- **The Site in a sandboxed iframe on another origin, with the editor outside it**: the strongest isolation, but it would undo the same-page Edit mode already designed and turn every in-place edit into messages between frames.
- **Run every script and rely on the cookie's flags**: a compromised tag or pixel could then publish changes as whoever is editing, including the Superadmin.
