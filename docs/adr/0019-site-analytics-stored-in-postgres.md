# Site analytics events are stored in Postgres

Site analytics keeps its raw events in the same Postgres database as everything else: monthly partitions of raw events, kept for a time the Install sets (13 months by default), plus hourly and daily rollup tables that dashboards, Reports and share links read and that are kept forever. One database keeps self-hosting to a single Compose stack and one backup. With rollups, Postgres easily covers an agency Install of tens of Sites and a few million page views a month. Reads go through one analytics query interface, so a separate column store can be added behind it later without changing dashboards.

## Considered Options

- **A separate column-store database in the Compose stack**: faster for large ad-hoc queries, but it doubles what an agency has to run, back up and upgrade, and v1 has no ad-hoc query builder that would need it.
