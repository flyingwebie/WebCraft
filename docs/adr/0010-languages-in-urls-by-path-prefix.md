# Languages appear in URLs as a path prefix, with optional domains per language

A Site's default language has no prefix (`/blog/hello`), and every other language is prefixed with its code (`/fr/blog/bonjour`). Staff may also map a language to its own domain or subdomain. The default is the path prefix because one domain keeps setup, TLS and search ranking simple. Per-language domains cost little because the Install already serves Sites by hostname. Every page links its other languages with `hreflang`. Browser-language redirects are a per-Site option, off by default, and limited to a visitor's first request to the home page.

## Considered Options

- **A prefix on every language, including the default**: rejected because it changes every existing URL when a Site adds its first second language.
- **Subdomains only**: rejected as the default because each language would need its own DNS record, but kept available through per-language domains.
