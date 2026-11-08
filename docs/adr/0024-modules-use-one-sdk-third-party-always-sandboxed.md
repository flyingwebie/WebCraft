# Modules reach WebCraft only through one SDK; third-party Modules will always run sandboxed

Every Module, first-party included, may import only the `@webcraft/module-sdk` package and its own dependencies, and can do only what its manifest declares and the Superadmin approved. v1 ships first-party Modules only (Site analytics, Forms, Popups, Redirects and 404 log, Extra blocks), running in the same process as Core. When third-party Modules arrive, their server code will run only in a sandbox reached through the same SDK, and their admin screens will be built from WebCraft's own UI pieces (or a sandboxed iframe), never loaded into the admin page. One Install holds many Workspaces' SMTP passwords, AI keys and content, so a single unsandboxed Module could read all of them. Building Core features on the same SDK proves the boundary before anyone else depends on it, and moving to a sandbox later changes the runtime, not the API.

## Considered Options

- **Third-party Modules in-process with full trust**: the cheapest way to an ecosystem, but it gives every Module access to every Workspace's secrets, and extension ecosystems built this way see constant supply-chain and vulnerability incidents.
- **In-process, with a permission-gated API as convention**: shows the intended boundary but cannot stop a hostile Module from going around it.
- **Local trusted Modules in v1**: would create an unsandboxed ecosystem that later versions would have to keep supporting.

## Consequences

- The licence exception for Modules ([ADR 0012](0012-agpl-core-with-module-and-site-exception.md)) covers code that uses only the Module SDK and Template markup.
- Modules react to events afterwards, as background jobs, so a broken Module never blocks saving or publishing. The only inline exceptions are form actions, which run after the Submission is stored, and a Module's own routes.
- Modules never read raw secrets: they ask WebCraft to send email or call an AI provider, and outgoing calls go only to the hosts they declare.
- Block types and Components from Modules are declarative (settings made of Fields, output in Template markup), so they will be the easiest part to open to outside authors.
- Which sandbox technology to use, how third-party Modules are installed, and any review before install are left to a later effort.
