import { wordsIn } from "@webcraft/module-sdk";
import type { EmailWording } from "./types.ts";

const days = (count: number) => (count === 1 ? "1 day" : `${count} days`);
const minutes = (count: number) => (count === 1 ? "1 minute" : `${count} minutes`);

const ROLES = { owner: "an Owner", editor: "an Editor", author: "an Author" } as const;

const SECOND_FACTOR = { authenticator: "An authenticator app", passkey: "A passkey" } as const;

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
				`${resetBy} reset the two-factor authentication of your account on ${installName}. Sign in with your password and set it up again.`,
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
		"review-submitted": ({ authorName, itemTitle, siteName, reviewPath }) => ({
			subject: `${authorName} submitted “${itemTitle}” for review`,
			heading: "Ready for review",
			paragraphs: [`${authorName} submitted “${itemTitle}” on ${siteName} for review.`],
			action: { label: "Review it", path: reviewPath },
		}),
		"review-result": ({ itemTitle, siteName, result, reviewerName, comment, itemPath }) => {
			const published = result === "published";
			return {
				subject: published ? `“${itemTitle}” was published` : `“${itemTitle}” was sent back`,
				heading: published ? "Published" : "Sent back",
				paragraphs: [
					published
						? `${reviewerName} published “${itemTitle}” on ${siteName}.`
						: `${reviewerName} sent “${itemTitle}” on ${siteName} back to you.`,
					...(comment ? [`Their comment: ${comment}`] : []),
				],
				action: { label: "Open it", path: itemPath },
			};
		},
		"scheduled-publish-failed": ({ itemTitle, siteName, itemPath }) => ({
			subject: `“${itemTitle}” wasn't published as scheduled`,
			heading: "A scheduled publish didn't go through",
			paragraphs: [
				`The scheduled publish of “${itemTitle}” on ${siteName} didn't go through. Open it to see why and publish it again.`,
			],
			action: { label: "Open it", path: itemPath },
		}),
		"ai-key-cap": ({ workspaceName, percent, usagePath }) =>
			percent === 100
				? {
						subject: `${workspaceName} has reached its monthly AI cap`,
						heading: "The monthly AI cap is reached",
						paragraphs: [
							`${workspaceName} has used all of this month's cap on the shared AI key, so AI translation has stopped. Queued work waits until the cap is raised or the month ends.`,
						],
						action: { label: "See AI usage", path: usagePath },
					}
				: {
						subject: `${workspaceName} has used 80% of its monthly AI cap`,
						heading: "80% of the monthly AI cap is used",
						paragraphs: [
							`${workspaceName} has used 80% of this month's cap on the shared AI key. AI translation stops at 100%, until the cap is raised or the month ends.`,
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
