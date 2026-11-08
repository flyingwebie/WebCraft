/**
 * Who a secret belongs to: the Install itself (Install SMTP, shared AI keys), one Workspace (its
 * AI key) or one Site of a Workspace (its SMTP, CDN token, Webhook and CAPTCHA secrets).
 */
export type SecretOwner =
	| { kind: "install" }
	| { kind: "workspace"; workspaceId: string }
	| { kind: "site"; workspaceId: string; siteId: string };

/** The Install itself, as the owner of a secret (Install SMTP, shared AI keys). */
export type InstallSecretOwner = Extract<SecretOwner, { kind: "install" }>;

/** Names one secret: its owner and a name unique within that owner, such as `smtp.password`. */
export type SecretRef<Owner extends SecretOwner = SecretOwner> = {
	owner: Owner;
	name: string;
};

/** How a secret's owner is stored: no Workspace for the Install, no Site for a Workspace. */
export type OwnerColumns = { workspaceId: string | null; siteId: string | null };

export function ownerColumns(owner: SecretOwner): OwnerColumns {
	switch (owner.kind) {
		case "install":
			return { workspaceId: null, siteId: null };
		case "workspace":
			return { workspaceId: owner.workspaceId, siteId: null };
		case "site":
			return { workspaceId: owner.workspaceId, siteId: owner.siteId };
	}
}

/** The secret a stored row holds. */
export function refFromColumns({ workspaceId, siteId, name }: OwnerColumns & { name: string }): SecretRef {
	if (workspaceId === null) return { owner: { kind: "install" }, name };
	if (siteId === null) return { owner: { kind: "workspace", workspaceId }, name };
	return { owner: { kind: "site", workspaceId, siteId }, name };
}

/** Names a secret in messages, such as `"smtp.password" of Site shop in Workspace acme`. Never shows a value. */
export function describeRef({ owner, name }: SecretRef): string {
	switch (owner.kind) {
		case "install":
			return `"${name}" of the Install`;
		case "workspace":
			return `"${name}" of Workspace ${owner.workspaceId}`;
		case "site":
			return `"${name}" of Site ${owner.siteId} in Workspace ${owner.workspaceId}`;
	}
}

/** Secret names are chosen by WebCraft's code, such as `smtp.password` or `webhook:<id>:signing`. */
const SECRET_NAME = /^[A-Za-z0-9._:-]{1,200}$/;

export function checkRef({ owner, name }: SecretRef): void {
	if (!SECRET_NAME.test(name)) {
		throw new TypeError(
			`"${name}" is not a secret name: use 1 to 200 letters, digits, dots, colons, dashes and underscores.`,
		);
	}
	if (owner.kind !== "install" && !owner.workspaceId.trim()) {
		throw new TypeError("A secret's owner needs a Workspace id.");
	}
	if (owner.kind === "site" && !owner.siteId.trim()) {
		throw new TypeError("A secret's owner needs a Site id.");
	}
}
