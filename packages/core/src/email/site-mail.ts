import { assertValidEmail, normaliseEmail } from "@webcraft/auth";
import { siteSmtp } from "@webcraft/db/schema";
import { directionOf } from "@webcraft/renderer";

import type { InstallConfig } from "../config.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import type { RelatedItem } from "./email-log.ts";
import { type OutboxPorts, queueEmail, type SmtpChoice } from "./outbox.ts";

/**
 * A Site's mail (spec story 135): the emails a Site sends as itself, such as a Form's Notifications
 * and Auto-replies. Unlike System emails it carries no Install branding: it goes out under the Site's
 * name (or the sender name its email settings give), through the Site's own server (its Site SMTP)
 * when it has one, else through the Install SMTP, with the Site's reply-to (or the one an email names),
 * never the Install SMTP's. It is recorded in the Email log with its Site, and retried like every email.
 */

/** How a Site's mail goes out: through which server, under which name, and where replies go by default. */
export type SiteMailRoute = { smtp: SmtpChoice; fromName: string; replyTo: string | null };

/** One email of a Site's, rendered by `renderSiteMail` and queued for the worker. */
export type SiteMail = {
	/** Its type in the Email log, such as `form-notification`. */
	type: string;
	to: string;
	/** Where replies go; absent for the Site's own reply-to. */
	replyTo?: string | null;
	/** The language it is written in (BCP 47), for the reader's mail client and its direction. */
	language: string;
	subject: string;
	/** Plain text paragraphs. */
	paragraphs: readonly string[];
	/** Labelled values, shown as a table (a Submission's). */
	rows?: readonly { label: string; value: string }[];
	/** A link into the admin: a path such as `/sites/<id>/forms/<id>`. */
	action?: { label: string; path: string } | null;
	/** A short last line, in smaller text. */
	note?: string | null;
	related: RelatedItem;
};

/** The route of a Site's mail, from its email settings (read through the Site's scope). */
export async function siteMailRoute(scope: Pick<SiteScope, "first" | "site">): Promise<SiteMailRoute> {
	const row = await scope.first(siteSmtp);
	const ownServer = Boolean(row?.host && row.fromAddress);
	return {
		smtp: ownServer ? { kind: "site", siteId: scope.site.id } : { kind: "install" },
		fromName: row?.fromName || scope.site.name,
		replyTo: row?.replyTo ?? null,
	};
}

/** An address fit for a header: one valid address, normalised; null for anything else. */
export function mailAddress(value: unknown): string | null {
	if (typeof value !== "string" || value.length > 254) return null;
	const address = normaliseEmail(value);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
	if (/[\s,;<>"\u0000-\u001f\u007f]/.test(address)) return null;
	try {
		assertValidEmail(address);
		return address;
	} catch {
		return null;
	}
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;

/** Text on one line, fit for a subject: no line breaks or control characters, at most `max` characters. */
export function oneLine(value: string, max = 300): string {
	return value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Queues one of a Site's emails: rendered, recorded in the Email log with its Site, sent by the worker. */
export async function queueSiteMail(
	ports: OutboxPorts & { config: InstallConfig },
	site: { id: string },
	route: SiteMailRoute,
	mail: SiteMail,
): Promise<{ emailId: string; status: "queued" | "logged" }> {
	const rendered = renderSiteMail(mail, ports.config.adminOrigin);
	return queueEmail(ports, {
		type: mail.type,
		to: mail.to,
		personId: null,
		fromName: oneLine(route.fromName, 100),
		subject: rendered.subject,
		text: rendered.text,
		html: rendered.html,
		headers: { "Auto-Submitted": "auto-generated" },
		smtp: route.smtp,
		related: mail.related,
		siteId: site.id,
		replyTo: mail.replyTo !== undefined ? mail.replyTo : route.replyTo,
	});
}

/**
 * A Site's email in its plain layout: the subject as a heading, the paragraphs, a table of labelled
 * values, at most one link, and a short note. Every value is escaped, and line breaks in a value are
 * kept; nothing a visitor sent can add markup, styles or links. The plain-text twin holds the same.
 */
export function renderSiteMail(mail: SiteMail, adminOrigin: string): { subject: string; html: string; text: string } {
	const subject = oneLine(mail.subject);
	const dir = directionOf(mail.language);
	const align = dir === "rtl" ? "right" : "left";
	const action = mail.action
		? { label: mail.action.label, url: new URL(mail.action.path, adminOrigin).toString() }
		: null;
	const paragraphs = mail.paragraphs
		.filter((paragraph) => paragraph.trim() !== "")
		.map(
			(paragraph) =>
				`<p style="margin:0 0 16px;font-size:16px;line-height:24px;color:#27272a;">${lines(paragraph)}</p>`,
		)
		.join("");
	const rows = (mail.rows ?? [])
		.map(
			(row) =>
				`<tr><th scope="row" style="padding:8px 12px 8px 0;vertical-align:top;text-align:${align};font-size:14px;font-weight:600;color:#52525b;width:35%;">${html(row.label)}</th><td style="padding:8px 0;vertical-align:top;font-size:15px;line-height:22px;color:#18181b;word-break:break-word;">${lines(row.value)}</td></tr>`,
		)
		.join("");
	const table = rows
		? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #e4e4e7;margin:0 0 16px;">${rows}</table>`
		: "";
	const link = action
		? `<p style="margin:0 0 16px;font-size:15px;"><a href="${html(action.url)}" style="color:#c2410c;">${html(action.label)}</a></p>`
		: "";
	const note = mail.note
		? `<p style="margin:16px 0 0;font-size:13px;line-height:20px;color:#71717a;">${lines(mail.note)}</p>`
		: "";
	const page = `<!doctype html>
<html lang="${html(mail.language)}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${html(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:24px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;text-align:${align};"><tr><td>
<h1 style="margin:0 0 16px;font-size:20px;line-height:28px;font-weight:600;color:#18181b;">${html(subject)}</h1>
${paragraphs}${table}${link}${note}
</td></tr></table>
</td></tr></table>
</body>
</html>
`;
	const text = [
		subject,
		"",
		...mail.paragraphs.filter((paragraph) => paragraph.trim() !== "").flatMap((paragraph) => [paragraph, ""]),
		...(mail.rows ?? []).flatMap((row) => [`${row.label}:`, indent(row.value), ""]),
		...(action ? [`${action.label}: ${action.url}`, ""] : []),
		...(mail.note ? ["--", mail.note, ""] : []),
	].join("\n");
	return { subject, html: page, text };
}

/** A value's lines, each indented, for the plain-text twin. */
function indent(value: string): string {
	return value
		.split(/\r\n|\r|\n/)
		.map((line) => `  ${line}`)
		.join("\n");
}

/** Escaped text with its line breaks kept. */
function lines(value: string): string {
	return html(value).replace(/\r\n|\r|\n/g, "<br>");
}

/** Escapes a value for HTML text or a quoted attribute. */
function html(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
