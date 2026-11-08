import type { EmailBranding } from "./branding.ts";
import type { EmailContent, LayoutWording } from "./wording/types.ts";

/** A System email, rendered: the subject, the HTML and its plain-text twin. */
export type RenderedEmail = { subject: string; html: string; text: string };

export type LayoutOptions = {
	content: EmailContent;
	branding: EmailBranding;
	words: LayoutWording;
	/** The recipient's Admin language and its writing direction. */
	language: string;
	dir: "ltr" | "rtl";
	/** Where admin paths lead, such as `https://admin.example.com`. */
	adminOrigin: string;
	/** The person's email switches, on emails they can turn off; absent otherwise. */
	preferencesPath?: string;
};

/**
 * The one built-in layout every System email uses: the logo (or sender name) on a bar in the accent
 * colour, the heading, the paragraphs, at most one button, then the footer. Inline styles and
 * tables, so mail clients show it as meant. Every value is escaped.
 */
export function renderEmail(options: LayoutOptions): RenderedEmail {
	const { content, branding, words, language, dir, adminOrigin } = options;
	const accent = branding.accentColour;
	const onAccent = readableOn(accent);
	const action = content.action
		? { label: content.action.label, url: adminUrl(adminOrigin, content.action.path) }
		: null;
	const preferencesUrl = options.preferencesPath ? adminUrl(adminOrigin, options.preferencesPath) : null;
	const align = dir === "rtl" ? "right" : "left";

	const header = branding.logoUrl
		? `<img src="${attr(branding.logoUrl)}" alt="${attr(branding.senderName)}" height="40" style="display:block;height:40px;width:auto;border:0;">`
		: `<span style="font-size:18px;font-weight:600;color:#18181b;">${html(branding.senderName)}</span>`;

	const paragraphs = content.paragraphs
		.map(
			(paragraph) => `<p style="margin:0 0 16px;font-size:16px;line-height:24px;color:#3f3f46;">${html(paragraph)}</p>`,
		)
		.join("");

	const button = action
		? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;"><tr><td style="border-radius:6px;background:${accent};"><a href="${attr(action.url)}" style="display:inline-block;padding:12px 20px;font-size:16px;font-weight:600;color:${onAccent};text-decoration:none;border-radius:6px;">${html(action.label)}</a></td></tr></table>`
		: "";

	const note = content.note
		? `<p style="margin:0 0 16px;font-size:14px;line-height:20px;color:#52525b;">${html(content.note)}</p>`
		: "";

	const linkHint = action
		? `<p style="margin:0;font-size:13px;line-height:20px;color:#71717a;">${html(words.linkHint)}<br><a href="${attr(action.url)}" style="color:#3f3f46;word-break:break-all;">${html(action.url)}</a></p>`
		: "";

	const footerText = branding.footer
		? `<p style="margin:0 0 8px;">${html(branding.footer).replace(/\n/g, "<br>")}</p>`
		: "";
	const preferences = preferencesUrl
		? ` <a href="${attr(preferencesUrl)}" style="color:#52525b;">${html(words.preferences)}</a>`
		: "";

	const page = `<!doctype html>
<html lang="${attr(language)}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${html(content.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Inter,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5;"><tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid #e4e4e7;border-top:4px solid ${accent};border-radius:8px;text-align:${align};">
<tr><td style="padding:24px 32px 0;">${header}</td></tr>
<tr><td style="padding:24px 32px 32px;">
<h1 style="margin:0 0 16px;font-size:22px;line-height:30px;font-weight:600;color:#18181b;">${html(content.heading)}</h1>
${paragraphs}${button}${note}${linkHint}
</td></tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;text-align:${align};"><tr><td style="padding:16px 32px;font-size:13px;line-height:20px;color:#71717a;">
${footerText}<p style="margin:0;">${html(words.sentBy(branding.installName))}${preferences}</p>
</td></tr></table>
</td></tr></table>
</body>
</html>
`;

	const text = [
		content.heading,
		"",
		...content.paragraphs.flatMap((paragraph) => [paragraph, ""]),
		...(action ? [`${action.label}: ${action.url}`, ""] : []),
		...(content.note ? [content.note, ""] : []),
		"--",
		...(branding.footer ? [branding.footer] : []),
		words.sentBy(branding.installName),
		...(preferencesUrl ? [`${words.preferences}: ${preferencesUrl}`] : []),
		"",
	].join("\n");

	return { subject: oneLine(content.subject), html: page, text };
}

/** An admin path made absolute on the admin's origin. */
function adminUrl(adminOrigin: string, path: string): string {
	return new URL(path, adminOrigin).toString();
}

/** A subject on one line, so it can't add headers. */
function oneLine(value: string): string {
	return value.replace(/[\r\n]+/g, " ").trim();
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

const attr = html;

const DARK_TEXT = "#18181b";

/** White or near-black text, whichever reads better on `background` (`#rrggbb`). */
export function readableOn(background: string): string {
	const luminance = relativeLuminance(background);
	const withWhite = 1.05 / (luminance + 0.05);
	const withDark = (luminance + 0.05) / (relativeLuminance(DARK_TEXT) + 0.05);
	return withWhite >= withDark ? "#ffffff" : DARK_TEXT;
}

function relativeLuminance(hex: string): number {
	const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
	const [r = 0, g = 0, b = 0] = channels.map((channel) =>
		channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
	);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
