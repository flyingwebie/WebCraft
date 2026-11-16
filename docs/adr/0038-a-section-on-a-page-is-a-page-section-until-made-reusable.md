# A Section on a Page is a Page section until Staff make it reusable

A Page holds placed Components only (its Page layout), so the building area's Section on a Page used to make a library Component named "Section1", "Section2", … and place it. Every section Staff built on any Page then filled the Components place, the Command menu's Components and the Allowed components choices with Components nobody meant to reuse. The owner decided (2026-11-16) that a Section on a Page makes a **Page section**: a Component the Page owns (`components.page_id`), placed only on that Page, with a name made from its id that nobody sees, listed nowhere. It stays an ordinary Component underneath, so its Placement's Prop values, translations, Co-editing, the one Undo history, Revisions of the Page and Site transfer keep working through the Page layout's existing machinery. **Make reusable Component** (Layers, the Inspector, the Command menu) asks for a name and turns it into a library Component: the same row, renamed, its owner cleared, its Placement left as it is.

## Considered Options

- **Free elements on Pages** (a Page holding its own element tree beside or instead of its Page layout): the most direct model, but it gives Pages a second kind of content with its own storage, translation, Member editing, Review, publishing and transfer rules, all of which the Page layout already has for Placements.
- **Asking each time** ("New Component or section on this Page?"): leaves the choice to every insert, and most answers would be the same; the library would still fill up whenever the default was taken.
- **Keep library Components named SectionN**: what was there; it is the clutter the owner asked to remove.

## Consequences

- A Page section is placed once, on its own Page: the Page layout writer refuses it on another Page, twice on its Page, and Template and Component saves and publishes read it as a Component that can't be placed there. It is never an Allowed component nor a Body field's Component, and can't be renamed. Duplicating its Placement in the building area makes another Page section with a copy of its Draft.
- **Publishing**: publishing the Page publishes the Sections its layout places that have something to publish, in the same transaction, as the Page's one Publish item, whoever may publish the Page (an Editor publishes the Section's Structure with it). Publish all lists a Page whose Sections changed as a changed Page and never lists the Sections themselves; Publish all at a time and Scheduled publishes publish the Sections' Drafts as they are when the Page goes live (only the Page's own Draft is frozen). A Review counts a Page whose Sections changed as something to review.
- **Removing** a Section's Placement keeps the Component while the Page's Draft or published layout may still need it, so Undo brings the Placement back and the published page keeps showing it; the Page's next publish deletes the Sections neither version places. A Revision of the Page from before that publish can't bring a deleted Section back. **Deleting** the Page deletes its Sections (and the foreign key cascades).
- Where a library Component is placed inside a Page section, its usage names the Page.
- Existing "SectionN" Components stay library Components; nothing is migrated.
