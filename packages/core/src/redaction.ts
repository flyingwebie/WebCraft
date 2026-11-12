/**
 * Redaction: what never reaches a log line, an Error log sample or an event sent to an error
 * tracker. One list, here, for every process:
 *
 * - Fields named as secrets (`SECRET_NAMES`): passwords, passphrases (a Site export's), secrets,
 *   tokens and keys (API tokens, Content keys, AI keys, OAuth codes and tokens), `Authorization`
 *   and `Cookie` headers, signatures. Their values are replaced, whatever they hold.
 * - Fields named as people's content (`CONTENT_NAMES`): form Submissions' values and email bodies.
 * - In any text (messages, stacks, URLs, other values): WebCraft's own tokens and keys by their
 *   prefixes, `Bearer` and `Basic` credentials, a password in a URL (`postgres://user:password@…`)
 *   and the values of query and form parameters named as secrets (`?token=…`, `&key=…`).
 *
 * The exceptions are deliberate, and marked where they are written with `printedOnPurpose`: the setup
 * token the web process prints while an Install has no Superadmin (spec story 5), and a System email
 * written to the log while no SMTP is set (spec story 7), both for the person running the server.
 */

/** What a redacted value is replaced with. */
export const REDACTED = "[redacted]";

/** Compared without case and without `-`, `_` and `.`: `api_key`, `apiKey` and `API-Key` are one name. */
function normalised(name: string): string {
	return name.toLowerCase().replace(/[-_.\s]/g, "");
}

/** Field names, or name endings, whose values are secrets (`smtpPassword`, `x-api-key`, `setCookie`). */
export const SECRET_NAMES = [
	"password",
	"passwd",
	"passphrase",
	"secret",
	"token",
	"apikey",
	"aikey",
	"contentkey",
	"privatekey",
	"accesskey",
	"secretaccesskey",
	"authorization",
	"proxyauthorization",
	"cookie",
	"cookies",
	"setcookie",
	"credentials",
	"signature",
	"otp",
	"totp",
	"backupcode",
	"backupcodes",
	"recoverycode",
] as const;

/** Field names whose values are people's content: a form Submission's values, an email's body. */
export const CONTENT_NAMES = [
	"submission",
	"submissions",
	"submissionvalues",
	"formvalues",
	"emailbody",
	"emailhtml",
	"html",
] as const;

const ON_PURPOSE = Symbol("webcraft.printedOnPurpose");

/** A value a log line holds as it is, never redacted. */
export type PrintedOnPurpose<Value> = { readonly [ON_PURPOSE]: Value };

/**
 * Marks a log field's value to be printed as it is: only for what the person running the server must
 * read in the log (the setup token, a System email while no SMTP is set). Never for anything else.
 */
export function printedOnPurpose<Value>(value: Value): PrintedOnPurpose<Value> {
	return { [ON_PURPOSE]: value };
}

function isPrintedOnPurpose(value: object): value is PrintedOnPurpose<unknown> {
	return ON_PURPOSE in value;
}

const SECRET = SECRET_NAMES.map(normalised);
const CONTENT = new Set<string>(CONTENT_NAMES.map(normalised));

/** Whether a field of this name holds a secret or people's content, and is never logged. */
export function isRedactedName(name: string): boolean {
	const key = normalised(name);
	return CONTENT.has(key) || SECRET.some((secret) => key === secret || key.endsWith(secret));
}

/** Query and form parameters whose values are secrets, in URLs and text. */
const SECRET_PARAMETERS =
	"token|access_token|refresh_token|id_token|code|device_code|user_code|key|api_key|apikey|content_key|contentkey|password|passwd|secret|client_secret|passphrase|signature|sig|sentry_key";

const TEXT_RULES: readonly [RegExp, string][] = [
	// WebCraft's own API tokens, Content keys and OAuth codes (device codes too), tokens and client secrets.
	[/\bwebcraft(?:-(?:ck|at|rt|cs|dc|code))?_[A-Za-z0-9_-]{8,}/g, REDACTED],
	// Credentials in an Authorization header written out.
	[/\b(Bearer|Basic|Digest)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${REDACTED}`],
	// A user and password in a URL: postgres://user:password@host/…
	[/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*):[^\s/@]+@/gi, `$1:${REDACTED}@`],
	// A quoted secret in JSON or code written into a message: "password":"…", 'apiKey': '…'.
	[
		/(["'])([\w-]*(?:password|passwd|passphrase|secret|token|api[_-]?key|authorization|cookie|private[_-]?key))\1(\s*[:=]\s*)(["'])(?:\\.|(?!\4)[^\\])*\4/gi,
		`$1$2$1$3$4${REDACTED}$4`,
	],
	// A secret parameter in a query string or a form body.
	[new RegExp(`([?&;]|\\b)(${SECRET_PARAMETERS})=[^&#\\s"'<>]+`, "gi"), `$1$2=${REDACTED}`],
];

/** A text with every secret found in it replaced. */
export function redactText(text: string): string {
	let result = text;
	for (const [pattern, replacement] of TEXT_RULES) result = result.replace(pattern, replacement);
	return result;
}

/** How deep redaction looks into nested values; anything deeper is left out. */
const MAX_DEPTH = 8;

/** An error as a line shows it: its kind, message and stack (redacted), and its code when it has one. */
function errorValue(error: Error, seen: WeakSet<object>, depth: number): Record<string, unknown> {
	const shown: Record<string, unknown> = {
		name: error.name,
		message: redactText(error.message),
		...(error.stack ? { stack: redactText(error.stack) } : {}),
	};
	const code = (error as { code?: unknown }).code;
	if (typeof code === "string" || typeof code === "number") shown.code = code;
	if (error.cause !== undefined && depth < MAX_DEPTH) shown.cause = redactValue(error.cause, seen, depth + 1);
	return shown;
}

/** A value with every secret and every piece of people's content in it replaced. */
export function redactValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
	if (typeof value === "string") return redactText(value);
	if (value === null || typeof value !== "object") return value;
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
	if (value instanceof URL) return redactText(value.toString());
	if (isPrintedOnPurpose(value)) return value[ON_PURPOSE];
	if (seen.has(value)) return "[circular]";
	if (depth >= MAX_DEPTH) return "[nested too deep]";
	seen.add(value);
	if (value instanceof Error) return errorValue(value, seen, depth);
	if (value instanceof Headers) return redactFields(Object.fromEntries(value), seen, depth);
	if (value instanceof Map) return redactFields(Object.fromEntries(value), seen, depth);
	if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `[${value.byteLength} bytes]`;
	if (Array.isArray(value)) return value.map((item) => redactValue(item, seen, depth + 1));
	return redactFields(value as Record<string, unknown>, seen, depth);
}

function redactFields(fields: Record<string, unknown>, seen: WeakSet<object>, depth: number): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(fields)) {
		if (value === undefined) continue;
		if (value !== null && typeof value === "object" && isPrintedOnPurpose(value)) result[name] = value[ON_PURPOSE];
		else result[name] = isRedactedName(name) ? REDACTED : redactValue(value, seen, depth + 1);
	}
	return result;
}

/** A log entry with every secret and every piece of people's content in it replaced. */
export function redactLogEntry<Entry extends { time: string; level: string; msg: string }>(entry: Entry): Entry {
	return redactFields(entry, new WeakSet(), -1) as Entry;
}
