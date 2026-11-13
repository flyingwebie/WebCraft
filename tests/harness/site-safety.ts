/**
 * What every Site answer must look like for the Site's scripts to be safe (ADRs 0022, 0023): the
 * fixed security headers on every response, the Site's Content Security Policy on its pages, and no
 * inline code in any page WebCraft writes. Every Site test that looks at a page checks it with
 * `expectSafePage`, so each built-in feature (Template commands, Components, Blocks, the Language
 * switcher, the theme toggle, 404 pages, Edit mode and Code mode) is held to it.
 */
import { expect } from "bun:test";

/** A Content Security Policy read into its directives: each name with its sources, in order. */
export type Policy = Map<string, string[]>;

/** Reads a `Content-Security-Policy` header value into its directives. */
export function readPolicy(value: string | null): Policy {
	const policy: Policy = new Map();
	for (const directive of (value ?? "").split(";")) {
		const [name, ...sources] = directive.trim().split(/\s+/);
		if (name) policy.set(name.toLowerCase(), sources);
	}
	return policy;
}

/** The policy a response enforces (`Content-Security-Policy`). */
export function policyOf(response: Response): Policy {
	return readPolicy(response.headers.get("content-security-policy"));
}

/** The policy a response only reports (`Content-Security-Policy-Report-Only`). */
export function reportOnlyPolicyOf(response: Response): Policy {
	return readPolicy(response.headers.get("content-security-policy-report-only"));
}

/** The directives that hold on every Site answer, whatever the Site's policy (ADR 0023). */
const FIXED_DIRECTIVES: Readonly<Record<string, readonly string[][]>> = {
	"base-uri": [["'self'"], ["'none'"]],
	"form-action": [["'self'"]],
	"frame-ancestors": [["'self'"], ["'none'"]],
};

/**
 * Checks the security headers every answer on a Site's domain carries: `nosniff`, a strict referrer
 * policy, no framing by other sites (`X-Frame-Options` and `frame-ancestors`), and an enforced policy
 * that blocks base-tag changes and forms posting elsewhere, and plugins (but on Media files, which a
 * browser may open with its PDF viewer).
 */
export function expectSiteHeaders(response: Response, options: { media?: boolean } = {}): void {
	const where = `${response.status} ${response.url || "answer"}`;
	expect(response.headers.get("x-content-type-options"), where).toBe("nosniff");
	expect(["strict-origin-when-cross-origin", "same-origin", "no-referrer"], where).toContain(
		response.headers.get("referrer-policy") ?? "",
	);
	expect(["SAMEORIGIN", "DENY"], where).toContain(response.headers.get("x-frame-options") ?? "");
	const policy = policyOf(response);
	for (const [name, allowed] of Object.entries(FIXED_DIRECTIVES)) {
		expect(allowed, `${where}: ${name}`).toContainEqual(policy.get(name) ?? []);
	}
	if (!options.media) expect(policy.get("object-src"), where).toEqual(["'none'"]);
}

/** Which policy a page is expected under: the Site's mode, or Edit mode's own. */
export type PagePolicy = "strict" | "relaxed" | "reportOnly" | "editMode";

/**
 * Checks a page answer of a Site: the fixed headers, the policy it is expected under, and its HTML
 * free of inline code (`expectNoInlineCode`). Answers the HTML.
 */
export async function expectSafePage(response: Response, expected: PagePolicy = "strict"): Promise<string> {
	expectSiteHeaders(response);
	const enforced = policyOf(response);
	const reported = reportOnlyPolicyOf(response);
	const full = expected === "reportOnly" ? reported : enforced;
	const where = `${response.status} ${response.url || "page"} (${expected})`;
	const scripts = full.get("script-src") ?? [];
	expect(scripts[0], where).toBe("'self'");
	expect(full.get("default-src"), where).toEqual(["'self'"]);
	if (expected === "relaxed") {
		expect(scripts, where).toContain("'unsafe-inline'");
		expect(scripts, where).toContain("'unsafe-eval'");
	} else {
		expect(scripts, where).not.toContain("'unsafe-inline'");
		expect(scripts, where).not.toContain("'unsafe-eval'");
		expect(full.get("style-src") ?? [], where).not.toContain("'unsafe-inline'");
	}
	if (expected === "reportOnly") {
		expect(enforced.get("script-src"), where).toBeUndefined();
	} else {
		expect(reported.size, where).toBe(0);
	}
	const html = await response.text();
	expectNoInlineCode(html);
	return html;
}

/**
 * Checks that a page carries no inline code (ADR 0023): every `<script>` loads a file (`src`) and
 * holds nothing (structured data, `application/ld+json`, is data and may), no `<style>` element, no
 * `style` or `on…` attribute, and no `javascript:` address. Tags are read with their attributes, so
 * escaped text that merely looks like code (an attack string in a value) doesn't count.
 */
export function expectNoInlineCode(html: string): void {
	for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
		const [tag = "", attributes = "", body = ""] = match;
		if (/\btype="application\/ld\+json"/i.test(attributes)) {
			// Data, never run: JSON, with nothing in it a browser could read as markup.
			expect(body, `structured data holding markup: ${body.slice(0, 200)}`).not.toMatch(/[<>]|\u2028|\u2029/);
			expect(() => JSON.parse(body), `structured data that isn't JSON: ${body.slice(0, 200)}`).not.toThrow();
			continue;
		}
		expect(attributes, `an inline script: ${tag.slice(0, 200)}`).toMatch(/\ssrc="[^"]+"/);
		expect(body, `a script with code in the page: ${tag.slice(0, 200)}`).toBe("");
	}
	const attribute = /([^\s"'>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
	const tags = /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
	for (const [tag = "", name = "", attributes = ""] of html.matchAll(tags)) {
		const where = tag.slice(0, 200);
		expect(name.toLowerCase(), `a <style> element: ${where}`).not.toBe("style");
		for (const [, rawName = "", rawValue = ""] of attributes.matchAll(attribute)) {
			const attributeName = rawName.toLowerCase();
			const value = rawValue
				.replace(/^["']|["']$/g, "")
				.trim()
				.toLowerCase();
			expect(attributeName.startsWith("on"), `an event handler attribute: ${where}`).toBe(false);
			expect(attributeName, `a style attribute: ${where}`).not.toBe("style");
			if (["href", "src", "action", "formaction"].includes(attributeName)) {
				expect(value.startsWith("javascript:"), `a javascript: address: ${where}`).toBe(false);
			}
		}
	}
}
