# Agency people are Install-level Staff, not Workspace Members

One Install belongs to one agency, and each Workspace is one of its clients. Agency people therefore hold an Install-level role (Superadmin or Staff) and are assigned to Workspaces, rather than being added to each Workspace as Members. That way the agency doesn't have to invite its team into every Workspace, a client's member list shows only the client's own people, and agency-only Structure changes have one clear owner.

## Considered Options

- **Agency people as Workspace Members with an "agency" role**: rejected because every new Workspace would need the whole team invited, and client Owners could see or remove agency accounts.
