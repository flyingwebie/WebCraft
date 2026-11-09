# PROTOTYPE: Code mode as a full builder (throwaway, never merged)

Answers [What does Code mode look like with a layers tree, element settings and an insert toolbar? (Pen design)](https://github.com/flyingwebie/WebCraft/issues/118), part of [Code mode as a full builder: chart the way to a design](https://github.com/flyingwebie/WebCraft/issues/114).

Open `code-builder.prototype.pen` in Pen, or look at `png/`. The example is the bakery Home page in Code mode, with the blockquote inside the Customer quote Component selected. That Component is used on 4 pages.

| # | Screen | Verdict |
|---|---|---|
| A1 | Three sides: tree left, element settings right, today's three code panels below the page | **Chosen** |
| B1 | One right column: Layers/Element tabs over one code panel at a time; insert toolbar floats under the selection | Not chosen |
| C1 | Bottom workspace: page full width; settings strip, then tree, HTML, CSS, JS in the dock | Not chosen |
| D1 | A1 with a Placement selected: its Prop values on the right, the Component's markup below | **Chosen** |
| D2 | A1 selection sync: one selection for page, tree and HTML; hover outlines in grey; the caret selects | **Chosen** |
| D3 | A1 insert: Inside or After, five common elements, More opens the full insert list, a line shows where it lands | **Chosen** |

## Rebuilding

`src/` holds the scripts that drew the file through the Pen CLI in headless mode: `lib.js`, `ie_libie.js` and `cx.js` come from the earlier prototypes, `cm.js` is this one. `OUT` in `cx.js` is the PNG folder; change it to your path.

```sh
node src/run.mjs src/gen/00-vars.js   # once, sets the theme variables
src/rr.sh A1 B1 C1 D1 D2 D3
```
