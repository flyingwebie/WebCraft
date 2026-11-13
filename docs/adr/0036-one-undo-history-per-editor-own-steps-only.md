# One undo history per editor, own steps only

Edit mode, Code mode and the Builder keep one undo history per browser tab, for Members and Staff alike. It covers inline text, Props, Page layout moves, the tree, the Inspector, Insert, the Command menu and typing in the HTML, CSS and JS panels, across every Draft the page touches. The code panels have no undo of their own: ⌘Z in a panel uses the same history. We chose this because an HTML edit is also a tree change, so separate histories would each hold half of one change and could undo it in an order that clashes. Since Drafts are shared live documents (ADR 0025), the history holds only the person's own steps: undo never takes back someone else's edit, and a step that no longer applies, or that the server's rules would refuse, is skipped with a message.

## Considered Options

- **Each code panel keeps its own editor undo**: the usual code-editor habit, but it splits one change across two histories.
- **One history shared by everyone on the Draft**: undo would take back other people's work.

## Consequences

The history lives for the tab, carrying on past autosaves, publishes, page changes and switches between Code mode and the Builder, and is cleared on reload. Checkpoints are the way back past that. Each step has a label used in tooltips, the Command menu and screen-reader announcements. The Edit bar's per-change "Undo" becomes **Revert**, so "Undo" only means stepping back through this history.

Members use the same history in Edit mode, so ⌘Z means the same thing for everyone and a Page layout move or hide can be undone like a text edit.
