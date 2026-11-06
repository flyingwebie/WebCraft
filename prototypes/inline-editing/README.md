# PROTOTYPE: Inline editing (throwaway, never merged)

Answers [What does Inline editing look like? (Pen design)](https://github.com/flyingwebie/WebCraft/issues/21).

Open `inline-editing.prototype.pen` in Pen, or look at `png/`. The Site is a mock bakery home page; photos are placeholders.

## Three variants, seven screens each

Screens in `png/<variant>/`: 1 Edit mode on (just arrived from the signed link), 2 editing rich text, 3 image (replace, alt text, focal point), 4 Loop items (own items editable in place; query Loops point to their Entries), 5 Page details (Fields that don't show on the page: SEO, social image), 6 save and publish, 7 switching language (Review mode, AI and hand-edited markers).

- **A: top bar.** A dark editing bar across the top of the Site (page, Draft status, Edit/Preview, device width, language, Page details, Publish). Editing happens in place with floating toolbars and popovers.
- **B: side panel.** A docked panel on the left lists the page's Fields as a form. Clicking on the page jumps to its Field; typing happens in the panel and the page updates live.
- **C: floating dock.** No bars; a small dock floats at the bottom. Editing happens in place as in A; details and publishing open as floating sheets.

## Rebuilding

`src/` holds the scripts that drew the file through the Pen CLI in headless mode: `node src/run.mjs <file.pen> src/v0.js src/vA.js src/vB.js src/vC.js`. Paths in them point at `/tmp/penproto-ie`.
