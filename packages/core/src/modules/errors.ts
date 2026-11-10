/** No Module of this build has that id. */
export class ModuleNotFoundError extends Error {
	override name = "ModuleNotFoundError";
	constructor() {
		super("There is no such Module, or it isn't on here.");
	}
}

/** The Module this Install runs is another version than the one asked about: look again. */
export class ModuleChangedError extends Error {
	override name = "ModuleChangedError";
	readonly version: string;
	constructor(version: string) {
		super(`This Install now runs version ${version} of the Module; look at what it asks for again.`);
		this.version = version;
	}
}

/** The Module breaks a rule of the Module SDK, so WebCraft never runs it. */
export class ModuleCannotRunError extends Error {
	override name = "ModuleCannotRunError";
	constructor(problem: string) {
		super(`WebCraft can't run this Module: ${problem}`);
	}
}

/** The Module waits for the Superadmin's approval, so it can't be switched on. */
export class ModuleNotApprovedError extends Error {
	override name = "ModuleNotApprovedError";
	constructor() {
		super("The Superadmin hasn't approved this Module, or this version of it, yet.");
	}
}

/** The Module failed while it ran; the reason is in the Module log, for the Superadmin. */
export class ModuleFailedError extends Error {
	override name = "ModuleFailedError";
	constructor() {
		super("The Module couldn't do this. The Superadmin can see why in the Module log.");
	}
}

/** Errors thrown by Module code, which the Module log keeps (never the Error log). */
const moduleFailures = new WeakSet<object>();

/** Marks an error as a Module's own failure, written to its Module log, before it is thrown on. */
export function markModuleFailure(error: unknown): void {
	if (typeof error === "object" && error !== null) moduleFailures.add(error);
}

/**
 * Whether an error is a Module's failure, which its Module log holds: the Error log is for WebCraft's
 * own unexpected failures (`GLOSSARY.md`).
 */
export function isModuleFailure(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	return moduleFailures.has(error) || (error as { name?: unknown }).name === "ModuleFailedError";
}
