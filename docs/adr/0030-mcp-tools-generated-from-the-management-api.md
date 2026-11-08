# MCP tools and CLI commands generated from the Management API, with Sensitive actions left out

Every public Management API procedure becomes one MCP tool and one CLI command, with its name, description and input schema taken from the procedure. Tools are named `<noun>_<verb>` and grouped into Toolsets. A person switches Toolsets on when they approve an AI client or create an API token, and a session lists only the tools in those Toolsets that the person's Permissions allow. A few combined tools are written by hand where one call replaces many.

Sensitive actions (changing secrets, creating tokens, changing roles or Site access, deleting a Site or Workspace, Impersonation) are never available through MCP or API tokens, because they need a fresh identity check that an AI client can't pass. They stay in the admin and in server-side `webcraft admin …` commands that need shell access to the Install. Actions that can't be undone or reach many items, such as publishing, Publish all and deleting Structure, use a two-step preview and confirmation, or elicitation where the client supports it.

## Considered Options

- **Hand-written, task-shaped MCP tools only**: rejected because they would drift from the API that the admin uses, and Module procedures already become tools automatically. Hand-written tools are kept only for a few combined actions.
- **Every tool listed at once**: rejected because 150 or more tools waste an AI client's context. Toolsets plus filtering by Permission keep the list short.
- **Sensitive actions allowed with a token scope**: rejected because a leaked token or a misled AI client could then take over a Workspace. The 10-minute identity check exists to stop exactly that.
- **A `confirm: true` argument**: rejected because a model sets it without asking anyone. A short-lived confirmation id returned with a preview makes the client show the change first.
