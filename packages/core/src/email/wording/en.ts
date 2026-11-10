import { wordsIn } from "@webcraft/module-sdk";
import { formatSize } from "./sizes.ts";
import type { EmailWording } from "./types.ts";

const days = (count: number) => (count === 1 ? "1 day" : `${count} days`);
const minutes = (count: number) => (count === 1 ? "1 minute" : `${count} minutes`);

const ROLES = { owner: "an Owner", editor: "an Editor", author: "an Author" } as const;

const SECOND_FACTOR = { authenticator: "An authenticator app", passkey: "A passkey" } as const;

/** A size as people read it: `850 KB`, `4.2 GB`. */
const size = (bytes: number) => formatSize(bytes, ".");

/** System emails in English. */
export const en: EmailWording = {
	types: {
		"smtp-test": (_data, { installName }) => ({
			subject: `Test email from ${installName}`,
			heading: "Your email settings work",
			paragraphs: [
				`This is a test email from ${installName}. It went through the SMTP server you entered, so emails can reach this address.`,
			],
		}),
		"staff-invite": ({ inviterName, acceptPath, expiresInDays }, { installName }) => ({
			subject: `${inviterName} invited you to ${installName}`,
			heading: "You're invited",
			paragraphs: [`${inviterName} invited you to join ${installName} as Staff.`],
			action: { label: "Accept the invite", path: acceptPath },
			note: `The invite works for ${days(expiresInDays)}. If you weren't expecting it, you can ignore this email.`,
		}),
		"member-invite": ({ inviterName, workspaceName, role, acceptPath, expiresInDays }, { installName }) => ({
			subject: `${inviterName} invited you to ${workspaceName}`,
			heading: "You're invited",
			paragraphs: [`${inviterName} invited you to ${workspaceName} on ${installName}, as ${ROLES[role]}.`],
			action: { label: "Accept the invite", path: acceptPath },
			note: `The invite works for ${days(expiresInDays)}. If you weren't expecting it, you can ignore this email.`,
		}),
		"password-reset": ({ resetPath, expiresInMinutes }, { installName }) => ({
			subject: "Reset your password",
			heading: "Reset your password",
			paragraphs: [
				`Someone asked to reset the password of your account on ${installName}. If it was you, choose a new password.`,
			],
			action: { label: "Choose a new password", path: resetPath },
			note: `The link works for ${minutes(expiresInMinutes)}. If you didn't ask for it, ignore this email: your password stays as it is.`,
		}),
		"email-change-confirm": ({ newEmail, confirmPath, expiresInMinutes }, { installName }) => ({
			subject: "Confirm your new email address",
			heading: "Confirm your new email address",
			paragraphs: [
				`You asked to sign in to ${installName} with ${newEmail} from now on. Confirm that this address is yours.`,
			],
			action: { label: "Confirm this address", path: confirmPath },
			note: `The link works for ${minutes(expiresInMinutes)}. If you didn't ask for it, ignore this email.`,
		}),
		"email-change-notice": ({ newEmail }, { installName }) => ({
			subject: "Your email address is changing",
			heading: "Your email address is changing",
			paragraphs: [
				`Someone asked to change the email address of your account on ${installName} to ${newEmail}.`,
				"If it wasn't you, sign in and change your password, and tell whoever runs this Install.",
			],
			action: { label: "Sign in", path: "/sign-in" },
		}),
		"account-locked": ({ failedAttempts, lockedMinutes }, { installName }) => ({
			subject: "Your account is locked for a while",
			heading: "Your account is locked for a while",
			paragraphs: [
				`After ${failedAttempts} failed attempts to sign in, your account on ${installName} is locked for ${minutes(lockedMinutes)}.`,
				"If it was you, wait and try again. If it wasn't, someone may be guessing your password: change it once you can sign in.",
			],
		}),
		"two-factor-reset": ({ resetBy }, { installName }) => ({
			subject: "Your two-factor authentication was reset",
			heading: "Your two-factor authentication was reset",
			paragraphs: [
				resetBy
					? `${resetBy} reset the two-factor authentication of your account on ${installName}. Sign in with your password and set it up again.`
					: `The two-factor authentication of your account on ${installName} was reset with a command on the server. Sign in with your password and set it up again.`,
				"If you didn't ask for it, tell whoever runs this Install at once.",
			],
			action: { label: "Sign in", path: "/sign-in" },
		}),
		"two-factor-changed": ({ method, change }, { installName }) => {
			const what = `${SECOND_FACTOR[method]} was ${change === "added" ? "added to" : "removed from"} your account`;
			return {
				subject: what,
				heading: what,
				paragraphs: [
					`${what} on ${installName}.`,
					"If it wasn't you, sign in, change your password and check your two-factor authentication.",
				],
			};
		},
		"api-token-created": ({ tokenName }, { installName }) => ({
			subject: "A new API token was created",
			heading: "A new API token was created",
			paragraphs: [
				`The API token “${tokenName}” was created for your account on ${installName}. Scripts that use it can act as you.`,
				"If you didn't create it, sign in and delete it.",
			],
		}),
		"ai-client-approved": ({ clientName }, { installName }) => ({
			subject: `${clientName} can now act for you`,
			heading: `${clientName} can now act for you`,
			paragraphs: [
				`The AI client ${clientName} was approved for your account on ${installName}. It can now do what you allowed, as you.`,
				"If it wasn't you, sign in and remove its access.",
			],
		}),
		"review-submitted": ({ authorName, items, siteName, note, reviewPath }) => {
			const named = listOf(items.map(reviewedName), "and");
			return {
				subject: `${authorName} submitted ${named} for review`,
				heading: "Ready for review",
				paragraphs: [
					`${authorName} submitted ${named} on ${siteName} for review. Publish it, schedule it or send it back with a comment.`,
					...(note ? [`Their note: ${note}`] : []),
				],
				action: { label: "Review it", path: reviewPath },
			};
		},
		"report-review": ({ reportName, placeName, reviewPath }) => ({
			subject: `“${reportName}” is waiting for review`,
			heading: "A Report is waiting for review",
			paragraphs: [
				`The Report “${reportName}” for ${placeName} is ready, with AI text to check. It goes out once someone approves it.`,
			],
			action: { label: "Review it", path: reviewPath },
		}),
		"review-result": ({ item, siteName, result, reviewerName, comment, scheduledFor, itemPath }) => {
			const named = reviewedName(item);
			const outcome = {
				published: {
					subject: `${capital(named)} was published`,
					heading: "Published",
					what: `${reviewerName} published ${named} on ${siteName}.`,
				},
				scheduled: {
					subject: `${capital(named)} is scheduled to be published`,
					heading: "Scheduled",
					what: `${reviewerName} scheduled ${named} on ${siteName} to be published at ${scheduledFor ?? "a later time"}.`,
				},
				"sent-back": {
					subject: `${capital(named)} was sent back`,
					heading: "Sent back",
					what: `${reviewerName} sent ${named} on ${siteName} back to you. Change it, then submit it for review again.`,
				},
			}[result];
			return {
				subject: outcome.subject,
				heading: outcome.heading,
				paragraphs: [outcome.what, ...(comment ? [`Their comment: ${comment}`] : [])],
				action: { label: "Open it", path: itemPath },
			};
		},
		"scheduled-publish-failed": ({ siteName, action, itemTitle, count, scheduledFor, reason, path }) => {
			const named = itemTitle ? `“${itemTitle}”` : "an item";
			const what =
				action === "unpublish"
					? `The Scheduled publish that was to unpublish ${named} on ${siteName} at ${scheduledFor} didn't go through: it is still published.`
					: count > 1
						? `The Scheduled publish of ${count} items on ${siteName} at ${scheduledFor} didn't go through, so none of them was published: they go live together or not at all.`
						: `The Scheduled publish of ${named} on ${siteName} at ${scheduledFor} didn't go through, so it wasn't published.`;
			const why: Record<typeof reason, string> = {
				deleted: `${capital(named)} was deleted after it was scheduled.`,
				invalid: `${capital(named)} has values that break a rule, or required values that are empty.`,
				pathTaken: `The address of ${named} is taken by something published since.`,
				parentUnpublished: `The parent Page of ${named} isn't published.`,
				structureChanged: `${capital(named)} uses a Template, Component, Field or Class that changed or was deleted after it was scheduled.`,
				access: "You may no longer publish on this Site.",
				homePage: `${capital(named)} is the Site's home page, or a Page above it.`,
				other: `${capital(named)} couldn't be published.`,
			};
			return {
				subject:
					action === "unpublish"
						? `${capital(named)} wasn't unpublished as scheduled`
						: `${count > 1 ? `${count} items weren't` : `${capital(named)} wasn't`} published as scheduled`,
				heading: "A Scheduled publish didn't go through",
				paragraphs: [
					what,
					why[reason],
					"The Drafts are as they were. Open them to fix it, then publish or schedule again.",
				],
				action: { label: "Open it", path },
			};
		},
		"ai-key-cap": ({ workspaceName, percent, usagePath }) =>
			percent === 100
				? {
						subject: `${workspaceName} has reached its monthly AI cap`,
						heading: "The monthly AI cap is reached",
						paragraphs: [
							`${workspaceName} has used all of this month's cap on its AI key, so AI translation has stopped. Nothing is half-written: queued work waits until the cap is raised or the month ends.`,
						],
						action: { label: "See AI usage", path: usagePath },
					}
				: {
						subject: `${workspaceName} has used 80% of its monthly AI cap`,
						heading: "80% of the monthly AI cap is used",
						paragraphs: [
							`${workspaceName} has used 80% of this month's cap on its AI key. AI translation stops at 100%, until the cap is raised or the month ends.`,
						],
						action: { label: "See AI usage", path: usagePath },
					},
		"domain-unreachable": ({ domain, siteName, domainsPath }) => ({
			subject: `${domain} is unreachable`,
			heading: `${domain} is unreachable`,
			paragraphs: [
				`The Domain check couldn't reach ${siteName} at ${domain}. The domain may point somewhere else, or its certificate may be missing or about to expire.`,
			],
			action: { label: "Check the domains", path: domainsPath },
		}),
		"media-quota-warning": ({ workspaceName, percent, usedBytes, quotaBytes, workspacePath }) => ({
			subject: `${workspaceName} has used ${percent}% of its Media storage`,
			heading: `${percent}% of the Media storage is used`,
			paragraphs: [
				`The Media libraries of ${workspaceName}'s Sites take ${size(usedBytes)} of ${size(quotaBytes)}. Uploads that would go past the quota are refused.`,
				"Delete files you no longer need (emptying the Trash frees their space at once), or ask for a larger quota.",
			],
			action: { label: "See the storage", path: workspacePath },
		}),
		"report-failed": ({ reportName, placeName, reportsPath }) => ({
			subject: `“${reportName}” couldn't be sent`,
			heading: "A Report couldn't be sent",
			paragraphs: [
				`The PDF of the Report “${reportName}” for ${placeName} couldn't be made after three tries, so it wasn't sent to anyone.`,
				"Its history says why. Send it again from there once the problem is fixed.",
			],
			action: { label: "Open its history", path: reportsPath },
		}),
		"webhook-switched-off": ({ webhookName, host, siteName, failures, webhooksPath }) => ({
			subject: `A Webhook of ${siteName} was switched off`,
			heading: "A Webhook was switched off",
			paragraphs: [
				`The Webhook ${webhookName} of ${siteName}, to ${host}, failed ${failures} deliveries in a row, so it was switched off: it receives nothing until it is switched on again.`,
				"Once the system it calls works again, switch it on and redeliver what it missed from its delivery log.",
			],
			action: { label: "Open the Webhooks", path: webhooksPath },
		}),
		"module-message": ({ moduleName, languages, subject, heading, paragraphs, action }) => {
			const words = (label: Readonly<Record<string, string>>) => wordsIn(label, "en", languages);
			return {
				subject: words(subject),
				heading: words(heading),
				paragraphs: [...paragraphs.map(words), `Sent by the ${words(moduleName)} Module.`],
				...(action ? { action: { label: words(action.label), path: action.path } } : {}),
			};
		},
		"site-smtp-failing": ({ siteName, lastResponse, settingsPath }) => ({
			subject: `The SMTP of ${siteName} is failing`,
			heading: `The SMTP of ${siteName} is failing`,
			paragraphs: [
				`The last 3 emails ${siteName} tried to send through its own SMTP server failed. Each is retried for about 24 hours.`,
				`The server's last answer: ${lastResponse}`,
			],
			action: { label: "Check the email settings", path: settingsPath },
		}),
	},
	layout: {
		linkHint: "If the button doesn't work, copy this address into your browser:",
		sentBy: (installName) => `Sent by ${installName}.`,
		preferences: "Choose which emails you get",
	},
};

/** A sentence's first letter in capitals. */
/** How a Review email names an item: an Entry by its title; the Globals and the Consent banner's words by what they are. */
function reviewedName(item: { kind: "entry" | "globals" | "consentBanner"; title: string | null }): string {
	if (item.kind === "globals") return "the Globals";
	if (item.kind === "consentBanner") return "the Consent banner's words";
	return item.title ? `“${item.title}”` : "an untitled Entry";
}

/** Names joined as a sentence lists them: “A”, “B” and “C”. */
function listOf(names: readonly string[], and: string): string {
	if (names.length <= 1) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} ${and} ${names.at(-1)}`;
}

function capital(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}
