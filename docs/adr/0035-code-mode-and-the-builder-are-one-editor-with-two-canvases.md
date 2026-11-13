# Code mode and the Builder are one editor with two canvases

Code mode on the live page and the full-screen Builder are one editor: the same layers tree, Inspector, Insert, Command menu, keys and layout (tree left, Inspector right, HTML, CSS and JS panels below). Only the canvas differs. Code mode shows the real page and is where anything visible on a page is built, including Page layouts, which never open in the Builder. The Builder shows a Template or Component with preview data, for things that have no page yet (an unplaced Component, a Search template, an Entry template with no Entries) or that Staff want to build on their own. Each links to the other ("Open in builder", "View on a page") in the same tab, keeping the selection, since both save to the same shared Draft.

## Considered Options

- **One tool, no Builder**: rejected because a Template or Component with no page would need a stand-in page inside Code mode, which is the Builder again under another name.
- **Two separate tools sharing panels**: rejected because their layouts, keys and habits would drift apart.

## Consequences

The Builder drops its switch between the Visual and Markup views for Code mode's docked panels, and an Entry template gets an Entry picker that chooses what both the preview and "View on a page" show.
