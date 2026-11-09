/**
 * Reading what Staff paste as an outside script (ADRs 0022, 0023): a third-party snippet is a few
 * `<script>` elements, some loading a file from another host, some holding code. Sites never carry
 * inline scripts, so each script holding code becomes a file the Site serves under its hash, loaded
 * where the snippet had it, in the same order; scripts loading from another host stay as they are.
 * The hosts a snippet loads from, or names in its code, are what the Site's policy must allow.
 */
import { contentHash } from "@webcraft/renderer";

import { readHost } from "./policy.ts";

/**
 * One script an outside script loads, in order: a file on another host (`src`), or code of its own,
 * which the Site serves as `/_wc/js/<hash>.js`.
 */
export type OutsideScriptPart =
	| {
			kind: "src";
			src: string;
			async: boolean;
			defer: boolean;
			module: boolean;
			/** Other attributes kept as written: `id`, `crossorigin`, `referrerpolicy`, `integrity`, `charset` and `data-…`. */
			attributes: [string, string][];
	  }
	| { kind: "code"; hash: string; code: string; module: boolean };

/** One thing wrong with a pasted snippet, with the line it is on. */
export type SnippetProblem = { line: number; message: string };

/** A snippet that can't be used, with every problem found. */
export class SnippetInvalidError extends Error {
	override name = "SnippetInvalidError";
	readonly problems: SnippetProblem[];
	constructor(problems: SnippetProblem[]) {
		super(problems.map((problem) => `Line ${problem.line}: ${problem.message}`).join("\n"));
		this.problems = problems;
	}
}

/** The longest snippet, in characters. */
export const SNIPPET_MAX_LENGTH = 200_000;

/** Attributes a pasted script may keep, besides `src`, `async`, `defer` and `type`. */
const KEPT_ATTRIBUTES = new Set(["id", "crossorigin", "referrerpolicy", "integrity", "charset"]);

/** Script types that run as JavaScript: classic (none, or one of these) and modules. */
const CLASSIC_TYPES = new Set(["", "text/javascript", "application/javascript", "text/ecmascript"]);

/**
 * Reads a pasted snippet into the scripts it loads, in order. Comments and white space between them
 * are left out; `<noscript>` parts are left out too (pages without JavaScript don't run the snippet's
 * scripts either). Anything else is refused with its line (`SnippetInvalidError`): other elements
 * (embeds go elsewhere), event handler attributes, scripts that aren't JavaScript, addresses that
 * aren't https, and a snippet with no script at all.
 */
export function readSnippet(snippet: string): OutsideScriptPart[] {
	const problems: SnippetProblem[] = [];
	const parts: OutsideScriptPart[] = [];
	let at = 0;
	const lineAt = (index: number) => snippet.slice(0, index).split("\n").length;
	while (at < snippet.length) {
		const rest = snippet.slice(at);
		const space = /^\s+/.exec(rest);
		if (space) {
			at += space[0].length;
			continue;
		}
		if (rest.startsWith("<!--")) {
			const end = snippet.indexOf("-->", at + 4);
			at = end === -1 ? snippet.length : end + 3;
			continue;
		}
		const noscript = /^<noscript\b[^>]*>/i.exec(rest);
		if (noscript) {
			const end = snippet.toLowerCase().indexOf("</noscript", at + noscript[0].length);
			at = end === -1 ? snippet.length : snippet.indexOf(">", end) + 1 || snippet.length;
			continue;
		}
		const open = /^<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>/i.exec(rest);
		if (!open) {
			const tag = /^<\/?([a-z][a-z0-9-]*)/i.exec(rest)?.[1];
			problems.push({
				line: lineAt(at),
				message: tag
					? `<${tag.toLowerCase()}> can't be pasted here: only scripts. Show embeds on the page with a Component.`
					: "Only <script> elements can be pasted here.",
			});
			break;
		}
		const bodyStart = at + open[0].length;
		const close = snippet.toLowerCase().indexOf("</script", bodyStart);
		if (close === -1) {
			problems.push({ line: lineAt(at), message: "This <script> is never closed." });
			break;
		}
		const part = readScript(open[1] ?? "", snippet.slice(bodyStart, close), lineAt(at), problems);
		if (part) parts.push(part);
		const closeEnd = snippet.indexOf(">", close);
		at = closeEnd === -1 ? snippet.length : closeEnd + 1;
	}
	if (problems.length === 0 && parts.length === 0) {
		problems.push({ line: 1, message: "The snippet holds no script." });
	}
	if (problems.length > 0) throw new SnippetInvalidError(problems);
	return parts;
}

/** One `<script>` of a snippet: its attributes and its code. */
function readScript(
	attributeText: string,
	body: string,
	line: number,
	problems: SnippetProblem[],
): OutsideScriptPart | null {
	const attributes = readAttributes(attributeText);
	let src: string | null = null;
	let type = "";
	let async = false;
	let defer = false;
	const kept: [string, string][] = [];
	for (const [name, value] of attributes) {
		if (name.startsWith("on")) {
			problems.push({ line, message: `${name} isn't allowed: event handlers run code inline.` });
		} else if (name === "src") {
			src = value;
		} else if (name === "type") {
			type = value.trim().toLowerCase();
		} else if (name === "async") {
			async = true;
		} else if (name === "defer") {
			defer = true;
		} else if (KEPT_ATTRIBUTES.has(name) || /^data-[a-z0-9_.-]+$/.test(name)) {
			kept.push([name, value]);
		}
		// Anything else (`nonce`, `nomodule`, `language`) is left out.
	}
	const module = type === "module";
	if (!module && !CLASSIC_TYPES.has(type)) {
		problems.push({ line, message: `A script of type ${type} isn't JavaScript.` });
		return null;
	}
	if (src !== null) {
		const address = outsideAddress(src);
		if (!address) {
			problems.push({ line, message: `${src.slice(0, 200)} isn't an https address on another host.` });
			return null;
		}
		if (body.trim()) problems.push({ line, message: "A script with an address holds no code of its own." });
		return { kind: "src", src: address, async, defer, module, attributes: kept };
	}
	const code = body.trim();
	if (!code) return null;
	return { kind: "code", hash: contentHash(code), code, module };
}

/** The attributes of a tag, by lower-case name, in order; values decoded from the few entities snippets use. */
function readAttributes(text: string): [string, string][] {
	const found: [string, string][] = [];
	const pattern = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
	for (const match of text.matchAll(pattern)) {
		const name = (match[1] ?? "").toLowerCase();
		const value = match[2] ?? match[3] ?? match[4] ?? "";
		found.push([name, decodeEntities(value)]);
	}
	return found;
}

function decodeEntities(value: string): string {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

/**
 * An outside script's address as the page loads it: https (an address starting `//` is read as
 * https), on a host a policy can name. Null for anything else: http, relative paths, other schemes.
 */
export function outsideAddress(input: string): string | null {
	const text = input.trim();
	let url: URL;
	try {
		url = new URL(text.startsWith("//") ? `https:${text}` : text);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
	try {
		readHost(url.hostname);
	} catch {
		return null;
	}
	return url.toString();
}

/**
 * The hosts an outside script's parts need: those its scripts load from, and those its code names in
 * an https address (a loader adding another script from there), each as `readHost` gives it.
 */
export function hostsOf(parts: readonly OutsideScriptPart[]): string[] {
	const hosts = new Set<string>();
	const add = (host: string) => {
		try {
			hosts.add(readHost(host));
		} catch {
			// Not a host a policy can name: nothing to allow.
		}
	};
	for (const part of parts) {
		if (part.kind === "src") add(new URL(part.src).hostname);
		else for (const match of part.code.matchAll(/https:(?:\\?\/){2}([a-z0-9.-]+)/gi)) add(match[1] ?? "");
	}
	return [...hosts].sort();
}
