import { ModuleError } from "@webcraft/module-sdk";

/**
 * Site paths as Redirect rules write them (see the Module SDK's `RedirectRequest`): a path on the
 * Site as its Staging address writes it, each segment percent-encoded once, no trailing slash. A
 * rule's `from` is such a path, or one ending `/*` for every path under it; its target is a Site path
 * (with a query or a fragment if wanted, or ending `/*` to carry the rest of the path over) or an
 * `https://` address.
 */

/** The longest path a rule matches, or the 404 log keeps. */
export const MAX_PATH_LENGTH = 500;
/** The longest target a rule has. */
export const MAX_TARGET_LENGTH = 2000;

/** What a rule matches: one Site path, or (`wildcard`) that path and every path under it. */
export type RuleFrom = { path: string; wildcard: boolean };

/** A Media library file as a target: `media:<id>`. */
export const MEDIA_TARGET = /^media:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An Entry as a target, sent to where it is published then: `entry:<id>`, or `entry:<id>:<language>`. */
export const ENTRY_TARGET =
	/^entry:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?::[a-z]{2,3}(?:-[a-z0-9]{2,8})*)?$/i;

/** The characters no path or address may hold: controls (a line break would end a header). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A Site path's segments, each decoded and encoded again; null for what isn't a path. */
function canonicalSegments(path: string): string[] | null {
	const trimmed = path.slice(1).replace(/\/$/, "");
	if (trimmed === "") return [];
	const segments: string[] = [];
	for (const part of trimmed.split("/")) {
		let decoded: string;
		try {
			decoded = decodeURIComponent(part);
		} catch {
			return null;
		}
		if (decoded === "" || decoded === "." || decoded === "..") return null;
		segments.push(encodeURIComponent(decoded));
	}
	return segments;
}

function invalid(code: string, message: string): never {
	throw new ModuleError(code, message, 400);
}

/** Reads the path a rule matches, as a person typed it: `/old-page`, `/old/*`, `/*`. */
export function parseFrom(input: string): RuleFrom {
	const typed = input.trim();
	if (!typed.startsWith("/") || typed.startsWith("//") || CONTROL.test(typed) || /[?#]/.test(typed)) {
		invalid("FROM_INVALID", "A rule matches a path on the Site, starting with /, without ? or #.");
	}
	const wildcard = typed === "/*" || typed.endsWith("/*");
	const base = wildcard ? typed.slice(0, -2) || "/" : typed;
	if (base.includes("*")) invalid("WILDCARD_INVALID", "A * goes only at the end of a path, after a /: /old/*.");
	const segments = canonicalSegments(base);
	if (!segments) invalid("FROM_INVALID", "That isn't a path: it has an empty part, . or .., or a broken %.");
	if (segments[0]?.startsWith("_")) {
		invalid("FROM_RESERVED", "Paths starting with /_ are the Install's own: no rule can send them elsewhere.");
	}
	const path = `/${segments.join("/")}`;
	if (path.length > MAX_PATH_LENGTH)
		invalid("FROM_INVALID", `A rule's path has at most ${MAX_PATH_LENGTH} characters.`);
	return { path, wildcard };
}

/**
 * Reads a rule's target, as a person typed it: a Site path (made canonical; with a query or a
 * fragment kept as typed), or an `https://` address. It ends `/*` only when the rule matches every
 * path under its own (`/old/*` to `/new/*`), to carry the rest of the path over.
 */
export function parseTarget(input: string, from: RuleFrom): string {
	const typed = input.trim();
	// A file of the Media library (an Import's rule for an old file address), sent to its address as it is then.
	if (MEDIA_TARGET.test(typed)) {
		if (from.wildcard) invalid("WILDCARD_INVALID", "A rule sending visitors to a Media file matches one path.");
		return typed.toLowerCase();
	}
	// An Entry (an Import's rule for an old page address), sent to where it is published then.
	if (ENTRY_TARGET.test(typed)) {
		if (from.wildcard) invalid("WILDCARD_INVALID", "A rule sending visitors to an Entry matches one path.");
		return typed.toLowerCase();
	}
	if (typed === "" || CONTROL.test(typed) || typed.length > MAX_TARGET_LENGTH) {
		invalid(
			"TO_INVALID",
			`A rule sends visitors to a path on the Site or an https:// address, of at most ${MAX_TARGET_LENGTH} characters.`,
		);
	}
	const carries = typed === "/*" || typed.endsWith("/*");
	if (carries && !from.wildcard) {
		invalid("WILDCARD_INVALID", "Only a rule matching every path under one (/old/*) carries the rest over (/new/*).");
	}
	if (typed.startsWith("/") && !typed.startsWith("//")) {
		const [beforeHash = "", ...hashParts] = typed.split("#");
		const [pathPart = "", ...queryParts] = beforeHash.split("?");
		const extra = `${queryParts.length > 0 ? `?${queryParts.join("?")}` : ""}${hashParts.length > 0 ? `#${hashParts.join("#")}` : ""}`;
		if (carries && extra !== "") invalid("WILDCARD_INVALID", "A target ending /* has no ? or #.");
		const base = carries ? pathPart.slice(0, -2) || "/" : pathPart;
		if (base.includes("*")) invalid("WILDCARD_INVALID", "A * goes only at the end of a path, after a /: /new/*.");
		const segments = canonicalSegments(base);
		if (!segments) invalid("TO_INVALID", "That isn't a path: it has an empty part, . or .., or a broken %.");
		const path = `/${segments.join("/")}`;
		const target = `${carries ? `${path === "/" ? "" : path}/*` : path}${extra.replaceAll(" ", "%20")}`;
		if (target.length > MAX_TARGET_LENGTH)
			invalid("TO_INVALID", `A target has at most ${MAX_TARGET_LENGTH} characters.`);
		return target;
	}
	let url: URL;
	try {
		url = new URL(typed);
	} catch {
		return invalid("TO_INVALID", "A rule sends visitors to a path on the Site (/new-page) or an https:// address.");
	}
	if (url.protocol !== "https:") {
		invalid("TO_SCHEME", "An address on another site must start with https://; no other kind of link is allowed.");
	}
	if (url.username !== "" || url.password !== "" || url.hostname === "") {
		invalid("TO_INVALID", "An address on another site names its host, without a user name or password.");
	}
	if (carries) {
		if (url.search !== "" || url.hash !== "") invalid("WILDCARD_INVALID", "A target ending /* has no ? or #.");
		if (url.pathname.slice(0, -2).includes("*")) invalid("WILDCARD_INVALID", "A * goes only at the end of an address.");
	}
	return url.href;
}

/** A rule's `from` as people write it: `/old`, `/old/*`, `/*`. */
export function writtenFrom(from: RuleFrom): string {
	if (!from.wildcard) return from.path;
	return from.path === "/" ? "/*" : `${from.path}/*`;
}

/** Whether a rule matches a Site path. */
export function covers(from: RuleFrom, path: string): boolean {
	if (!from.wildcard) return path === from.path;
	return from.path === "/" || path === from.path || path.startsWith(`${from.path}/`);
}

/** The paths a wildcard rule matching `path` could start at, longest first: `/a/b` gives `/a/b`, `/a`, `/`. */
export function wildcardBases(path: string): string[] {
	const segments = path === "/" ? [] : path.slice(1).split("/");
	const bases: string[] = [];
	for (let count = segments.length; count > 0; count--) bases.push(`/${segments.slice(0, count).join("/")}`);
	bases.push("/");
	return bases;
}

/** Where a rule sends a path it matches: its target, with the rest of the path carried over when the target ends `/*`. */
export function targetFor(rule: RuleFrom & { target: string }, path: string): string {
	if (!rule.target.endsWith("/*")) return rule.target;
	const base = rule.target.slice(0, -2);
	const rest = !rule.wildcard || path === rule.path ? "" : rule.path === "/" ? path : path.slice(rule.path.length);
	const joined = `${base}${rest === "/" ? "" : rest}`;
	return joined === "" ? "/" : joined;
}

/** The Site path a target names (without its query or fragment), or null for an address elsewhere. */
export function sitePathOf(target: string): string | null {
	if (!target.startsWith("/")) return null;
	const [path = "/"] = target.split(/[?#]/);
	return path.endsWith("/*") ? path.slice(0, -2) || "/" : path;
}

/** `text` for a `LIKE` pattern, its own `%`, `_` and `\` matching only themselves. */
export function likeText(text: string): string {
	return text.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
