/**
 * Template commands: the built-in instructions written with `@` in Template markup
 * (`{{@if summary}} … {{@else}} … {{/if}}`). Each is one entry in `TEMPLATE_COMMANDS`, which says
 * how it reads from markup, how it prints, how its stored node is checked and how it renders, so a
 * new command is a new entry here and a new node kind in `TreeNode`, never a change to the markup
 * parser or printer.
 *
 * Commands the spec names but later work brings (Filters and Popups) are reserved: markup naming
 * them is refused for now.
 */
import { type Expression, passes, type RenderTime, writeExpression } from "./expressions.ts";
import { DEFAULT_ITEM_NAME, loopBodyScope, paginationProblem, readLoopArgument, type ValueScope } from "./loops.ts";
import type {
	ConditionBranch,
	ConditionNode,
	FormNode,
	LanguageSwitcherNode,
	LoopNode,
	OutletNode,
	PaginationNode,
	SearchNode,
	ThemeToggleNode,
	TreeNode,
} from "./tree.ts";
import type { TemplateValue } from "./values.ts";

/** The node kinds Template commands store. */
export type CommandNode =
	| ConditionNode
	| OutletNode
	| ThemeToggleNode
	| LanguageSwitcherNode
	| FormNode
	| LoopNode
	| PaginationNode
	| SearchNode;

/** One section of a command in markup: the opening one (`{{@if …}}`), then each branch (`{{@else}}`). */
export type MarkupSection = {
	/** `if`, `else if`, `else`. */
	keyword: string;
	/** What follows the keyword, such as the test. */
	argument: string;
	/** Where the argument starts in the markup, for problems. */
	argumentOffset: number;
	/** Where the section's `{{` is in the markup. */
	offset: number;
	children: TreeNode[];
};

export type FromMarkupTools = {
	/** Reads an expression written at `offset` in the markup; undefined after reporting a problem. */
	expression(text: string, offset: number): Expression | undefined;
	/** The id of the Site's Form with this key, written at `offset`; undefined after reporting a problem. */
	form(key: string, offset: number): string | undefined;
	problem(offset: number, message: string): void;
	/** What bindings may read where the command is. */
	scope: ValueScope;
};

export type CheckTools = {
	problem(at: string, message: string): void;
	/** Checks a stored expression at `at`. */
	expression(input: unknown, at: string): Expression | undefined;
	/**
	 * Checks a stored list of nodes at `at`, as children of the command's parent, reading what
	 * `scope` allows (what is around the command when absent).
	 */
	nodes(input: unknown, at: string, scope?: ValueScope): TreeNode[];
	/** What bindings may read where the command is. */
	scope: ValueScope;
	/** Checks a stored Form id at `at`: one of the Site's Forms the tree may place. */
	form(input: unknown, at: string): string | undefined;
};

export type RenderTools = {
	read(path: string): TemplateValue;
	/** The time the page is rendered, for tests that read `now`. */
	time?: RenderTime;
	/** Renders a Loop: its content once per item, or what shows when it has none. */
	loop(node: LoopNode): string;
	/** The links to a Loop's pages: nothing unless it paginates on this page. */
	pagination(loop: string): string;
	/** Renders nodes in the command's place. */
	nodes(nodes: readonly TreeNode[]): string;
	/** The page's content, rendered: what the Site template's `{{@outlet}}` shows. */
	outlet(): string;
	/** The theme toggle, rendered: nothing when the Site has no dark mode. */
	themeToggle(): string;
	/** The Language switcher, rendered: nothing on a Site with one language. */
	languageSwitcher(): string;
	/** A Form, rendered: nothing where Forms don't run, or for a Form the page can't show. */
	form(formId: string): string;
	/** The Search element, rendered: nothing while the Site has no search results page in the page's language. */
	search(): string;
};

/** What printing a command needs to know about the Site: the keys of its Forms. */
export type ToMarkupTools = {
	/** The key of the Form with this id, as `{{@form <key>}}` writes it. */
	formKey(formId: string): string | undefined;
};

/** A section as it prints: `{{@<keyword> <argument>}}` then its children. */
export type PrintedSection = { keyword: string; argument: string; children: readonly TreeNode[] };

export type TemplateCommand<Node extends CommandNode = CommandNode> = {
	/** Written after `{{@`, and in `{{/name}}` for a block. */
	name: string;
	/** The node kind it is stored as. */
	nodeType: Node["type"];
	/** Whether it holds content and ends with `{{/name}}`. */
	block: boolean;
	/** The keywords of sections that may follow the opening one inside the block, such as `else`. */
	branches: readonly string[];
	/**
	 * The markup Code mode's `{{@` menu inserts for it (ADR 0016), `$0` marking where the caret goes,
	 * so every command in the registry is offered there by itself.
	 */
	snippet: string;
	fromMarkup(sections: readonly MarkupSection[], tools: FromMarkupTools): Node | undefined;
	toMarkup(node: Node, tools: ToMarkupTools): PrintedSection[];
	check(input: Record<string, unknown>, at: string, tools: CheckTools): Node | undefined;
	/** The node's lists of children, for walking a tree. */
	children(node: Node): readonly (readonly TreeNode[])[];
	render(node: Node, tools: RenderTools): string;
	/** Why the command can't sit inside `ancestors` (element tags, outermost first), or undefined. */
	placementProblem?(ancestors: readonly string[]): string | undefined;
	/**
	 * What the opening section's content may read, from its argument (a Loop's items), reporting a
	 * problem with the argument; what is around it when absent. Markup reads the content with it.
	 */
	bodyScope?(
		section: Omit<MarkupSection, "children">,
		around: ValueScope,
		problem: (offset: number, message: string) => void,
	): ValueScope;
};

/** `{{@if test}} … {{@else if test}} … {{@else}} … {{/if}}`: a Condition. */
const ifCommand: TemplateCommand<ConditionNode> = {
	name: "if",
	nodeType: "condition",
	block: true,
	branches: ["else if", "else"],
	snippet: "{{@if $0}}\n{{/if}}",

	fromMarkup(sections, tools) {
		const branches: ConditionBranch[] = [];
		let otherwise: TreeNode[] | null = null;
		let complete = true;
		for (const section of sections) {
			if (section.keyword === "else") {
				if (section.argument.trim()) {
					tools.problem(section.argumentOffset, "{{@else}} takes no test: write {{@else if …}} to test something.");
				}
				if (otherwise !== null) tools.problem(section.offset, "{{@if}} has one {{@else}} at most.");
				otherwise = section.children;
				continue;
			}
			if (otherwise !== null) tools.problem(section.offset, "{{@else if}} goes before {{@else}}.");
			if (!section.argument.trim()) {
				tools.problem(section.offset, `{{@${section.keyword}}} needs a test, such as {{@${section.keyword} summary}}.`);
				complete = false;
				continue;
			}
			const test = tools.expression(section.argument, section.argumentOffset);
			if (test) branches.push({ test, children: section.children });
			else complete = false;
		}
		return complete ? { type: "condition", branches, otherwise } : undefined;
	},

	toMarkup(node) {
		return [
			...node.branches.map((branch, index) => ({
				keyword: index === 0 ? "if" : "else if",
				argument: writeExpression(branch.test),
				children: branch.children,
			})),
			...(node.otherwise === null ? [] : [{ keyword: "else", argument: "", children: node.otherwise }]),
		];
	},

	check(input, at, tools) {
		const { branches, otherwise } = input;
		if (!Array.isArray(branches) || branches.length === 0) {
			tools.problem(`${at}.branches`, "A Condition has at least one test, with what it shows.");
			return undefined;
		}
		const checked: ConditionBranch[] = [];
		branches.forEach((branch: unknown, index) => {
			const here = `${at}.branches[${index}]`;
			const raw = (branch ?? {}) as Record<string, unknown>;
			const test = tools.expression(raw.test, `${here}.test`);
			const children = tools.nodes(raw.children ?? [], `${here}.children`);
			if (test) checked.push({ test, children });
		});
		const elseNodes = otherwise === null || otherwise === undefined ? null : tools.nodes(otherwise, `${at}.otherwise`);
		return { type: "condition", branches: checked, otherwise: elseNodes };
	},

	children(node) {
		return [...node.branches.map((branch) => branch.children), ...(node.otherwise === null ? [] : [node.otherwise])];
	},

	render(node, tools) {
		const chosen = node.branches.find((branch) => passes(branch.test, tools.read, tools.time));
		if (chosen) return tools.nodes(chosen.children);
		return node.otherwise === null ? "" : tools.nodes(node.otherwise);
	},
};

/**
 * `{{@outlet}}`: where the Site template shows each page's content (an Entry through its Entry
 * template, a Page's layout, the 404 page). It holds nothing and takes nothing; the Site template has
 * exactly one, inside its <main> (`page-structure.ts`).
 */
const outletCommand: TemplateCommand<OutletNode> = {
	name: "outlet",
	nodeType: "outlet",
	block: false,
	branches: [],
	snippet: "{{@outlet}}",

	fromMarkup(sections, tools) {
		const [section] = sections;
		if (section?.argument.trim()) {
			const leading = section.argument.length - section.argument.trimStart().length;
			tools.problem(section.argumentOffset + leading, "{{@outlet}} takes nothing: write it alone.");
			return undefined;
		}
		return { type: "outlet" };
	},

	toMarkup() {
		return [{ keyword: "outlet", argument: "", children: [] }];
	},

	check() {
		return { type: "outlet" };
	},

	children() {
		return [];
	},

	render(_node, tools) {
		return tools.outlet();
	},
};

/** Elements a button can't go inside: a browser would break the page's controls apart. */
const INTERACTIVE = new Set(["a", "button", "label", "select", "textarea", "summary", "details", "audio", "video"]);

/**
 * `{{@themeToggle}}`: a button that switches the page between the light and dark values of the
 * Design system, remembering the visitor's choice. It renders only when the Site's published Design
 * system has dark mode, starts hidden, and shows once its script (a file, never inline) runs.
 */
const themeToggleCommand: TemplateCommand<ThemeToggleNode> = {
	name: "themeToggle",
	nodeType: "themeToggle",
	block: false,
	branches: [],
	snippet: "{{@themeToggle}}",

	fromMarkup(sections, tools) {
		const [section] = sections;
		if (section?.argument.trim()) {
			const leading = section.argument.length - section.argument.trimStart().length;
			tools.problem(section.argumentOffset + leading, "{{@themeToggle}} takes nothing: write it alone.");
			return undefined;
		}
		return { type: "themeToggle" };
	},

	toMarkup() {
		return [{ keyword: "themeToggle", argument: "", children: [] }];
	},

	check() {
		return { type: "themeToggle" };
	},

	children() {
		return [];
	},

	render(_node, tools) {
		return tools.themeToggle();
	},

	placementProblem(ancestors) {
		const inside = ancestors.findLast((tag) => INTERACTIVE.has(tag));
		if (inside) return `{{@themeToggle}} is a button: it can't go inside <${inside}>.`;
		if (ancestors.at(-1) === "ul" || ancestors.at(-1) === "ol")
			return "{{@themeToggle}} goes inside an <li>, not directly in a list.";
		return undefined;
	},
};

/** Elements whose content is text and inline elements only, where a <nav> can't go. */
const PHRASING_ONLY = new Set([
	"p",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"pre",
	"span",
	"abbr",
	"b",
	"bdi",
	"bdo",
	"cite",
	"code",
	"data",
	"dfn",
	"em",
	"i",
	"kbd",
	"mark",
	"q",
	"ruby",
	"rt",
	"rp",
	"s",
	"samp",
	"small",
	"strong",
	"sub",
	"sup",
	"time",
	"u",
	"var",
	"caption",
	"dt",
	"figcaption",
]);

/**
 * `{{@languageSwitcher}}`: the Language switcher, a list of links to the page in each of the Site's
 * languages (to a language's home page where the page's Entry is hidden), the current one marked,
 * each named in its own language. It renders as a <nav>, so it goes where one can, and renders
 * nothing on a Site with one language.
 */
const languageSwitcherCommand: TemplateCommand<LanguageSwitcherNode> = {
	name: "languageSwitcher",
	nodeType: "languageSwitcher",
	block: false,
	branches: [],
	snippet: "{{@languageSwitcher}}",

	fromMarkup(sections, tools) {
		const [section] = sections;
		if (section?.argument.trim()) {
			const leading = section.argument.length - section.argument.trimStart().length;
			tools.problem(section.argumentOffset + leading, "{{@languageSwitcher}} takes nothing: write it alone.");
			return undefined;
		}
		return { type: "languageSwitcher" };
	},

	toMarkup() {
		return [{ keyword: "languageSwitcher", argument: "", children: [] }];
	},

	check() {
		return { type: "languageSwitcher" };
	},

	children() {
		return [];
	},

	render(_node, tools) {
		return tools.languageSwitcher();
	},

	placementProblem(ancestors) {
		const inside = ancestors.findLast((tag) => INTERACTIVE.has(tag) || PHRASING_ONLY.has(tag));
		if (inside) return `{{@languageSwitcher}} is a list of links in a <nav>: it can't go inside <${inside}>.`;
		if (ancestors.at(-1) === "ul" || ancestors.at(-1) === "ol")
			return "{{@languageSwitcher}} goes inside an <li>, not directly in a list.";
		return undefined;
	},
};

/** Elements a <form> can't go inside: another form's controls, or text and inline elements only. */
const NO_FORM_INSIDE = new Set([...INTERACTIVE, ...PHRASING_ONLY, "form"]);

/**
 * Why a Form can't be placed in a Loop's items: a page shows a placed Form once, never once per item
 * (the copies would be the same Form, with nothing telling their Submissions apart). `{{@empty}}`
 * renders once, so it may hold one.
 */
const FORM_IN_LOOP =
	"{{@form}} can't go inside a Loop's items: a page shows a placed Form once, not once per item. Place it outside the Loop, or in its {{@empty}}.";

/**
 * `{{@form <key>}}`: one of the Site's Forms, placed by its key and stored by its id. It renders the
 * Form's published version as a `<form>` posting to the Site itself, which works without JavaScript;
 * nothing where Forms don't run on the Site. A form is a block of its own, so it goes where a <div>
 * can, never inside a link, a control, a paragraph or another form.
 */
const formCommand: TemplateCommand<FormNode> = {
	name: "form",
	nodeType: "form",
	block: false,
	branches: [],
	snippet: "{{@form $0}}",

	fromMarkup(sections, tools) {
		const [section] = sections;
		const key = section?.argument.trim() ?? "";
		if (!section || key === "") {
			tools.problem(section?.offset ?? 0, "{{@form}} names the Form to place by its key, such as {{@form contact}}.");
			return undefined;
		}
		if (tools.scope.aliases.length > 0) {
			tools.problem(section.offset, FORM_IN_LOOP);
			return undefined;
		}
		const leading = section.argument.length - section.argument.trimStart().length;
		const formId = tools.form(key, section.argumentOffset + leading);
		return formId === undefined ? undefined : { type: "form", form: formId };
	},

	toMarkup(node, tools) {
		return [{ keyword: "form", argument: tools.formKey(node.form) ?? node.form, children: [] }];
	},

	check(input, at, tools) {
		if (tools.scope.aliases.length > 0) {
			tools.problem(at, FORM_IN_LOOP);
			return undefined;
		}
		const formId = tools.form(input.form, `${at}.form`);
		return formId === undefined ? undefined : { type: "form", form: formId };
	},

	children() {
		return [];
	},

	render(node, tools) {
		return tools.form(node.form);
	},

	placementProblem(ancestors) {
		const inside = ancestors.findLast((tag) => NO_FORM_INSIDE.has(tag));
		if (inside) return `{{@form}} is a form of its own: it can't go inside <${inside}>.`;
		if (ancestors.at(-1) === "ul" || ancestors.at(-1) === "ol")
			return "{{@form}} goes inside an <li>, not directly in a list.";
		return undefined;
	},
};

/**
 * `{{@search}}`: the Search element (ADR 0021), a search box sending visitors to the Site's search
 * results page in the page's language with a plain GET (`?q=…`), so it works without JavaScript. It
 * renders nothing while the Site has no search results page there. A <form> of its own, it goes where
 * a <div> can: never inside a link, a control, a paragraph, inline text or another form.
 */
const searchCommand: TemplateCommand<SearchNode> = {
	name: "search",
	nodeType: "search",
	block: false,
	branches: [],
	snippet: "{{@search}}",

	fromMarkup(sections, tools) {
		const [section] = sections;
		if (section?.argument.trim()) {
			const leading = section.argument.length - section.argument.trimStart().length;
			tools.problem(section.argumentOffset + leading, "{{@search}} takes nothing: write it alone.");
			return undefined;
		}
		return { type: "search" };
	},

	toMarkup() {
		return [{ keyword: "search", argument: "", children: [] }];
	},

	check() {
		return { type: "search" };
	},

	children() {
		return [];
	},

	render(_node, tools) {
		return tools.search();
	},

	placementProblem(ancestors) {
		const inside = ancestors.findLast((tag) => NO_FORM_INSIDE.has(tag));
		if (inside) return `{{@search}} is a form of its own: it can't go inside <${inside}>.`;
		if (ancestors.at(-1) === "ul" || ancestors.at(-1) === "ol")
			return "{{@search}} goes inside an <li>, not directly in a list.";
		return undefined;
	},
};

/**
 * `{{@loop source as post}} … {{@empty}} … {{/loop}}`: a Loop (`loops.ts`). Its content renders once
 * per item, reading the item as `post.x` and its position as `loop.x`; `{{@empty}}`'s content renders
 * when there are none and reads only what is around the Loop.
 */
const loopCommand: TemplateCommand<LoopNode> = {
	name: "loop",
	nodeType: "loop",
	block: true,
	branches: ["empty"],
	snippet: "{{@loop $0 as item}}\n{{@empty}}\n{{/loop}}",

	bodyScope(section, around, problem) {
		const read = readLoopArgument(section.argument);
		if ("problem" in read) {
			problem(section.argumentOffset + read.at, read.problem);
			return { ...around, isKnownValue: undefined, aliases: [...around.aliases, DEFAULT_ITEM_NAME] };
		}
		const body = loopBodyScope(read.source, read.alias, around);
		if (body.problem) {
			const at =
				body.problem.on === "loop"
					? section.offset
					: section.argumentOffset + (body.problem.on === "source" ? read.sourceAt : read.aliasAt);
			problem(at, body.problem.message);
		}
		return body.scope;
	},

	fromMarkup(sections, tools) {
		const [opening, ...rest] = sections;
		const read = readLoopArgument(opening?.argument ?? "");
		let empty: TreeNode[] | null = null;
		for (const section of rest) {
			if (section.argument.trim()) {
				tools.problem(section.argumentOffset, "{{@empty}} takes nothing: write it alone.");
			}
			if (empty !== null) tools.problem(section.offset, "A Loop has {{@empty}} once at most.");
			empty = section.children;
		}
		if (!opening || "problem" in read) return undefined;
		return { type: "loop", source: read.source, alias: read.alias, children: opening.children, empty };
	},

	toMarkup(node) {
		return [
			{
				keyword: "loop",
				argument: node.alias === DEFAULT_ITEM_NAME ? node.source : `${node.source} as ${node.alias}`,
				children: node.children,
			},
			...(node.empty === null ? [] : [{ keyword: "empty", argument: "", children: node.empty }]),
		];
	},

	check(input, at, tools) {
		const { source, alias = DEFAULT_ITEM_NAME } = input;
		if (typeof source !== "string" || typeof alias !== "string") {
			tools.problem(at, "A Loop names its source and what its items are called.");
			return undefined;
		}
		const read = readLoopArgument(`${source} as ${alias}`);
		if ("problem" in read || read.source !== source || read.alias !== alias) {
			tools.problem(`${at}.source`, `${source} isn't a Loop's name or a value's name.`);
			return undefined;
		}
		const body = loopBodyScope(source, alias, tools.scope);
		if (body.problem) {
			tools.problem(body.problem.on === "loop" ? at : `${at}.${body.problem.on}`, body.problem.message);
		}
		const children = tools.nodes(input.children ?? [], `${at}.children`, body.scope);
		const empty = input.empty === null || input.empty === undefined ? null : tools.nodes(input.empty, `${at}.empty`);
		return { type: "loop", source, alias, children, empty };
	},

	children(node) {
		return node.empty === null ? [node.children] : [node.children, node.empty];
	},

	render(node, tools) {
		return tools.loop(node);
	},
};

/**
 * `{{@pagination latest-posts}}`: links to the pages of a Loop of the Site that paginates, on
 * Archive templates and Pages; nothing elsewhere, or with one page. It renders a <nav>, so it goes
 * where one can.
 */
const paginationCommand: TemplateCommand<PaginationNode> = {
	name: "pagination",
	nodeType: "pagination",
	block: false,
	branches: [],
	snippet: "{{@pagination $0}}",

	fromMarkup(sections, tools) {
		const [section] = sections;
		if (!section) return undefined;
		const name = section.argument.trim();
		const refused = paginationProblem(name, tools.scope);
		if (refused) {
			const leading = section.argument.length - section.argument.trimStart().length;
			tools.problem(name ? section.argumentOffset + leading : section.offset, refused);
			return undefined;
		}
		return { type: "pagination", loop: name };
	},

	toMarkup(node) {
		return [{ keyword: "pagination", argument: node.loop, children: [] }];
	},

	check(input, at, tools) {
		const name = typeof input.loop === "string" ? input.loop : "";
		const refused = paginationProblem(name, tools.scope);
		if (refused) {
			tools.problem(`${at}.loop`, refused);
			return undefined;
		}
		return { type: "pagination", loop: name };
	},

	children() {
		return [];
	},

	render(node, tools) {
		return tools.pagination(node.loop);
	},

	placementProblem(ancestors) {
		const inside = ancestors.findLast((tag) => INTERACTIVE.has(tag) || PHRASING_ONLY.has(tag));
		if (inside) return `{{@pagination}} is a list of links in a <nav>: it can't go inside <${inside}>.`;
		if (ancestors.at(-1) === "ul" || ancestors.at(-1) === "ol")
			return "{{@pagination}} goes inside an <li>, not directly in a list.";
		return undefined;
	},
};

/** Every Template command there is. */
export const TEMPLATE_COMMANDS: readonly TemplateCommand[] = [
	ifCommand,
	loopCommand,
	outletCommand,
	paginationCommand,
	themeToggleCommand,
	languageSwitcherCommand,
	formCommand,
	searchCommand,
];

/** Commands the spec names that later work brings; markup naming them is refused until then. */
export const RESERVED_COMMANDS: ReadonlySet<string> = new Set(["filter", "popup"]);

/** The command written `{{@name}}`, if there is one. */
export function commandNamed(name: string): TemplateCommand | undefined {
	return TEMPLATE_COMMANDS.find((command) => command.name === name);
}

/** The command a stored node kind belongs to, if there is one. */
export function commandForNode(type: unknown): TemplateCommand | undefined {
	return TEMPLATE_COMMANDS.find((command) => command.nodeType === type);
}
