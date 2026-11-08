# Staff can edit code on the Site in Code mode

Edit mode was for Content only, with Structure changed in the admin. v1 adds **Code mode** to Edit mode, for Staff and the Superadmin: they select an element on the live page and edit its HTML (from the Template or Component it comes from), its CSS (its Class or the Site CSS) and a page or Site script, in three panels below the page. Changes are saved to the Draft and published like any other Structure change; when a Component is used on several pages, a warning says the edit applies to all of them. The panels suggest the Entry's Fields, Site options, Loops, Components and Classes in HTML, and properties and design-token variables in CSS, with icon buttons for common layout properties. Agencies fix and fine-tune Sites fastest while looking at the real page, and a code view next to the page suits the people who build them.

## Considered Options

- **Whole page in the panels, like a code playground**: rejected because one large file is hard to map back to the Templates and Components the builder stores as data (ADR 0002).
- **Read-only inspector**: rejected because Staff would still have to switch to the admin for every small fix.
- **No code on the Site; the admin builder only**: rejected for the same reason.

## Consequences

HTML edited in Code mode has to map back to Templates and Components stored as data; how is still open.
