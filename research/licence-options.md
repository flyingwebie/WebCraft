# Licence options for WebCraft

> **Not legal advice.** A facts-and-options brief for an engineering decision. Before choosing, have a lawyer who covers software licensing (ideally EU/Irish law) review it. Facts fetched 2026-11-05.

## Summary

Comparable self-hosted projects split between permissive licences (Ghost, Strapi's core and reportedly Payload use MIT) and copyleft or source-available licences (Plausible uses AGPL-3.0; Directus now uses a source-available licence that converts to GPL-3.0 after four years). There is no single dominant pattern. The choice mostly follows whether the project plans a hosted or enterprise revenue line.

## Precedents

| Project | Core licence found | Notes |
|---|---|---|
| Ghost | MIT | Fully permissive core; the hosted Ghost(Pro) is the revenue line. |
| Payload CMS | MIT (widely documented; the raw file fetch failed on this run, so re-check) | |
| Strapi | MIT for the Community Edition; code under `ee/` is licensed separately | Classic "open core": permissive core plus a separately licensed enterprise tier. |
| Directus | "Monospace Sustainable Core License" (source-available): forbids competing hosted use, converts to GPL-3.0 four years after each release | Differs from its older GPL-3.0 history; re-confirm before citing. |
| WordPress | GPLv2 or later | |
| Plausible Analytics | AGPL-3.0 | Self-hosted tool with a paid hosted version, the closest structural match to WebCraft. AGPL §13 closes the "run a modified copy as a network service without sharing changes" gap in the GPL. |
| Cal.com | Root `LICENSE` fetched as MIT, which conflicts with its commonly cited AGPL-plus-enterprise history | Unverified; re-check directly before citing. |

## Structural options

- **MIT or Apache-2.0**: lowest friction for agencies to adopt, fork and sell services around. Gives the least protection if a well-funded fork out-hosts a future hosted WebCraft. Apache-2.0 adds an explicit patent grant.
- **AGPL-3.0**: the usual choice when a hosted version is planned. Open question for counsel: an agency's multi-tenant Install serving many client Workspaces over the network may be exactly the network use §13 targets.
- **AGPL-3.0 with a Module exception**: keeps the core copyleft while letting third-party and commercial Modules (WebCraft's extension boundary, see `GLOSSARY.md`) avoid inheriting AGPL obligations. Written as a licence clause instead of a separate directory.
- **Defer**: several projects chose their core licence together with their monetisation model, not before it.

## Sources

- Ghost: https://github.com/TryGhost/Ghost/blob/main/LICENSE
- Payload: https://github.com/payloadcms/payload/blob/main/LICENSE.md
- Strapi: https://github.com/strapi/strapi/blob/develop/LICENSE
- Directus: https://github.com/directus/directus/blob/main/license
- WordPress: https://wordpress.org/about/license/
- Plausible: https://github.com/plausible/analytics/blob/master/LICENSE.md
- Cal.com: https://github.com/calcom/cal.com/blob/main/LICENSE
- AGPL-3.0 text: https://www.gnu.org/licenses/agpl-3.0.html
