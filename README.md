<div align="center">

# WebCraft

### The open-source CMS where agencies build the site and clients edit it, right on the live page.

Self-hosted · Multi-tenant · Visual builder + real code · Live co-editing · Headless-ready · AI-native

[Get started](#get-started-in-60-seconds) · [Deploy](docs/deploy/README.md) · [CLI](docs/cli.md) · [API](docs/api/README.md) · [Glossary](GLOSSARY.md) · [Decisions](docs/adr/)

![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)
![Runtime: Bun + Node](https://img.shields.io/badge/runtime-Bun%20%2B%20Node-black)
![Database: Postgres](https://img.shields.io/badge/database-Postgres-336791)
![Self-hosted](https://img.shields.io/badge/hosting-self--hosted-success)

</div>

---

## Why WebCraft

Agencies juggle two bad options. Hand clients a full admin panel and they break the design. Lock everything down and every typo becomes a support ticket.

WebCraft draws one clear line:

- **Your agency owns the Structure**: templates, components, design tokens, code, domains, settings.
- **Your clients own the Content**: text, images, translations, form submissions, and page layouts wherever you allow it.

Clients browse their own live site, click on what they want to change, and type. No back-office maze, no training session, no broken layouts. You stay in control of everything that matters, on your own server.

**One Install. All your clients. Every site.**

---

## What you get

### ✏️ Edit on the live site
Clients turn on **Edit mode** and change text, images and lists right on the page they are looking at. What they see is what visitors get.

### 🧱 A visual builder that writes real code
Staff design with a visual builder backed by **classes and design tokens**, not inline-style soup. Switch to **Code mode** on the live page to edit the HTML, CSS and scripts of any element: one editor, two canvases, one undo history.

### 👥 Real-time co-editing
Two people can work on the same draft at once, in forms, the block editor, the builder or Code mode. Edits merge as you type. No locks, no "someone else is editing this page".

### 🚦 Draft, stage, publish all
Every change lands in a draft first. Preview it on a **Staging address**, send a **Share link** to a client, then **Publish all** staged changes in one go.

### 🗂 A content model that grows with the site
Post Types, Fields, Groups, Repeaters, two-way Relationships, Loops, Globals and a **block editor** for long-form writing. Model a blog, a team page or a product catalogue without a plugin.

### 🌍 Multilingual from day one
Translations are stored **per field** (and per block), served under clean language path prefixes like `/fr/`, with optional **AI translation**.

### 🤖 AI built in, on your terms
Bring your own key for any major provider or any OpenAI-compatible endpoint, including self-hosted models. WebCraft tracks tokens and cost per call and enforces monthly caps per Workspace. No gateway account required.

Every Install also exposes **MCP tools** generated from its Management API, so AI clients can manage content with exactly the access you approve.

### 🔌 Headless when you want it
A read-only **Content API** for your own front ends, a full **Management API** with an OpenAPI document, signed **Webhooks**, and API tokens per person.

### 💻 A CLI that treats Structure as code
`webcraft` signs in with a device code, runs every API procedure as a command, and **pulls and pushes a Site's Structure as files**, ready for git and CI.

### 🧩 First-party Modules included
| Module | What it does |
| --- | --- |
| **Forms** | Build forms, collect submissions, route them by email |
| **Site analytics** | Privacy-first, consent-tiered analytics stored in your own Postgres |
| **Popups** | Popups and announcements, managed per Site |
| **Redirects** | Redirect rules plus a 404 log to catch broken links |
| **Extra blocks** | More block types for the block editor |
| **WordPress import** | Bring existing content across in one pass |

Build your own with the **Module SDK**. Third-party Modules always run sandboxed, and the licence lets you sell them under any terms.

---

## Built for agencies

- **Multi-tenant by design.** One Install holds every client **Workspace**, each with its own Sites, Members and settings.
- **Clear roles.** Superadmin and Staff on the agency side; Owner, Editor and Author on the client side. Every role is a fixed set of named Permissions.
- **Impersonation.** See exactly what a client sees, to support them without asking for passwords.
- **Allowed components.** Decide which components clients may place, and on which Sites.
- **Your domains, automatic HTTPS.** Point a client's domain at the Install and TLS is handled for you.

## Secure and dependable by default

- **Passkeys and two-factor sign-in**, sensitive-action re-checks and a full **Audit** log.
- **Strict Content Security Policy** with self-hosted libraries. Outside scripts never run in Edit mode.
- **Encrypted secrets** under a Master key that never goes into a backup.
- **Daily Backups**, one-command restores and a whole-Site export to move Sites between Installs.
- **Safe updates**: migrations run as a separate step, take a backup first, and keep the previous version working.
- `webcraft admin doctor` checks the whole Install and tells you what to fix.

---

## Get started in 60 seconds

You need [Bun](https://bun.sh) and a Postgres database (`docker-compose.dev.yml` starts one).

```sh
git clone https://github.com/flyingwebie/WebCraft.git && cd WebCraft
bun install
cp .env.example .env   # then set WEBCRAFT_SECRET_KEY: openssl rand -base64 32
bun run dev
```

Open the setup link the web process prints in its log, create your Superadmin, and you're in.

The full developer guide (commands, environment variables, the test harness and code conventions) is in [`docs/development.md`](docs/development.md).

## Deploy it for real

Run an Install on the platform you already use:

| Target | Guide |
| --- | --- |
| Your own VPS with Docker Compose + Caddy | [compose.md](docs/deploy/compose.md) |
| Coolify | [coolify.md](docs/deploy/coolify.md) |
| Railway | [railway.md](docs/deploy/railway.md) |

Multi-arch images (`amd64`, `arm64`) are published to the GitHub Container Registry. A server with **2 vCPUs and 2 GB of memory** is enough to start. See [`docs/deploy/`](docs/deploy/README.md).

---

## Under the hood

| Layer | Choice |
| --- | --- |
| Web process | Bun: admin, APIs and every Site, rendered on request by our own renderer |
| Worker | Node LTS: jobs, image processing, email, Webhooks, Domain checks, Backups |
| Database | Postgres, for everything, including analytics, the job queue and live-editing sync |
| Live editing | CRDT documents synced over WebSockets |
| APIs | Typed procedures with generated OpenAPI documents and MCP tools |

Every significant design decision is recorded as an [Architecture Decision Record](docs/adr/), and the shared vocabulary lives in the [Glossary](GLOSSARY.md).

## Documentation

- [Development guide](docs/development.md)
- [Deployment](docs/deploy/README.md)
- [The `webcraft` CLI](docs/cli.md)
- [APIs](docs/api/README.md)
- [Webhooks](docs/webhooks.md)
- [Extra blocks](docs/extra-blocks.md)
- [Modules](modules/README.md)

## Contributing

Issues and ideas are welcome in [GitHub Issues](https://github.com/flyingwebie/WebCraft/issues). Outside contributors sign a CLA so the project can keep its licensing options open.

## License

WebCraft's core is **AGPL-3.0-or-later**, with an additional permission that keeps two things outside the AGPL:

- **Modules** built only on the public Module SDK, under any licence, including commercial.
- **Your Sites' output and Structure**: the HTML, CSS and JS rendered for a Site, and the templates, components and content built in the admin belong to you and your clients.

See [ADR 0012](docs/adr/0012-agpl-core-with-module-and-site-exception.md) for the details.

<div align="center">

**Build it once. Let your clients run it.**

</div>
