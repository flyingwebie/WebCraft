# Contributing to WebCraft

Thanks for helping build WebCraft. This page covers how to report a problem, propose a change and get a pull request merged.

## Before you start

- **Read the vocabulary.** WebCraft uses the terms in [`GLOSSARY.md`](GLOSSARY.md) exactly: in code, tests, UI text, issues and commits. A "Workspace" is never a "tenant", an "Entry" is never a "post".
- **Check the decisions.** Significant design choices are recorded in [`docs/adr/`](docs/adr/). If your change goes against one, open an issue first so we can discuss it.
- **Sign the CLA.** Outside contributors agree to the [Contributor Licence Agreement](CLA.md) before their first pull request is merged (see [below](#the-contributor-licence-agreement)).

## Reporting bugs and asking for features

Open a [GitHub issue](https://github.com/flyingwebie/WebCraft/issues). For a bug, say:

- what you did, what you expected and what happened instead;
- the WebCraft version (`webcraft admin doctor` prints it) and where it runs (Docker Compose, Coolify, Railway, a checkout);
- any relevant log lines, with secrets and personal data removed.

New issues get the `needs-triage` label. A maintainer then marks them `needs-info`, `ready-for-human`, `ready-for-agent` or `wontfix`.

**Security problems:** don't open a public issue. Use GitHub's private vulnerability reporting on this repository (Security › Report a vulnerability).

## Setting up

You need Bun 1.4, Node 22.18 or later, and Docker (or a Postgres 18 server you can create databases on).

```sh
git clone https://github.com/flyingwebie/WebCraft.git && cd WebCraft
bun install
cp .env.example .env   # then set DATABASE_URL and WEBCRAFT_SECRET_KEY (openssl rand -base64 32)
bun run dev
```

The full guide (layout, commands, environment variables, the test harness) is [`docs/development.md`](docs/development.md).

## Making a change

1. **Pick or open an issue**, and say there that you're working on it, so nobody duplicates the work.
2. **Branch from `main`** with a short, descriptive name, such as `fix/123-slug-clash` or `feat/45-form-steps`.
3. **Write tests first where you can.** Tests run against a real Postgres; only the edges (time, email, outside HTTP) are replaced with fakes.
4. **Follow the conventions** in [`docs/development.md` › Conventions](docs/development.md#conventions). The main ones:
   - strict TypeScript with explicit `.ts`/`.tsx` extensions on relative imports, and no `enum`, `namespace` or parameter properties;
   - Workspace data goes through the data layer, which checks Permissions; check a Permission, never a role name;
   - secrets go through `services.secrets` only, never into another table, a log line, a job payload or a response;
   - British spelling in prose ("licence", "normalise").
5. **Run the checks** before you push:

   ```sh
   bun run lint
   bun run typecheck
   bun run test
   ```

   If you changed the admin or Edit mode, also run the browser checks: `bun run build && bun run test:browser`.
   If you added a dependency, run `bun run check:licences`: it must be AGPL-compatible (permissive, LGPL, MPL-2.0, GPL-3.0 or AGPL-3.0).
   If you changed a public procedure, regenerate the API documents with `bun run api:document` or `bun run content-api:document`.

## Commit messages

Gitmoji + Conventional Commits, with the issue number:

```
✨ feat(forms): add conditional steps (#123)
🐛 fix(renderer): keep the language prefix on Loop links (#124)
📝 docs: explain Share links (#125)
```

Keep each commit to one logical change, and say *why* in the body when it isn't obvious.

## Pull requests

- Open the pull request against `main` and link the issue (`Closes #123`).
- Describe what changed, why, and how you tested it. Screenshots help for anything visible.
- Keep it focused: one issue per pull request is easiest to review.
- CI runs lint, typecheck, build, the licence check, the test suite and the deploy smoke test. All must pass before merge.
- On your first pull request, include this line in its description:

  > I have read the WebCraft Contributor Licence Agreement (CLA.md) and agree to it for this and all my future contributions to WebCraft.

## Writing in our own words

WebCraft is written from its own specification. When you describe a feature, in code, comments, docs, issues, commit messages or UI text, describe it by what it does ("a visual builder", "a form builder") rather than by naming another product. Don't copy code, CSS, assets, screenshots or text from other products. CI runs a check for this; on pull requests from forks it can't run, so a maintainer runs it before merging.

## Modules

Want to extend WebCraft rather than change its core? Build a Module on the public Module SDK (`@webcraft/module-sdk`). See [`modules/README.md`](modules/README.md) and the Modules section of the development guide. Modules built only on the SDK can use any licence, including a commercial one.

## The Contributor Licence Agreement

WebCraft's core is licensed AGPL-3.0-or-later ([ADR 0012](docs/adr/0012-agpl-core-with-module-and-site-exception.md)). The [CLA](CLA.md) lets the project keep its licensing options open, for example dual licensing, without asking every past contributor again.

It is a **licence, not a copyright assignment**: you keep the copyright in your work and can use it however you like. Your contribution is still released to everyone under the AGPL.

## Licence of your contribution

Code you contribute is released under AGPL-3.0-or-later, with the additional permission described in ADR 0012. Documentation is released under CC BY 4.0.

## Code of conduct

Be kind, assume good intent and keep feedback about the work, not the person. Maintainers may remove comments, or block people, that make the project unwelcoming.
