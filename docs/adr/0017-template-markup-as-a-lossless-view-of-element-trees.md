# Template markup is a lossless, WebCraft-parsed view of element trees

Templates and Components stay stored as element trees (ADR 0002). Code mode, the builder's code view, export files, the MCP server and the CLI all read and write them as **Template markup**: HTML plus `{{ value }}` for Fields (`title`), Globals (`site.`), Loop items and Props (`props.`), PascalCase tags for the Site's own Components, and `{{@command}} … {{/command}}` blocks for everything built in (loop, if/else, empty, outlet, pagination, form, filter, popup). WebCraft prints the tree as markup and parses saved markup back into a tree. The markup is never stored as text, and every element setting has a written form, so a round trip loses nothing. Because WebCraft parses the markup itself, it knows where every value lands. It escapes each value for that place, cleans rich text against an allowlist, refuses values in script, style, event and `srcdoc` positions, allows only safe URL schemes, and runs Conditions with its own small expression interpreter rather than JavaScript.

## Considered Options

- **Store edited HTML as opaque custom-HTML blocks**: rejected because the builder, Inline editing and Checks could no longer see Fields and Loops inside them.
- **An existing template engine with raw output and arbitrary expressions**: rejected because WebCraft could not guarantee escaping by context or map markup back to element trees.
- **Loops and Conditions as tags (`<Loop>`, `<wc-if>`) or attributes (`if=""`, `each=""`)**: rejected because tags are easily confused with Components and attributes can't express else across siblings.

## Consequences

The parser and validator are one module used by every entry point. Popups, Filters and Site script safety are decided in their own tickets; Template markup only reserves their commands.
