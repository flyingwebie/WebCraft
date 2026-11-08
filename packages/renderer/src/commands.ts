/**
 * Template commands: the built-in instructions written with `@` in Template markup
 * (`{{@if summary}} … {{@else}} … {{/if}}`). Each is one entry in `TEMPLATE_COMMANDS`, which says
 * how it reads from markup, how it prints, how its stored node is checked and how it renders, so a
 * new command is a new entry here and a new node kind in `TreeNode`, never a change to the markup
 * parser or printer.
 *
 * Commands the spec names but later work brings (Loops and `{{@empty}}`, the content outlet,
 * pagination, Forms, Filters and Popups) are reserved: markup naming them is refused for now.
 */
import { type Expression, passes, writeExpression } from "./expressions.ts";
import type { ConditionBranch, ConditionNode, TreeNode } from "./tree.ts";
import type { TemplateValue } from "./values.ts";

/** The node kinds Template commands store. */
export type CommandNode = ConditionNode;

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
	problem(offset: number, message: string): void;
};

export type CheckTools = {
	problem(at: string, message: string): void;
	/** Checks a stored expression at `at`. */
	expression(input: unknown, at: string): Expression | undefined;
	/** Checks a stored list of nodes at `at`, as children of the command's parent. */
	nodes(input: unknown, at: string): TreeNode[];
};

export type RenderTools = {
	read(path: string): TemplateValue;
	/** Renders nodes in the command's place. */
	nodes(nodes: readonly TreeNode[]): string;
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
	fromMarkup(sections: readonly MarkupSection[], tools: FromMarkupTools): Node | undefined;
	toMarkup(node: Node): PrintedSection[];
	check(input: Record<string, unknown>, at: string, tools: CheckTools): Node | undefined;
	/** The node's lists of children, for walking a tree. */
	children(node: Node): readonly (readonly TreeNode[])[];
	render(node: Node, tools: RenderTools): string;
};

/** `{{@if test}} … {{@else if test}} … {{@else}} … {{/if}}`: a Condition. */
const ifCommand: TemplateCommand<ConditionNode> = {
	name: "if",
	nodeType: "condition",
	block: true,
	branches: ["else if", "else"],

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
		const chosen = node.branches.find((branch) => passes(branch.test, tools.read));
		if (chosen) return tools.nodes(chosen.children);
		return node.otherwise === null ? "" : tools.nodes(node.otherwise);
	},
};

/** Every Template command there is. */
export const TEMPLATE_COMMANDS: readonly TemplateCommand[] = [ifCommand];

/** Commands the spec names that later work brings; markup naming them is refused until then. */
export const RESERVED_COMMANDS: ReadonlySet<string> = new Set([
	"loop",
	"empty",
	"outlet",
	"pagination",
	"form",
	"filter",
	"popup",
]);

/** The command written `{{@name}}`, if there is one. */
export function commandNamed(name: string): TemplateCommand | undefined {
	return TEMPLATE_COMMANDS.find((command) => command.name === name);
}

/** The command a stored node kind belongs to, if there is one. */
export function commandForNode(type: unknown): TemplateCommand | undefined {
	return TEMPLATE_COMMANDS.find((command) => command.nodeType === type);
}
