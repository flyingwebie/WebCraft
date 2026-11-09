import { z } from "zod";

/**
 * A Module's manifest: who it is, which SDK versions it works with, where it is switched on, and
 * everything it asks for. The Superadmin approves what it asks for on the consent screen; WebCraft
 * refuses anything it didn't declare when it runs.
 */

/** The Consent categories a script a Module adds to Site pages can be in (see the Consent banner). */
export const CONSENT_CATEGORIES = ["necessary", "analytics", "marketing", "media"] as const;

export type ConsentCategory = (typeof CONSENT_CATEGORIES)[number];

/**
 * The built-in roles a Module can give one of its Permissions to (ADR 0028). The Superadmin holds
 * every Module Permission, as they hold every Permission.
 */
export const MODULE_PERMISSION_ROLES = ["staff", "owner", "editor", "author"] as const;

export type ModulePermissionRole = (typeof MODULE_PERMISSION_ROLES)[number];

/** WebCraft services a Module may ask to use. `email`: send emails through the Install's email settings. */
export const MODULE_USES = ["email"] as const;

export type ModuleUse = (typeof MODULE_USES)[number];

/**
 * Words people see, in each of the Module's admin languages: `{ en: "Notes", it: "Note" }`. People
 * whose Admin language the Module doesn't have see its first language.
 */
export type Label = Readonly<Record<string, string>>;

/** A Module id: lower-case letters and digits, words joined by single dashes, such as `site-analytics`. */
export const MODULE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** A Permission key or a procedure name part: `notes.edit`, `submissions.view`. */
const PERMISSION_KEY = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*$/;

/** A host name, in lower case, without a scheme, port or path: `api.example.com`. */
const HOST_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** The path part under `/_wc/m/`: lower-case letters and digits, joined by single dashes. */
const ROUTE_PREFIX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A language tag such as `en` or `pt-BR`. */
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** A version as Semantic Versioning writes it: `1.4.0`, `2.0.0-beta.1`. */
const SEMVER =
	/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const label = z.record(z.string(), z.string().trim().min(1).max(1000));

const unique = <T>(values: readonly T[], key: (value: T) => string = String) =>
	new Set(values.map(key)).size === values.length;

/** One Permission a Module adds, named under its id (`sample.notes.edit`), checked at the Module's level. */
const modulePermission = z.strictObject({
	/** The key, without the Module's id: `notes.edit`. */
	key: z.string().min(1).max(100).regex(PERMISSION_KEY),
	/** What it lets people do, in plain words: "Edit notes". Shown on the consent screen. */
	label,
	/** The built-in roles that hold it, besides the Superadmin. */
	roles: z
		.array(z.enum(MODULE_PERMISSION_ROLES))
		.max(MODULE_PERMISSION_ROLES.length)
		.refine((roles) => unique(roles), "Each role once."),
});

export const moduleManifestSchema = z
	.strictObject({
		id: z.string().min(2).max(32).regex(MODULE_ID),
		name: label,
		/** One or two sentences about what the Module does, shown on the Modules screen and the consent screen. */
		description: label,
		version: z.string().max(64).regex(SEMVER, "A version such as 1.0.0."),
		/** The SDK versions the Module works with, as a range: `^1.0.0`. */
		sdk: z.string().min(1).max(100),
		/** Where Staff switch it on: on each Site, or on each Workspace. */
		level: z.enum(["site", "workspace"]),
		/** Whether it is on wherever Staff haven't switched it, once the Superadmin approves it. */
		onByDefault: z.boolean(),
		/** The admin languages its words come in; the first is used for people whose language isn't there. */
		adminLanguages: z
			.array(z.string().regex(LANGUAGE))
			.min(1)
			.max(30)
			.refine((languages) => unique(languages), "Each language once."),
		/** The Permissions it adds, mapped onto the built-in roles (ADR 0028). */
		permissions: z
			.array(modulePermission)
			.max(50)
			.refine((permissions) => unique(permissions, (permission) => permission.key), "Each Permission key once.")
			.default([]),
		/** The WebCraft services it uses. */
		uses: z
			.array(z.enum(MODULE_USES))
			.refine((uses) => unique(uses), "Each service once.")
			.default([]),
		/** The outside hosts it calls; calls to any other host are refused. */
		outsideHosts: z
			.array(z.string().regex(HOST_NAME, "A host name in lower case, such as api.example.com."))
			.max(50)
			.refine((hosts) => unique(hosts), "Each host once.")
			.default([]),
		/** Where its Site routes answer: `/_wc/m/<routePrefix>/…`. Needed only when it has Site routes. */
		routePrefix: z.string().min(1).max(32).regex(ROUTE_PREFIX).optional(),
		/** The Consent category of the script it adds to Site pages, or null when it adds none. */
		siteScript: z.enum(CONSENT_CATEGORIES).nullable().default(null),
	})
	.superRefine((manifest, context) => {
		const labels: [string, Label][] = [
			["name", manifest.name],
			["description", manifest.description],
			...manifest.permissions.map((permission, index): [string, Label] => [
				`permissions[${index}].label`,
				permission.label,
			]),
		];
		for (const [path, words] of labels) {
			const problem = labelProblem(words, manifest.adminLanguages);
			if (problem) context.addIssue({ code: "custom", path: path.split(/[.[\]]+/).filter(Boolean), message: problem });
		}
	});

/** A manifest as a Module writes it; lists it leaves out are empty. */
export type ModuleManifestInput = z.input<typeof moduleManifestSchema>;

/** A manifest as WebCraft reads it. */
export type ModuleManifest = z.output<typeof moduleManifestSchema>;

/** Why `words` isn't a label in exactly these languages, or null when it is. */
export function labelProblem(words: Label, languages: readonly string[]): string | null {
	const missing = languages.filter((language) => typeof words[language] !== "string" || words[language].trim() === "");
	if (missing.length > 0) return `Words are missing in ${missing.join(", ")}.`;
	const extra = Object.keys(words).filter((language) => !languages.includes(language));
	if (extra.length > 0) return `Words in ${extra.join(", ")}, which the Module doesn't declare.`;
	return null;
}

/** The words of a label in `language`, or in the first of `languages` when it has none in it. */
export function wordsIn(words: Label, language: string, languages: readonly string[]): string {
	return words[language] ?? words[languages[0] ?? ""] ?? Object.values(words)[0] ?? "";
}
