import { AUDIT_RETENTION_DAYS, HISTORY_LIMITS, INSTALL_NAME_MAX_LENGTH, MEDIA_MAX_FILE_BYTES } from "@webcraft/core";
import { z } from "zod";

import { onInstall, sensitive } from "../context.ts";
import { adminLanguage } from "../inputs.ts";
import { emailBranding, emailLog, smtp } from "./email.ts";

/** A storage key part: letters, digits, dots, dashes and underscores. */
const KEY_PART = "[A-Za-z0-9_][A-Za-z0-9._-]*";

/** An S3-compatible bucket's settings, as Media storage and Backups take them. */
const bucketSettings = {
	endpoint: z.url({ protocol: /^https?$/ }).max(500),
	region: z
		.string()
		.trim()
		.min(1)
		.max(64)
		.regex(/^[a-z0-9-]+$/),
	bucket: z
		.string()
		.trim()
		.min(3)
		.max(63)
		.regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/),
	/** Put in front of every key, so one bucket can hold several Installs; empty for none. */
	prefix: z
		.string()
		.trim()
		.max(200)
		.regex(new RegExp(`^(${KEY_PART}(/${KEY_PART})*)?$`))
		.default(""),
	pathStyle: z.boolean().default(true),
	accessKeyId: z.string().trim().min(1).max(200),
	/** A new secret access key; absent keeps the one stored. */
	secretAccessKey: z.string().min(1).max(500).optional(),
};

/** Install settings › Backups: whether the worker takes one every day, and where they go. */
const backupChange = z.object({
	scheduled: z.boolean(),
	target: z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("folder") }),
		z.object({ kind: z.literal("s3"), ...bucketSettings }),
	]),
});

/** Where Media is stored: local disk, or an S3-compatible bucket with all its settings. */
const storageChange = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("disk") }),
	z.object({
		kind: z.literal("s3"),
		...bucketSettings,
	}),
]);

/** The Install itself, for the Superadmin. */
export const install = {
	settings: {
		/** Install settings › General. */
		get: onInstall("install.manage").handler(({ context }) => context.services.settings.read()),
		/** Changes Install settings › General; an empty name clears it. */
		update: onInstall("install.manage")
			.input(
				z.object({
					name: z.string().trim().max(INSTALL_NAME_MAX_LENGTH).nullable().optional(),
					defaultAdminLanguage: adminLanguage.optional(),
				}),
			)
			.handler(({ context, input }) => context.services.settings.update(input)),
	},
	masterKey: {
		/** Whether the running Master key is confirmed as stored outside the server, and its fingerprint. */
		status: onInstall("install.manage").handler(async ({ context }) => ({
			...(await context.services.masterKey.status()),
			fingerprint: context.services.masterKey.fingerprint,
		})),
		/** The Superadmin confirms the running Master key is stored outside the server. */
		confirmStored: onInstall("install.manage")
			.use(sensitive("masterKey.confirmStored"))
			.handler(async ({ context }) => ({
				...(await context.services.masterKey.confirmStored(context.install)),
				fingerprint: context.services.masterKey.fingerprint,
			})),
	},
	/** Install settings › Security: how the Install checks people's passwords. */
	security: {
		get: onInstall("install.manage").handler(({ context }) => context.services.settings.security()),
		/** Switches the leaked-password check on new passwords on or off. */
		update: onInstall("install.manage")
			.use(sensitive("leakedPasswordCheck.change"))
			.input(z.object({ leakedPasswordCheck: z.boolean() }))
			.handler(({ context, input }) =>
				context.services.settings.setLeakedPasswordCheck(context.install, input.leakedPasswordCheck),
			),
		/**
		 * Requires two-factor authentication of everyone on the Install, or stops requiring it. People
		 * without it are sent to add it right after signing in. Switching it on needs your own first.
		 */
		requireTwoFactor: onInstall("install.manage")
			.use(sensitive("twoFactorRequirement.change"))
			.input(z.object({ required: z.boolean() }))
			.handler(({ context, input }) =>
				context.services.twoFactor.setInstallRequirement(context.install, input.required),
			),
		/** How many days Audit log entries are kept (1 year unless the Superadmin chose another). */
		auditRetention: onInstall("install.manage").handler(({ context }) => context.services.audit.retention()),
		/**
		 * Sets how many days Audit log entries are kept, from 90 days to 10 years; the worker removes
		 * older ones every day. A Sensitive action: a shorter time removes entries.
		 */
		setAuditRetention: onInstall("install.manage")
			.use(sensitive("auditRetention.change"))
			.input(z.object({ days: z.number().int().min(AUDIT_RETENTION_DAYS.min).max(AUDIT_RETENTION_DAYS.max) }))
			.handler(({ context, input }) => context.services.audit.setRetention(context.install, input.days)),
	},
	/** Install settings › Storage: where Media is stored, local disk or an S3-compatible bucket. */
	storage: {
		get: onInstall("install.manage").handler(({ context }) => context.services.storage.settings()),
		/**
		 * Changes where new files go. A bucket is checked first (a small file is written, read and
		 * removed); files stored before stay where they are and keep their URLs.
		 */
		update: onInstall("install.manage")
			.use(sensitive("storage.change"))
			.input(storageChange)
			.handler(({ context, input }) => context.services.storage.change(context.install, input)),
	},
	/**
	 * Install settings › Revisions: whether publishing saves Revisions anywhere on the Install, how many
	 * days Revisions are kept (at least each item's newest few, however old) and how many days
	 * Checkpoints are kept. Turning Revisions off stops new ones; those saved before follow the same rules.
	 */
	history: {
		get: onInstall("install.manage").handler(({ context }) => context.services.history.settings()),
		update: onInstall("install.manage")
			.input(
				z.object({
					revisionsOn: z.boolean().optional(),
					revisionDays: z
						.number()
						.int()
						.min(HISTORY_LIMITS.revisionDays.min)
						.max(HISTORY_LIMITS.revisionDays.max)
						.optional(),
					revisionsKept: z
						.number()
						.int()
						.min(HISTORY_LIMITS.revisionsKept.min)
						.max(HISTORY_LIMITS.revisionsKept.max)
						.optional(),
					checkpointDays: z
						.number()
						.int()
						.min(HISTORY_LIMITS.checkpointDays.min)
						.max(HISTORY_LIMITS.checkpointDays.max)
						.optional(),
				}),
			)
			.handler(({ context, input }) => context.services.history.changeSettings(context.install, input)),
	},
	/** Install settings › Storage: what the Media library takes. */
	media: {
		get: onInstall("install.manage").handler(({ context }) => context.services.settings.media()),
		/** Sets the largest file the Media library takes, from 1 MB to 1 GB. */
		update: onInstall("install.manage")
			.input(
				z.object({
					maxFileBytes: z.number().int().min(MEDIA_MAX_FILE_BYTES.min).max(MEDIA_MAX_FILE_BYTES.max),
				}),
			)
			.handler(({ context, input }) =>
				context.services.settings.setMediaMaxFileBytes(context.install, input.maxFileBytes),
			),
	},
	/**
	 * Install settings › Backups: the setting, the Backup log (newest first) and how Backups are doing.
	 * Taking and restoring one are server commands (`webcraft admin backup`, `restore`).
	 */
	backups: {
		get: onInstall("install.manage").handler(async ({ context }) => {
			const { backups } = context.services;
			const [settings, log, status] = await Promise.all([
				backups.settings(),
				backups.list({ limit: 30 }),
				backups.status(),
			]);
			return { settings, backups: log, status };
		}),
		/** Changes whether Backups are taken every day and where they go; a bucket is checked first. */
		update: onInstall("install.manage")
			.use(sensitive("backups.change"))
			.input(backupChange)
			.handler(({ context, input }) => context.services.backups.change(context.install, input)),
	},
	/** The update check: this build's version and the newest release the feed listed, as last checked. */
	updates: {
		get: onInstall("install.manage").handler(({ context }) => context.services.updates.latest()),
	},
	/** The Install SMTP. */
	smtp,
	/** Install branding of System emails. */
	emailBranding,
	/** The Email log. */
	emailLog,
};
