import { INSTALL_NAME_MAX_LENGTH, MEDIA_MAX_FILE_BYTES } from "@webcraft/core";
import { z } from "zod";

import { onInstall, sensitive } from "../context.ts";
import { adminLanguage } from "../inputs.ts";
import { emailBranding, emailLog, smtp } from "./email.ts";

/** A storage key part: letters, digits, dots, dashes and underscores. */
const KEY_PART = "[A-Za-z0-9_][A-Za-z0-9._-]*";

/** Where Media is stored: local disk, or an S3-compatible bucket with all its settings. */
const storageChange = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("disk") }),
	z.object({
		kind: z.literal("s3"),
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
	/** The Install SMTP. */
	smtp,
	/** Install branding of System emails. */
	emailBranding,
	/** The Email log. */
	emailLog,
};
