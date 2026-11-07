# PROTOTYPE: Import screens (throwaway, never merged)

Answers [What do the import screens look like? (Pen design)](https://github.com/flyingwebie/WebCraft/issues/45). Rules come from [Does v1 import content from WordPress?](https://github.com/flyingwebie/WebCraft/issues/43); the admin look comes from [What do the key admin screens look like? (Pen design)](https://github.com/flyingwebie/WebCraft/issues/22) (variant A, `b1Fk3bmIS` preset).

Open `import-screens.prototype.pen` in Pen, or look at `png/`. The example is Acme Bakery moving its old WordPress site in.

| # | Screen | Verdict |
|---|---|---|
| 01 | Import list: past Import runs and the three ways to start | Approved |
| 02 | Source step: live site login, test result, notes on secrets | Approved |
| 03 | Map A: one table of content types, the selected type's keys below | Not chosen |
| 04 | Map B: type list, key cards, a live sample Entry | **Chosen** |
| 05 | Preview: real Entries with Fields, converted Body Blocks, Import leftovers and Redirect rule | Approved |
| 06 | Import run in progress: phases, live log, safe to leave | Approved |
| 07 | Import report: counts, tabs, Undo and re-run | Approved |
| 08 | CSV import as an Owner, from the Post Type's Entry list | Approved |

## Rebuilding

`src/` holds the scripts that drew the file through the Pen CLI in headless mode. `run.mjs` reads `libx.js` and calls `/tmp/penproto/pr.sh`:

```sh
cat src/lib.js src/fx.js src/ix.js > src/libx.js
node src/run.mjs import.pen src/vars.js src/gen/*.js
```
