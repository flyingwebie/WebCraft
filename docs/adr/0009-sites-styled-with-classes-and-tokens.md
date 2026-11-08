# Sites are styled with Classes over Design tokens, not utility-first

Staff style elements in the builder by giving them Classes, whose styles draw on the Site's Design tokens; utility classes generated from the tokens are a supplement, not the main tool. Tokens become CSS custom properties, and each Site gets one stylesheet per published Design system, holding only the Classes and utilities the Site uses, ordered by CSS cascade layers (`reset → tokens → base → classes → utilities → custom`). A Class is one place to change how every matching element looks, its name keeps the HTML readable next to semantic elements, and because element trees are data (ADR 0002) the renderer can send only what is used. Element trees store references to Classes by id, so moving away from Classes later would mean rewriting every stored tree.

## Considered Options

- **Per-element styles only**: rejected because a style change has to be repeated on every element, and nothing ties similar elements together.
- **Utility classes only**: rejected because long class lists are hard to edit visually, and Staff lose a single place to restyle a pattern across the Site.
- **Inline `style` attributes for one-off styles**: rejected because they bypass the cascade layers and media queries; a one-off style becomes a generated Class instead.
