import { forms } from "@webcraft/db/schema";
import type { FormSubmission, SpamReason } from "@webcraft/module-sdk";
import { FORM_INPUTS, type FormState, type FormVersion, formWords } from "@webcraft/renderer";
import { and, eq, isNotNull } from "drizzle-orm";

import type { Clock } from "../clock.ts";
import { siteLanguages } from "../content/languages.ts";
import { pathSegments } from "../content/url-patterns.ts";
import type { GuardedFetch } from "../guarded-fetch.ts";
import { isUuid } from "../ids.ts";
import type { Logger } from "../log.ts";
import type { ModuleHost } from "../modules/host.ts";
import type { RateLimits } from "../rate-limits.ts";
import { languageOnHost, pageLocation, type SiteHost } from "../site-pages/index.ts";
import type { DataLayer } from "../tenancy/data-layer.ts";
import { storedFormVersion } from "./definition.ts";
import { siteCaptcha } from "./page-forms.ts";
import type { FormTokens } from "./tokens.ts";
import { checkValues, type SentFields, sentValues } from "./values.ts";

/**
 * What a visitor sends to a Form (`POST /_webcraft/forms/<id>` on the Site's domain), after the web
 * process read it: the fields as sent, or null for a post larger than any Form takes (its values are
 * never read).
 */
export type FormPost = {
	fields: SentFields | null;
	/** The client address it came from (`clientAddress`), for the per-address limits; null when unknown. */
	clientAddress: string | null;
	/** The address of the page the browser says it came from (`Referer`), for hidden fields. */
	referer: string | null;
};

/**
 * What a post answers:
 * - `notFound`: no published Form of the Site has that id, or Forms don't run on the Site;
 * - `tooLarge`: the post was larger than any Form takes (kept in the Spam folder);
 * - `invalid`: what was sent breaks the Form's rules: the page is shown again with the visitor's
 *   input and each field's error (nothing is kept);
 * - `sent`: kept (in the inbox, or the Spam folder, which looks the same to the sender); the visitor
 *   goes on to `location` (post, redirect, get).
 */
export type FormPostAnswer =
	| { kind: "notFound" }
	| { kind: "tooLarge" }
	| { kind: "invalid"; page: string; instance: number; state: FormState }
	| { kind: "sent"; location: string };

/** The largest post a Form takes, in bytes: anything larger is spam. */
export const FORM_POST_MAX_BYTES = 512 * 1024;

/** The name of a Site's CAPTCHA secret key. */
export const CAPTCHA_SECRET = "forms.captcha.secret";

export type ReceiveDeps = {
	data: DataLayer;
	modules: Pick<ModuleHost, "submissionsKeptBy" | "receiveSubmission">;
	rateLimits: Pick<RateLimits, "count">;
	tokens: FormTokens;
	fetch: GuardedFetch;
	clock: Clock;
	log: Logger;
};

/** The query that sends a visitor back to the page with Form number `instance` showing its message. */
export const SENT_PARAMETER = "wc-sent";

/**
 * Receives a post to one of the Site's Forms: checks it, then hands the Submission to the Module
 * that keeps them. The checks, in order: the post's size; the time trap (a token this Install made
 * for the Site, at least the Form's fill time old); the honeypot; the Form's rules (failing which
 * the page comes back with errors, and nothing is kept); the per-address limits; the Site's CAPTCHA.
 * Failing a spam check keeps the post in the Spam folder and answers as if it went through.
 */
export async function receiveFormPost(
	deps: ReceiveDeps,
	host: SiteHost,
	formId: string,
	post: FormPost,
): Promise<FormPostAnswer> {
	const { data, modules, clock } = deps;
	if (!isUuid(formId) || (await modules.submissionsKeptBy(host.site)) === null) return { kind: "notFound" };
	const scope = data.visitors(host.site);
	const row = await scope.first(forms, and(eq(forms.id, formId), isNotNull(forms.published)));
	if (!row) return { kind: "notFound" };
	const version = storedFormVersion(row.published);
	const receivedAt = clock.now();
	const keep = (submission: Omit<FormSubmission, "formId" | "formKey" | "formName" | "receivedAt">) =>
		modules.receiveSubmission(host.site, {
			formId: row.id,
			formKey: row.key,
			formName: row.name,
			receivedAt,
			...submission,
		});

	if (post.fields === null) {
		const { defaultLanguage } = await siteLanguages(scope);
		await keep({ language: defaultLanguage, page: null, spam: "size", values: [] });
		return { kind: "tooLarge" };
	}
	const sent = post.fields;
	const page = pageOf(sent.get(FORM_INPUTS.page)?.[0]);
	const instance = instanceOf(sent.get(FORM_INPUTS.instance)?.[0]);
	const language = await languageOnHost(scope, host, page);
	const from = sentFrom(host, page, post.referer);
	const sentLocation = await afterSending(deps, host, version, page, instance, language);

	let spam: SpamReason | null = null;
	const issuedAt = await deps.tokens.issuedAt(host.site.id, sent.get(FORM_INPUTS.token)?.[0] ?? "");
	if (issuedAt === null) spam = "token";
	else if (receivedAt.getTime() - issuedAt.getTime() < version.spam.minFillSeconds * 1000) spam = "too-fast";
	else if ((sent.get(FORM_INPUTS.honeypot) ?? []).some((value) => value !== "")) spam = "honeypot";

	const checked = checkValues(version, sent, language, from);
	const invalid = Object.keys(checked.errors).length > 0;
	if (spam === null && invalid) {
		return { kind: "invalid", page, instance, state: invalidState(sent, checked.errors, null) };
	}
	// Each kept post counts against the address's limits; one beyond them is spam.
	if (!(await withinLimits(deps, row.id, version, post.clientAddress)) && spam === null) spam = "rate-limit";

	if (spam === null) {
		const captcha = await checkCaptcha(deps, host, sent, post.clientAddress);
		if (captcha === "missing" || captcha === "refused") {
			return {
				kind: "invalid",
				page,
				instance,
				state: invalidState(sent, {}, formWords(language).captcha),
			};
		}
		if (captcha === "unchecked") spam = "captcha";
	}

	const values = spam === null || !invalid ? checked.values : sentValues(version, sent, from);
	await keep({ language, page, spam, values });
	return { kind: "sent", location: sentLocation };
}

/** The page a Form says it was sent from: a path on the Site, else `/`. */
function pageOf(text: string | undefined): string {
	if (!text || text.length > 2000 || !text.startsWith("/") || text.startsWith("//") || /[\s\\?#]/.test(text)) {
		return "/";
	}
	return pathSegments(text) ? text : "/";
}

/** Which Form of the page was sent, counting from 1. */
function instanceOf(text: string | undefined): number {
	const number = Number(text);
	return Number.isInteger(number) && number >= 1 && number <= 1000 ? number : 1;
}

/** Where hidden fields read from: the page's address (on this hostname) and its query, as the browser sent them. */
function sentFrom(host: SiteHost, page: string, referer: string | null) {
	let query = new URLSearchParams();
	if (referer) {
		try {
			const url = new URL(referer);
			if (url.origin === host.origin) query = url.searchParams;
		} catch {
			// A Referer that isn't an address gives nothing.
		}
	}
	return { pageUrl: `${host.origin}${page}`, query };
}

/** What a visitor sent and each field's error, as the page shows them again. */
function invalidState(sent: SentFields, errors: Record<string, string>, formError: string | null): FormState {
	const values: Record<string, string[]> = {};
	for (const [name, list] of sent) values[name] = list.map((value) => value.slice(0, 20_000));
	return { kind: "invalid", values, errors, formError };
}

/**
 * Where the visitor goes once the Form is sent: the Form's Page in their language, or the page they
 * were on with the Form's message (which a page answered for them shows, never cached).
 */
async function afterSending(
	deps: ReceiveDeps,
	host: SiteHost,
	version: FormVersion,
	page: string,
	instance: number,
	language: string,
): Promise<string> {
	if (version.success.kind === "redirect") {
		const location = await pageLocation(deps.data.visitors(host.site), host, version.success.pageId, language);
		if (location) return location;
	}
	return `${page}?${SENT_PARAMETER}=${instance}#wc-form-${instance}`;
}

/** Counts a kept post against the Form's limits for the address it came from: per minute, and per hour. */
async function withinLimits(
	deps: ReceiveDeps,
	formId: string,
	version: FormVersion,
	clientAddress: string | null,
): Promise<boolean> {
	const address = clientAddress ?? "unknown";
	const minute = await deps.rateLimits.count(`form:${formId}:minute:${address}`, {
		limit: version.spam.perMinute,
		windowMs: 60_000,
	});
	const hour = await deps.rateLimits.count(`form:${formId}:hour:${address}`, {
		limit: version.spam.perHour,
		windowMs: 3_600_000,
	});
	return minute && hour;
}

/**
 * Checks the Site's CAPTCHA answer with its provider, through the guarded fetcher, with the Site's
 * secret key: `passed` (or no CAPTCHA), `missing` (no answer sent), `refused` (the provider said
 * no), or `unchecked` (the provider couldn't be asked: kept as spam, so nothing is lost).
 */
async function checkCaptcha(
	deps: ReceiveDeps,
	host: SiteHost,
	sent: SentFields,
	clientAddress: string | null,
): Promise<"passed" | "missing" | "refused" | "unchecked"> {
	const captcha = await siteCaptcha(deps.data.visitors(host.site));
	if (!captcha) return "passed";
	const answer = sent.get(captcha.responseField)?.[0] ?? "";
	if (answer === "" || answer.length > 10_000) return "missing";
	try {
		const verifyUrl = new URL(captcha.verifyUrl);
		const response = await deps.data.useSiteSecret(host.site, CAPTCHA_SECRET, (secret) => {
			const body = new URLSearchParams({ secret, response: answer });
			if (clientAddress) body.set("remoteip", clientAddress);
			return deps.fetch(
				new Request(verifyUrl.href, {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: body.toString(),
				}),
				{ allowedHosts: [verifyUrl.hostname], maxRedirects: 0, timeoutMs: 10_000, maxBytes: 64 * 1024 },
			);
		});
		if (!response.ok) throw new Error(`The CAPTCHA provider answered ${response.status}.`);
		const result = (await response.json()) as { success?: unknown };
		return result.success === true ? "passed" : "refused";
	} catch (error) {
		deps.log.warn("A Form's CAPTCHA answer couldn't be checked: the Submission is kept as spam", {
			siteId: host.site.id,
			error,
		});
		return "unchecked";
	}
}
