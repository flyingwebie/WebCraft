import { forms } from "@webcraft/db/schema";
import type { FormSubmission, SpamReason } from "@webcraft/module-sdk";
import { FORM_INPUTS, type FormState, type FormVersion, formTextIn, formWords } from "@webcraft/renderer";
import { and, eq, isNotNull } from "drizzle-orm";

import type { Clock } from "../clock.ts";
import { pathSegments } from "../content/url-patterns.ts";
import type { GuardedFetch } from "../guarded-fetch.ts";
import { isUuid } from "../ids.ts";
import type { Logger } from "../log.ts";
import type { ModuleHost } from "../modules/host.ts";
import type { RateLimits } from "../rate-limits.ts";
import { languageOnHost, pageLocation, type SiteHost } from "../site-pages/index.ts";
import { PAGE_PARAMETER, pageHref, pageNumberIn } from "../site-pages/loops.ts";
import type { DataLayer } from "../tenancy/data-layer.ts";
import { storedFormVersion } from "./definition.ts";
import { siteCaptcha } from "./page-forms.ts";
import type { FormTokens } from "./tokens.ts";
import { cleanFileName, type FormUploads, uploadContentType, uploadFormat } from "./uploads.ts";
import { checkValues, type SentFields, type SentFiles, sentValues } from "./values.ts";

/** A post's body once read: its fields as sent, and the files sent with it, by field name. */
export type FormPostBody = {
	fields: SentFields;
	files?: ReadonlyMap<string, readonly { name: string; bytes: Uint8Array }[]>;
};

/**
 * What a visitor sends to a Form (`POST /_webcraft/forms/<id>` on the Site's domain). Its body is
 * still unread: WebCraft reads it only once it knows the Form takes posts from that address.
 */
export type FormPost = {
	/**
	 * Reads the body, as far as the Form takes one: a post with files (`takesFiles`: the Form has a file
	 * field) up to `FORM_UPLOAD_POST_MAX_BYTES`, any other up to `FORM_POST_MAX_BYTES`. Null for a
	 * larger one, which is never read to its end.
	 */
	body(takesFiles: boolean): Promise<FormPostBody | null>;
	/** The client address it came from (`clientAddress`), for the per-address limits; null when unknown. */
	clientAddress: string | null;
	/** The address of the page the browser says it came from (`Referer`), for hidden fields. */
	referer: string | null;
	/** How the post reached the Site: on its Staging address, or on one of its domains. */
	via: "staging" | "domain";
	/** Whether the post carries an Edit mode session that still holds. */
	editing: boolean;
	/** The post itself, for what Modules hear of its sender (`FormSender`): its consent cookie and headers. */
	request: Request;
};

/**
 * What a post answers:
 * - `notFound`: no published Form of the Site has that id, or Forms don't run on the Site;
 * - `refused`: the address sent more than the Form takes from one address (`REFUSED_FROM` times its
 *   limits): nothing is read or kept until `retryAfterSeconds` have passed;
 * - `tooLarge`: the post was larger than the Form takes (nothing is kept);
 * - `invalid`: what was sent breaks the Form's rules: the page is shown again with the visitor's
 *   input and each field's error (nothing is kept);
 * - `sent`: kept (in the inbox, or the Spam folder, which looks the same to the sender); the visitor
 *   goes on to `location` (post, redirect, get).
 */
export type FormPostAnswer =
	| { kind: "notFound" }
	| { kind: "refused"; retryAfterSeconds: number }
	| { kind: "tooLarge" }
	| {
			kind: "invalid";
			/** The path of the page the Form was sent from, and which page of a paginated Loop it showed. */
			page: string;
			pageNumber: number;
			instance: number;
			state: FormState;
	  }
	| {
			kind: "sent";
			location: string;
			/** The Form's message once sent, in the visitor's language; null when it sends them to a Page. */
			message: string | null;
	  };

/** The largest post a Form takes, in bytes: anything larger is refused. */
export const FORM_POST_MAX_BYTES = 512 * 1024;

/**
 * How many times a Form's per-address limits one address may send before its posts are refused
 * outright. Up to the limits, posts reach the inbox; past them they are kept as spam, so a person who
 * sends a few too many loses nothing; past this many times the limits nothing is read, rendered or
 * kept, so one address can't fill the Spam folder or keep the web process busy.
 */
export const REFUSED_FROM = 10;

/** The name of a Site's CAPTCHA secret key. */
export const CAPTCHA_SECRET = "forms.captcha.secret";

export type ReceiveDeps = {
	data: DataLayer;
	uploads: Pick<FormUploads, "store" | "discard">;
	modules: Pick<ModuleHost, "submissionsKeptBy" | "receiveSubmission">;
	rateLimits: Pick<RateLimits, "count" | "tally">;
	tokens: FormTokens;
	fetch: GuardedFetch;
	clock: Clock;
	log: Logger;
};

/** The query that sends a visitor back to the page with Form number `instance` showing its message. */
export const SENT_PARAMETER = "wc-sent";

/**
 * Receives a post to one of the Site's Forms: checks it, then hands the Submission to the Module
 * that keeps them. The checks, in order: how much the address has sent (past `REFUSED_FROM` times the
 * Form's limits the post is refused unread); the post's size (a larger one is refused, its body never
 * read to the end); the time trap (a token this Install made for the Site, at least the Form's fill
 * time old); the honeypot; the Form's rules (failing which the page comes back with errors, and
 * nothing is kept); the per-address limits; the Site's CAPTCHA. Failing a spam check keeps the post
 * in the Spam folder and answers as if it went through.
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
	const keep = (submission: Omit<FormSubmission, "formId" | "formKey" | "formName" | "receivedAt" | "sender">) =>
		modules.receiveSubmission(
			host.site,
			{ formId: row.id, formKey: row.key, formName: row.name, receivedAt, ...submission },
			{
				route: { site: host.site, via: post.via, clientAddress: post.clientAddress, editing: post.editing },
				request: post.request,
			},
		);

	const retryAfterSeconds = await refusedFor(deps, row.id, version, post.clientAddress);
	if (retryAfterSeconds !== null) return { kind: "refused", retryAfterSeconds };
	const body = await post.body(version.fields.some((field) => field.type === "file"));
	if (body === null) return { kind: "tooLarge" };
	const sent = body.fields;
	const { path, number } = pageOf(sent.get(FORM_INPUTS.page)?.[0]);
	// The page's address as visitors saw it: page N of a paginated Loop keeps its `?page=N`.
	const page = pageHref(path, number);
	const instance = instanceOf(sent.get(FORM_INPUTS.instance)?.[0]);
	const language = await languageOnHost(scope, host, path);
	const from = sentFrom(host, page, post.referer);
	const sentLocation = await afterSending(deps, host, version, page, instance, language);
	const sentMessage = version.success.kind === "message" ? formTextIn(version.success.message, language) : null;
	const files = sentFilesOf(body.files);

	let spam: SpamReason | null = null;
	const issuedAt = await deps.tokens.issuedAt(host.site.id, sent.get(FORM_INPUTS.token)?.[0] ?? "");
	if (issuedAt === null) spam = "token";
	else if (receivedAt.getTime() - issuedAt.getTime() < version.spam.minFillSeconds * 1000) spam = "too-fast";
	else if ((sent.get(FORM_INPUTS.honeypot) ?? []).some((value) => value !== "")) spam = "honeypot";

	const checked = checkValues(version, sent, language, from, files);
	const invalid = Object.keys(checked.errors).length > 0;
	if (spam === null && invalid) {
		return {
			kind: "invalid",
			page: path,
			pageNumber: number,
			instance,
			state: invalidState(sent, checked.errors, null),
		};
	}
	// Each kept post counts against the address's limits; one beyond them is spam.
	if (!(await withinLimits(deps, row.id, version, post.clientAddress)) && spam === null) spam = "rate-limit";

	if (spam === null) {
		const captcha = await checkCaptcha(deps, host, sent, post.clientAddress);
		if (captcha === "missing" || captcha === "refused") {
			return {
				kind: "invalid",
				page: path,
				pageNumber: number,
				instance,
				state: invalidState(sent, {}, formWords(language).captcha),
			};
		}
		if (captcha === "unchecked") spam = "captcha";
	}

	if (spam !== null) {
		// Spam keeps what was sent, its files by name and size only: their bytes are never stored.
		const values = invalid ? sentValues(version, sent, from, files) : checked.values;
		await keep({ language, page, spam, values });
		return { kind: "sent", location: sentLocation, message: sentMessage };
	}
	// The files are stored first, then belong to the Submission once it is kept (or go, if it isn't).
	const uploads = [...checked.files].flatMap(([fieldKey, list]) =>
		list.map((file) => ({
			fieldKey,
			name: file.name,
			bytes: file.bytes,
			contentType: file.contentType ?? "application/octet-stream",
		})),
	);
	const stored = await deps.uploads.store(host.site, row.id, uploads);
	const uploadIds = stored.flatMap((file) => (file.uploadId ? [file.uploadId] : []));
	let at = 0;
	const values = checked.values.map((value) =>
		value.type === "file" && Array.isArray(value.value)
			? { ...value, value: value.value.map(() => stored[at++] ?? null).filter((file) => file !== null) }
			: value,
	);
	try {
		await keep({ language, page, spam, values });
	} catch (error) {
		await deps.uploads.discard(host.site, uploadIds);
		throw error;
	}
	return { kind: "sent", location: sentLocation, message: sentMessage };
}

/** The files sent, each with what its bytes are: a format Forms take, or null. */
function sentFilesOf(files: FormPostBody["files"]): SentFiles {
	const read = new Map<string, SentFiles extends ReadonlyMap<string, infer List> ? List : never>();
	for (const [key, list] of files ?? []) {
		read.set(
			key,
			list.map((file) => {
				const name = cleanFileName(file.name);
				const format = uploadFormat(file.bytes, name);
				return { name, bytes: file.bytes, format, contentType: format ? uploadContentType(format) : null };
			}),
		);
	}
	return read;
}

/**
 * The page a Form says it was sent from: a path on the Site (else `/`), and which page of a paginated
 * Loop it showed (`/blog?page=2`; the first for any other query).
 */
function pageOf(text: string | undefined): { path: string; number: number } {
	const [path = "", query, ...rest] = (text ?? "").split("?");
	if (
		!text ||
		text.length > 2000 ||
		rest.length > 0 ||
		!path.startsWith("/") ||
		path.startsWith("//") ||
		/[\s\\#]/.test(path) ||
		!pathSegments(path)
	) {
		return { path: "/", number: 1 };
	}
	const asked = query === undefined ? 1 : pageNumberIn(new URLSearchParams(query));
	const onlyPage = query === undefined || query === `${PAGE_PARAMETER}=${asked}`;
	return { path, number: onlyPage && asked !== undefined ? asked : 1 };
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
	return `${page}${page.includes("?") ? "&" : "?"}${SENT_PARAMETER}=${instance}#wc-form-${instance}`;
}

/**
 * Counts a post against what the Form takes from one address at all (`REFUSED_FROM` times its limits,
 * per minute and per hour): null while it is within both, else how many seconds until the address may
 * send again. Every post counts, whatever becomes of it.
 */
async function refusedFor(
	deps: ReceiveDeps,
	formId: string,
	version: FormVersion,
	clientAddress: string | null,
): Promise<number | null> {
	const address = clientAddress ?? "unknown";
	const tallies = [
		await deps.rateLimits.tally(`form:${formId}:all:minute:${address}`, {
			limit: version.spam.perMinute * REFUSED_FROM,
			windowMs: 60_000,
		}),
		await deps.rateLimits.tally(`form:${formId}:all:hour:${address}`, {
			limit: version.spam.perHour * REFUSED_FROM,
			windowMs: 3_600_000,
		}),
	];
	const over = tallies.filter((tally) => !tally.within);
	if (over.length === 0) return null;
	const until = Math.max(...over.map((tally) => tally.resetsAt.getTime()));
	return Math.max(1, Math.ceil((until - deps.clock.now().getTime()) / 1000));
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
