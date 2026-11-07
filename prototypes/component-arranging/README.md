# PROTOTYPE: Arranging Components in Edit mode (throwaway, never merged)

Answers [How do Members arrange Components in Edit mode? (Pen design)](https://github.com/flyingwebie/WebCraft/issues/44). It builds on the Edit mode bar from [What does Inline editing look like? (Pen design)](https://github.com/flyingwebie/WebCraft/issues/21), the roles from [What roles exist, and what can each do?](https://github.com/flyingwebie/WebCraft/issues/9) and live co-editing from [How do revisions, scheduled publishing, review and edit locking work?](https://github.com/flyingwebie/WebCraft/issues/34).

Open `components.prototype.pen` in Pen, or look at `png/`. The example Site is the bakery Home page: a header and footer from the Page template, and five Placements in its Page layout (Hero split, Product grid, Customer quote, Latest posts, Call to action). Maeve (green) is editing at the same time.

| # | Screen | Verdict |
|---|---|---|
| A1 | On the page: selected Component with its toolbar, "+" between Components, another person's outline | **Chosen** |
| A2 | On the page: Add a component (allowed Components only), placeholder where it goes, locked header | **Chosen** |
| A3 | On the page: Props side panel | **Chosen** |
| B1 | Layout drawer: drag to reorder, keyboard moves, locked header and footer rows | **Chosen** as the "Page layout" list beside A |
| B2 | Layout drawer: add a Component with "Goes after" | **Chosen** (the drawer's add flow) |
| B3 | Layout drawer: Props inline and the row menu | Row menu **chosen**; Props open in A's side panel instead |
| C1 | Arrange mode: page as cards, drag in from a library | Not chosen |
| C2 | Arrange mode: Props inspector | Not chosen |
| P1 | Phone: A's bottom sheet, B's full-screen list, C's cards | A and B **chosen** |
| S1 | Staff: Page layout switch and the per-Site allow list | **Chosen** |

## Rebuilding

`src/` holds the scripts that drew the file through the Pen CLI in headless mode: `lib.js` (admin look, from the filter-builder prototype), `ie_libie.js` (Edit mode bar and bakery Site, from the inline-editing prototype) and `cx.js` (this prototype). `OUT` in `cx.js` is the PNG folder; change it to your path.

```sh
node src/run.mjs src/gen/00-vars.js   # once, sets the theme variables
src/rr.sh A1 A2 A3 B1 B2 B3 C1 C2 P1 S1
```
