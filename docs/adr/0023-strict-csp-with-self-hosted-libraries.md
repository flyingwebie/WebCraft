# Sites send a strict CSP, with scripts served as files and Libraries self-hosted

Site pages are cached, so per-request nonces can't be used. Instead WebCraft never puts inline scripts in Site output: its own scripts and Staff scripts are served as hashed files from the Site's domain, and the default policy is `script-src 'self'` plus a per-Site list of allowed outside hosts, with fixed headers that block plugins, base-tag changes, framing by other sites and forms posting elsewhere. Libraries such as animation packages are added by package and version or URL, then copied and served from the Site, so they need no outside host, can't change underneath a Site and don't send visitors' IP addresses to a CDN. A Libraries screen shows when newer versions exist and lets Staff update them; nothing updates on its own. Each Site can switch to Relaxed (inline and eval allowed, for tag managers) or Report only.

## Considered Options

- **Load Libraries from a public CDN with an integrity hash**: also pinned, but it adds an outside host to every Site's policy and sends every visitor's IP address to the CDN.
- **Hashes of inline scripts in the policy**: works with caching, but every script edit changes the policy, and pasted snippets break it constantly.
- **No CSP by default**: the easiest for agencies, but then nothing limits the damage a compromised snippet can do.
