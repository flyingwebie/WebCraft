/**
 * Reading Template markup into an element tree (ADR 0017). Template markup is HTML plus
 * `{{ value }}` bindings (with an optional formatter), `{{@command}} … {{/command}}` blocks, fixed
 * text with values in other languages (`{{ "Read more" fr: "Lire la suite" }}`) and `\{{` for a
 * literal `{{`. Each element's id is written as `data-wc-id`; an element without one
 * gets a new id. Classes are written by name in `class`, and an inline `style` becomes a generated
 * Class with a notice. A PascalCase tag places a Component, its Props written as attributes.
 *
 * WebCraft reads the markup itself, strictly: every element needs its end tag, nothing a browser
 * would silently repair is accepted, and every problem is reported with its line and column. The
 * tree it answers is canonical and has passed the same checks as any stored tree.
 */
import { decodeHTML, decodeHTMLAttribute } from "entities";

import { commandNamed, type MarkupSection, RESERVED_COMMANDS, TEMPLATE_COMMANDS } from "../commands.ts";
import {
	boundaryProblem,
	type ComponentCatalogue,
	expansionProblem,
	isComponentInfo,
	isComponentTag,
	type PlacementNode,
	type PropValue,
	placementHoldsNothing,
} from "../components.ts";
import { URL_ATTRIBUTES } from "../escape.ts";
import { type Expression, expressionPaths, readExpression } from "../expressions.ts";
import { readFormat } from "../formatters.ts";
import { canonicalLanguage, languageTagMessage, type Translations } from "../languages.ts";
import { mediaReference } from "../media.ts";
import {
	type Attribute,
	type AttributePart,
	attributeProblem,
	canonicalNodes,
	commentProblem,
	type ElementNode,
	type ElementTree,
	ElementTreeInvalidError,
	elementProblem,
	type FormCatalogue,
	hasText,
	isElementId,
	isValuePath,
	MAX_PROBLEMS,
	nestingProblem,
	parseElementTree,
	randomElementId,
	type TextNode,
	TREE_LIMITS,
	type TreeCheck,
	type TreeNode,
	textPlacementProblem,
	textProblem,
	unknownValueMessage,
	type ValueNode,
	VOID_ELEMENTS,
} from "../tree.ts";
import { readInlineStyle } from "./inline-style.ts";
import { type MarkupNotice, type MarkupProblem, MarkupSource, TemplateMarkupInvalidError } from "./problems.ts";

/** The attribute that carries an element's id in Template markup. */
export const ID_ATTRIBUTE = "data-wc-id";

export type ParseMarkupOptions = {
	/** Whether a binding's path names a value this markup may read; every path is allowed when absent. */
	isKnownValue?: (path: string) => boolean;
	/** Refuses an element this kind of Template mustn't hold, answering why. */
	refuseElement?: (tag: string) => string | undefined;
	/** Refuses a Template command this kind of Template mustn't hold, by its name, answering why. */
	refuseCommand?: (name: string) => string | undefined;
	/** Checks rules about the Template as a whole once it is read, reporting each problem where its node is. */
	checkTree?: TreeCheck;
	/** The id of the Site's Class with this name; every Class name is refused when absent. */
	classNamed?: (name: string) => string | undefined;
	/**
	 * The generated Class for an inline style's declarations (canonical, such as `color: red;`): one
	 * the Site has, or a new one; or why the style can't become one. Inline styles are refused when
	 * absent.
	 */
	classForStyle?: (declarations: string) => { id: string; name: string } | { problem: string };
	/**
	 * The Components the markup may place, by name (`<PostCard … />`) and by id, with their Props and
	 * trees. Every PascalCase tag is refused when absent.
	 */
	components?: ComponentCatalogue;
	/** Why a path names no value here, when `isKnownValue` refuses it; `unknownValueMessage` by default. */
	unknownValue?: (path: string) => string;
	/** The Forms the markup may place (`{{@form <key>}}`), by key and by id. Every Form is refused when absent. */
	forms?: FormCatalogue;
	/** How deep the markup already sits in Components: 0 for a Template (the default), 1 for a Component's. */
	placedDepth?: number;
	/** Makes an id for an element written without one; random by default. */
	newId?: () => string;
};

/** Template markup read into a tree, with notices about what saving changed. */
export type ParsedMarkup = { tree: ElementTree; notices: MarkupNotice[] };

/**
 * Reads Template markup into a canonical element tree. Throws `TemplateMarkupInvalidError` listing
 * every problem (up to 20) with its line and column.
 */
export function parseTemplateMarkup(markup: string, options: ParseMarkupOptions = {}): ParsedMarkup {
	return new MarkupParser(markup, options).parse();
}

/** A problem that stops reading: the rest of the markup can't be read reliably after it. */
class Stop extends Error {}

/** What ended a run of content. */
type End =
	| { kind: "eof"; offset: number }
	| { kind: "endTag"; name: string; offset: number }
	| { kind: "branch"; keyword: string; argument: string; argumentOffset: number; offset: number }
	| { kind: "close"; name: string; offset: number };

/** What the content being read sits in. */
type Container =
	| { kind: "root" }
	| { kind: "element"; tag: string; name: string; offset: number }
	| { kind: "command"; name: string; branches: readonly string[]; offset: number };

/** `{{ … }}` as written: what is inside, and where. */
type Curly = { inner: string; offset: number; innerOffset: number };

/** An attribute as written, before it is checked. */
type WrittenAttribute = {
	/** The name in lower case, as HTML reads it. */
	name: string;
	/** The name as written: a Placement's Props keep their case (`heroImage`). */
	rawName: string;
	offset: number;
	parts: AttributePart[];
	/** Whether the value holds a binding. */
	bound: boolean;
	/** The value's text when it holds no binding. */
	text: string;
	valueOffset: number;
};

/** Elements whose content HTML reads as plain text up to their end tag. */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set([
	"script",
	"style",
	"textarea",
	"title",
	"xmp",
	"iframe",
	"noembed",
	"noframes",
	"noscript",
]);

/** Elements HTML reads without content or an end tag, allowed in Templates or not. */
const HTML_VOID_ELEMENTS: ReadonlySet<string> = new Set([
	...VOID_ELEMENTS,
	"area",
	"base",
	"embed",
	"input",
	"keygen",
	"link",
	"meta",
	"param",
]);

/** The keywords that open or continue a command, longest first, so `else if` is found before `else`. */
const KEYWORDS = [
	...new Set([...TEMPLATE_COMMANDS.flatMap((command) => [command.name, ...command.branches]), ...RESERVED_COMMANDS]),
].sort((a, b) => b.length - a.length);

class MarkupParser {
	private readonly source: MarkupSource;
	private readonly text: string;
	private pos = 0;
	private readonly problems: MarkupProblem[] = [];
	private readonly notices: MarkupNotice[] = [];
	private readonly ids = new Map<string, number>();
	private readonly classIds = new Set<string>();
	/** Where each node was read, for problems `checkTree` reports on a node. */
	private readonly offsets = new WeakMap<object, number>();
	private count = 0;
	/** Boundary checks already made, by Component and where it sits. */
	private readonly boundaries = new Map<string, string | undefined>();
	private readonly newId: () => string;
	private readonly options: ParseMarkupOptions;

	constructor(markup: string, options: ParseMarkupOptions) {
		this.options = options;
		this.source = new MarkupSource(markup);
		this.text = this.source.text;
		this.newId = options.newId ?? randomElementId;
	}

	parse(): ParsedMarkup {
		let nodes: TreeNode[] = [];
		try {
			const content = this.readContent({ kind: "root" }, [], 1);
			nodes = content.nodes;
			this.unexpectedEnd(content.end, { kind: "root" });
			const components = this.options.components;
			if (this.problems.length === 0 && components) {
				const tooBig = expansionProblem(nodes, (id) => components.byId(id));
				if (tooBig) this.problem(this.offsets.get(tooBig.node) ?? 0, tooBig.message);
			}
			if (this.problems.length === 0) {
				this.options.checkTree?.(nodes, (node, message) =>
					this.problem((node && this.offsets.get(node)) ?? 0, message),
				);
			}
		} catch (error) {
			if (!(error instanceof Stop)) throw error;
		}
		if (this.problems.length > 0) throw new TemplateMarkupInvalidError(this.sortedProblems());
		let tree: ElementTree;
		try {
			// The same checks as any stored tree; reading the markup has already reported each of them.
			tree = parseElementTree(
				{ version: 1, nodes },
				{
					isKnownValue: this.options.isKnownValue,
					refuseElement: this.options.refuseElement,
					refuseCommand: this.options.refuseCommand,
					components: this.options.components,
					forms: this.options.forms,
					unknownValue: this.options.unknownValue,
					placedDepth: this.options.placedDepth,
					classIds: this.classIds,
					newId: this.newId,
				},
			);
		} catch (error) {
			if (!(error instanceof ElementTreeInvalidError)) throw error;
			throw new TemplateMarkupInvalidError(
				error.problems.map((problem) => ({ line: 1, column: 1, message: problem.message })),
			);
		}
		const notices = [...this.notices].sort((a, b) => a.line - b.line || a.column - b.column);
		return { tree, notices };
	}

	// -----------------------------------------------------------------------------------------
	// Problems

	private problem(offset: number, message: string): void {
		if (this.problems.length < MAX_PROBLEMS) this.problems.push({ ...this.source.position(offset), message });
		if (this.problems.length >= MAX_PROBLEMS) throw new Stop();
	}

	private stop(offset: number, message: string): never {
		this.problem(offset, message);
		throw new Stop();
	}

	private notice(offset: number, message: string): void {
		this.notices.push({ ...this.source.position(offset), message });
	}

	private sortedProblems(): MarkupProblem[] {
		return [...this.problems].sort((a, b) => a.line - b.line || a.column - b.column);
	}

	private lineOf(offset: number): number {
		return this.source.position(offset).line;
	}

	// -----------------------------------------------------------------------------------------
	// Content: text, bindings, commands, comments and elements, up to what ends it

	private readContent(
		container: Container,
		ancestors: readonly string[],
		depth: number,
	): { nodes: TreeNode[]; end: End } {
		const nodes: TreeNode[] = [];
		let text = "";
		let textOffset = this.pos;
		const add = (node: TreeNode | undefined, offset: number) => {
			if (!node) return;
			if (depth > TREE_LIMITS.depth) this.stop(offset, `Elements nest at most ${TREE_LIMITS.depth} deep.`);
			this.count++;
			if (this.count > TREE_LIMITS.nodes) this.stop(offset, `A Template holds at most ${TREE_LIMITS.nodes} nodes.`);
			this.offsets.set(node, offset);
			nodes.push(node);
		};
		const flush = () => {
			if (text) {
				const refused = textProblem(text);
				if (refused) this.problem(textOffset, refused);
				if (text.trim()) {
					const misplaced = textPlacementProblem(ancestors.at(-1));
					if (misplaced) this.problem(textOffset, misplaced);
				}
				add({ type: "text", text }, textOffset);
			}
			text = "";
			textOffset = this.pos;
		};

		for (;;) {
			if (this.pos >= this.text.length) {
				flush();
				return { nodes, end: { kind: "eof", offset: this.pos } };
			}
			const char = this.text[this.pos];
			if (char === "\\" && this.text.startsWith("{{", this.pos + 1)) {
				if (!text) textOffset = this.pos;
				text += "{{";
				this.pos += 3;
				continue;
			}
			if (char === "{" && this.text.startsWith("{{", this.pos)) {
				flush();
				const curly = this.readCurly();
				const inner = curly.inner.trim();
				if (inner.startsWith("@")) {
					const opened = this.readCommandWord(curly);
					const command = commandNamed(opened.keyword);
					if (command && opened.keyword === command.name) {
						const refused = this.options.refuseCommand?.(command.name);
						if (refused) this.problem(opened.offset, refused);
						add(this.readCommand(command, opened, ancestors, depth), opened.offset);
					} else if (container.kind === "command" && container.branches.includes(opened.keyword)) {
						return { nodes, end: { kind: "branch", ...opened } };
					} else {
						this.misplacedKeyword(opened.keyword, curly.offset, container);
					}
				} else if (inner.startsWith("/")) {
					return { nodes, end: { kind: "close", name: inner.slice(1).trim(), offset: curly.offset } };
				} else if (inner.startsWith('"')) {
					const node = this.readTranslatedText(curly);
					const misplaced = node && hasText(node) ? textPlacementProblem(ancestors.at(-1)) : undefined;
					if (misplaced) this.problem(curly.offset, misplaced);
					add(node, curly.offset);
				} else {
					const misplaced = textPlacementProblem(ancestors.at(-1));
					if (misplaced) this.problem(curly.offset, misplaced.replace(/^Text/, "A value"));
					add(this.readValue(curly), curly.offset);
				}
				textOffset = this.pos;
				continue;
			}
			if (char === "<") {
				const next = this.text[this.pos + 1] ?? "";
				if (this.text.startsWith("<!--", this.pos)) {
					flush();
					const commentOffset = this.pos;
					add(this.readComment(), commentOffset);
					textOffset = this.pos;
					continue;
				}
				if (next === "/") {
					flush();
					return { nodes, end: this.readEndTag() };
				}
				if (/[A-Za-z]/.test(next)) {
					flush();
					const elementOffset = this.pos;
					add(this.readElement(ancestors, depth), elementOffset);
					textOffset = this.pos;
					continue;
				}
				if (next === "!" || next === "?") {
					this.stop(
						this.pos,
						"Doctypes, CDATA sections and processing instructions aren't allowed in Template markup.",
					);
				}
				this.problem(this.pos, "Write &lt; for a < in text.");
				if (!text) textOffset = this.pos;
				text += "<";
				this.pos++;
				continue;
			}
			// Plain text up to the next character that may start something else.
			let end = this.pos + 1;
			while (end < this.text.length && !"<{\\".includes(this.text[end] ?? "")) end++;
			if (!text) textOffset = this.pos;
			const raw = this.text.slice(this.pos, end);
			if (raw.includes("\0")) this.problem(this.pos + raw.indexOf("\0"), "Text can't hold the NUL character.");
			text += decodeHTML(raw);
			this.pos = end;
		}
	}

	/** Reports a branch keyword or reserved command that can't be where it is. */
	private misplacedKeyword(keyword: string, offset: number, container: Container): never {
		if (RESERVED_COMMANDS.has(keyword)) this.stop(offset, `{{@${keyword}}} isn't available yet.`);
		const owner = TEMPLATE_COMMANDS.find((command) => command.branches.includes(keyword));
		if (!owner) {
			const word = keyword.split(/\s/)[0] ?? keyword;
			this.stop(
				offset,
				`There is no Template command {{@${word}}}: use ${TEMPLATE_COMMANDS.map((command) => `{{@${command.name}}}`).join(", ")}.`,
			);
		}
		if (container.kind === "element") {
			this.stop(
				offset,
				`{{@${keyword}}} must be directly inside {{@${owner.name}}}: <${container.name}> on line ${this.lineOf(container.offset)} is still open.`,
			);
		}
		this.stop(offset, `{{@${keyword}}} belongs inside {{@${owner.name}}} … {{/${owner.name}}}.`);
	}

	/** Checks what ended the content of `container`; anything but its own end is a problem that stops. */
	private unexpectedEnd(end: End, container: Container): void {
		if (container.kind === "root") {
			if (end.kind === "eof") return;
			if (end.kind === "endTag") this.stop(end.offset, `</${end.name}> closes no element.`);
			if (end.kind === "close") this.stop(end.offset, `{{/${end.name}}} closes no {{@${end.name}}}.`);
			this.misplacedKeyword(end.kind === "branch" ? end.keyword : "", end.offset, container);
		}
	}

	// -----------------------------------------------------------------------------------------
	// {{ … }}

	/** Reads `{{ … }}` from `pos`, skipping quoted text inside, up to the first `}}`. */
	private readCurly(): Curly {
		const offset = this.pos;
		let index = this.pos + 2;
		for (;;) {
			if (index >= this.text.length) {
				this.stop(offset, `{{ on line ${this.lineOf(offset)} has no closing }}.`);
			}
			const char = this.text[index];
			if (char === '"') {
				index++;
				while (index < this.text.length && this.text[index] !== '"') index += this.text[index] === "\\" ? 2 : 1;
				index++;
				continue;
			}
			if (char === "}" && this.text[index + 1] === "}") break;
			if (char === "\n" && this.text.startsWith("{{", index + 1)) {
				this.stop(offset, `{{ on line ${this.lineOf(offset)} has no closing }}.`);
			}
			index++;
		}
		this.pos = index + 2;
		return { inner: this.text.slice(offset + 2, index), offset, innerOffset: offset + 2 };
	}

	/** The keyword after `{{@` (`if`, `else if`, `else`) and what follows it. */
	private readCommandWord(curly: Curly): {
		keyword: string;
		argument: string;
		argumentOffset: number;
		offset: number;
	} {
		const at = curly.inner.indexOf("@");
		const afterAt = curly.inner.slice(at + 1);
		const keyword = KEYWORDS.find(
			(candidate) => afterAt.startsWith(candidate) && !/[A-Za-z0-9_]/.test(afterAt[candidate.length] ?? ""),
		);
		const word = keyword ?? /^[^\s}]*/.exec(afterAt)?.[0] ?? "";
		const argumentOffset = curly.innerOffset + at + 1 + word.length;
		return { keyword: word, argument: afterAt.slice(word.length), argumentOffset, offset: curly.offset };
	}

	private readValue(curly: Curly): ValueNode | undefined {
		const [pathText = "", ...formats] = curly.inner.split("|");
		const path = pathText.trim();
		const pathOffset = curly.innerOffset + (pathText.length - pathText.trimStart().length);
		if (!path) {
			this.problem(curly.offset, "{{ }} needs a value's name, such as {{ title }}.");
			return undefined;
		}
		if (!isValuePath(path)) {
			this.problem(pathOffset, `${path} isn't a value's name: write names joined by dots, such as {{ title }}.`);
			return undefined;
		}
		if (this.options.isKnownValue && !this.options.isKnownValue(path)) {
			this.problem(pathOffset, (this.options.unknownValue ?? unknownValueMessage)(path));
			return undefined;
		}
		if (formats.length === 0) return { type: "value", path };
		if (formats.length > 1) {
			this.problem(curly.offset + 2 + pathText.length + 1 + (formats[0]?.length ?? 0), "A value has one formatter.");
			return undefined;
		}
		const formatText = formats[0] ?? "";
		const read = readFormat(formatText);
		if ("problem" in read) {
			const leading = formatText.length - formatText.trimStart().length;
			this.problem(curly.innerOffset + pathText.length + 1 + leading, read.problem);
			return undefined;
		}
		return { type: "value", path, format: read.format };
	}

	/**
	 * Reads fixed text with values in other languages: `{{ "Read more" fr: "Lire la suite" }}`, the
	 * text as written in double quotes, then each language's (`\"` for a quote, `\\` for a
	 * backslash, `\r` for a carriage return).
	 */
	private readTranslatedText(curly: Curly): TextNode | undefined {
		const source = curly.inner;
		const at = (index: number) => curly.innerOffset + index;
		const layout = 'Write each language as fr: "…", after the text as written.';
		let index = 0;
		const skipSpace = () => {
			while (index < source.length && /\s/.test(source[index] ?? "")) index++;
		};
		const readQuoted = (): string | undefined => {
			const start = index;
			index++;
			let value = "";
			for (;;) {
				if (index >= source.length) {
					this.problem(at(start), 'This text never ends: close it with ".');
					return undefined;
				}
				const char = source[index] ?? "";
				if (char === '"') {
					index++;
					return value;
				}
				if (char === "\\") {
					const next = source[index + 1];
					if (next === '"' || next === "\\") value += next;
					else if (next === "r") value += "\r";
					else {
						this.problem(
							at(index),
							'In quoted text, write \\" for a quote, \\\\ for a backslash and \\r for a carriage return.',
						);
						return undefined;
					}
					index += 2;
					continue;
				}
				value += char;
				index++;
			}
		};
		skipSpace();
		const text = readQuoted();
		if (text === undefined) return undefined;
		const refused = textProblem(text);
		if (refused) this.problem(curly.offset, refused);
		const translations: Translations = {};
		for (;;) {
			skipSpace();
			if (index >= source.length) break;
			const tagStart = index;
			const tag = /^[A-Za-z0-9-]+/.exec(source.slice(index))?.[0];
			if (!tag) {
				this.problem(at(index), layout);
				return undefined;
			}
			index += tag.length;
			skipSpace();
			if (source[index] !== ":") {
				this.problem(at(tagStart), layout);
				return undefined;
			}
			index++;
			skipSpace();
			if (source[index] !== '"') {
				this.problem(at(index), layout);
				return undefined;
			}
			const value = readQuoted();
			if (value === undefined) return undefined;
			const language = canonicalLanguage(tag);
			if (!language) this.problem(at(tagStart), languageTagMessage(tag));
			else if (Object.hasOwn(translations, language)) this.problem(at(tagStart), `${language} is given twice.`);
			else {
				const refusedValue = textProblem(value);
				if (refusedValue) this.problem(at(tagStart), refusedValue);
				if (value !== "") translations[language] = value;
			}
		}
		return Object.keys(translations).length > 0 ? { type: "text", text, translations } : { type: "text", text };
	}

	private readExpression(text: string, offset: number): Expression | undefined {
		const read = readExpression(text);
		if ("problem" in read) {
			this.problem(offset + read.problem.offset, read.problem.message);
			return undefined;
		}
		const unknown = expressionPaths(read.expression).find(
			(path) => this.options.isKnownValue && !this.options.isKnownValue(path),
		);
		if (unknown !== undefined) {
			const at = new RegExp(`(?<![A-Za-z0-9_.])${unknown.replaceAll(".", "\\.")}(?![A-Za-z0-9_])`).exec(text);
			this.problem(offset + (at?.index ?? 0), (this.options.unknownValue ?? unknownValueMessage)(unknown));
			return undefined;
		}
		return read.expression;
	}

	// -----------------------------------------------------------------------------------------
	// Template commands

	private readCommand(
		command: NonNullable<ReturnType<typeof commandNamed>>,
		opened: { keyword: string; argument: string; argumentOffset: number; offset: number },
		ancestors: readonly string[],
		depth: number,
	): TreeNode | undefined {
		if (depth > TREE_LIMITS.depth) this.stop(opened.offset, `Elements nest at most ${TREE_LIMITS.depth} deep.`);
		const misplaced = command.placementProblem?.(ancestors);
		if (misplaced) this.problem(opened.offset, misplaced);
		const sections: MarkupSection[] = [];
		let current = { ...opened, keyword: command.name };
		if (command.block) {
			const container: Container = {
				kind: "command",
				name: command.name,
				branches: command.branches,
				offset: opened.offset,
			};
			for (;;) {
				const { nodes, end } = this.readContent(container, ancestors, depth + 1);
				sections.push({ ...current, children: nodes });
				if (end.kind === "branch") {
					current = {
						keyword: end.keyword,
						argument: end.argument,
						argumentOffset: end.argumentOffset,
						offset: end.offset,
					};
					continue;
				}
				if (end.kind === "close" && end.name === command.name) break;
				if (end.kind === "eof") {
					this.stop(
						opened.offset,
						`{{@${command.name}}} on line ${this.lineOf(opened.offset)} has no {{/${command.name}}}.`,
					);
				}
				if (end.kind === "close") {
					this.stop(
						end.offset,
						`{{/${end.name}}} doesn't close {{@${command.name}}} on line ${this.lineOf(opened.offset)}.`,
					);
				}
				this.stop(
					end.offset,
					`</${end.kind === "endTag" ? end.name : ""}> comes before {{/${command.name}}}, which closes {{@${command.name}}} on line ${this.lineOf(opened.offset)}.`,
				);
			}
		} else {
			sections.push({ ...current, children: [] });
		}
		return command.fromMarkup(sections, {
			expression: (text, offset) => this.readExpression(text, offset),
			form: (key, offset) => {
				const found = this.options.forms?.keyed(key);
				if (!found || "refused" in found) {
					this.problem(offset, found?.refused ?? `There is no Form with the key ${key} on this Site.`);
					return undefined;
				}
				return found.id;
			},
			problem: (offset, message) => this.problem(offset, message),
		});
	}

	// -----------------------------------------------------------------------------------------
	// Comments

	private readComment(): TreeNode {
		const offset = this.pos;
		const start = this.pos + 4;
		const end = this.text.indexOf("-->", start);
		if (end < 0) this.stop(offset, `The comment on line ${this.lineOf(offset)} never ends: close it with -->.`);
		const text = this.text.slice(start, end);
		this.pos = end + 3;
		const refused = commentProblem(text);
		if (refused) this.problem(offset, refused);
		return { type: "comment", text };
	}

	// -----------------------------------------------------------------------------------------
	// Elements

	private readEndTag(): End {
		const offset = this.pos;
		const match = /^<\/([^\s>]*)\s*>/.exec(this.text.slice(this.pos, this.pos + 200));
		if (!match) this.stop(offset, "Write an end tag as </name>.");
		this.pos += match[0].length;
		return { kind: "endTag", name: match[1] ?? "", offset };
	}

	private readElement(ancestors: readonly string[], depth: number): ElementNode | PlacementNode | undefined {
		const offset = this.pos;
		this.pos++;
		const namePattern = /[^\s/>]*/y;
		namePattern.lastIndex = this.pos;
		const nameMatch = namePattern.exec(this.text)?.[0] ?? "";
		this.pos += nameMatch.length;
		if (nameMatch.includes("{")) this.stop(offset, "Values can't be used in tag names.");
		const isComponent = isComponentTag(nameMatch);
		const tag = isComponent ? nameMatch : nameMatch.toLowerCase();
		const { attributes, selfClosing } = this.readAttributes(offset, nameMatch);

		if (isComponent) return this.readPlacement(nameMatch, attributes, selfClosing, offset, ancestors, depth);
		if (RAW_TEXT_ELEMENTS.has(tag)) {
			this.problem(offset, elementProblem(tag) ?? `There is no element named ${tag} in Templates.`);
			const close = this.text.toLowerCase().indexOf(`</${tag}`, this.pos);
			if (close < 0) this.stop(offset, `<${tag}> on line ${this.lineOf(offset)} has no end tag </${tag}>.`);
			this.pos = close;
			this.readEndTag();
			return undefined;
		}
		if (tag === "plaintext") this.stop(offset, "There is no element named plaintext in Templates.");

		const refused = elementProblem(tag) ?? this.options.refuseElement?.(tag) ?? nestingProblem(tag, ancestors);
		if (refused) this.problem(offset, refused);
		if (depth > TREE_LIMITS.depth) this.stop(offset, `Elements nest at most ${TREE_LIMITS.depth} deep.`);

		const element = this.elementFrom(tag, attributes, offset);
		if (HTML_VOID_ELEMENTS.has(tag)) return refused ? undefined : element;
		if (selfClosing) this.stop(offset, `<${tag}> can't close itself: write <${tag}></${tag}>.`);

		// HTML drops a newline right after <pre>'s start tag.
		if (tag === "pre" && this.text[this.pos] === "\n") this.pos++;
		const { nodes, end } = this.readContent(
			{ kind: "element", tag, name: nameMatch, offset },
			[...ancestors, tag],
			depth + 1,
		);
		this.expectEndTag(end, tag, nameMatch, offset);
		element.children = canonicalNodes(nodes);
		return refused ? undefined : element;
	}

	/**
	 * A PascalCase tag: a Placement of the Component with that name, its Props written as attributes
	 * (`<PostCard heading="{{ title }}" featured />`). It holds nothing: Components have no slots.
	 */
	private readPlacement(
		name: string,
		written: readonly WrittenAttribute[],
		selfClosing: boolean,
		offset: number,
		ancestors: readonly string[],
		depth: number,
	): PlacementNode | undefined {
		if (depth > TREE_LIMITS.depth) this.stop(offset, `Elements nest at most ${TREE_LIMITS.depth} deep.`);
		if (!selfClosing) {
			const { nodes, end } = this.readContent({ kind: "element", tag: name, name, offset }, ancestors, depth + 1);
			this.expectEndTag(end, name, name, offset);
			const inside = nodes[0];
			if (inside) this.problem(this.offsets.get(inside) ?? offset, placementHoldsNothing(name));
		}
		const catalogue = this.options.components;
		const found = catalogue?.named(name);
		if (!isComponentInfo(found)) {
			this.problem(offset, found?.refused ?? `There is no Component named ${name}.`);
			return undefined;
		}
		const boundary = boundaryProblem(
			found,
			ancestors,
			(id) => catalogue?.byId(id),
			this.boundaries,
			(this.options.placedDepth ?? 0) + 1,
		);
		if (boundary) this.problem(offset, boundary);
		let id: string | undefined;
		const props: PropValue[] = [];
		const given = new Set<string>();
		for (const attribute of written) {
			if (attribute.name === ID_ATTRIBUTE) {
				if (attribute.bound || !isElementId(attribute.text)) {
					this.problem(attribute.valueOffset, `${ID_ATTRIBUTE} is 1 to 64 letters, digits, dashes and underscores.`);
				} else {
					id = attribute.text;
				}
				continue;
			}
			const key = attribute.rawName;
			if (given.has(key)) {
				this.problem(attribute.offset, `${key} is given twice.`);
				continue;
			}
			given.add(key);
			const prop = found.props.find((candidate) => candidate.key === key);
			if (!prop) {
				const near = found.props.find((candidate) => candidate.key.toLowerCase() === key.toLowerCase());
				this.problem(
					attribute.offset,
					near
						? `${found.name} has no Prop named ${key}: Props are written as declared, ${near.key}.`
						: `${found.name} has no Prop named ${key}.`,
				);
				continue;
			}
			if (!attribute.bound) {
				const refused = prop.check(attribute.text);
				if (refused) {
					this.problem(attribute.valueOffset, `${key}: ${refused}`);
					continue;
				}
			}
			props.push({ name: key, value: canonicalNodes(attribute.parts) });
		}
		for (const prop of found.props) {
			if (prop.required && !given.has(prop.key)) {
				this.problem(offset, `${found.name} needs ${prop.key}: the Prop is required.`);
			}
		}
		return { type: "component", id: this.elementId(id, offset), component: found.id, props };
	}

	private expectEndTag(end: End, tag: string, name: string, offset: number): void {
		const line = this.lineOf(offset);
		if (end.kind === "endTag") {
			const matches = /^[A-Z]/.test(name) && /[a-z]/.test(name) ? end.name === name : end.name.toLowerCase() === tag;
			if (matches) return;
			const closing = end.name.toLowerCase();
			if (HTML_VOID_ELEMENTS.has(closing))
				this.stop(end.offset, `<${closing}> has no end tag: write <${closing}> alone.`);
			this.stop(end.offset, `</${end.name}> doesn't close <${name}> on line ${line}: close it with </${name}> first.`);
		}
		if (end.kind === "eof") this.stop(offset, `<${name}> on line ${line} has no end tag </${name}>.`);
		if (end.kind === "close") {
			this.stop(end.offset, `{{/${end.name}}} comes before </${name}>, which closes <${name}> on line ${line}.`);
		}
		this.stop(
			end.offset,
			`{{@${end.kind === "branch" ? end.keyword : ""}}} must be directly inside its command: <${name}> on line ${line} is still open.`,
		);
	}

	/** Builds an element from its attributes: its id, Classes, inline style and the rest, checked. */
	private elementFrom(tag: string, written: readonly WrittenAttribute[], offset: number): ElementNode {
		let id: string | undefined;
		const classes: string[] = [];
		const attributes: Attribute[] = [];
		const seen = new Set<string>();
		let style: WrittenAttribute | undefined;
		for (const attribute of written) {
			const { name } = attribute;
			if (seen.has(name)) {
				this.problem(attribute.offset, `${name} is given twice.`);
				continue;
			}
			seen.add(name);
			if (name === ID_ATTRIBUTE) {
				if (attribute.bound || !isElementId(attribute.text)) {
					this.problem(attribute.valueOffset, `${ID_ATTRIBUTE} is 1 to 64 letters, digits, dashes and underscores.`);
				} else {
					id = attribute.text;
				}
				continue;
			}
			if (name === "class") {
				if (attribute.bound) {
					this.problem(attribute.valueOffset, "Values can't be used in class: give the element its Classes by name.");
					continue;
				}
				for (const className of attribute.text.split(/\s+/).filter(Boolean)) {
					const classId = this.options.classNamed?.(className);
					if (classId === undefined)
						this.problem(attribute.valueOffset, `There is no Class named ${className} on this Site.`);
					else if (!classes.includes(classId)) classes.push(classId);
				}
				continue;
			}
			if (name === "style") {
				if (attribute.bound) this.problem(attribute.valueOffset, "Values can't be used in style.");
				else style = attribute;
				continue;
			}
			const refused = attributeProblem(name);
			if (refused) {
				this.problem(attribute.offset, refused);
				continue;
			}
			// `media:<id>` names a file of the Site's Media library (an `<img>` renders as a Media image);
			// only its form is checked here: a file can be deleted later, and then nothing renders.
			if (
				URL_ATTRIBUTES.has(name) &&
				/^\s*media:/i.test(attribute.text) &&
				!attribute.bound &&
				mediaReference(attribute.text) === undefined
			) {
				this.problem(
					attribute.valueOffset,
					"media: is followed by the id of a file in the Site's Media library, such as media:3f9a1c2b-7d4e-4f60-9a1c-2b7d4e5f6071.",
				);
				continue;
			}
			attributes.push({ name, value: canonicalNodes(attribute.parts) });
		}
		if (style) this.styleToClass(style, classes);
		for (const classId of classes) this.classIds.add(classId);
		return { type: "element", id: this.elementId(id, offset), tag, attributes, classes, children: [] };
	}

	/** Turns an inline style into the generated Class for it, with a notice. */
	private styleToClass(style: WrittenAttribute, classes: string[]): void {
		const read = readInlineStyle(style.text);
		if ("problem" in read) {
			this.problem(style.valueOffset, read.problem);
			return;
		}
		if (!read.declarations) return;
		if (!this.options.classForStyle) {
			this.problem(style.offset, "Inline styles aren't allowed: give the element a Class.");
			return;
		}
		const generated = this.options.classForStyle(read.declarations);
		if ("problem" in generated) {
			this.problem(style.valueOffset, generated.problem);
			return;
		}
		if (!classes.includes(generated.id)) classes.push(generated.id);
		this.notice(
			style.offset,
			`The inline style became the Class ${generated.name}: pages never carry inline styles, so change it in the Design system.`,
		);
	}

	/** The id written for an element, or a new one when none was written or another element has it. */
	private elementId(written: string | undefined, offset: number): string {
		if (written !== undefined) {
			const first = this.ids.get(written);
			if (first === undefined) {
				this.ids.set(written, offset);
				return written;
			}
			this.notice(
				offset,
				`The element on line ${this.lineOf(first)} has the same ${ID_ATTRIBUTE}, so this one got a new id.`,
			);
		}
		let id = this.newId();
		while (this.ids.has(id)) id = this.newId();
		this.ids.set(id, offset);
		return id;
	}

	// -----------------------------------------------------------------------------------------
	// Attributes

	private readAttributes(tagOffset: number, tagName: string): { attributes: WrittenAttribute[]; selfClosing: boolean } {
		const attributes: WrittenAttribute[] = [];
		for (;;) {
			this.skipSpace();
			if (this.pos >= this.text.length) {
				this.stop(tagOffset, `<${tagName} on line ${this.lineOf(tagOffset)} has no closing >.`);
			}
			if (this.text[this.pos] === ">") {
				this.pos++;
				return { attributes, selfClosing: false };
			}
			if (this.text.startsWith("/>", this.pos)) {
				this.pos += 2;
				return { attributes, selfClosing: true };
			}
			if (this.text[this.pos] === "/") {
				this.pos++;
				continue;
			}
			const nameOffset = this.pos;
			let rawName = "";
			let bound = false;
			while (this.pos < this.text.length && !/[\s/>=]/.test(this.text[this.pos] ?? "")) {
				if (this.text.startsWith("{{", this.pos)) {
					this.readCurly();
					bound = true;
					continue;
				}
				rawName += this.text[this.pos];
				this.pos++;
			}
			if (bound) {
				this.problem(nameOffset, "Values can't be used in attribute names.");
				this.skipAttributeValue();
				continue;
			}
			const name = rawName.toLowerCase();
			this.skipSpace();
			if (this.text[this.pos] !== "=") {
				attributes.push({
					name,
					rawName,
					offset: nameOffset,
					parts: [],
					bound: false,
					text: "",
					valueOffset: nameOffset,
				});
				continue;
			}
			this.pos++;
			this.skipSpace();
			attributes.push({ name, rawName, offset: nameOffset, ...this.readAttributeValue(tagOffset, tagName) });
		}
	}

	private skipSpace(): void {
		while (this.pos < this.text.length && /\s/.test(this.text[this.pos] ?? "")) this.pos++;
	}

	private skipAttributeValue(): void {
		this.skipSpace();
		if (this.text[this.pos] !== "=") return;
		this.pos++;
		this.skipSpace();
		this.readAttributeValue(this.pos, "");
	}

	/** Reads a quoted or unquoted attribute value: text and bindings, `\{{` for a literal `{{`. */
	private readAttributeValue(
		tagOffset: number,
		tagName: string,
	): { parts: AttributePart[]; bound: boolean; text: string; valueOffset: number } {
		const quote = this.text[this.pos] === '"' || this.text[this.pos] === "'" ? this.text[this.pos] : undefined;
		if (quote) this.pos++;
		const valueOffset = this.pos;
		const parts: AttributePart[] = [];
		let raw = "";
		let bound = false;
		let commandReported = false;
		const flush = () => {
			if (raw) parts.push({ type: "text", text: decodeHTMLAttribute(raw) });
			raw = "";
		};
		for (;;) {
			if (this.pos >= this.text.length) {
				if (quote) this.stop(valueOffset - 1, `This attribute value never ends: close it with ${quote}.`);
				this.stop(tagOffset, `<${tagName} on line ${this.lineOf(tagOffset)} has no closing >.`);
			}
			const char = this.text[this.pos] ?? "";
			if (quote ? char === quote : /[\s>]/.test(char)) {
				if (quote) this.pos++;
				break;
			}
			if (char === "\\" && this.text.startsWith("{{", this.pos + 1)) {
				flush();
				parts.push({ type: "text", text: "{{" });
				this.pos += 3;
				continue;
			}
			if (char === "{" && this.text.startsWith("{{", this.pos)) {
				flush();
				const curly = this.readCurly();
				const inner = curly.inner.trim();
				if (inner.startsWith("@") || inner.startsWith("/")) {
					if (!commandReported) this.problem(curly.offset, "Template commands can't be used inside attribute values.");
					commandReported = true;
					continue;
				}
				if (inner.startsWith('"')) {
					const text = this.readTranslatedText(curly);
					if (text) parts.push(text);
					bound = true;
					continue;
				}
				const value = this.readValue(curly);
				if (value) parts.push(value);
				bound = true;
				continue;
			}
			if (char === "\0") this.problem(this.pos, "Text can't hold the NUL character.");
			raw += char;
			this.pos++;
		}
		flush();
		const text = parts.map((part) => (part.type === "text" ? part.text : "")).join("");
		return { parts, bound, text, valueOffset };
	}
}
