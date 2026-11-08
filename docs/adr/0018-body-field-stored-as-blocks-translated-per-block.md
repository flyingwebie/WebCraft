# The Body field is stored as Blocks and translated one Block at a time

Long-form text is kept as a JSON list of typed Blocks with stable ids, not as HTML or Markdown, and WebCraft's renderer turns it into semantic HTML. Nothing from Content is stored as HTML, so there is nothing to clean. Excerpts, tables of contents and Markdown copies are worked out from the Blocks, and the ids let translations follow the default language one Block at a time. Each language keeps its own Block list. Every translated Block remembers its source Block and whether the AI or a person wrote it. A hand-edited paragraph then becomes an Outdated translation on its own, and the rest of the article stays free to be re-translated.

## Considered Options

- **Cleaned HTML, like rich text**: rejected because derived values and per-Block translation would have to re-parse HTML and guess which parts match.
- **Markdown**: kept as the exchange format for AI clients, the MCP server and the CLI, but rejected for storage because it has no stable ids and no room for Component Props.
- **One shared Block structure with only text translated**: rejected because translators sometimes need to drop, add or reorder paragraphs in their language.
