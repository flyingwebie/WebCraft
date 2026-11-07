# PROTOTYPE: Filter builder (throwaway, never merged)

Answers [What does the Filter builder look like? (Pen design)](https://github.com/flyingwebie/WebCraft/issues/30). Rules come from [How do Filters, facets and search work on Loops?](https://github.com/flyingwebie/WebCraft/issues/28); the admin look comes from [What do the key admin screens look like? (Pen design)](https://github.com/flyingwebie/WebCraft/issues/22) (variant A, `b1Fk3bmIS` preset).

Open `filter-builder.prototype.pen` in Pen, or look at `png/`. The example Site is a bakery shop with a sidebar or top-bar Filter over a query Loop of Products.

| # | Screen | Verdict |
|---|---|---|
| 01 | Builder A: control list, settings for the selected control, live preview | **Chosen** |
| 02 | Builder B: settings open inside the list, bigger preview | Not chosen |
| 03 | Layout tab: Sidebar, Top bar and Phone drawer presets | Approved |
| 04 | On the Site, Live mode, sidebar preset | Approved |
| 05 | On the Site, On submit mode, top bar preset with an open dropdown | Approved |
| 06 | On a phone: drawer closed, drawer open, no results | Approved |

## Rebuilding

`src/` holds the scripts that drew the file through the Pen CLI in headless mode (`lib.js` from the admin-screens prototype plus `fx.js` for the Site look). Paths point at `/tmp/penproto`; `run.mjs` reads `libx.js`, which is `lib.js` and `fx.js` joined:

```sh
cat src/lib.js src/fx.js > src/libx.js
node src/run.mjs filters.pen src/vars.js src/gen/*.js
```
