# The core is AGPL-3.0-or-later, with an exception for Modules and Site output, and contributors sign a CLA

WebCraft's core is licensed `AGPL-3.0-or-later`, so a modified copy run as a network service must share its changes, and a closed hosted fork cannot take the code. An additional permission under AGPL §7 keeps two things outside the AGPL: Modules that use only the public Module boundary (any licence, including commercial), and Site output and Structure (the HTML, CSS and JS rendered for a Site, and the templates, Components, Design system and content built in the admin), which belong to the agency or client. Outside contributors sign a CLA that grants the project a broad licence (not copyright assignment), so relicensing or dual licensing stays possible.

## Considered Options

- **MIT or Apache-2.0**: easiest to adopt, but offers no protection against a closed hosted fork, and a hosted WebCraft stays possible later.
- **Source-available, converting to open source after some years**: rejected because WebCraft is meant to be open source.
- **DCO instead of a CLA**: less friction, but every contribution would stay AGPL-only and relicensing would need every contributor's consent.

## Consequences

- Docs and Pen designs are CC BY 4.0. The WebCraft name and logo are under no licence (see `TRADEMARK.md`).
- Dependencies must be AGPL-compatible: permissive licences, LGPL, MPL-2.0, GPL-3.0 or AGPL-3.0. SSPL, BUSL, Commons Clause, non-commercial and GPL-2.0-only licences are blocked by a CI licence check. Bundled fonts are OFL or similar.
- The wording of the Module exception follows the Module boundary decision: Modules that use only the `@webcraft/module-sdk` package and Template markup ([ADR 0024](0024-modules-use-one-sdk-third-party-always-sandboxed.md)).
- A lawyer reviews the licence, the §7 permission, the CLA and the trademark before the first public release.
- `research/*` branches are working records and carry no licence.
