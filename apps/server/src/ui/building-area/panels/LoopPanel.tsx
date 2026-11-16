import { type ElementTree, readExpression, type TreeNode, writeExpression } from "@webcraft/renderer/builder";
import { ChevronDownIcon, ExternalLinkIcon, RepeatIcon } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";

import { type NodePath, nodeAt, replaceAt } from "../../editor/tree.ts";
import { fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";
import type { Structure, StructureSource } from "../editing/selection.ts";
import { managementApi } from "../management.ts";
import { CommitInput, FieldCard, Note, Switch, type ValueChoice } from "./inputs.tsx";

/**
 * The Loop panel and the Condition panel for Staff (SPEC 5, `builder/07`; BA-09): the Inspector's
 * title says "Loop" or "Condition" when one is selected, or (a Loop) when an element it repeats is.
 *
 * Loop: which of the Site's Loops it repeats (and whether that lists Entries or its own items), what
 * each item is called in the markup, what the Loop lists in words (it is set in the Loops place, not
 * in the markup), and "Open in Loops". Condition: the test of each branch and whether it has an
 * Otherwise. Each change is one Undo step through the Template's or Component's shared Draft.
 */

type LoopNode = Extract<TreeNode, { type: "loop" }>;
type ConditionNode = Extract<TreeNode, { type: "condition" }>;

/** What the panel knows of a Loop of the Site: itself, the names of the Post Types it lists, and its first item. */
type LoopFacts = {
	loop: {
		id: string;
		name: string;
		source: "query" | "items";
		postTypes: string[];
		sort: { by: string; direction: string }[];
		limit: number;
	} | null;
	postTypeNames: ReadonlyMap<string, string>;
	/** The first item its Draft lists now, for the values `{{` offers; null while there is none. */
	sample: Record<string, unknown> | null;
	loaded: boolean;
};

const NO_FACTS: LoopFacts = { loop: null, postTypeNames: new Map(), sample: null, loaded: false };

/** Facts read once per Loop name in this tab (a Loop's settings change in the Loops place, which reads its own). */
const read = new Map<string, Promise<LoopFacts>>();

async function readFacts(token: string, siteId: string, name: string): Promise<LoopFacts> {
	const api = managementApi(token);
	try {
		const [{ loops }, { postTypes }] = await Promise.all([api.loops.list({ siteId }), api.postTypes.list({ siteId })]);
		const found = loops.find((loop) => loop.name === name);
		const postTypeNames = new Map(postTypes.map((type) => [type.key, type.name]));
		if (!found) return { ...NO_FACTS, postTypeNames, loaded: true };
		const result = await api.loops.result({ siteId, loopId: found.id }).catch(() => null);
		const query = found.draft.query;
		return {
			loop: {
				id: found.id,
				name: found.name,
				source: found.draft.source,
				postTypes: query.postTypes,
				sort: query.sort,
				limit: query.limit,
			},
			postTypeNames,
			sample: ((result?.items[0] as { values?: Record<string, unknown> } | undefined)?.values ?? null) as Record<
				string,
				unknown
			> | null,
			loaded: true,
		};
	} catch {
		return { ...NO_FACTS, loaded: true };
	}
}

/** What the panel knows of a Loop of the Site, by its name. */
export function useLoopFacts(token: string, siteId: string, name: string | null): LoopFacts {
	const [facts, setFacts] = useState<LoopFacts>(NO_FACTS);
	useEffect(() => {
		if (!name) {
			setFacts(NO_FACTS);
			return;
		}
		let current = true;
		const key = `${siteId}:${name}`;
		let pending = read.get(key);
		if (!pending) {
			pending = readFacts(token, siteId, name);
			read.set(key, pending);
		}
		void pending.then((found) => {
			if (current) setFacts(found);
		});
		return () => {
			current = false;
		};
	}, [token, siteId, name]);
	return facts;
}

/** The Loop node around a node of a tree (the nearest), and where it is; null when it is in none. */
export function loopAround(tree: ElementTree, path: NodePath): { node: LoopNode; path: NodePath } | null {
	for (let length = path.length - 1; length > 0; length--) {
		const at = path.slice(0, length);
		const node = nodeAt(tree, at);
		if (node?.type === "loop") return { node, path: at };
	}
	return null;
}

/**
 * The values a Loop's item offers in `{{` (`post.title`, `post.author.name`), from its first item: a
 * Group, a choice or an Entry a Relationship points at opens into its parts; a list is left out (it is
 * read with a Loop of its own).
 */
export function itemValues(facts: LoopFacts, alias: string): ValueChoice[] {
	if (!facts.sample) return [{ path: `${alias}.title` }];
	const { id: _, ...values } = facts.sample;
	const found: ValueChoice[] = [];
	const visit = (value: unknown, path: string) => {
		if (Array.isArray(value)) return;
		if (value !== null && typeof value === "object") {
			for (const [key, inner] of Object.entries(value)) visit(inner, `${path}.${key}`);
			return;
		}
		found.push({ path });
	};
	for (const [key, value] of Object.entries(values)) visit(value, `${alias}.${key}`);
	return found;
}

/** What a Loop lists, in words: "Entries of Blog posts, newest first, 3 at most." */
function describe(words: Words, facts: LoopFacts): string {
	const said = words.placements.loop;
	const loop = facts.loop;
	if (!loop) return "";
	if (loop.source === "items") return `${said.ownItems} ${said.setByLoop}`;
	const names = loop.postTypes.map((key) => facts.postTypeNames.get(key) ?? key).join(", ");
	const [sort] = loop.sort;
	const dated = !sort || /At$/.test(sort.by);
	const order = !sort
		? said.order.newest
		: dated
			? sort.direction === "desc"
				? said.order.newest
				: said.order.oldest
			: fill(sort.direction === "desc" ? said.order.za : said.order.az, { field: sort.by });
	return `${fill(said.entriesOf, { postTypes: names })}, ${order}, ${fill(said.atMost, { count: String(loop.limit) })}. ${said.setByLoop}`;
}

export function LoopPanel({
	structure,
	words,
	token,
	siteId,
	source,
	path,
	node,
	onOpenLoop,
}: {
	structure: Structure;
	words: Words;
	token: string;
	siteId: string;
	source: StructureSource;
	path: NodePath;
	node: LoopNode;
	/** Opens the Loops place on a Loop (its id). */
	onOpenLoop(loopId: string): void;
}) {
	const said = words.placements.loop;
	const ids = { loop: useId(), alias: useId() };
	const facts = useLoopFacts(token, siteId, node.source);
	const [problem, setProblem] = useState<string | null>(null);
	const readOnly = !source.editable;
	const loops = useMemo(() => {
		const names = source.catalogue.loops.map((loop) => loop.name);
		return names.includes(node.source) ? names : [node.source, ...names];
	}, [source.catalogue.loops, node.source]);

	const update = (next: LoopNode, label: string) => {
		const refused = structure.change(source.ref, replaceAt(source.tree, path, next), label);
		setProblem(refused);
		return refused === null;
	};

	return (
		<div className="flex flex-col gap-2" data-wc-loop-panel="">
			<div className="flex items-center gap-2">
				<div className="relative flex min-w-0 grow items-center">
					<RepeatIcon aria-hidden="true" className="pointer-events-none absolute start-2.5 size-3.5 text-[#fbbf24]" />
					<select
						id={ids.loop}
						aria-label={said.which}
						value={node.source}
						disabled={readOnly}
						onChange={(event) =>
							update({ ...node, source: event.target.value }, fill(said.step, { name: event.target.value }))
						}
						className={`text-chrome-strong h-8 w-full min-w-0 appearance-none truncate rounded-md border border-[#2a2a30] bg-[#0c0c0e] ps-8 pe-7 text-[12px] font-medium ${CHROME_EASE} ${FOCUS_RING}`}
					>
						{loops.map((name) => (
							<option key={name} value={name}>
								{name}
							</option>
						))}
					</select>
					<ChevronDownIcon
						aria-hidden="true"
						className="text-chrome-muted pointer-events-none absolute end-2 size-3.5"
					/>
				</div>
				{facts.loop ? (
					<span className="shrink-0 rounded-[4px] bg-[#fbbf24]/15 px-1.5 font-mono text-[11px] leading-[18px] font-semibold text-[#fbbf24]">
						{facts.loop.source === "items" ? said.items : said.entries}
					</span>
				) : null}
			</div>
			<FieldCard label={said.eachItem} htmlFor={ids.alias}>
				<CommitInput
					id={ids.alias}
					value={node.alias}
					mono
					disabled={readOnly}
					onCommit={(alias) =>
						update({ ...node, alias: alias.trim() || "item" }, fill(said.aliasStep, { name: node.source }))
					}
				/>
			</FieldCard>
			{facts.loaded && !facts.loop ? (
				<Note>{fill(said.notFound, { name: node.source })}</Note>
			) : facts.loop ? (
				<p className="text-chrome-muted px-0.5 text-[12px] leading-[16px]" data-wc-loop-summary="">
					{describe(words, facts)}
				</p>
			) : null}
			{problem ? (
				<p role="alert" className="text-chrome-warn px-0.5 text-[12px]">
					{problem}
				</p>
			) : null}
			<button
				type="button"
				disabled={!facts.loop}
				onClick={() => facts.loop && onOpenLoop(facts.loop.id)}
				className={`text-chrome-strong hover:bg-chrome-hover flex h-8 w-full items-center justify-center gap-2 rounded-md border border-[#2a2a30] text-[12px] font-medium disabled:opacity-50 ${CHROME_EASE} ${FOCUS_RING}`}
				data-wc-open-loop=""
			>
				<ExternalLinkIcon aria-hidden="true" className="size-3.5" />
				{said.open}
			</button>
		</div>
	);
}

export function ConditionPanel({
	structure,
	words,
	source,
	path,
	node,
	values,
}: {
	structure: Structure;
	words: Words;
	source: StructureSource;
	path: NodePath;
	node: ConditionNode;
	/** What `{{` offers in a test (paths a test may read). */
	values: readonly ValueChoice[];
}) {
	const said = words.placements.condition;
	const id = useId();
	const [problem, setProblem] = useState<string | null>(null);
	const readOnly = !source.editable;
	const name = conditionName(words, node);

	const update = (next: ConditionNode, label: string) => {
		const refused = structure.change(source.ref, replaceAt(source.tree, path, next), label);
		setProblem(refused);
		return refused === null;
	};

	return (
		<div className="flex flex-col gap-2" data-wc-condition-panel="">
			{node.branches.map((branch, index) => (
				<FieldCard
					// biome-ignore lint/suspicious/noArrayIndexKey: a branch is where it is.
					key={index}
					label={index === 0 ? said.test : said.elseIf}
					htmlFor={`${id}-${index}`}
				>
					<CommitInput
						id={`${id}-${index}`}
						value={writeExpression(branch.test)}
						mono
						disabled={readOnly}
						values={values}
						valuesLabel={words.placements.values}
						onCommit={(text) => {
							const read = readExpression(text.replace(/\{\{\s*|\s*\}\}/g, ""));
							if ("problem" in read) {
								setProblem(fill(said.bad, { problem: read.problem.message }));
								return false;
							}
							return update(
								{
									...node,
									branches: node.branches.map((each, at) => (at === index ? { ...each, test: read.expression } : each)),
								},
								fill(said.step, { name }),
							);
						}}
					/>
				</FieldCard>
			))}
			<FieldCard label={said.otherwise}>
				<Switch
					checked={node.otherwise !== null}
					label={said.otherwise}
					on={words.placements.props.on}
					off={words.placements.props.off}
					disabled={readOnly}
					onChange={(on) => update({ ...node, otherwise: on ? [] : null }, on ? said.otherwiseOn : said.otherwiseOff)}
				/>
			</FieldCard>
			<p className="text-chrome-muted px-0.5 text-[12px] leading-[16px]">{said.otherwiseHint}</p>
			{problem ? (
				<p role="alert" className="text-chrome-warn px-0.5 text-[12px]">
					{problem}
				</p>
			) : null}
		</div>
	);
}

/** What a Condition is called in the panel's title and its steps: its first test. */
export function conditionName(words: Words, node: ConditionNode): string {
	const [first] = node.branches;
	return fill(words.placements.condition.name, { test: first ? writeExpression(first.test) : "" });
}
