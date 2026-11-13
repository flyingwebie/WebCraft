import { ADMIN_LANGUAGE_CODES, WORKSPACE_ROLES } from "@webcraft/core";
import { z } from "zod";

/** A person's name as they type it. */
export const personName = z.string().trim().min(1).max(200);

/** An email address; WebCraft's auth checks its shape and normalises it. */
export const email = z.string().max(320);

/** A password; WebCraft's auth decides which ones are allowed. */
export const password = z.string().max(4096);

export const adminLanguage = z.enum(ADMIN_LANGUAGE_CODES);

/** A code from an authenticator app: 6 digits, spaces between them allowed (some apps group them). */
export const authenticatorCode = z.string().regex(/^\s*(\d\s*){6}$/, "Enter the 6 digits the app shows.");

const base64url = (max: number) =>
	z
		.string()
		.max(max)
		.regex(/^[A-Za-z0-9_-]*$/, "Not base64url.");

/** A new passkey, as the browser's `PublicKeyCredential.toJSON()` gives it after `navigator.credentials.create`. */
export const registrationCredential = z.object({
	id: base64url(1400),
	rawId: base64url(1400),
	type: z.literal("public-key"),
	response: z.object({
		clientDataJSON: base64url(4096),
		attestationObject: base64url(65536),
		transports: z.array(z.string().max(32)).max(10).optional(),
	}),
});

/** A passkey's answer, as the browser's `PublicKeyCredential.toJSON()` gives it after `navigator.credentials.get`. */
export const assertionCredential = z.object({
	id: base64url(1400),
	rawId: base64url(1400),
	type: z.literal("public-key"),
	response: z.object({
		clientDataJSON: base64url(4096),
		authenticatorData: base64url(4096),
		signature: base64url(2048),
		userHandle: base64url(256).nullish(),
	}),
});

/** A code given at sign-in: an authenticator app's, or a backup code. A wrong one counts as a wrong attempt. */
export const signInCode = z.string().min(1).max(64);

/** The id of a Workspace, Site, person or invite. */
export const id = z.uuid();

/** A Component's id: a UUID for the Site's own, `<module id>:<Name>` for a Module's. */
export const componentId = z.union([id, z.string().regex(/^[a-z][a-z0-9-]{0,31}:[A-Z][A-Za-z0-9]{0,63}$/)]);

/** Which Workspaces (or Sites) something reaches: `"all"`, including ones created later, or a list of ids. */
export const reach = z.union([z.literal("all"), z.array(id).max(1000)]);

/** A Workspace role a Membership holds: `owner`, `editor` or `author`. */
export const workspaceRole = z.enum(WORKSPACE_ROLES);

/** Which Sites of its Workspace a Membership reaches: `"all"`, including ones created later, or at least one chosen Site. */
export const memberSites = z.union([z.literal("all"), z.array(id).min(1).max(1000)]);

/**
 * The version of the Draft a save was made from (as reading it answered `version`), or null when it
 * was made while there was none. A save based on a version the Draft no longer has is refused with
 * `CHANGED_MEANWHILE`, so it never overwrites someone else's save. Left out, a save replaces the Draft.
 */
export const basedOn = z
	.string()
	.regex(/^[0-9a-f]{16}$/)
	.nullable()
	.optional();

/** One publishable item, as publishing and its history name it: by kind, and by id where a Site has many. */
export const publishItem = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("entry"), id }),
	z.object({ kind: z.literal("template"), id }),
	z.object({ kind: z.literal("component"), id }),
	z.object({ kind: z.literal("loop"), id }),
	z.object({ kind: z.literal("filter"), id }),
	z.object({ kind: z.literal("script"), id }),
	z.object({ kind: z.literal("form"), id }),
	z.object({ kind: z.literal("popup"), id }),
	z.object({ kind: z.literal("popupContent"), id }),
	z.object({ kind: z.literal("formEmails"), id }),
	z.object({ kind: z.literal("globals") }),
	z.object({ kind: z.literal("consentBanner") }),
	z.object({ kind: z.literal("designSystem") }),
]);

/**
 * An item submitted for Review: the Content Authors change and can't publish (an Entry, Pages
 * included; the Globals; the Consent banner's words).
 */
export const reviewItem = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("entry"), id }),
	z.object({ kind: z.literal("popupContent"), id }),
	z.object({ kind: z.literal("globals") }),
	z.object({ kind: z.literal("consentBanner") }),
]);

/** The Toolsets a client is given: WebCraft's own keys (`content`, `submissions`, …) and Modules' (`m.<id>`). */
export const toolsetsInput = z.array(z.string().max(120)).max(100);
