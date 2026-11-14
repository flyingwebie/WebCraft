import { TEMPLATE_COMMANDS } from "@webcraft/renderer/builder";

/**
 * The Template markup guard of Format (SPEC 5.1): Prettier formats HTML, and knows nothing of
 * Template markup, so before it sees the markup every value (`{{ post.title }}`), Template command
 * (`{{@loop … }}`, `{{@if … }}`, `{{@empty}}`, `{{/loop}}`, `{{@outlet}}`, `{{@form …}}`) and
 * Component tag (`<PostCard … />`) is swapped for a placeholder, and put back after:
 *
 * - a value becomes a word of the same length (Prettier never splits a word), carrying a quote where
 *   it must keep Prettier from quoting its attribute differently;
 * - a block command becomes one element per branch (`{{@loop}} … {{@empty}} … {{/loop}}` is two), so
 *   it indents what it holds like a tag; it is laid out as a block only where white space beside it
 *   never shows (it holds only blocks, and stands between blocks or white space), else inline, so
 *   Prettier adds no white space a page would show;
 * - a command without content and a Component tag become empty elements, kept whole.
 *
 * Reading the markup also checks what Prettier's HTML parser would silently repair: an element or a
 * command left open, an end that closes nothing, a `{{` never closed. Those answer a problem with its
 * line, and nothing is formatted.
 */

export type GuardedMarkup =
	| {
			ok: true;
			/** The markup with placeholders, for Prettier. */
			text: string;
			/** Puts the Template markup back into what Prettier made of `text`. */
			restore(formatted: string): string;
			/** Where an offset of `text` was in the markup given. */
			originalOffset(offset: number): number;
	  }
	| { ok: false; line: number; reason: string };

type Node =
	| { kind: "text"; raw: string; at: number }
	| { kind: "value"; raw: string; at: number }
	| { kind: "comment"; raw: string; at: number }
	| { kind: "element"; name: string; open: Piece[]; children: Node[]; close: string; at: number }
	| { kind: "component"; open: string; children: Node[]; close: string; at: number }
	| { kind: "leaf"; name: string; raw: string; at: number; block: boolean }
	| { kind: "command"; name: string; branches: Branch[]; closer: string; at: number; block: boolean };

/** A start tag as written: its text, and the values in its attribute values (with their quote). */
type Piece = { text: string; at: number } | { value: string; quote: string; at: number };

type Branch = { opener: string; children: Node[]; at: number };

/** A Template command's block and branches, from the renderer's registry. */
const COMMANDS = new Map(TEMPLATE_COMMANDS.map((command) => [command.name, command]));
const KEYWORDS = [...new Set(TEMPLATE_COMMANDS.flatMap((command) => [command.name, ...command.branches]))].sort(
	(a, b) => b.length - a.length,
);

/**
 * Commands without content that render a block of their own (a form, a nav), or the page's content,
 * or nothing: white space beside them never shows where they stand between blocks. The others (a
 * button, a link) are inline.
 */
const BLOCK_LEAVES = new Set(["outlet", "form", "filter", "search", "languageSwitcher", "pagination"]);

/** Elements HTML lays out as blocks: white space beside their edges never shows. */
const BLOCK_ELEMENTS = new Set(
	"address article aside blockquote caption dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr legend li main menu nav ol p pre search section summary table tbody td tfoot th thead tr ul".split(
		" ",
	),
);

/** Elements HTML reads without content or an end tag. */
const VOID_ELEMENTS = new Set("area base br col embed hr img input keygen link meta param source track wbr".split(" "));

/** Whether a tag places a Component: PascalCase (`PostCard`), as the parser reads it. */
function isComponentTag(name: string): boolean {
	return /^[A-Z][A-Za-z0-9]*$/.test(name) && /[a-z]/.test(name);
}

class Problem extends Error {
	readonly at: number;
	readonly reason: string;
	constructor(at: number, reason: string) {
		super(reason);
		this.at = at;
		this.reason = reason;
	}
}

/** Reads Template markup into the shape Format needs: elements, values, commands, Components. */
class Reader {
	private pos = 0;
	private readonly text: string;
	constructor(text: string) {
		this.text = text;
	}

	read(): Node[] {
		const { nodes, end } = this.content();
		if (end.kind === "endTag") throw new Problem(end.at, `</${end.name}> closes no element`);
		if (end.kind === "close") throw new Problem(end.at, `{{/${end.name}}} closes no {{@${end.name}}}`);
		if (end.kind === "branch") throw new Problem(end.at, `{{@${end.keyword}}} is outside the command it belongs to`);
		return nodes;
	}

	private content(): {
		nodes: Node[];
		end:
			| { kind: "eof" }
			| { kind: "endTag"; name: string; raw: string; at: number }
			| { kind: "close"; name: string; raw: string; at: number }
			| { kind: "branch"; keyword: string; raw: string; at: number };
	} {
		const nodes: Node[] = [];
		let text = "";
		let textAt = this.pos;
		const flush = () => {
			if (text) nodes.push({ kind: "text", raw: text, at: textAt });
			text = "";
		};
		const source = this.text;
		for (;;) {
			if (this.pos >= source.length) {
				flush();
				return { nodes, end: { kind: "eof" } };
			}
			const char = source[this.pos];
			if (!text) textAt = this.pos;
			if (char === "\\" && source.startsWith("{{", this.pos + 1)) {
				text += "\\{{";
				this.pos += 3;
				continue;
			}
			if (char === "{" && source.startsWith("{{", this.pos)) {
				flush();
				const at = this.pos;
				const raw = this.curly();
				const inner = raw.slice(2, -2).trim();
				if (inner.startsWith("@")) {
					const words = inner.slice(1);
					const keyword = KEYWORDS.find((each) => words === each || new RegExp(`^${each}(\\s|$)`).test(words));
					const command = keyword ? COMMANDS.get(keyword) : undefined;
					if (command?.block) nodes.push(this.command(command.name, command.branches, raw, at));
					else if (keyword && !command) {
						flush();
						return { nodes, end: { kind: "branch", keyword, raw, at } };
					} else {
						const name = keyword ?? words.split(/\s/)[0] ?? "";
						nodes.push({ kind: "leaf", name, raw, at, block: BLOCK_LEAVES.has(name) });
					}
				} else if (inner.startsWith("/")) {
					return { nodes, end: { kind: "close", name: inner.slice(1).trim(), raw, at } };
				} else nodes.push({ kind: "value", raw, at });
				continue;
			}
			if (char === "<") {
				const next = source[this.pos + 1] ?? "";
				if (source.startsWith("<!--", this.pos)) {
					flush();
					const at = this.pos;
					const end = source.indexOf("-->", this.pos + 4);
					if (end < 0) throw new Problem(at, "the comment never ends");
					nodes.push({ kind: "comment", raw: source.slice(at, end + 3), at });
					this.pos = end + 3;
					continue;
				}
				if (next === "/") {
					flush();
					const at = this.pos;
					const match = /^<\/([^\s>]*)\s*>/.exec(source.slice(this.pos, this.pos + 200));
					if (!match) throw new Problem(at, "an end tag isn't written as </name>");
					this.pos += match[0].length;
					return { nodes, end: { kind: "endTag", name: match[1] ?? "", raw: match[0], at } };
				}
				if (/[A-Za-z]/.test(next)) {
					flush();
					nodes.push(this.element());
					continue;
				}
			}
			text += char;
			this.pos++;
		}
	}

	/** `{{ … }}` from `pos`, skipping quoted text inside, up to the first `}}` (as the parser reads it). */
	private curly(): string {
		const source = this.text;
		const start = this.pos;
		let index = start + 2;
		for (;;) {
			if (index >= source.length) throw new Problem(start, "{{ has no closing }}");
			const char = source[index];
			if (char === '"') {
				index++;
				while (index < source.length && source[index] !== '"') index += source[index] === "\\" ? 2 : 1;
				index++;
				continue;
			}
			if (char === "}" && source[index + 1] === "}") break;
			if (char === "\n" && source.startsWith("{{", index + 1)) throw new Problem(start, "{{ has no closing }}");
			index++;
		}
		this.pos = index + 2;
		return source.slice(start, this.pos);
	}

	private command(name: string, keywords: readonly string[], opener: string, at: number): Node {
		const branches: Branch[] = [];
		let current = { opener, at };
		for (;;) {
			const { nodes, end } = this.content();
			branches.push({ ...current, children: nodes });
			if (end.kind === "branch" && keywords.includes(end.keyword)) {
				current = { opener: end.raw, at: end.at };
				continue;
			}
			if (end.kind === "close" && end.name === name) {
				return { kind: "command", name, branches, closer: end.raw, at, block: true };
			}
			if (end.kind === "eof") throw new Problem(at, `{{@${name}}} has no {{/${name}}}`);
			if (end.kind === "endTag")
				throw new Problem(end.at, `</${end.name}> closes an element while {{@${name}}} is open`);
			if (end.kind === "close") throw new Problem(end.at, `{{/${end.name}}} closes no {{@${end.name}}}`);
			throw new Problem(end.at, `{{@${end.keyword}}} doesn't belong inside {{@${name}}}`);
		}
	}

	private element(): Node {
		const source = this.text;
		const at = this.pos;
		const nameMatch = /[^\s/>]*/y;
		nameMatch.lastIndex = at + 1;
		const written = nameMatch.exec(source)?.[0] ?? "";
		this.pos = at + 1 + written.length;
		const open: Piece[] = [];
		let buffer = `<${written}`;
		let bufferAt = at;
		const take = () => {
			if (buffer) open.push({ text: buffer, at: bufferAt });
			buffer = "";
			bufferAt = this.pos;
		};
		let selfClosing = false;
		// The attributes, with the values in them; a quote is open from one quote mark to its pair, and
		// only a quote that starts a value opens one (`a="…"`, `a='…'`).
		let quote = "";
		let afterEquals = false;
		for (;;) {
			if (this.pos >= source.length) throw new Problem(at, `<${written} has no closing >`);
			const char = source[this.pos] ?? "";
			if (char === "\\" && source.startsWith("{{", this.pos + 1)) {
				buffer += "\\{{";
				this.pos += 3;
				afterEquals = false;
				continue;
			}
			if (char === "{" && source.startsWith("{{", this.pos)) {
				take();
				const valueAt = this.pos;
				open.push({ value: this.curly(), quote, at: valueAt });
				bufferAt = this.pos;
				afterEquals = false;
				continue;
			}
			if (quote) {
				if (char === quote) quote = "";
			} else if ((char === '"' || char === "'") && afterEquals) quote = char;
			else if (char === ">") {
				selfClosing = source[this.pos - 1] === "/";
				buffer += ">";
				this.pos++;
				take();
				break;
			}
			if (!quote && !/\s/.test(char)) afterEquals = char === "=";
			buffer += char;
			this.pos++;
		}
		if (isComponentTag(written)) {
			const raw = source.slice(at, this.pos);
			if (selfClosing) return { kind: "component", open: raw, children: [], close: "", at };
			const { nodes, end } = this.content();
			if (end.kind === "endTag" && end.name === written)
				return { kind: "component", open: raw, children: nodes, close: end.raw, at };
			this.unclosed(`<${written}>`, at, end);
		}
		const name = written.toLowerCase();
		if (VOID_ELEMENTS.has(name)) return { kind: "element", name, open, children: [], close: "", at };
		if (selfClosing) throw new Problem(at, `<${name}> can't close itself`);
		if (name === "script" || name === "style" || name === "textarea" || name === "title") {
			// Text up to its end tag, as HTML reads it.
			const close = source.toLowerCase().indexOf(`</${name}`, this.pos);
			if (close < 0) throw new Problem(at, `<${name}> has no end tag`);
			const textAt = this.pos;
			const text = source.slice(textAt, close);
			this.pos = close;
			const match = /^<\/[^\s>]*\s*>/.exec(source.slice(this.pos, this.pos + 200));
			if (!match) throw new Problem(close, "an end tag isn't written as </name>");
			this.pos += match[0].length;
			return { kind: "element", name, open, children: [{ kind: "text", raw: text, at: textAt }], close: match[0], at };
		}
		const { nodes, end } = this.content();
		if (end.kind === "endTag" && end.name.toLowerCase() === name)
			return { kind: "element", name, open, children: nodes, close: end.raw, at };
		this.unclosed(`<${name}>`, at, end);
	}

	private unclosed(tag: string, at: number, end: { kind: string; at?: number; name?: string; raw?: string }): never {
		if (end.kind === "eof") throw new Problem(at, `${tag} has no end tag`);
		throw new Problem(end.at ?? at, `${end.raw ?? ""} comes before the end of ${tag}`);
	}
}

// ---------------------------------------------------------------------------------------------
// Where a command may be laid out as a block

/** How a node sits for the white space beside it: `block`, `space` (shows nothing, a comment) or `inline`. */
function sitting(node: Node): "block" | "space" | "inline" {
	switch (node.kind) {
		case "text":
			return node.raw.trim() === "" ? "space" : "inline";
		case "comment":
			return "space";
		case "element":
			return BLOCK_ELEMENTS.has(node.name) ? "block" : "inline";
		case "leaf":
		case "command":
			return node.block ? "block" : "inline";
		default:
			return "inline";
	}
}

/**
 * Lays out as blocks the commands that may be: a block command holding only blocks (and white space),
 * and a block command without content, each standing at a block's edge, beside a block or after
 * white space. Turning one inline can change what its neighbours may be, so it runs until nothing changes.
 */
function settleBlocks(roots: Node[]): void {
	type Place = { siblings: Node[]; index: number; edge: boolean };
	const places = new Map<Node, Place>();
	const visit = (nodes: Node[], edge: boolean, pre: boolean) => {
		nodes.forEach((node, index) => {
			if (node.kind === "leaf" || node.kind === "command") {
				if (pre) node.block = false;
				places.set(node, { siblings: nodes, index, edge });
			}
			if (node.kind === "element") visit(node.children, BLOCK_ELEMENTS.has(node.name), pre || node.name === "pre");
			if (node.kind === "component") visit(node.children, false, pre);
			if (node.kind === "command") for (const branch of node.branches) visit(branch.children, true, pre);
		});
	};
	visit(roots, true, false);
	// A command's branches sit at its own edges: a block where the command is one.
	const parentOf = new Map<Node[], Node>();
	for (const node of places.keys())
		if (node.kind === "command") for (const branch of node.branches) parentOf.set(branch.children, node);
	const edgeHolds = (place: Place): boolean => {
		const owner = parentOf.get(place.siblings);
		return owner ? owner.kind === "command" && owner.block : place.edge;
	};
	const side = (place: Place, step: -1 | 1): boolean => {
		for (let at = place.index + step; at >= 0 && at < place.siblings.length; at += step) {
			const node = place.siblings[at];
			if (!node) break;
			if (node.kind === "comment") continue;
			if (node.kind === "text") {
				if (node.raw.trim() === "") continue;
				return step === -1 ? /\s$/.test(node.raw) : /^\s/.test(node.raw);
			}
			return sitting(node) === "block";
		}
		return edgeHolds(place);
	};
	for (let changed = true; changed; ) {
		changed = false;
		for (const [node, place] of places) {
			if ((node.kind !== "leaf" && node.kind !== "command") || !node.block) continue;
			const holdsBlocks =
				node.kind === "leaf" ||
				(node.branches.every((branch) => branch.children.every((child) => sitting(child) !== "inline")) &&
					node.branches.some((branch) => branch.children.some((child) => sitting(child) === "block")));
			if (!holdsBlocks || !side(place, -1) || !side(place, 1)) {
				node.block = false;
				changed = true;
			}
		}
	}
}

// ---------------------------------------------------------------------------------------------
// Placeholders

/** Swaps Template markup for placeholders Prettier formats as HTML; see the top of this file. */
export function guardTemplateMarkup(markup: string): GuardedMarkup {
	let nodes: Node[];
	try {
		nodes = new Reader(markup).read();
	} catch (error) {
		if (!(error instanceof Problem)) throw error;
		return { ok: false, line: lineAt(markup, error.at), reason: error.reason };
	}
	settleBlocks(nodes);

	// Names nothing in the markup holds already, so only placeholders are put back.
	let stem = "wc";
	while (markup.includes(`${stem}v`) || markup.includes(`${stem}-p`)) stem += "q";
	const directive = "<!-- display: block -->";
	const tags: { open: string; close: string; block: boolean }[] = [];
	const values = new Map<string, string>();
	let out = "";
	/** Each piece written: where it starts in `out` and where it came from in the markup. */
	const map: [number, number][] = [];
	const write = (text: string, from: number) => {
		map.push([out.length, from]);
		out += text;
	};

	const value = (raw: string, quote: string, at: number) => {
		// The quote a value must carry so Prettier keeps its attribute's quotes: a `"` in single quotes.
		const mark = quote === "'" ? '"' : "";
		const head = `${stem}v${values.size}${mark}`;
		const token = head + "z".repeat(Math.max(1, raw.length - head.length));
		values.set(token, raw);
		write(token, at);
	};
	const tag = (open: string, close: string, block: boolean, at: number, children: () => void) => {
		const name = `${stem}-p${tags.length}`;
		tags.push({ open, close, block });
		if (block) write(directive, at);
		write(`<${name}>`, at);
		children();
		write(`</${name}>`, at);
	};
	const emit = (list: readonly Node[]) => {
		for (const node of list) {
			switch (node.kind) {
				case "text":
				case "comment":
					write(node.raw, node.at);
					break;
				case "value":
					value(node.raw, "", node.at);
					break;
				case "element":
					for (const piece of node.open) {
						if ("text" in piece) write(piece.text, piece.at);
						else value(piece.value, piece.quote, piece.at);
					}
					emit(node.children);
					write(node.close, node.at);
					break;
				case "component":
					tag(node.open, node.close, false, node.at, () => emit(node.children));
					break;
				case "leaf":
					tag(node.raw, "", node.block, node.at, () => {});
					break;
				case "command":
					node.branches.forEach((branch, index) => {
						const last = index === node.branches.length - 1;
						// A branch's trailing white space goes after its end, so a blank line before the next stays.
						const trailing = last ? [] : trailingSpace(branch.children);
						tag(branch.opener, last ? node.closer : "", node.block, branch.at, () =>
							emit(trailing.length ? branch.children.slice(0, -1) : branch.children),
						);
						for (const space of trailing) write(space.raw, branch.at);
					});
					break;
			}
		}
	};
	emit(nodes);

	const originalOffset = (offset: number): number => {
		let found: [number, number] = [0, 0];
		for (const entry of map) {
			if (entry[0] > offset) break;
			found = entry;
		}
		return found[1] + (offset - found[0]);
	};

	const restore = (formatted: string): string => {
		const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const lines = formatted.split("\n");
		const result: string[] = [];
		for (const line of lines) {
			// A block's placeholder kept on one line holds what it holds on lines of its own.
			const one = new RegExp(`^(\\s*)<${literal(stem)}-p(\\d+)>(.+)</${literal(stem)}-p\\2>$`).exec(line);
			if (one && tags[Number(one[2])]?.block && one[3] && !one[3].includes(`<${stem}-p${one[2]}>`)) {
				const indent = one[1] ?? "";
				result.push(`${indent}<${stem}-p${one[2]}>`, `${indent}  ${one[3]}`, `${indent}</${stem}-p${one[2]}>`);
				continue;
			}
			result.push(line);
		}
		const kept: string[] = [];
		for (const line of result) {
			const trimmed = line.trim();
			if (trimmed === directive) continue;
			const alone = new RegExp(`^</${literal(stem)}-p(\\d+)\\s*>$`).exec(trimmed);
			if (alone && tags[Number(alone[1])]?.close === "") continue;
			kept.push(line);
		}
		let text = kept.join("\n").split(directive).join("");
		text = text.replace(new RegExp(`<(/?)${literal(stem)}-p(\\d+)\\s*>`, "g"), (_, end: string, index: string) => {
			const found = tags[Number(index)];
			if (!found) return "";
			return end ? found.close : found.open;
		});
		if (values.size) {
			const pattern = new RegExp(
				[...values.keys()]
					.sort((a, b) => b.length - a.length)
					.map(literal)
					.join("|"),
				"g",
			);
			text = text.replace(pattern, (token) => values.get(token) ?? token);
		}
		return text;
	};

	return { ok: true, text: out, restore, originalOffset };
}

/** The white-space-only text at the end of a branch, if any. */
function trailingSpace(children: readonly Node[]): { kind: "text"; raw: string; at: number }[] {
	const last = children.at(-1);
	return last?.kind === "text" && last.raw.trim() === "" ? [last] : [];
}

function lineAt(text: string, offset: number): number {
	let line = 1;
	for (let index = 0; index < offset && index < text.length; index++) if (text[index] === "\n") line++;
	return line;
}
