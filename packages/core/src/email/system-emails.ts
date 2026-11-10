import { assertValidEmail, normaliseEmail } from "@webcraft/auth";
import type { Database } from "@webcraft/db";
import { emailLog, emailOptOuts, people } from "@webcraft/db/schema";
import { and, eq, inArray } from "drizzle-orm";

import { type AdminLanguageCode, adminLanguageDirection, isAdminLanguage } from "../admin-languages.ts";
import type { InstallConfig } from "../config.ts";
import type { InstallSettings } from "../install-settings.ts";
import type { SecretRef } from "../secrets/refs.ts";
import type { EmailBranding, InstallBranding } from "./branding.ts";
import { canTurnOff, SYSTEM_EMAIL_TYPES, type SystemEmailData, type SystemEmailType } from "./catalogue.ts";
import type { RelatedItem } from "./email-log.ts";
import { checkSettings, INSTALL_SMTP_PASSWORD, type SmtpSettings } from "./install-smtp.ts";
import { renderEmail } from "./layout.ts";
import { emailOf, type OutboxPorts, queueEmail, send } from "./outbox.ts";
import type { SiteMailRoute } from "./site-mail.ts";
import { en } from "./wording/en.ts";
import { it } from "./wording/it.ts";
import type { EmailContent, EmailWording } from "./wording/types.ts";

/** System emails in every Admin language. */
const WORDING: Record<AdminLanguageCode, EmailWording> = { en, it };

/** Where each person turns work and alert emails on and off. */
export const EMAIL_PREFERENCES_PATH = "/account#emails";

/**
 * Who a System email goes to: a person with an account (their address, Admin language and email
 * switches come from their profile), or an address with no account yet, such as an invite's.
 */
export type Recipient = { personId: string } | { email: string; language?: AdminLanguageCode };

/** A System email to send: its type, its recipients and the data its wording needs. */
export type SystemEmail<Type extends SystemEmailType = SystemEmailType> = {
	type: Type;
	to: Recipient | readonly Recipient[];
	data: SystemEmailData<Type>;
	/** What it is about, linked from the Email log. */
	related?: RelatedItem;
	/**
	 * Tried at once from this process as well as queued: Health alerts only, which can't wait for a
	 * worker that may be what is failing.
	 */
	now?: boolean;
	/**
	 * The Site whose mail it is (a Site-level Module's email): it goes out as the Site's mail does,
	 * through the Site's own server when it has one, else the Install SMTP, under the Site's sender name
	 * and with its reply-to. Absent for the Install's own emails.
	 */
	site?: { id: string; route: SiteMailRoute };
};

/**
 * What became of the email to each recipient: `queued` for the worker, `logged` (written to the
 * log: the Install SMTP isn't set), or `turned-off` (they turned this type off in their profile).
 */
export type SendResult = { recipient: string; status: "queued" | "logged" | "turned-off"; emailId: string | null };

/** The result of a test email: whether the server took it, and its answer. */
export type TestEmailResult = { status: "sent" | "failed"; response: string; emailId: string };

/** Headers every System email carries: it was sent by software, so auto-replies stay away. */
const SYSTEM_HEADERS = { "Auto-Submitted": "auto-generated" };

type SenderOptions = OutboxPorts & {
	config: InstallConfig;
	settings: InstallSettings;
	branding: InstallBranding;
};

type Addressee = { email: string; personId: string | null; language: AdminLanguageCode; turnedOff: boolean };

export function createSystemEmailSender(options: SenderOptions) {
	const { database, config, settings, branding, clock } = options;

	/** Renders a type's wording in one language, inside the layout, under Install branding. */
	const render = <Type extends SystemEmailType>(
		brand: EmailBranding,
		type: Type,
		data: SystemEmailData<Type>,
		language: AdminLanguageCode,
		forPerson: boolean,
	) => {
		const wording = WORDING[language];
		const write = wording.types[type] as (
			data: SystemEmailData<Type>,
			context: { installName: string },
		) => EmailContent;
		const rendered = renderEmail({
			content: write(data, { installName: brand.installName }),
			branding: brand,
			words: wording.layout,
			language,
			dir: adminLanguageDirection(language),
			adminOrigin: config.adminOrigin,
			preferencesPath: forPerson && canTurnOff(type) ? EMAIL_PREFERENCES_PATH : undefined,
		});
		return { ...rendered, fromName: brand.senderName };
	};

	return {
		/**
		 * Sends a System email: renders its wording in each recipient's Admin language, in the one
		 * built-in layout under Install branding, records it in the Email log and queues it for the
		 * worker, which sends it through the Install SMTP. Recipients who turned the type off are
		 * skipped; security emails always go. Until the Install SMTP is set, the email is written to the
		 * log instead.
		 */
		async send<Type extends SystemEmailType>(email: SystemEmail<Type>): Promise<SendResult[]> {
			const data = SYSTEM_EMAIL_TYPES[email.type].data.parse(email.data) as SystemEmailData<Type>;
			const addressees = await resolveRecipients(database, settings, email.type, email.to);
			const brand = await branding.resolve();
			const results: SendResult[] = [];
			for (const addressee of addressees) {
				if (addressee.turnedOff) {
					results.push({ recipient: addressee.email, status: "turned-off", emailId: null });
					continue;
				}
				const rendered = render(brand, email.type, data, addressee.language, addressee.personId !== null);
				const site = email.site;
				const { emailId, status } = await queueEmail(options, {
					type: email.type,
					to: addressee.email,
					personId: addressee.personId,
					fromName: site ? site.route.fromName : rendered.fromName,
					subject: rendered.subject,
					text: rendered.text,
					html: rendered.html,
					headers: SYSTEM_HEADERS,
					smtp: site ? site.route.smtp : { kind: "install" },
					related: email.related ?? null,
					...(site ? { siteId: site.id, replyTo: site.route.replyTo } : {}),
					...(email.now ? { now: true } : {}),
				});
				results.push({ recipient: addressee.email, status, emailId });
			}
			return results;
		},

		/**
		 * Sends a test email at once, through the SMTP settings given (which may not be saved yet), and
		 * answers whether the server took it. `password` is a newly typed one; without it the stored
		 * Install SMTP password is used. It is recorded in the Email log, but doesn't count towards the
		 * Install SMTP's record of failures: the settings tried may not be the saved ones.
		 */
		async sendTest(test: {
			to: string;
			language: AdminLanguageCode;
			smtp: SmtpSettings;
			password?: string;
			personId: string;
			/**
			 * A Site's mail settings being tried: its sender name and reply-to, which server they name
			 * (`site`: its own, whose stored password is `password`; `install`: the Install SMTP).
			 */
			site?: {
				id: string;
				fromName: string;
				replyTo: string | null;
				smtp: "site" | "install";
				password: SecretRef;
			};
		}): Promise<TestEmailResult> {
			const to = normaliseEmail(test.to);
			assertValidEmail(to);
			const smtp = checkSettings(test.smtp);
			const rendered = render(await branding.resolve(), "smtp-test", {}, test.language, false);
			const site = test.site;
			const now = clock.now();
			const [row] = await database.db
				.insert(emailLog)
				.values({
					createdAt: now,
					type: "smtp-test",
					recipient: to,
					personId: null,
					subject: rendered.subject,
					smtp: site?.smtp ?? "install",
					siteId: site?.id ?? null,
					status: "queued",
					nextAttemptAt: now,
					relatedKind: site ? "site-smtp" : "install-smtp",
					relatedId: site?.id ?? "install",
				})
				.returning({ id: emailLog.id });
			if (!row) throw new Error("The Email log did not take the test email.");
			const message = site
				? { to, ...rendered, fromName: site.fromName, replyTo: site.replyTo, headers: SYSTEM_HEADERS }
				: { to, ...rendered, headers: SYSTEM_HEADERS };
			const outcome = await send(
				options,
				{ settings: smtp, password: site?.password ?? INSTALL_SMTP_PASSWORD },
				emailOf(message, smtp),
				test.password,
			);
			await database.db
				.update(emailLog)
				.set({
					status: outcome.ok ? "sent" : "failed",
					attempts: 1,
					lastResponse: outcome.response,
					lastAttemptAt: now,
					nextAttemptAt: null,
				})
				.where(eq(emailLog.id, row.id));
			options.log.info("A test email was sent through SMTP settings", {
				personId: test.personId,
				emailId: row.id,
				smtp: { host: smtp.host, port: smtp.port },
				status: outcome.ok ? "sent" : "failed",
				response: outcome.response,
			});
			return { status: outcome.ok ? "sent" : "failed", response: outcome.response, emailId: row.id };
		},
	};
}

export type SystemEmailSender = ReturnType<typeof createSystemEmailSender>;

/** Each recipient once, with their address, Admin language and whether they turned the type off. */
async function resolveRecipients(
	database: Database,
	settings: InstallSettings,
	type: SystemEmailType,
	to: Recipient | readonly Recipient[],
): Promise<Addressee[]> {
	const recipients: readonly Recipient[] = Array.isArray(to) ? to : [to as Recipient];
	const { defaultAdminLanguage } = await settings.read();
	const personIds = recipients.flatMap((recipient) => ("personId" in recipient ? [recipient.personId] : []));
	const found = personIds.length
		? await database.db
				.select({ id: people.id, email: people.email, adminLanguage: people.adminLanguage })
				.from(people)
				.where(inArray(people.id, personIds))
		: [];
	const turnedOff = new Set(
		personIds.length && canTurnOff(type)
			? (
					await database.db
						.select({ personId: emailOptOuts.personId })
						.from(emailOptOuts)
						.where(and(inArray(emailOptOuts.personId, personIds), eq(emailOptOuts.type, type)))
				).map((row) => row.personId)
			: [],
	);

	const addressees = new Map<string, Addressee>();
	for (const recipient of recipients) {
		if ("personId" in recipient) {
			const person = found.find((candidate) => candidate.id === recipient.personId);
			if (!person) throw new Error(`There is no person ${recipient.personId} to send a System email to.`);
			const language =
				person.adminLanguage && isAdminLanguage(person.adminLanguage) ? person.adminLanguage : defaultAdminLanguage;
			addressees.set(person.email, {
				email: person.email,
				personId: person.id,
				language,
				turnedOff: turnedOff.has(person.id),
			});
		} else {
			const email = normaliseEmail(recipient.email);
			assertValidEmail(email);
			if (!addressees.has(email)) {
				addressees.set(email, {
					email,
					personId: null,
					language: recipient.language ?? defaultAdminLanguage,
					turnedOff: false,
				});
			}
		}
	}
	return [...addressees.values()];
}
