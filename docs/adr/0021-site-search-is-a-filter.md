# Site search is a Filter over one shared full-text index

Visitor search and Loop Filters use one engine. Each Site has one Postgres full-text index per language, and the Fields it covers and their weights are set once on each Post Type (its Searched fields), not per Filter. A Filter's search box searches that index, limited to its Loop's query. Site search is simply a built-in Filter with only a search box, on a query Loop over the Post Types marked searchable. Marking a Post Type searchable only decides whether it appears in Site search; every Post Type is indexed. This gives one engine, one URL format, one way of working without JavaScript and one set of input checks.

## Considered Options

- **Searched Fields chosen per Filter**: more flexible, but each Filter would need its own index or slow unindexed queries, and the same Entry could rank differently in two places on the same Site.
- **Site search as a separate feature from Filters**: simpler at first, but it duplicates the URL handling, the in-place updates and the security rules for visitor input.
