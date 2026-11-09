# WebCraft

An open-source, multi-tenant CMS where agencies build websites and their clients edit them while browsing the live site.

## Language

### Tenancy

**Workspace**:
One client organisation, such as a company an agency builds websites for. It owns its Members and its Sites.
_Avoid_: Tenant, account, organisation, team

**Site**:
One website inside a Workspace, with its own domains, layout, pages, content, media, forms and email settings.
_Avoid_: Project, website, app

**Member**:
A person with access to a Workspace, holding a role within it.
_Avoid_: User (when meaning access to a Workspace), collaborator

**Install**:
One running copy of WebCraft, self-hosted by one agency, containing all of that agency's Workspaces.
_Avoid_: Instance, deployment, server

**Superadmin**:
A person who administers a whole Install, above every Workspace.
_Avoid_: Admin (ambiguous), owner, root

**Staff**:
A person from the agency that runs the Install, working on the Workspaces they are assigned to. Staff are not Members and never hold a Membership; agency people who should only edit Content join a Workspace as Members instead.
_Avoid_: Agency member, developer, team

**Membership**:
A Member's place in one Workspace: their Workspace role and the Sites they can reach. One person can hold Memberships in several Workspaces.
_Avoid_: Seat, access

### Workspace roles

**Owner**:
The client-side administrator of a Workspace, who manages its Members and can publish.
_Avoid_: Admin, client admin

**Editor**:
A Member who edits and publishes content.
_Avoid_: Publisher, manager

**Author**:
A Member who edits content and saves drafts but cannot publish.
_Avoid_: Contributor, writer

### Change layers

**Content**:
What clients always change: the text and media of entries and Pages, Loop items, translations, Protected terms, form submissions, and where form submissions are sent.
_Avoid_: Data, copy

**Page layout**:
The Components placed in a Page's content area, with their Prop values. Clients may change it only where the agency allows it for that Site, and only with the Components the agency allows (Allowed components). The Page template's header and footer are never part of it.
_Avoid_: Design, structure, builder access

**Structure**:
Everything that shapes a Site: Post Types, Fields, Loops, templates, components, Forms, design tokens, code and Site settings such as domains, SMTP and languages. Only the Superadmin and Staff change it.
_Avoid_: Schema, setup, configuration

**Permission**:
One named thing a person may do, such as publishing an Entry, uploading Media or inviting a Member. Every role (Superadmin, Staff, Owner, Editor, Author) is a fixed set of Permissions.
_Avoid_: Capability, right, ability

### Content model

**Post Type**:
A kind of Entry a Site holds, such as Pages, blog posts or team members, with its own Fields. Each Post Type belongs to one Site.
_Avoid_: Collection, content type, model, CPT

**Entry**:
One record of a Post Type, holding values for that Post Type's Fields.
_Avoid_: Post, item, document, record

**Page**:
An Entry of the built-in Page Post Type, arranged with a Page layout rather than rendered through a template.
_Avoid_: Screen, view

**Globals**:
A Site's own set of Fields, such as its phone number, address or footer text, that any Template or Component can show. Staff define the Fields; clients edit the values.
_Avoid_: Site settings (those are Structure), options, site info

**Field**:
One named value that every Entry of a Post Type (or every Loop item) carries, such as a title, a price or an image.
_Avoid_: Attribute, property, column, custom field

**Group**:
A Field that holds a fixed set of other Fields.
_Avoid_: Object, fieldset

**Repeater**:
A Field that holds an ordered list of Groups.
_Avoid_: Array, list field

**Relationship**:
A Field that points at one or more Entries of chosen Post Types. It is two-way by default, so the Entries pointed at show the link back, or one-way when Staff choose.
_Avoid_: Reference, link, foreign key

**Body field**:
A Field that holds the long-form main text of an Entry, such as a blog article, as a list of Blocks written in a block editor. A Post Type has at most one, and Pages never have one.
_Avoid_: Content (a change layer), post, article, rich text (a separate Field type for short formatted text)

**Block**:
One unit of a Body field, such as a paragraph, a heading, an image, a table or a placed Component. Not to be confused with a Component, which is never called a block.
_Avoid_: Node, element, section

**Block type**:
A kind of Block, such as a callout or a gallery. Core provides the standard set; a Module can add more, each defined by settings made of Fields and output written in Template markup.
_Avoid_: Block (that is one placed instance), widget, shortcode

**Translatable field**:
A Field that holds a separate value for each of the Site's languages. All other Fields hold one value shared by every language.
_Avoid_: Localised field, i18n field

**Loop**:
A repeated part of a Site that renders the same markup, usually a Component, once per item, with optional content to show when there are no items. Its items come from a query over Entries, from the Loop's own list of Loop items, or from a Repeater or Relationship on the current Entry.
_Avoid_: Query, list, collection, repeater

**Loop item**:
One item in a Loop's own list, with values for the Fields the Loop defines. Clients change Loop items; Staff define the Loop.
_Avoid_: Row, entry (a Loop item is not an Entry)

**Template**:
An arrangement of elements, built by Staff in the admin, that renders part of a Site. There are three kinds: Site template, Entry template and Archive template.
_Avoid_: Theme, view, layout

**Site template**:
The Template that wraps every page of a Site, holding its header, footer and the place where the page's content goes.
_Avoid_: Master page, shell, layout

**Entry template**:
The Template that renders a single Entry of a Post Type.
_Avoid_: Single template, detail view

**Archive template**:
The Template that lists the Entries of a Post Type.
_Avoid_: List template, index view

**Component**:
A reusable arrangement of elements, built by Staff in the admin, that can be placed in Templates and Page layouts.
_Avoid_: Block, widget, partial, symbol

**Prop**:
A value a Component asks for, filled in separately wherever the Component is placed. Props use the same types as Fields.
_Avoid_: Parameter, attribute, setting

**Placement**:
One Component placed in a Page layout or Template, with its own Prop values. The same Component can have many Placements.
_Avoid_: Instance, usage, block

**Allowed component**:
A Component that Staff have switched on for Members to add to Page layouts on one Site. Switching one off stops new Placements; existing ones stay.
_Avoid_: Whitelisted component, available block

**Locked placement**:
A Placement that Staff have fixed in a Page layout. Members can still edit its Content and Props but cannot move, hide or remove it.
_Avoid_: Pinned block, fixed section

**Hidden placement**:
A Placement a Member has hidden on its Page. It stays in the Draft, shown faded in Edit mode, but is not rendered for visitors.
_Avoid_: Disabled block, draft section

**Condition**:
A rule that shows or hides an element depending on a Field or Prop value, the current language, the date, or the element's position in a Loop.
_Avoid_: Visibility rule, display logic

**Template markup**:
The written form of a Template or Component: HTML plus WebCraft's notation for Fields, Props, Loops, Components and Conditions. Staff read and write it in Code mode, the builder's code view, export files and through AI clients.
_Avoid_: Template language, source code, HTML view

**Template command**:
A built-in instruction in Template markup, written with `@`, such as a Loop, a Condition, the content outlet, pagination, a Form, a Filter or a popup. Tags written in PascalCase are always the Site's own Components, never Template commands.
_Avoid_: Directive, tag, helper, shortcode

**Media image**:
An image from a Site's media library, placed through a media Field or as a fixed item, that WebCraft resizes and outputs with its sizes, formats and alt text.
_Avoid_: Dynamic image, uploaded image

**Decorative**:
A setting on a placed image saying it carries no meaning, so WebCraft gives it empty alt text and screen readers skip it. Every image is either Decorative or has alt text; an image with neither raises a Check.
_Avoid_: Presentational, no-alt, hidden image

**External image**:
An image referenced by an outside `https` address, which WebCraft outputs exactly as written and never fetches or resizes.
_Avoid_: Remote image, hotlinked image

**Media library**:
A Site's own collection of uploaded files (images, SVGs, documents, audio and video), organised in folders. A file is never shared between Sites: copying it to another Site makes a separate copy. Changes to it go live at once, with no Draft.
_Avoid_: Asset manager, uploads, file manager, shared library

**Focal point**:
The spot on a Media image that must stay visible whenever a design shows the image at a different shape. Set once per image and shared by every language.
_Avoid_: Crop, hotspot, anchor

**Form upload**:
A file a visitor attaches to a Form Submission. It is private: it never enters the Media library, has no public address, can only be downloaded through the admin by people who may see that Form's Submissions, and is deleted with its Submission.
_Avoid_: Private media, attachment (except in a Notification email)

### Importing

**Import**:
A saved way of bringing outside content into one Site: its source (a WordPress export file, a live WordPress site, or a CSV file) and how that source maps onto Post Types and Fields. It can be run more than once.
_Avoid_: Migration, sync, Site export (that moves a WebCraft Site)

**Import run**:
One run of an Import, which creates or updates Draft Entries, Media and Redirect rules. A run can be undone as a whole until anything it brought in is published or edited.
_Avoid_: Job, batch, sync

**Import report**:
The record of an Import run: what was created, updated or skipped, which source fields were left unmapped, which files could not be fetched, and its Import leftovers.
_Avoid_: Log, import log

**Import leftover**:
A piece of source content that had no matching Block type, such as a shortcode or page-builder markup, kept as plain text and listed in the Import report for someone to fix.
_Avoid_: Unknown block, error, orphan

**Source id**:
The identifier an imported Entry or Media item had in the place it came from, kept so a later Import run updates it instead of creating a copy.
_Avoid_: External id, legacy id, original id

### Styling

**Design system**:
A Site's Design tokens, Classes, base styles, custom CSS and Dark mode setting, published together as one item. It is Structure, so clients never change it.
_Avoid_: Theme, style guide, global styles

**Design token**:
A named design value of a Site, such as a colour, a spacing step, a type size, a radius or a breakpoint, that styles refer to instead of raw values.
_Avoid_: Variable, setting, style value

**Class**:
A named set of styles that Staff create in the builder and give to elements, so every element with that Class looks the same.
_Avoid_: Style, preset, global style

**Generated Class**:
A Class WebCraft makes from a one-off inline style in Template markup, so pages never carry inline styles. It goes live with the Template that made it, and stops being generated once Staff change it.
_Avoid_: Inline class, auto class

**Token utility**:
A class made from one Design token for one property, such as a background colour or a padding, that elements can be given like a Class. Only the token utilities published elements use are sent to visitors.
_Avoid_: Utility class, helper class, atomic class

**Dark mode**:
A Site's dark values for its colours, which follow the visitor's device and an optional theme toggle.
_Avoid_: Night mode

### Publishing

**Publish**:
To make the draft version of an Entry, the Globals, a Template, a Component, a Form or the Design system the version visitors see. Each one is published on its own.
_Avoid_: Deploy, release, go live, push

**Draft**:
The version of an Entry, the Globals, a Template, a Component, a Form or the Design system that is being changed and that visitors don't see until it is published.
_Avoid_: Working copy, unpublished version

**Publish all**:
To publish, in one go, every Draft of a Site that the person is allowed to publish, after reviewing the list of what will change.
_Avoid_: Push live, deploy, release

**Staging address**:
A Site's address on the agency's own domain, showing the Site with all its Drafts so the agency and its client can review work before it is published. Search engines are told to ignore it.
_Avoid_: Staging site, dev site, preview URL, test site

**Revision**:
A saved copy of an item, taken each time it is published, that people can compare with the Draft and restore into it. Restoring never publishes. Revisions can be turned off for an Install or for one Post Type.
_Avoid_: Version, history entry, backup

**Checkpoint**:
A saved copy of an item's Draft, taken while it is being edited, so a Draft that was changed or written over can be got back before it is published.
_Avoid_: Autosave, snapshot

**Scheduled publish**:
A publish set to happen at a later time. It publishes the version that existed when it was scheduled, not later edits. It covers one item or a Publish all set. Entries can also be scheduled to unpublish.
_Avoid_: Release, timed post, embargo

**Review**:
The step where an Author submits a Draft and an Editor, Owner or Staff member publishes it or sends it back with a comment. While it waits, the item is In review.
_Avoid_: Approval workflow, moderation

**Co-editing**:
Several people, AI clients or AI translation changing the same Draft at the same time, each seeing the others' changes as they happen. Drafts are never locked.
_Avoid_: Collaboration mode, multiplayer, edit lock

**Primary domain**:
The one domain a Site is served on. Its other domains redirect to it.
_Avoid_: Main domain, live URL

**Redirect domain**:
A domain attached to a Site that sends visitors to the same path on the Site's Primary domain, such as `www` or an old domain.
_Avoid_: Alias, secondary domain, parked domain

**Webhook**:
A call the Install makes to an outside address when something happens on a Site, such as a form being submitted or an Entry being published.
_Avoid_: Callback, hook, integration

**Delivery log**:
The record of every call a Webhook made in the last 30 days: what was sent, each attempt, and what the receiving system answered. Staff send a failed delivery again from it.
_Avoid_: Webhook history, event log, call log

### Search and discovery

**SEO fields**:
The fields every Entry has for search engines and social sharing: SEO title, description, canonical URL, noindex and social image. Empty ones fall back to patterns Staff set per Post Type.
_Avoid_: Meta tags, SEO settings, SEO box

**Social card**:
The image WebCraft generates for an Entry that has no social image, from a layout chosen out of a built-in set, filled with the Entry's title and the Site's logo and colours.
_Avoid_: OG image, share image, preview image

**Schema type**:
The kind of thing a Post Type's Entries describe to search engines (Article, Product, Event and so on), with each property mapped to a Field. WebCraft outputs it as structured data on every page.
_Avoid_: Rich snippet, schema markup, JSON-LD type

**Redirect rule**:
A rule on a Site that sends visitors from one path to another, added by people on the Redirects screen or by WebCraft when a published slug changes. It is Content. Not to be confused with a Redirect domain, which redirects a whole domain.
_Avoid_: Redirect, 301, URL forward

**404 log**:
The list of paths on a Site that visitors asked for and that didn't exist, with hit counts, from which a Redirect rule can be added.
_Avoid_: Broken links report, error log

**Site search**:
The search that visitors run on a Site, over the indexable Entries of the Post Types Staff mark as searchable, in the visitor's language. It is a Filter with only a search box, on the Site's search results page.
_Avoid_: Search engine, full-text search, finder

**Searched fields**:
The Fields of a Post Type that Site search and every Filter's search box look in, each with a weight, set once on the Post Type.
_Avoid_: Search index, indexed fields

**Check**:
A warning WebCraft shows while a Template, Component, Entry or the Design system is edited, such as a page with two main headings, an image with no alt text that is not Decorative, vague link text, or a colour pair with too little contrast. Every Site has one list of its open Checks. Checks never stop publishing.
_Avoid_: Lint, error, validation, audit

**Accessibility statement**:
An optional Page on a Site, built from a short form Staff fill in, that states how accessible the Site is, what is known not to be, and how visitors can report problems. It follows the EU model statement for public-sector websites and is not a declaration of conformity under the European Accessibility Act.
_Avoid_: Accessibility page, conformance declaration, VPAT

### Forms

**Form**:
A set of fields, sections and optional steps that visitors fill in on a Site. It belongs to one Site, is Structure built by Staff, and is placed on pages with a Form element.
_Avoid_: Contact form, form block, form widget

**Submission**:
One filled-in Form as received by the Install, kept with the language and page it came from.
_Avoid_: Entry, lead, response, message

**Notification**:
An email the Install sends to a Form's recipients when a Submission arrives. The recipients are Content.
_Avoid_: Alert, form email

**Auto-reply**:
An email sent back to the person who filled in a Form, in the language they used.
_Avoid_: Confirmation email, autoresponder

### Email

**System email**:
An email WebCraft itself sends to a person with an account, such as an invite, a password reset, a security notice or a Review request. It always goes through the Install's own email settings, uses fixed wording in the person's Admin language and carries the Install branding.
_Avoid_: Transactional email (too broad), notification (that is a Form email), alert

**Install branding**:
The sender name, logo, accent colour and footer text the Superadmin sets for every System email of an Install.
_Avoid_: White label, email theme, agency branding

**Email log**:
The record of every email an Install sends, one line per email with its type, recipient, subject, status and the mail server's last answer, but never its body. Each person sees only the lines for what they can reach.
_Avoid_: Mail log, delivery report, outbox

### Filters

**Filter**:
A set of controls that visitors use to narrow, search and sort the items of one query Loop on a Site. It belongs to one Site and is Structure built by Staff; its labels, placeholders and no-results text are Content.
_Avoid_: Facet set, search form, faceted search

**Filter control**:
One part of a Filter, such as a search box, checkboxes, a range, a sort menu or a reset link. Its controls can sit anywhere on the page but always act on the Filter's one Loop.
_Avoid_: Facet (a facet is one kind of Filter control), widget, field (a Field is a value on an Entry)

### Popups

**Popup**:
Content that opens over a Site's page, shown as a Modal, a Slide-in, a Bar or full screen. It belongs to one Site and is Structure built by Staff; its text and media, whether it is on, and its start and end dates are Content.
_Avoid_: Modal (that is one Popup layout), lightbox, overlay, interstitial. The Consent banner is never a Popup.

**Trigger**:
What opens a Popup, such as loading the page, scrolling, trying to leave, staying idle or clicking a link that points at it.
_Avoid_: Event, activation

**Display rule**:
A rule saying on which pages, in which languages, on which devices and for which visitors a Popup may show.
_Avoid_: Targeting rule, audience, condition (that is a Template command)

### Translation

**AI translation**:
Machine translation of a Site's content into its other languages by an AI model.
_Avoid_: Auto-translate, machine translation

**Protected term**:
A word or phrase that AI translation must leave exactly as written, such as a brand or product name. A Workspace keeps a list for all its Sites, and each Site keeps its own.
_Avoid_: Glossary entry, do-not-translate list, exclusion

**Default language**:
The language a Site is written in first. Its URLs have no language prefix, and other languages fall back to it one Field at a time.
_Avoid_: Main language, source language, primary locale

**Language visibility**:
Whether an Entry exists in one of the Site's languages. When it is off, the Entry has no page, no Loop place and no sitemap line in that language.
_Avoid_: Translation status, published languages

**Translation mode**:
How one Site language is kept up to date: Automatic (AI translation is published together with the default-language change), Review (AI translation lands in the Draft for a person to publish) or Manual (people translate).
_Avoid_: Auto-translate setting, sync mode

**Outdated translation**:
A translated value written by a person whose default-language source has changed since. It is never overwritten on its own; someone re-translates or confirms it.
_Avoid_: Stale, untranslated, dirty

**Language switcher**:
An element Staff place on a Site that links to the same page in each of the Site's other languages, or to that language's home page when the page doesn't exist in it.
_Avoid_: Language picker, locale menu, flags

**Admin language**:
The language one person sees the admin and their own emails in, chosen in their profile, separate from any Site's languages.
_Avoid_: Locale, UI language

**AI key**:
The credential WebCraft uses to call an AI provider. Each Workspace has its own, unless the Superadmin assigns a shared one, which comes with a monthly spending cap.
_Avoid_: API key (too generic), token

### Features

**Inline editing**:
Changing a Site's content while browsing the Site itself, rather than through a separate admin form.
_Avoid_: Frontend editing, live editing, visual editing

**Edit mode**:
A way of viewing a Site on its own domain that shows Drafts and lets a signed-in person change Content in place. Previewing is Edit mode with the editing tools turned off.
_Avoid_: Preview mode, draft mode, admin bar

**Code mode**:
A third way of using Edit mode, for Staff and the Superadmin only: selecting an element on the page opens its HTML (from its Template or Component), its CSS (its Class or the Site CSS) and a page or Site script, all editable and saved to the Draft.
_Avoid_: God mode, dev mode, developer tools

**Safe mode**:
Edit mode with none of the Site's own scripts running, so a broken script can never lock anyone out of editing.
_Avoid_: Recovery mode, scriptless mode, debug mode

**Site script**:
A script that runs on every page of a Site: the one Staff write for the whole Site in Code mode, or one a Module adds. Like every script on a Site, it is a file served from the Site's own domain, never written into the page.
_Avoid_: Global script, custom code, header code

**Page script**:
A script Staff write in Code mode for one page, which runs there only, after the Site script. Both are Structure, with a Draft, published like a Template.
_Avoid_: Inline script, page code

**Library**:
A ready-made script package, such as an animation library, that Staff add to a Site at a fixed version. WebCraft keeps its own copy and serves it from the Site, so it never changes unless Staff update it.
_Avoid_: Package, dependency, vendor script, CDN script

**Outside script**:
A script loaded live from another host or pasted as a third-party snippet, such as a tag, pixel, tag manager or chat widget. It can change at any time, so it never runs in Edit mode.
_Avoid_: Third-party script, tag, external script

**API token**:
A credential a person creates so a script or AI client can act as them within one Workspace, never with more access than they have.
_Avoid_: API key (that is an AI key or a provider's credential), access key, PAT

**AI client**:
An outside AI app or agent that works with an Install on a person's behalf, after they approve it or give it an API token.
_Avoid_: Bot, integration, agent (too generic)

**Toolset**:
A named group of related actions, such as Content, Media, Structure, Publishing or Submissions, that a person switches on for an AI client or API token. The client can only use the actions in the Toolsets switched on, and only those the person may do.
_Avoid_: Scope, capability, plugin

**Sensitive action**:
An action that needs a fresh password, passkey or 2FA check, such as changing secrets, creating API tokens, changing roles or Site access, or deleting a Site or Workspace. AI clients and API tokens can never perform one.
_Avoid_: Admin action, dangerous action

**Management API**:
WebCraft's documented, versioned API for changing and reading an Install as a person, used by the admin, the MCP server, the CLI and agencies' own scripts through API tokens.
_Avoid_: Admin API, private API, internal API

**Content API**:
A Site's read-only, versioned API that gives frontends built elsewhere its published content. Staff switch it on per Site, and it never shows Drafts.
_Avoid_: Headless API, delivery API, public API, REST API

**Content key**:
A revocable key Staff create for one Site so a frontend built elsewhere can read that Site's published content through the Content API. It grants nothing else, so it is safe in browser code.
_Avoid_: Public key, API key, API token (that acts as a person)

**Module**:
A self-contained feature that plugs into WebCraft only through the Module SDK and can be switched off without breaking a Site. v1 ships only first-party Modules (Site analytics, Forms, Popups, Redirects and 404 log); third-party Modules come later and will always run in a sandbox.
_Avoid_: Plugin, extension, add-on, app

**Core**:
The part of WebCraft that is not a Module and cannot be switched off: tenancy, roles, security, the content model, Template markup and the renderer, the Design system, publishing, languages, SEO, Filters, Media and the API.
_Avoid_: Kernel, platform, base

**Module SDK**:
The one published, versioned package a Module may use to reach WebCraft. It is the "public Module boundary" named in the licence.
_Avoid_: Plugin API, hooks, extension API

**Consent screen**:
Where the Superadmin reads, in WebCraft's own words, everything a Module asks for (the Permissions it gives roles, the outside hosts it calls, sending email, a Site script) and approves it. A Module runs only once approved, and an update that asks for more waits, switched off, until it is approved again.
_Avoid_: Permission prompt, install dialog. Not the Consent banner, which asks visitors.

**Module log**:
The record of what each Module wrote and of everything that went wrong while it ran, such as a background job that failed, kept for 90 days and read by the Superadmin.
_Avoid_: Error log (that is the Install's unexpected failures), Audit log (that is who did what)

**Impersonation**:
Superadmin or Staff acting in the admin as a particular Staff member or Member, for a limited time, with every action recorded under both names.
_Avoid_: View as, log in as, masquerade

**Audit log**:
The permanent record of security-relevant actions on an Install: who did what, where, when, and through which way in (the admin, Edit mode, an API token or an AI client).
_Avoid_: Activity feed, history, event log

### Running an Install

**Master key**:
The secret an Install is started with that encrypts every stored secret (SMTP passwords, AI keys). It is never stored in the database or in a Backup, so losing it makes those secrets unreadable.
_Avoid_: Encryption key, app secret, salt

**Backup**:
A copy of a whole Install, its database plus locally stored Media and Form uploads, from which the Install can be restored. It never contains the Master key.
_Avoid_: Snapshot, dump, export (that is one Site)

**Site export**:
A file holding one Site, its Structure, Content, Media, history, Submissions and Members, used to copy it into a Workspace on the same or another Install. Importing always creates a new Site. It is not a Backup.
_Avoid_: Clone, site template, migration, transfer

**Install health**:
The Superadmin's view of whether an Install is working: its web and worker processes, database, job queue, storage, Backups, email settings, Site domains and Error log, each shown as OK, Warning or Failing.
_Avoid_: Status page, dashboard (that is analytics), monitoring

**Error log**:
The list of unexpected failures on an Install, grouped by cause, each with a count, when it was first and last seen, and the Workspace and Site involved. Only the Superadmin sees it.
_Avoid_: Crash report, exceptions, 404 log (that is missing pages)

**Domain check**:
The regular test, run for every live Site domain, that the domain still points at the Install and has a valid certificate. A domain that fails it is marked Unreachable.
_Avoid_: Uptime monitor, ping, Site check

**Health alert**:
The notice the Superadmin gets when part of the Install turns Failing and again when it recovers, as a System email that can't be turned off and a banner across the admin.
_Avoid_: Alarm, incident, notification (that is a Form email)

### Analytics

**Site analytics**:
The visits, page views and events WebCraft counts on a Site with its own tracking, shown to Staff and the Site's Owners.
_Avoid_: Stats, traffic, tracking (that is how it is collected)

**Goal**:
Something a visitor does on a Site that counts as a result: a Form Submission, a visit to a page, a click on an outbound, download, phone or email link, or a custom event. Goals are Structure.
_Avoid_: Conversion (that is a Goal being reached), target, KPI

**Funnel**:
An ordered list of two to five Goals or page visits, showing how many visitors in one visit reach each step.
_Avoid_: Journey, flow, path

**Dashboard**:
A grid of Widgets showing a Site's analytics, or all of a Workspace's Sites added together. Staff build dashboards; Owners view them.
_Avoid_: Report (that is the scheduled PDF), board, overview

**Widget**:
One chart, table, number or note on a Dashboard, chosen from WebCraft's built-in set, with its own date range and filters.
_Avoid_: Card, tile, panel, block (a Block belongs to a Body field)

**Report**:
A PDF made from a Dashboard on a schedule and emailed to its recipients, with AI-written explanations and suggestions.
_Avoid_: Export, digest, summary

**Share link**:
A link, with an optional password and expiry date, that lets someone without an account explore a Dashboard without changing it.
_Avoid_: Public link, client portal, guest access

**Services list**:
The services an agency offers, written by Staff for the whole Install, that the suggestions in Reports may point to.
_Avoid_: Offerings, products, upsells

**Consent banner**:
The notice on a Site that asks visitors which categories of tracking and outside content they accept. WebCraft's built-in banner can be replaced by an outside consent service or turned off.
_Avoid_: Cookie banner, cookie popup, GDPR notice

**Consent category**:
A group of things a visitor can accept or decline together: Necessary, Analytics, Marketing or Media. Staff put every Site script and embed in one.
_Avoid_: Purpose, cookie type

**Consent record**:
The proof of one visitor's consent choice: a random id, the time, the choices made, the banner version and the language, with nothing that identifies the visitor.
_Avoid_: Consent log entry, cookie record
