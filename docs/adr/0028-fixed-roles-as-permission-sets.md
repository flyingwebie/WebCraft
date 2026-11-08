# Fixed roles in v1, stored as permission sets so custom roles can come later

v1 has fixed roles only: Superadmin and Staff at Install level, Owner, Editor and Author in a Workspace. There are no custom Workspace roles, no Staff sub-roles and no Memberships limited by Post Type. Agency people who should only edit Content are invited as Members, and Staff never also hold a Membership.

To keep custom roles possible without a data migration:
- `can()` checks named Permissions (`entry.publish`, `media.upload`, `member.invite`), never role names.
- Each built-in role is a Permission set in the role table in code, with a test per row.
- Memberships and Install-level roles store a text role key. Built-in keys are reserved and never editable, so later custom roles are new rows with new keys.
- Site scoping stays on the Membership, apart from the role.
- Modules declare their Permissions in their manifest, and v1 maps them onto the built-in roles.

## Considered Options

- **Custom Workspace roles in v1**: rejected because per-Site scoping covers the common split, and a role builder makes every feature add, translate and audit permission names before the product has settled.
- **A second fixed Staff role (content-only Staff)**: rejected because inviting the person as a Member already gives Content-only access, scoped per Workspace and visible to the client.
- **More per-Site switches that tweak roles**: rejected because enough switches become custom roles by another name. Page layout stays the only one.
