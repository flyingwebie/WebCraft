# Reference material

Some WebCraft decisions are informed by private reference material: other products' docs, hands-on use, and study of their shipped artifacts (ADR 0013). It informs what features do, never how WebCraft's code is written.

## Rules

- The material lives in a gitignored local folder and is never committed.
- The names of the products it covers never appear in anything tracked or published: code, comments, docs, specs, issues, PR text, commit messages, branch names, UI text, tests and test data.
- Features are described by category ("a visual builder", "a form builder") and in our own words.
- Nothing is copied from it: no code, CSS, assets, screenshots or text.
- Findings first become our own tracked spec; code is written from that spec, never with the material open.

## The denylist check

A list of those names, one case-insensitive extended regular expression per line, is kept outside the repo: in a local file and in the `REFERENCE_DENYLIST` repository secret. `scripts/check-denylist.sh` checks tracked files, file names, commit messages and branch names against it, in CI on every pull request and push, and locally through the opt-in git hooks. It reports only where a match is, never the list itself. See "Reference-material denylist" in `docs/development.md` for how to run it.
