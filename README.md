# WebCraft

An open-source, self-hosted, multi-tenant CMS where agencies build websites and their clients edit them while browsing the live site.

WebCraft is being built. The v1 spec is [issue #46](https://github.com/flyingwebie/WebCraft/issues/46); its vocabulary is in [`GLOSSARY.md`](GLOSSARY.md) and its decisions in [`docs/adr/`](docs/adr/).

To run it locally and contribute, see [`docs/development.md`](docs/development.md):

```sh
bun install
cp .env.example .env   # then set WEBCRAFT_SECRET_KEY: openssl rand -base64 32
bun run dev
```

WebCraft is licensed AGPL-3.0-or-later (see ADR 0012).
