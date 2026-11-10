# Extra blocks

The first-party `extra-blocks` Module uses only `@webcraft/module-sdk`. SDK 1.12 opens `blockTypes` with `blockType({ name, label, props, markup })`, using the same existing Field definitions and Template markup compiler as Module Components. There are no new Field types, Template commands or built-in gallery Blocks.

After the Superadmin approves the Module, Staff choose its types in a Post Type's Body field's **Allowed Components**. The list is empty by default. The Entry editor, slash/add menu and Edit mode share the permitted catalog. Each type is also a reusable Component for Templates and Page layouts; it does not need a separate declaration. Labels and Prop labels ship in English and Italian.

| Type | Existing Fields | Output without JavaScript |
| --- | --- | --- |
| Gallery | `images` Repeater: Media `image`, text `alt`, boolean `decorative`, text `caption` | Figures with responsive Media images and optional captions. Alt and Decorative belong to each placement; ordinary Checks report missing alt. |
| Accordion | `items` Repeater: text `heading`, rich text `text` | Native details and summary elements. |
| Tabs | Text `label`, the same `items` Repeater | Named section containing all panels, each headed by an H2. |
| MapEmbed | Text `label`, non-translatable text `url` | A named link to an OpenStreetMap embed URL. |

Repeaters hold at most 50 items and use the existing Props JSON editor. Tabs enhance to independent ARIA tabsets with arrow/Home/End keys, roving focus and labelled panels. Native disclosure behavior is retained. There are no animations, including with reduced motion.

## Scripts and Consent

`siteScript: { code, whenUsed: ["Tabs", "MapEmbed"] }` requests the existing hashed, same-origin script route. The host checks the declaration; the renderer includes it only if one of those declared Components or Block types actually rendered, including Body Blocks and nested Placements. Gallery and Accordion require no script. Existing Modules without `whenUsed` keep their behavior.

Extra blocks declares **Media** consent for its optional enhancement script. Tabs stay as visible sections until consent; maps make no outside request before it. The map script checks the URL's HTTPS origin, credentials, port and `/export/embed.html` path before making a sandboxed, named iframe. The manifest declares `www.openstreetmap.org`; the existing host approval and Site CSP cover it. No raw iframe markup or general embed hook is added. The script never loads in Edit, Code or Safe mode, or while the Module is off. With no JavaScript the map remains a usable link.

## Storage, translation and Markdown

A Module Block uses the existing lossless Component Block shape, for example:

```json
{"id":"questions","type":"component","component":"extra-blocks:Accordion","props":[{"name":"items","value":"[{\"heading\":\"Delivery?\",\"text\":\"Every day.\"}]"}]}
```

The Post Type's Body field stores allowed namespaced ids in its existing `components` list. This preserves existing per-field Component allowances, Drafts, co-editing and history without a migration. Markdown uses the existing PascalCase tag form, with JSON Props escaped as attributes. Unknown or unavailable types refuse new Markdown with line numbers; JSON retains unavailable existing Blocks unchanged, allowing the rest of the Entry to save and publish. Unavailable Placements render nothing, and enabling the Module brings them back. Markdown reads still retain their names and values. If an older Site Component and a newly installed Module share a tag name, Markdown writes refuse the ambiguity; JSON keeps their distinct identities, or Staff can rename the Site Component.

Automatic translation walks declared Field types, sending text/rich-text pieces and Link labels only, using the existing formatting markers and translation cache. Media ids, URLs and settings stay unchanged. Each translated Block retains its stable id, author and `source.was`; manual edits, moved Blocks and Outdated status use the existing per-Block rules. A declaration can set `translatable: false` for text that is a setting. Compiled declarations remain usable for translation while a Module is off; absent or malformed declarations leave copies pending until the Module returns.

## Site transfer

No new ID kind or allowance column is added. Stable Block ids and Module Component ids stay unchanged. The typed Component Prop declarations identify Media references inside JSON Repeater values, including retained `source.was` and history versions. Site import must remap those references while preserving literal UUID-shaped alt/caption text. The cross-Install regression test is `tests/site-transfer/extra-blocks.test.ts`.
