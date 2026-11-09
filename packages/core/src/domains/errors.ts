/**
 * Why a domain can't be added:
 * - `format`: it isn't a domain (an address with a scheme or path, an IP address, a wildcard, one name);
 * - `install`: it is one of the Install's own names (the admin host, the sites domain or a name under it).
 */
export type DomainInvalidReason = "format" | "install";

export class DomainInvalidError extends Error {
	override name = "DomainInvalidError";
	readonly reason: DomainInvalidReason;
	constructor(reason: DomainInvalidReason) {
		super(
			reason === "install"
				? "This domain is the Install's own: choose another one."
				: "A domain is a name such as bakery.ie or www.bakery.ie, without https:// or a path.",
		);
		this.reason = reason;
	}
}

/** A domain is unique on the Install: a Site (this one or another) already has it. */
export class DomainTakenError extends Error {
	override name = "DomainTakenError";
	readonly domain: string;
	constructor(domain: string) {
		super(`${domain} is already one of the Install's domains. To move it, remove it there first.`);
		this.domain = domain;
	}
}

/** The Site has no domain with this id. */
export class DomainNotFoundError extends Error {
	override name = "DomainNotFoundError";
	constructor() {
		super("The Site has no such domain.");
	}
}

/**
 * What can't be done to a domain:
 * - `not-verified`: only a domain the Install has verified can become the Primary domain;
 * - `language`: a language's domain is changed in Languages, not here.
 */
export type DomainChangeProblem = "not-verified" | "language";

export class DomainChangeRefusedError extends Error {
	override name = "DomainChangeRefusedError";
	readonly problem: DomainChangeProblem;
	constructor(problem: DomainChangeProblem) {
		super(
			problem === "language"
				? "This is a language's domain: change it in Languages."
				: "Only a verified domain can become the Primary domain: wait until it is verified.",
		);
		this.problem = problem;
	}
}
