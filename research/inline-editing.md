# How other CMSs do inline editing on published sites

Researched 2026-11-05.

## Summary

Every mainstream CMS that supports "edit while browsing" either (a) embeds the live
frontend in an `<iframe>` inside the admin and drives it with `postMessage`/Comlink, or
(b) mounts the editor UI directly on the real page at the site's own origin with no
iframe. Editable regions are marked either by invisible metadata auto-injected into
rendered strings (stega / content source maps) or by explicit `data-*` attributes the
frontend developer adds by hand. Draft content is served either by a special
preview/draft mode that bypasses CDN caching, or by passing a version/token query
param that the frontend forwards to the CMS API at request time — both of which are
in tension with "static site on a CDN." WordPress is the outlier: its native Site
Editor does not do true inline editing on the public URL at all.

## Per-system findings

### Payload CMS — Live Preview

- **Mechanism:** iframe + `window.postMessage`. The Admin Panel renders the frontend
  in an iframe (`admin.livePreview.url`) and pushes a message on every unsaved change
  to the document. The frontend subscribes and re-renders with the pushed data.
  [Live Preview overview](https://payloadcms.com/docs/live-preview/overview)
- **Editable regions:** none marked in HTML. Live Preview is a "whole page re-renders
  with new props" model, not click-to-edit on individual fields — there is no overlay
  or field-level affordance in the docs.
- **Draft vs published:** the iframe receives *unsaved, in-memory* document data via
  postMessage, not a draft-mode HTTP request; "No need to save a draft or publish your
  changes" ([same page](https://payloadcms.com/docs/live-preview/overview)).
- **Auth reaching the site's domain:** not documented. The `url` function can read
  `req.user` server-side to decide whether to enable preview at all, but how the admin
  session reaches the iframe's origin is unspecified.
- **Static/CDN:** not addressed in the docs. Because updates arrive via postMessage
  into a page already loaded on the client, a fully static CDN page could in principle
  receive them if it has client-side JS listening — but Payload doesn't document this,
  and relative/absolute URL handling (v3) suggests they expect you to control the same
  app, not a prebuilt static export.
- **Trade-off:** simplest mental model (iframe shows your app, you listen for a
  message), no markup conventions to maintain, but no per-field click-to-edit and no
  stated CDN story.

### Sanity — Presentation tool / visual editing / stega

- **Mechanism:** iframe + Comlink (a postMessage RPC layer). The Presentation tool
  loads the frontend in an iframe, calls a draft-mode-enable endpoint with a secret
  validated by `@sanity/preview-url-secret`, which sets a cookie/session flag so
  subsequent requests read the `drafts` perspective (uncached). Field edits are saved
  to the Content Lake; the Live Content API emits a sync tag that triggers a refetch.
  [Visual editing architecture](https://www.sanity.io/docs/visual-editing/visual-editing-architecture)
- **Editable regions:** `enableVisualEditing()` scans the rendered DOM for
  **stega-encoded strings** — invisible zero-width Unicode characters appended to
  string field values that carry document ID + field path + Studio URL — and places
  transparent click-to-edit overlays over the matching elements. Stega only works on
  strings; non-string fields (images, numbers, booleans) need manual
  `createDataAttribute()` tags.
  [Client setup and stega](https://www.sanity.io/docs/visual-editing/stega)
- **Draft vs published:** published queries run through the CDN (`useCdn: true`
  default); draft queries require `useCdn: false` and are never cached, served from
  the `drafts` perspective after the draft-mode cookie is set.
- **Auth:** shared-secret handshake (preview URL secret) validated server-side, which
  then sets the draft-mode cookie/session; details of later cookie verification aren't
  fully documented.
- **Static/CDN:** published pages can stay statically generated and CDN-cached; draft
  preview explicitly cannot — it needs a server-rendered/hybrid route that can set a
  cookie and skip the CDN. A purely static export with no server has no documented way
  to show drafts.
- **Trade-off:** stega gives automatic, markup-free editability for text (no manual
  tagging), at the cost of needing UTF-8-correct responses and `stegaClean()` calls
  before using values in URLs/dates/comparisons; non-text fields fall back to manual
  attributes anyway.

### Storyblok — Visual Editor / Bridge

- **Mechanism:** iframe. Storyblok's admin loads the configured Preview URL in an
  iframe; the `StoryblokBridge` script (served from `app.storyblok.com`, also
  available as the `@storyblok/preview-bridge` package) handles the two-way
  communication (click-to-edit, outlines, context menu, reload on save/publish/input
  events). [Visual editor](https://www.storyblok.com/docs/concepts/visual-editor.md)
- **Editable regions:** the draft API response adds a private `_editable` field to
  every block/component, containing JSON (block name, space, uid, story id). The SDK
  helper `storyblokEditable(blok)` turns that into two HTML attributes —
  `data-blok-c` (stringified JSON) and `data-blok-uid` — which the bridge reads to
  know what was clicked.
- **Draft vs published:** the frontend must explicitly request `version: "draft"`
  from the Content Delivery API; the preview URL carries story id, space id,
  timestamp and a token that is a SHA-1 hash of space id + preview token + timestamp,
  valid for one hour, checked server-side.
- **Auth reaching the domain:** no cookies — access is via the signed URL parameters
  plus server-side token validation. Cross-origin embedding needs HTTPS and a CSP
  allowing `frame-ancestors https://app.storyblok.com`.
- **Static/CDN:** not addressed directly, but since draft content requires a live,
  token-checked server-side fetch, Storyblok's own guidance is to point the Visual
  Editor at a separate preview deployment of the same codebase rather than the
  production static build.
- **Trade-off:** clean separation (signed URL + server validation, no session
  cookies to worry about) but requires either a server at request time or a parallel
  preview deployment; the published, CDN-static build is untouched.

### TinaCMS — contextual/visual editing

- **Mechanism:** **no iframe.** Tina mounts its editing sidebar directly on the real
  page, same origin, same session — e.g. by visiting
  `/admin/#/~/<path>` on your own site, or by running Tina's dev server and opening
  `/admin`, which mounts a sidebar "next to your real pages."
  [tinaField docs](https://tina.io/docs/contextual-editing/tinafield);
  forum/community descriptions corroborate the no-iframe, same-page model (official
  architecture page for this wasn't found — treat with slightly lower confidence).
- **Editable regions:** the `data-tina-field` attribute, produced by the `tinaField()`
  helper applied to the object returned by the `useTina` hook. Must be applied to
  plain HTML elements, not React components (framework code has to forward it through
  a prop). Clicking a tagged element opens that field in the sidebar.
- **Draft vs published:** Tina's content is git-backed; `useTina` re-hydrates page
  data client-side so edits show immediately, and are ultimately committed to the
  repo (draft = working/unsaved form state layered over the last commit, not a CMS
  draft-mode flag).
- **Auth:** not documented in the pages fetched.
- **Static/CDN:** React-only today (Vue/Astro experimental as of late 2025), and since
  there's no iframe, editing requires the editor to load the app's own React runtime
  directly on the page — i.e. it needs a hydrated client, not a plain static HTML
  response with no JS. The published site can still be statically exported; only the
  editing session needs the live app shell.
- **Trade-off:** no cross-origin/CSP/cookie complexity at all (same origin, same
  session as the real site), but ties editing to React and to having the app shell
  loaded, and is git-commit-oriented rather than draft/publish-oriented.

### Builder.io — Visual Editor

- **Mechanism:** iframe. "Builder's Visual Editor loads your site inside a central
  iframe for real-time content editing on your live website."
  [How Builder works](https://builder.io/c/docs/how-builder-works) (fetch of this
  exact page 404'd when re-verified; summary drawn from search-indexed docs text,
  lower confidence than fetched sources above — recommend re-checking
  `/c/docs/how-builder-works` directly before relying on it).
- **Editable regions:** content is **not** markup-driven at all — it's modeled as a
  tree of "Blocks" (JSON) rendered by Builder's own renderer (`<builder-component>`)
  or compiled to code (Visual Copilot). You don't tag arbitrary HTML; you register
  custom components as Blocks and edit the Block tree.
  [Visual editor tour](https://www.builder.io/c/docs/ui-ve-tour)
- **Draft vs published:** a dedicated preview route (e.g. `/builder-preview`) renders
  the model by name; unpublished/draft content requires the SDK's
  `includeUnpublished: true` plus cache-busting — multiple forum threads report this
  flag alone being unreliable for draft content via the HTTP/HTML API, suggesting the
  documented behavior and real-world behavior diverge somewhat.
- **Auth:** not documented in pages fetched.
- **Static/CDN:** Builder explicitly does not host your site — "you control your site,
  code, and hosting; Builder only passes content to your site" — and content loads
  asynchronously after page load, which is friendly to a statically-hosted shell with
  a client-side content fetch, at the cost of a flash-of-no-content / CLS risk and the
  draft-fetch caveats above.
- **Trade-off:** fully decoupled from your HTML/CSS (good for CDN/static shells,
  since Builder content is fetched, not server-injected) but editing is constrained
  to whatever is modeled as a Block — you can't just inline-edit arbitrary existing
  markup the way Storyblok/Tina/Contentful can.

### Directus — Visual Editor (Studio module) / Live Preview

- **Mechanism:** iframe (the "Directus Studio iframe"); also usable from the item
  detail page's Live Preview pane.
  [Studio module](https://directus.com/docs/guides/content/visual-editor/studio-module)
- **Editable regions:** a `data-directus` attribute on frontend elements, whose
  `mode` value (`drawer` | `modal` | `popover`) controls how the editor surfaces that
  field — via the **Visual Editor Frontend Library**.
- **Draft vs published:** the Studio/preview URL can include a `{{$version}}` token;
  it resolves to `published` by default, or to a named Content Version (including the
  special `Draft` version). The frontend must read this param and request
  `/items/<collection>/<id>?version=<key>` itself — Directus does not swap content
  for you. Items with no version record show published content, read-only.
- **Auth/transport:** requires `CONTENT_SECURITY_POLICY_DIRECTIVES__FRAME_SRC` on the
  Directus server to include the site's origin (CSP `frame-ancestors`), and the site
  must return a matching CSP header; editing is gated by the acting user's field-level
  permissions. No cookie/token mechanism for the iframe itself is documented.
- **Static/CDN:** not addressed; since draft display depends on the frontend making a
  live, version-parameterized API call, a purely static/CDN-cached build would need a
  server or client-side fetch layer to honor `?version=`, and `CACHE_AUTO_PURGE` must
  be on or the API cache can serve stale draft data.
- **Trade-off:** reuses the general-purpose Directus permission system (no separate
  preview-token scheme) but pushes version-handling logic into every frontend
  integration, and is CSP-fragile (misconfigured `frame-ancestors`/`frame-src` is the
  most common failure mode per the docs).

### Contentful — Live Preview / Inspector Mode

- **Mechanism:** iframe ("the live preview iframe"); the SDK (`@contentful/live-preview`
  on npm) is required for live updates and inspector mode (side-by-side preview alone
  needs no SDK).
  [Live preview](https://contentful.com/developers/docs/tutorials/preview/live-preview.md),
  [Inspector mode](https://contentful.com/developers/docs/tutorials/preview/inspector-mode.md)
- **Editable regions — two options:**
  1. **Content Source Maps** (Premium-plan feature): the Preview/GraphQL API returns
     source maps; `encodeGraphQLResponse`/`encodeCPAResponse` embed them as invisible
     Unicode characters in the rendered strings (same stega-style idea as Sanity's).
     Covers text/Rich Text/asset alt-text; skips URLs, ISO dates, enum-like fields.
  2. **Manual tagging** (all plans): add `data-contentful-entry-id` /
     `data-contentful-field-id` (`data-contentful-asset-id` for assets) yourself;
     helpers `ContentfulLivePreview.getProps` / `useContentfulInspectorMode` generate
     them.
- **Draft vs published:** Preview API (draft) vs Content Delivery API (published) are
  separate endpoints/tokens; which one a given render uses is an app-level choice
  (e.g. Next.js `draftMode()`).
- **Auth reaching the domain:** cookie-based — the docs specifically require
  `SameSite=None; Secure` on authorization cookies so the browser sends them inside
  the cross-origin iframe; without permissive framing headers, SSO won't work and the
  preview shows "Refused to connect."
- **Static/CDN:** not stated either way. The SDK's reliance on preview-mode cookies
  and either SSR (`draftMode()`) or client-side scanning of manually-tagged markup
  means a static page can still host inspector-mode tags, but genuinely fresh draft
  *content* needs a preview-aware render path, not a long-lived CDN-cached response.
- **Trade-off:** offers both an automatic (stega-like) and a manual tagging path,
  which is flexible but means two different integration stories to maintain; the
  `SameSite=None` cookie requirement is a real constraint on hosting setups with
  strict cookie/CSP policies.

### WordPress — block themes / Site Editor

- **Mechanism:** WordPress core's Site Editor is **wp-admin only** — editors work on
  `/wp-admin/site-editor.php`, not on the public URL. Block themes store customizations
  as theme.json/template overrides in the database; "editing the live page while
  browsing it" in the sense this research is scoped to does not exist natively.
  (Primary WP source confirms Site Editor blocks are edited within the editor
  environment, not a corroborated true live-URL overlay —
  [Site Editor docs](https://wordpress.org/documentation/?p=15201243).)
- **Draft vs published:** standard WP revision/draft/publish post-status model;
  nothing iframe- or overlay-specific.
- **Static/CDN:** WordPress itself is PHP-rendered per request; a block theme site
  served statically via a cache/CDN would need the same "bypass cache for the editor,
  cache for everyone else" split as the other systems, but this isn't a feature WP
  documents — it's the hosting layer's problem.
- **Trade-off:** no cross-origin bridge needed at all (editing happens in wp-admin,
  same install), but it is not "browse-the-live-site-and-click-to-edit" the way the
  headless/JAMstack-era tools above are — it's closer to WebCraft's existing
  "separate admin form" baseline that Inline Editing is meant to improve on.

## Patterns comparison table

| Pattern | How editable regions are found | Draft/published serving | Auth across origins | Works on static/CDN site? | Examples |
|---|---|---|---|---|---|
| **A. Iframe + postMessage/RPC bridge** | Bridge script reads whatever marking convention the frontend uses (attrs or stega) inside the embedded page | Iframe is pointed at a preview-mode URL/deployment that bypasses cache and reads draft content | Cross-origin: needs permissive `frame-ancestors`/CSP, often `SameSite=None; Secure` cookies or a signed token in the URL | Only the *preview* render needs to be dynamic; published pages can stay static/CDN-cached, but draft preview typically can't | Payload, Storyblok, Directus, Contentful, Sanity (Presentation tool uses iframe) |
| **B. Automatic content-source-map / stega tagging** | Invisible metadata auto-injected into rendered string values by the CMS client; overlay script decodes it — no manual markup | Requires an uncached "drafts" perspective/query; explicitly incompatible with CDN caching for the draft path | Secret/token handshake sets a draft-mode cookie or session flag | Published: yes (CDN-safe, metadata strips cleanly). Draft preview: no, needs live/dynamic render | Sanity (stega), Contentful (Content Source Maps) |
| **C. Manual data-attribute convention** | Frontend developer explicitly adds `data-*` attrs (or an `_editable` blob) per field/block; CMS script scans for them | Independent of this pattern — paired with whichever draft mechanism (A) the CMS uses | Independent of this pattern | Yes for the *markup*, since the attributes are just static HTML; the draft-content fetch is still the limiting factor | Storyblok (`data-blok-*`), TinaCMS (`data-tina-field`), Contentful (manual attrs), Directus (`data-directus`) |
| **D. Same-origin, no-iframe sidebar on the real page** | Editor UI mounted directly on the live route (same session, same JS runtime); field linking via an attribute read by the mounted app itself | Content is whatever the running app already has (often git-backed working state, not a CMS draft flag) | None needed — same origin, same cookies/session as the real site | Needs a hydrated client app at edit time; the *published* output can be static, but editing requires the app shell, not a bare static HTML response | TinaCMS |

(WordPress and Builder.io don't map cleanly onto A–D: WordPress edits happen in
wp-admin, not on the live URL at all; Builder.io sidesteps markup entirely by making
content a JSON Block tree rendered by its own component, which is really "block-tree
editing," a different axis from "mark up existing HTML.")

## Implications for WebCraft

Not decisions — options to weigh against WebCraft's architecture (Install → Workspace
→ Site, Sites possibly static on Cloudflare Pages with dynamic forms/webhooks):

- **If a Site is statically exported to a CDN**, every pattern above needs *some*
  non-static path for the editing session itself: either (a) a separate
  preview/draft deployment or route that bypasses the CDN (Sanity/Storyblok's
  approach), or (b) a client-side fetch-and-patch layer that calls back to the admin
  Install for draft content while the cached HTML shell stays static (closer to
  Builder.io's async content loading). WebCraft would need to pick one rather than
  assume CDN-static and inline-editable are free to combine.
- **Iframe (pattern A) vs same-origin (pattern D)** is close to WebCraft's core
  deployment question: if admin.agency.com and the Site's own domain are genuinely
  different origins (per the Glossary's Install/Workspace/Site split), an iframe
  bridge is the only option that doesn't require shipping the admin's JS runtime onto
  the client's domain — but it inherits every CSP/cookie/`frame-ancestors` headache
  documented above (Directus and Contentful both flag this as their most common
  failure mode). A same-origin approach (TinaCMS-style) avoids that but likely means
  injecting an editor bundle into the Site's own served pages, which cuts against
  "static on a CDN."
  - A middle option not represented above: a **small same-origin script, served from
    the Site's own domain, that opens a cross-origin connection back to the admin**
    (e.g. via `window.open`/`postMessage` to a popup, or a signed short-lived token)
    rather than an iframe showing the whole admin, or the whole Site showing inside
    the whole admin.
- **Marking convention (B vs C):** automatic/stega-style tagging (pattern B) means
  Module authors get inline-editability "for free" on any text field with zero markup
  work, at the cost of real engineering (Unicode-safe pipelines, `stegaClean()`-style
  stripping before using values in URLs/attributes) and it degrades to manual tagging
  for non-string fields anyway. Manual `data-*` attributes (pattern C) are simpler to
  implement and reason about but put the tagging burden on every Module/template
  author, which may or may not fit the "Module = self-contained feature package"
  boundary in the Glossary.
- **Draft/version model:** Sanity/Contentful/Directus all separate "draft" from
  "published" as a first-class server concept (perspective, version, CPA vs CDA);
  Payload instead streams *unsaved, in-memory* edits via postMessage without any
  server-side draft state; TinaCMS treats "draft" as git working-tree state. WebCraft
  should decide early whether Inline Editing implies a true draft/publish content
  state per Site (closer to Sanity/Contentful/Directus) or a direct-write model
  (closer to Payload's live, unsaved preview, or TinaCMS's git commits) — this choice
  cascades into caching, CDN invalidation, and what "publish" even means for a Site
  that's static on Cloudflare Pages.
- **Permission model:** Directus ties editability to its existing field-level
  permission system rather than a separate preview-token scheme; this is closer to
  how WebCraft's Member/role model (per Glossary) could plug in, versus Storyblok's
  signed-URL-plus-server-validation approach which needs no session at all.
- **Scope of what's editable:** Storyblok/TinaCMS/Contentful/Directus all let you
  inline-edit *whatever markup already exists* (attribute-driven); Builder.io instead
  requires content to be modeled as its own Block tree rendered by its own component —
  trading markup freedom for a cleaner CDN/static story. WebCraft's Module system
  could go either way per Module, or standardize on one.

## Sources

- Payload: https://payloadcms.com/docs/live-preview/overview
- Sanity: https://www.sanity.io/docs/visual-editing/visual-editing-architecture ,
  https://www.sanity.io/docs/visual-editing/stega
- Storyblok: https://www.storyblok.com/docs/concepts/visual-editor.md
- TinaCMS: https://tina.io/docs/contextual-editing/tinafield (official docs); broader
  architecture claims corroborated only by secondary/community sources (Vercel
  changelog, Astro starter blog, forum posts) — flagged inline above as lower
  confidence.
- Builder.io: https://www.builder.io/c/docs/how-builder-works (search-indexed text;
  direct refetch 404'd — re-verify before relying on it),
  https://www.builder.io/c/docs/ui-ve-tour , Builder forum threads on
  `includeUnpublished`/draft preview (community reports, not official docs)
- Directus: https://directus.com/docs/guides/content/visual-editor/studio-module
- Contentful: https://contentful.com/developers/docs/tutorials/preview/live-preview.md ,
  https://contentful.com/developers/docs/tutorials/preview/inspector-mode.md
- WordPress: https://wordpress.org/documentation/?p=15201243 (Site Editor, official)
