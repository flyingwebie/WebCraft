import { ADMIN_LANGUAGE_CODES, WORKSPACE_ROLES } from "@webcraft/core";
import { z } from "zod";

/** A person's name as they type it. */
export const personName = z.string().trim().min(1).max(200);

/** An email address; WebCraft's auth checks its shape and normalises it. */
export const email = z.string().max(320);

/** A password; WebCraft's auth decides which ones are allowed. */
export const password = z.string().max(4096);

export const adminLanguage = z.enum(ADMIN_LANGUAGE_CODES);

/** The id of a Workspace, Site, person or invite. */
export const id = z.uuid();

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
	z.object({ kind: z.literal("formEmails"), id }),
	z.object({ kind: z.literal("globals") }),
	z.object({ kind: z.literal("consentBanner") }),
	z.object({ kind: z.literal("designSystem") }),
]);

/** The Toolsets a client is given: WebCraft's own keys (`content`, `submissions`, …) and Modules' (`m.<id>`). */
export const toolsetsInput = z.array(z.string().max(120)).max(100);
