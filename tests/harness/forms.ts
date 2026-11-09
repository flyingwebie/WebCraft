import { fromAddress } from "./browser.ts";
import type { TestInstall } from "./index.ts";

/**
 * A visitor's browser filling in Forms on a Site, without JavaScript: it loads a page, reads a Form's
 * hidden inputs as a browser keeps them, and posts the Form from the Site's own page (the `Origin`
 * and `Sec-Fetch-Site` a browser sends, the page as `Referer`), from its own client address.
 */
export type FormVisitor = {
	/** The client address the web process sees. */
	address: string;
	/** Loads a page; `form(n)` reads the n-th Form on it (from 1). */
	open(url: string): Promise<LoadedPage>;
	/** Sends Form number `instance` of a loaded page with `fields`, as a browser posts it. */
	send(page: LoadedPage, fields: Record<string, string | readonly string[]>, options?: SendOptions): Promise<Response>;
};

export type LoadedPage = {
	url: string;
	status: number;
	html: string;
	response: Response;
	form(instance?: number): PageForm;
};

/** A Form as a page holds it: where it posts, and its hidden inputs by name. */
export type PageForm = { action: string; hidden: Record<string, string> };

export type SendOptions = {
	instance?: number;
	/** Leaves out or replaces a hidden input the page gave. */
	hidden?: Record<string, string | null>;
	/** Sends `Origin` as another site's (`https://elsewhere.example`), or none. */
	origin?: string | null;
	/** Sends no `Sec-Fetch-Site`, or another value. */
	fetchSite?: string | null;
	contentType?: string;
	/** The raw body, in place of the fields. */
	body?: string;
	/** More headers the browser sends, such as its cookies or `DNT`. */
	headers?: Record<string, string>;
};

let visitors = 0;

export function formVisitor(install: TestInstall, address?: string): FormVisitor {
	const n = ++visitors;
	const own = address ?? `198.51.100.${n % 250}`;
	return {
		address: own,
		async open(url) {
			const response = await install.request(fromAddress(new Request(url), own));
			const html = await response.text();
			return { url, status: response.status, html, response, form: (instance = 1) => formIn(html, instance) };
		},
		async send(page, fields, options = {}) {
			const form = page.form(options.instance);
			const body = new URLSearchParams();
			for (const [name, value] of Object.entries({ ...form.hidden, ...options.hidden })) {
				if (value !== null && value !== undefined) body.append(name, value);
			}
			for (const [name, value] of Object.entries(fields)) {
				for (const each of typeof value === "string" ? [value] : value) body.append(name, each);
			}
			const target = new URL(form.action, page.url);
			const headers = new Headers({ "content-type": options.contentType ?? "application/x-www-form-urlencoded" });
			const origin = options.origin === undefined ? target.origin : options.origin;
			if (origin !== null) headers.set("origin", origin);
			const fetchSite =
				options.fetchSite === undefined ? (origin === target.origin ? "same-origin" : "cross-site") : options.fetchSite;
			if (fetchSite !== null) headers.set("sec-fetch-site", fetchSite);
			headers.set("referer", page.url);
			for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
			const request = new Request(target, { method: "POST", headers, body: options.body ?? body.toString() });
			return install.request(fromAddress(request, own));
		},
	};
}

/** The n-th Form in a page's HTML (from 1): its action and hidden inputs. */
export function formIn(html: string, instance = 1): PageForm {
	const forms = [...html.matchAll(/<form\b[^>]*\baction="([^"]*)"[^>]*>([\s\S]*?)<\/form>/g)];
	const match = forms[instance - 1];
	if (!match) throw new Error(`The page has no Form number ${instance}.`);
	const hidden: Record<string, string> = {};
	for (const input of (match[2] ?? "").matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
		hidden[input[1] ?? ""] = decodeEntities(input[2] ?? "");
	}
	return { action: decodeEntities(match[1] ?? ""), hidden };
}

function decodeEntities(text: string): string {
	return text
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");
}
