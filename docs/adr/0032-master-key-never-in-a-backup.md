# The Master key is never in a Backup

A Backup holds the database (with secrets encrypted under the Master key), locally stored Media and Form uploads, and a manifest carrying a fingerprint of the Master key, never the key itself. Agencies are told to store the key separately, and restore refuses to run when the running Install's key does not match the fingerprint.

A Site export does carry its secrets, but re-encrypted under a passphrase the exporter chooses, never under the Master key and never in plain text. Without the passphrase the import drops them.

## Considered Options

- **Key inside the Backup**: rejected because anyone who gets one Backup file would then read every SMTP password and AI key of every Workspace in the Install. A one-step restore is not worth that.
- **An external secrets manager**: rejected for v1 because a self-hosting agency on one VPS should not need another service to run WebCraft.
