# PROTOTYPE: admin navigation (throwaway, never merged)

Answers [How is the admin organised? (Pen design of navigation)](https://github.com/flyingwebie/WebCraft/issues/20).

Open `admin-navigation.prototype.pen` in Pen, or look at `png/`.

## Four navigation variants

Each variant has the same eight screens in `png/<variant>/`: 1 Blog posts, 2 switching between Workspaces and Sites, 3 Workspace Sites, 4 Superadmin with the master-key backup banner, 5 Domains & Staging, 6 Publish all, 7 dark, 8 Superadmin dark. The setup wizard (`png/setup-wizard.png`) has no navigation, so there is one version.

- **A: sidebar with a context switcher.** One sidebar whose items change with the level; a switcher at its top jumps between the Install, Workspaces and Sites.
- **B: Workspace rail + Site tree.** A rail of Workspace icons, then the Workspace's Sites as a tree; switching is a quick switcher (⌘K).
- **C: top bar + tabs, no sidebar.** Workspace and Site are dropdowns in the top bar; each level's areas are tabs.
- **D: mix of A and C.** A's sidebar and switcher for a Site's main areas (Content, Media, Forms, Translations, Build, Settings); C's tabs for what's inside each area.

## Rebuilding

`src/` holds the scripts that drew the file through the Pen CLI in headless mode (`pen interactive --out …`). Paths in them point at `/tmp/penproto`.
