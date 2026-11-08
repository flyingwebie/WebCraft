# Sites move between Installs by Site export, not by partial restore of a Backup

Backups and restores always cover a whole Install. Moving or copying one Site uses a Site export: an archive of the Site's Structure, Content, Media, Revisions, Submissions, analytics and logs, plus a versioned manifest. Import always creates a new Site in a chosen Workspace and never overwrites one. Things that can't move as they are get rules: secrets are re-encrypted under an export passphrase, domains arrive paused until Staff switch them on, and Members are matched by email or become pending invitations, because passwords, passkeys and 2FA never leave their Install.

Import accepts exports from the same or an older WebCraft version and upgrades them; it refuses newer ones. Export and import are Sensitive actions, run as worker jobs and are written to the Audit log.

## Considered Options

- **Restore part of a Backup**: rejected because a Backup's ids, accounts and secrets belong to one Install and would collide with or leak into another.
- **No Site moving in v1**: rejected because agencies hand clients over, split Installs and start new Sites from existing ones, and the same file covers all three.
- **Workspace export**: left out; moving a Workspace means exporting each of its Sites, and Members come along with each Site.
