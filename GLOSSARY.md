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

### Translation

**AI translation**:
Machine translation of a Site's content into its other languages by an AI model.
_Avoid_: Auto-translate, machine translation

**Protected term**:
A word or phrase that AI translation must leave exactly as written, such as a brand or product name.
_Avoid_: Glossary entry, do-not-translate list, exclusion

**AI key**:
The credential WebCraft uses to call an AI provider. Each Workspace has its own, unless the Superadmin assigns a shared one.
_Avoid_: API key (too generic), token

### Features

**Inline editing**:
Changing a Site's content while browsing the Site itself, rather than through a separate admin form.
_Avoid_: Frontend editing, live editing, visual editing

**Module**:
A self-contained feature package that plugs into WebCraft through a defined boundary. Core features are Modules; third-party Modules come later.
_Avoid_: Plugin, extension, add-on, app
