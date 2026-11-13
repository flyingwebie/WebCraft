# One building area on the Site's own address, with the page in a same-origin frame

Status: Proposed. Nothing is built yet; the order of work is in the UI overhaul's plan.

Edit mode, Code mode and the Builder become one **building area**: one full-screen shell with a rail, a canvas, docks that hold movable panels, a bottom bar, and places (Content, Templates, Media, Styles, Loops, Components, Forms) that open over the canvas. The Site's own address serves it (its Primary domain once verified, else its Staging address) at `/_webcraft/build/…`, as hashed files under a strict policy, and it shows the page in a frame of the same origin: the page at its own address, rendered for the person editing. Because the frame is same-origin, the shell reads the page's elements directly, draws selection, outlines and chips over it, and gives it a real width, so the Site's media queries answer to tablet and phone widths. We chose this because three editors with three kinds of chrome could not be told apart or left, moving between them loaded the page again or changed host, and a page narrowed inside its own window is not a device preview. A shell that stays loaded also makes one Undo history and one set of live Drafts the natural state, not something handed from page to page.

## What is decided

- **Who gets in, and how.** As today (ADR 0022): a one-use link from the admin starts an Edit mode session on the Site's address, tied to the admin session, for at most 8 hours, and every request is checked again (the edit cookie, the header token, the same origin). There is no second sign-in and the admin's cookie never reaches a Site. The admin keeps one stable address that makes the link, so a bookmark or a link from an admin screen always works.
- **One shell, drawn by Permission** (ADR 0028). With `structure.edit` a person gets the whole building area. Without it they get client editing: the same parts, larger and in words, with no code panes, Inspector, Layers tree, insert row or Structure places. The server decides each request by Permission; the shell only shows what the person may do.
- **What runs where.** The shell loads none of the Site's scripts. The framed page runs the Site's own scripts and Libraries and never an outside script, as ADR 0022 says, plus one WebCraft script, the page agent, which makes Content editable in place and reports to the shell. Everything with chrome (panels, toolbars, popovers, chips) and every service (requests, shared Drafts, the Undo history) lives in the shell.
- **What a page shows.** For someone with `structure.edit`, the Drafts of the Site's Structure around the Drafts of its Content, every element tagged with where it comes from and every editable region tagged too, so one click selects and, on text, starts typing. For everyone else, the Drafts of the Content through the published Structure, as Edit mode shows it today: Members never see a half-made Template.
- **A Template or Component with no page** shows on a stand-in page on the same address: its tree rendered as the Site renders it, with preview data and no scripts. Where a page shows it, it opens on that page.
- **What the session reaches.** The building area calls the Management API on the Site's address for a named list of procedures that change this Site's Content and Structure, pinned to the session's Site, as the person, recorded as coming from Edit mode. Workspace and Install procedures are not served there, and a Sensitive action is always refused there.
- **Addresses.** The open document is the path (`/_webcraft/build/page/about`, `…/entry-template/<Post Type>`, `…/component/<id>`), an open place is the query (`?place=styles/classes`). The browser's Back button closes a place or returns to the document before, and a reload opens the same document and place.
- **Drafts, Publish, Co-editing.** Drafts save as they change; there is no Save button. Publish in the bottom bar publishes the open document's changed items, Content and, for those who may, the Structure it shows, through the same procedure as Publish all. Every Draft the document touches is opened once, as a shared document (ADR 0025), by the shell.
- **One Undo history** (ADR 0036) lives in the shell for the life of the tab, across documents and places. Nothing is handed over between pages any more, because the shell is never left.
- **Panels and docks.** Each panel has a switch and a rule about what must be open or selected for it to show; both must hold. A person's panel layout is kept with their account, so it follows them to another browser and another Site.
- **Code panes** follow the selection: the HTML of the Template or Component the selection comes from, the CSS of an element's Classes, and the page's, the Site's or a Component's script. Format runs in the browser, with the formatter served from the Site's address and loaded on first use.

## Considered Options

- **The shell on the admin, the Site's page in a frame from the Site's address.** The strongest separation, and the option ADR 0022 already rejected: the two are different origins, so every outline, drag and in-place edit becomes messages between frames, and the page still needs its own edit session to show Drafts.
- **The shell on the admin, with a copy of the page served from the admin.** Same origin, but the Site's own scripts and Libraries would run with the admin session, across every Workspace the person reaches, or would have to be stripped, and then it is not the page. Every address the page names would also need rewriting. The Builder's canvas works this way for one Template with preview data; it does not stretch to real pages.
- **Keep editing in the page and draw a frame around it.** The least work, but the window stays wide, so media queries never answer, and the editor's chrome keeps sharing a page with the Site's CSS and scripts.
- **Keep the Builder beside the new shell for things with no page.** Two tools again (the reason ADR 0035 gave for one editor). The stand-in page gives the same canvas inside the one shell.
- **Serve the whole Management API on the Site's address.** Simpler than a list, but a Site's own script runs beside the shell with the same session, and could then reach Members, domains, secrets and other Workspaces.
- **A sign-in of its own on the Site's address.** A second place to hold passwords and second factors, on a domain the client owns.

## What it changes in earlier decisions

- **Supersedes ADR 0035** (one editor with two canvases): there is one canvas, a frame, and two things it can show (a real page, a stand-in page). "Open in builder" and "View on a page" become opening another document in the same shell.
- **Amends ADR 0016** (Code mode): there is no Code mode to switch on. The three code panels are panes of the bottom dock that follow the selection, still for Staff and the Superadmin only, still saving to the Drafts.
- **Amends ADR 0022** (scripts in Edit mode): Edit mode is no longer "in the same page as the Site" but in a frame of the same origin under a shell on the Site's domain. Which scripts run, Safe mode and the request checks all stand. Same origin means the Site's own scripts can still reach what the session reaches, as today, and that reach grows to the listed Content and Structure procedures of this one Site.
- **Amends ADR 0023** (strict policy): the shell is one more set of hashed files on the Site's domain, with a policy of its own and nothing inline. A page shown in the building area may be framed by its own origin, as visitors' pages already may.
- **Amends ADR 0002** (built in the admin): Templates and Components are built in the building area, on the Site's address, and are still stored as element trees.
- **Amends ADR 0036** (one Undo history): the hand-over between pages and between hosts goes; the history also covers what a person changes in a place.
- ADRs 0009, 0013, 0017, 0025 and 0028 stand as they are and bind the building area.

## Consequences

- Building needs an address. Today the Builder works for a Site with neither a verified domain nor a Staging address; the building area does not, as Edit mode never did. An Install that builds Sites must set its sites domain, and the admin must say so where it is missing.
- A Site's own script, or a Library, running in the frame can ask for anything the session's list allows on that Site. The list, the pin to one Site and the refusal of Sensitive actions are the boundary, and each addition to the list is a reviewed change. Safe mode stays the way in when a script misbehaves.
- The editing bar, Code mode's injected panels and the admin's Builder route are deleted once the building area does what they did. Until then they run beside it, unchanged.
- The glossary needs the new words (building area, place, dock, panel, page agent) and loses or redefines Edit mode, Code mode, Builder and Page layout drawer.
