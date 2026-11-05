# Research: Can Better Auth cover WebCraft's auth needs?

Date: 2026-11-05. Scope: Better Auth core + official plugins, checked against primary sources (better-auth.com/docs, GitHub releases, GitHub security advisories, npm registry) as of today. Latest stable: **v1.7.18** (npm, published today); next major in beta: **v1.8.0-beta.6**.

## Summary (3-5 lines)

Better Auth's `organization` plugin maps cleanly onto Workspace → Member → custom roles (via `createAccessControl`), and the `admin` plugin gives a Superadmin layer with impersonation and bans — but neither plugin has a documented concept of per-Site (per-resource-instance) permissions; that would need hand-rolled checks on top. 2FA (TOTP + backup codes) is solid but only auto-enforced on credential sign-in routes, with no documented per-role/per-org enforcement policy. Cross-domain session sharing (admin.agency.com editing on each Site's own domain) is the biggest open question: Better Auth's native answer is same-parent-domain cookies (`crossSubDomainCookies`) or the Bearer-token plugin, not real cross-root-domain SSO — the OIDC Provider plugin is the documented path for that, but WebCraft would be both the IdP and the RP, which is unusual and unverified here. Better Auth has an active CVE disclosure history (10+ advisories, several Critical/High, mostly patched same-week) and a fast-moving release cadence, which cuts both ways: real community security review, but also real churn to track. It has first-party Drizzle+Postgres and TanStack Start adapters; Astro has an official (if thinner) guide; Bun is a supported package-manager/CLI target but is not called out as a distinct supported *runtime* in the docs.

## Requirements vs. support

| Requirement | Status | Notes |
|---|---|---|
| Email/password | ✅ Supported | Core feature, documented at a top level (not deep-dived here; it's the baseline sign-in method all other plugins build on). |
| 2FA — TOTP | ✅ Supported | `twoFactor` plugin; enrollment must be verified before it activates; returns `totpURI` for QR rendering. |
| 2FA — backup codes | ✅ Supported | One-time use, removed from DB after use; regenerating invalidates the old set. |
| 2FA — enforce per role | ⚠️ Gap | No documented role/org-based enforcement policy. Default enforcement is route-based (`/sign-in/email`, `/sign-in/username`, `/sign-in/phone-number` only); OAuth, passkey, magic-link, email-OTP sign-ins are **not** gated by default. Per-role enforcement needs custom hooks. |
| Passkeys (WebAuthn) | ✅ Supported | Separate `@better-auth/passkey` package, built on SimpleWebAuthn. Conditional UI (autofill) supported with feature-detection. No official browser support matrix; Apple devices report all-zero AAGUID under default attestation, limiting authenticator-name lookup. |
| Magic links | ✅ Supported | `magicLink` plugin. Default 5-minute expiry, single-use (atomic consume), default rate limit 5/min. App must implement email sending itself (`sendMagicLink` callback) — no built-in email provider. |
| Organization plugin → Workspaces + Members | ✅ Supported | `organization` plugin: orgs, members, invitations, `listMembers`/`updateMemberRole`/`removeMember`, membership cap (default 100), org cap per user. Maps well to Workspace/Member. |
| Custom roles/permissions | ✅ Supported | `createAccessControl` + `ac.newRole(...)`, checked via `hasPermission` (server/client) or synchronous `checkRolePermission`. Also a **dynamic** access-control mode where admins create roles at runtime (stored in `organizationRole` table). Default roles: owner/admin/member. |
| Teams (sub-groups within a Workspace) | ✅ Supported | `teams: { enabled: true }` sub-feature of `organization`; team-scoped CRUD, membership caps, team-scoped invitations. |
| Per-Site permissions (resource-instance scoping) | ❌ Gap (undocumented) | Access control is per **resource type** (e.g. `project: [create, update]`) assigned per **org-wide** role — nothing in the docs grants a role scoped to one specific Site/resource instance. Would require WebCraft's own app-level checks layered on `hasPermission`, or modeling each Site as its own sub-organization/team (unverified pattern). |
| Admin plugin → Superadmin | ⚠️ Partial | No built-in "superadmin" role; default roles are `admin`/`user`. A `superadmin` role must be defined via custom access control and listed in `adminRoles` (or just given the right permissions directly). Functionally workable, just not a built-in primitive above Workspaces. |
| Impersonation | ✅ Supported | Admin plugin; default max duration 1 hour (`impersonationSessionDuration`); admins can't impersonate other admins by default (opt-in via `impersonate-admins` permission). |
| Bans | ✅ Supported | `banUser`/`unbanUser`; optional reason + expiry (omit expiry = permanent); revokes all existing sessions; customizable ban message. |
| Session handling across admin.agency.com ↔ per-Site domains | ⚠️ Gap / design problem | Native cookie sharing (`crossSubDomainCookies`) only works across subdomains of **one** parent domain — not across arbitrary client-owned domains like `example.com`. Safari treats cross-site API cookies as third-party and may block them; documented workarounds are (a) proxy through the frontend's own domain, or (b) put everything under one shared parent domain — neither fits "each Site has its own domain." No documented turnkey feature for "log in once, edit on N arbitrary domains." |
| — via Bearer tokens | ⚠️ Partial option | `bearer` plugin sends a token in `Authorization` header instead of a cookie, sidesteps cross-origin cookie problems, but token typically lives in `localStorage` (XSS exposure) and docs explicitly scope it to "APIs that don't support cookies," not as a general cross-domain SSO story. |
| — via JWT plugin | ⚠️ Partial option | JWT plugin can expose session data as a verifiable JWT (JWKS-checkable), separate from the main cookie session; could carry identity to another domain's API, but the docs content pulled here didn't confirm a ready-made cross-domain login flow. |
| — via OIDC Provider plugin | ⚠️ Likely path, unverified in depth | Dedicated "OIDC Provider" plugin exists for turning Better Auth into an IdP for other apps — this is the architecturally correct answer for "admin app is IdP, each Site is an RP," analogous to a mini Keycloak. Not deep-dived in this pass; needs a follow-up read of `/docs/plugins/oidc-provider` before committing. |
| Rate limiting | ✅ Supported | Built-in; prod default 100 req/10s; stricter built-in rule on `/sign-in/email` (3/10s) and all `/two-factor/*` paths; configurable storage (memory/database/secondary-storage/custom); 429 + `X-Retry-After` on limit. IP read from `X-Forwarded-For` by default — must configure `trustedProxies`/`ipAddressHeaders` to prevent spoofing. |
| Account lockout (after N failed logins) | ❌ Gap (undocumented) | Rate limiting throttles *requests*, not a documented "lock this account after N bad passwords" feature. Would need custom hooks. |
| Audit logging / hooks | ⚠️ Partial | Generic `before`/`after` hook system exists (single middleware function per phase, branch on `ctx.path`), plus a `databaseHooks` mechanism mentioned but not documented in depth. No purpose-built audit-log plugin/table; you'd build audit logging yourself on top of `after` hooks. |
| i18n of auth emails/errors | ❌ Not found | `/docs/concepts/internationalization` 404s on the docs site — no dedicated i18n concept page found. Email content is entirely app-supplied (`sendMagicLink`, OTP senders, etc.), so translating email bodies is already on WebCraft regardless; error-message i18n is not documented as a built-in feature. |
| SSO (SAML/OIDC) for later | ✅ Supported, partly commercial | `@better-auth/sso` plugin: OIDC (discovery, `private_key_jwt`) and SAML (SP+IdP initiated, signature/replay validation, Single Logout), org-linked providers, DNS domain verification. **Self-service SSO** (customers configuring their own connections) is gated behind "Better Auth Infrastructure" — a paid/enterprise offering, not the open-source core. |
| Drizzle + Postgres adapter | ✅ Supported | First-party `@better-auth/drizzle-adapter`; `provider: "pg"`; schema via `npx auth generate` + `drizzle-kit generate/migrate`; joins (2–3x speedup on `/get-session`) available from v1.4.0 behind a flag; several naming/relation gotchas documented (table/field name mapping, no duplicate singular+plural aliases, `schemaName` for namespacing). |
| Bun compatibility | ⚠️ Partial / unverified at runtime level | Docs show Bun only as a package manager/CLI runner (`bun add`, `bun x auth generate`). No explicit "Bun is a supported server runtime" statement found; Node and Cloudflare Workers (needs `nodejs_compat`/`nodejs_als` for `AsyncLocalStorage`) are the explicitly documented runtimes. CJS is explicitly unsupported. Should be smoke-tested directly on Bun before relying on it. |
| TanStack Start integration | ✅ Supported, first-party | Official guide: catch-all route handler, `tanstackStartCookies` plugin (must be last in the plugins array), `createServerFn`-based `getSession`/`ensureSession` helpers, `beforeLoad` route guards. |
| Astro integration | ✅ Supported, official but thinner | Official guide: catch-all API route, typed `App.Locals`, `middleware.ts` populating `locals.user`/`locals.session`. No explicit SSR-mode requirement stated (implied by its reliance on server-side request handling) and the docs' own example of passing session into a component looked possibly buggy (passes a function, not a value) — worth independently verifying before relying on the doc's code sample. |

## Known security advisories (GitHub Security Advisories, first page of 5 — not exhaustive)

| Advisory | Package | Severity | Published | Issue |
|---|---|---|---|---|
| GHSA-4wq4-2ppv-q3hg | `@better-auth/expo` | Critical | 2026-11-03 | Authorization proxy could sign values it did not issue. |
| GHSA-965c-763c-88jm | `better-auth` | Critical | 2026-09-30 | OAuth state value usable as a magic link to sign in as another user. |
| GHSA-9p5w-h4pr-fcrc | `@better-auth/electron` | High | 2026-11-03 | Desktop sign-in could expose the server secret and bypass 2FA. |
| GHSA-mx9r-x6ww-qjw9 | `@better-auth/sso` | High | 2026-09-29 | Personal SSO providers could sign in as another provider's users. |
| GHSA-g95c-wqvr-8c3j | `better-auth` | Moderate | 2026-11-03 | Admins with `user:update` could change another user's phone number. |
| GHSA-9hm7-xhfp-cx58 | `better-auth` | Moderate | 2026-11-03 | OAuth sign-in could treat an unverified provider email as verified. |
| GHSA-48c2-w96j-mv3m | `@better-auth/kysely-adapter` | Moderate | 2026-11-03 | MySQL serial IDs could return another request's record. |
| GHSA-2f9c-7xj7-gh55 | `better-auth` | Moderate | 2026-11-03 | Email-OTP attempt limit raceable; codes loosely bound to addresses. |
| GHSA-hwq2-v29r-p69r | `better-auth` | Moderate | 2026-11-03 | Email-change links remained valid after the address changed hands. |
| GHSA-44jh-23m7-hpcf | `@better-auth/drizzle-adapter` | Low | 2026-09-30 | Concurrent requests could exceed rate limits on Postgres. |

Note: 4 more pages of advisories exist on GitHub and were not fetched in this pass (time-boxed). The visible pattern — a cluster of fixes published 2026-11-03, i.e. two days before this research — suggests an active, fast-responding security process, but also that WebCraft would need a process for tracking and promptly applying these patches (not a one-time adoption decision).

## Implications for WebCraft (options, not decisions)

1. **Workspace/Member/role mapping**: the `organization` + custom-access-control plugins are a strong fit for Workspace → Member → role as named in the glossary. Little custom auth-schema work needed here.
2. **Per-Site permissions**: three options to resolve the documented gap — (a) build an app-level permission check keyed by `(member, site)` on top of Better Auth's org-level `hasPermission`; (b) model each Site as a Better Auth "team" within its Workspace and use team-scoped roles as a stand-in for Site scoping; (c) accept Workspace-wide roles only and drop per-Site granularity from the MVP.
3. **Superadmin**: workable via `admin` plugin + a custom `superadmin` role/permission set; WebCraft would be defining this itself rather than getting it as a true built-in primitive — worth confirming it composes cleanly with the `organization` plugin's own owner/admin/member roles (two separate role systems stacked).
4. **Cross-domain editing (admin.agency.com editing on example.com)**: this is the central architectural risk. Options: (a) proxy each Site's editing requests through the admin domain (same pattern Better Auth's own Safari workaround suggests) so the browser never needs a cross-site cookie; (b) adopt the OIDC Provider plugin and treat each Site as an OAuth/OIDC client of the admin install, issuing short-lived tokens per edit session — needs a dedicated follow-up research pass, since it wasn't verified in depth here; (c) use the Bearer-token plugin to carry a token from the admin domain into Site-side editor JS, accepting the `localStorage`/XSS tradeoff; (d) use one-time, server-validated handoff tokens minted by the admin app and redeemed by the Site on page load (classic "cross-domain SSO ticket" pattern) — not a documented Better Auth feature, would be hand-built on top of its hook system.
5. **2FA enforcement policy**: if WebCraft wants to require 2FA for, say, all Superadmins or all Workspace owners, that policy needs to be hand-built via `before` hooks gating the relevant sign-in/action routes — not a config flag.
6. **Audit logging**: no built-in audit trail. If WebCraft needs an audit log (likely, given Superadmin/impersonation/multi-tenant risk), plan to build it on the `after`-hook system from day one rather than bolt it on later.
7. **i18n**: since email bodies are entirely app-authored anyway, i18n of auth emails is "free" in the sense that WebCraft already owns that content — the gap is really about auth *error messages* surfaced by the SDK/API, which may need a translation layer in WebCraft's own API wrapper.
8. **Security posture**: the advisory history is a point in favor of adopting a widely-used library rather than hand-rolling, but also implies an ongoing patch-tracking obligation — budget for it rather than treating adoption as "done" at integration time.
9. **Bun**: before committing to Bun as the runtime, run a direct smoke test of Better Auth's HTTP handler under Bun (not just Bun-as-package-manager), since the docs don't explicitly certify it as a server runtime the way they do Node and Cloudflare Workers.
10. **Alternatives, for comparison** (not deep-researched this pass, flagging for a possible follow-up ticket):
    - **Lucia-style hand-rolled**: Lucia itself pivoted to being a set of guides rather than a library; "Lucia-style" here really means hand-rolling sessions/adapters. Gives full control over per-Site permission modeling and cross-domain session design, at the cost of building and maintaining 2FA/passkeys/SSO/rate-limiting/admin tooling that Better Auth already ships.
    - **Auth.js (NextAuth)**: framework-oriented (historically Next.js-centric, now broader), strong OAuth/social support, weaker out-of-the-box multi-tenant org/role modeling than Better Auth's `organization` plugin.
    - **Ory (Kratos/Hydra/Keto)**: purpose-built for exactly this shape of problem (separate identity, OAuth2/OIDC provider, and fine-grained permission services) — likely a stronger native fit for the cross-domain SSO + per-resource-permission requirements, at the cost of running/operating more infrastructure (self-hosting several services vs. one library).
    - **Keycloak**: mature, full IdP with SAML/OIDC and admin console; heavier to self-host (JVM-based) for an agency-run, presumably lightweight-infra product; strong SSO fit, weak fit with "lightweight Bun/Postgres stack" goal.
    - **Zitadel**: similar niche to Keycloak/Ory, newer, Postgres-backed, has a multi-tenant "organization" concept natively (closer to WebCraft's own model); worth a closer look if the cross-domain SSO requirement turns out to be the dominant constraint.

## Sources

- https://www.better-auth.com/docs/introduction
- https://www.better-auth.com/docs/plugins/organization
- https://www.better-auth.com/docs/plugins/admin
- https://www.better-auth.com/docs/plugins/2fa
- https://www.better-auth.com/docs/plugins/passkey
- https://www.better-auth.com/docs/plugins/magic-link
- https://www.better-auth.com/docs/concepts/session-management
- https://www.better-auth.com/docs/concepts/cookies
- https://www.better-auth.com/docs/concepts/rate-limit
- https://www.better-auth.com/docs/concepts/hooks
- https://www.better-auth.com/docs/plugins/sso
- https://www.better-auth.com/docs/plugins/bearer
- https://www.better-auth.com/docs/adapters/drizzle
- https://www.better-auth.com/docs/integrations/tanstack
- https://www.better-auth.com/docs/integrations/astro
- https://www.better-auth.com/docs/installation
- https://github.com/better-auth/better-auth/releases (checked 2026-11-05; latest stable v1.7.18, pre-release v1.8.0-beta.6)
- https://github.com/better-auth/better-auth/security/advisories (page 1 of 5, checked 2026-11-05)
- https://registry.npmjs.org/better-auth/latest (checked 2026-11-05 — confirms v1.7.18)
- Attempted, 404 / not found: `/docs/plugins/oidc-provider` (not found at that path — needs locating the correct doc path in a follow-up), `/docs/concepts/internationalization` (404 — no dedicated i18n doc found)
