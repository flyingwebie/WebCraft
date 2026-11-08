# Superadmin and Staff can impersonate people in v1

Agencies support clients who can't describe what they see, so the Superadmin can impersonate anyone and Staff can impersonate Members in the Workspaces they're assigned to. The limits keep this safe:
- Impersonation needs a second factor and a recent identity check.
- A session lasts at most 1 hour, behind a visible banner.
- It cannot change the person's password, 2FA, passkeys, sessions, API tokens or OAuth grants.
- Every action is recorded in the Audit log under both names, and the person can see those entries.

## Considered Options

- **A read-only "preview as role" view instead**: rejected because it can't show an actual person's Site access, Drafts or settings, which is what support needs.
