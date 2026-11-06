# PROTOTYPE: admin navigation (throwaway, never merged)

Answers [How is the admin organised? (Pen design of navigation)](https://github.com/flyingwebie/WebCraft/issues/20).

Open `admin-navigation.prototype.pen` in Pen, or look at `png/`.

## Three ways to move between Install, Workspaces and Sites

All three show the same screen (a Site's Blog posts list) so only the navigation differs.

- **A: sidebar with a context switcher** (`01`, dark `04`, switcher open `05`). One sidebar whose items change with the level you're at. A switcher at the top jumps between the Install, Workspaces and Sites. Site items are split into Content and Structure (Staff only).
- **B: Workspace rail + Site tree** (`02`). A narrow rail of Workspace icons on the far left, then a tree of the Workspace's Sites, each expanding into its own sections.
- **C: top bar + tabs, no sidebar** (`03`). Workspace and Site are switchers in the top bar's breadcrumb; a Site's areas are tabs; Post Types are a list inside the Content tab.

## Screens from the deploy decisions (drawn in variant A's frame)

`06` Workspace Sites · `07`/`08` Superadmin area with the master-key backup banner (light/dark) · `09` Site Domains & Staging (Primary domain, Redirect domains, Waiting for DNS with per-platform DNS steps, Staging address and password) · `10` Publish all review list · `11` first-run setup wizard.

## Rebuilding

`src/` holds the scripts that drew the file through the Pen CLI in headless mode (`pen interactive --out …`). Paths in them point at `/tmp/penproto`.
