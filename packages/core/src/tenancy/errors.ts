/**
 * The Workspace doesn't exist, or the person can't see it: both answer the same, so nobody learns
 * which Workspaces exist outside their reach.
 */
export class WorkspaceNotFoundError extends Error {
	override name = "WorkspaceNotFoundError";
	constructor() {
		super("There is no such Workspace, or you can't reach it.");
	}
}

/** The Site doesn't exist, or the person can't see it. */
export class SiteNotFoundError extends Error {
	override name = "SiteNotFoundError";
	constructor() {
		super("There is no such Site, or you can't reach it.");
	}
}

/** The person can see what they asked for but doesn't hold the Permission the action needs. */
export class PermissionDeniedError extends Error {
	override name = "PermissionDeniedError";
	readonly permission: string;
	constructor(permission: string) {
		super(`You don't have the ${permission} Permission here.`);
		this.permission = permission;
	}
}
