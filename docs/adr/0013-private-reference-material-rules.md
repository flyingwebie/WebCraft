# Private reference material informs behaviour only, and never enters anything tracked

Some decisions are informed by private reference material: other products' docs, hands-on use, and reverse engineering of their shipped artifacts (skipped where a product's licence forbids it). It is studied only to learn what features do and how they behave, never as code to adapt. Raw notes, product names, screenshots and decompiled output stay in a gitignored local folder. Everything tracked describes behaviour by category ("a visual builder") in our own words, with no names, quotes, code, CSS, assets or screenshots. We chose a lightweight split over a full clean room: findings first become our own tracked spec, and code is written from that spec, never with decompiled reference code open. A gitignored denylist of names is checked by a local pre-commit hook and by CI (with the list stored as a repository secret). The full rules live in `docs/reference-material.md`.

## Considered Options

- **Full clean room** (separate people or sessions for studying and writing code): stronger, but too heavy for a small team.
- **No process, just "don't copy"**: rejected because names and phrasing leak easily into issues and commits.
