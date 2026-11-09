import { z } from "zod";

/**
 * What kind of System email a type is, which decides whether people can turn it off:
 * - `security`: about a person's account and its safety (invites, resets, sign-in changes). Always sent.
 * - `work`: about their work (Review, Scheduled publishes, AI caps). Each can be turned off.
 * - `alert`: about something on the Install going wrong (domains, a Site's SMTP). Each can be turned off.
 */
export const EMAIL_CATEGORIES = ["security", "work", "alert"] as const;

export type EmailCategory = (typeof EMAIL_CATEGORIES)[number];

/**
 * A path in the admin, such as `/invites/abc`. System emails link only into the admin: the sender
 * puts the admin's origin in front.
 */
const adminPath = z
	.string()
	.max(2048)
	.regex(/^\/(?!\/)[^\s\\]*$/, "an admin path starting with a single /");

const name = z.string().trim().min(1).max(200);
const title = z.string().trim().min(1).max(300);
const count = z.number().int().positive().max(1_000_000);
/** Words a Module wrote, by language. */
const moduleWords = z.record(z.string().max(35), z.string().trim().min(1).max(5000));

/**
 * Every System email type, with its category and the data its wording needs. The wording itself,
 * in every Admin language, is in `wording/`; each person's switches for work and alert emails are
 * in their profile. Add a type here (and its wording) before sending it; never rename one that
 * shipped, as the Email log and people's switches refer to it.
 */
export const SYSTEM_EMAIL_TYPES = {
	// Security: always sent.
	"smtp-test": {
		category: "security",
		data: z.object({}),
	},
	"staff-invite": {
		category: "security",
		data: z.object({ inviterName: name, acceptPath: adminPath, expiresInDays: count }),
	},
	"member-invite": {
		category: "security",
		data: z.object({
			inviterName: name,
			workspaceName: name,
			role: z.enum(["owner", "editor", "author"]),
			acceptPath: adminPath,
			expiresInDays: count,
		}),
	},
	"password-reset": {
		category: "security",
		data: z.object({ resetPath: adminPath, expiresInMinutes: count }),
	},
	"email-change-confirm": {
		category: "security",
		data: z.object({ newEmail: z.string().max(320), confirmPath: adminPath, expiresInMinutes: count }),
	},
	"email-change-notice": {
		category: "security",
		data: z.object({ newEmail: z.string().max(320) }),
	},
	"account-locked": {
		category: "security",
		data: z.object({ failedAttempts: count, lockedMinutes: count }),
	},
	"two-factor-reset": {
		category: "security",
		data: z.object({ resetBy: name }),
	},
	"two-factor-changed": {
		category: "security",
		data: z.object({ method: z.enum(["authenticator", "passkey"]), change: z.enum(["added", "removed"]) }),
	},
	"api-token-created": {
		category: "security",
		data: z.object({ tokenName: name }),
	},
	"ai-client-approved": {
		category: "security",
		data: z.object({ clientName: name }),
	},
	// Work: each can be turned off.
	"review-submitted": {
		category: "work",
		data: z.object({ authorName: name, itemTitle: title, siteName: name, reviewPath: adminPath }),
	},
	"review-result": {
		category: "work",
		data: z.object({
			itemTitle: title,
			siteName: name,
			result: z.enum(["published", "sent-back"]),
			reviewerName: name,
			comment: z.string().max(5000).nullable(),
			itemPath: adminPath,
		}),
	},
	"report-review": {
		category: "work",
		data: z.object({ reportName: title, placeName: name, reviewPath: adminPath }),
	},
	/**
	 * A Scheduled publish (or an Entry's scheduled unpublish) didn't go through, so nothing of it was
	 * published: to the person who scheduled it. `itemTitle` names the item that stopped it (or the only
	 * one), `count` how many the Scheduled publish held, `reason` why, worded in each language.
	 */
	"scheduled-publish-failed": {
		category: "work",
		data: z.object({
			siteName: name,
			action: z.enum(["publish", "unpublish"]),
			itemTitle: title.nullable(),
			count,
			/** When it was scheduled for, as the admin shows times: `2026-03-02 09:00 UTC`. */
			scheduledFor: z.string().max(40),
			reason: z.enum([
				"deleted",
				"invalid",
				"pathTaken",
				"parentUnpublished",
				"structureChanged",
				"access",
				"homePage",
				"other",
			]),
			path: adminPath,
		}),
	},
	"ai-key-cap": {
		category: "work",
		data: z.object({ workspaceName: name, percent: z.union([z.literal(80), z.literal(100)]), usagePath: adminPath }),
	},
	/**
	 * An email a Module sends (`context.email.send`), its words written by the Module in its own
	 * languages: each recipient gets them in their Admin language when the Module has it, otherwise
	 * in the Module's first language (`languages[0]`).
	 */
	"module-message": {
		category: "work",
		data: z.object({
			moduleName: moduleWords,
			languages: z.array(z.string().max(35)).min(1).max(30),
			subject: moduleWords,
			heading: moduleWords,
			paragraphs: z.array(moduleWords).max(20),
			action: z.object({ label: moduleWords, path: adminPath }).nullable(),
		}),
	},
	// Alerts: each can be turned off.
	"domain-unreachable": {
		category: "alert",
		data: z.object({ domain: z.string().max(253), siteName: name, domainsPath: adminPath }),
	},
	"site-smtp-failing": {
		category: "alert",
		data: z.object({ siteName: name, lastResponse: z.string().max(1000), settingsPath: adminPath }),
	},
	"media-quota-warning": {
		category: "alert",
		data: z.object({
			workspaceName: name,
			percent: z.number().int().min(80).max(100),
			usedBytes: z.number().int().min(0),
			quotaBytes: z.number().int().positive(),
			workspacePath: adminPath,
		}),
	},
	"report-failed": {
		category: "alert",
		data: z.object({ reportName: title, placeName: name, reportsPath: adminPath }),
	},
	"webhook-switched-off": {
		category: "alert",
		data: z.object({
			webhookName: name,
			host: z.string().max(300),
			siteName: name,
			failures: count,
			webhooksPath: adminPath,
		}),
	},
} as const satisfies Record<string, { category: EmailCategory; data: z.ZodType }>;

export type SystemEmailType = keyof typeof SYSTEM_EMAIL_TYPES;

/** The data a System email type's wording needs. */
export type SystemEmailData<Type extends SystemEmailType> = z.infer<(typeof SYSTEM_EMAIL_TYPES)[Type]["data"]>;

export const SYSTEM_EMAIL_TYPE_IDS = Object.keys(SYSTEM_EMAIL_TYPES) as [SystemEmailType, ...SystemEmailType[]];

export function isSystemEmailType(type: string): type is SystemEmailType {
	return Object.hasOwn(SYSTEM_EMAIL_TYPES, type);
}

export function categoryOf(type: SystemEmailType): EmailCategory {
	return SYSTEM_EMAIL_TYPES[type].category;
}

/** Whether people can turn a type off in their profile: work and alert emails, never security ones. */
export function canTurnOff(type: SystemEmailType): boolean {
	return categoryOf(type) !== "security";
}
