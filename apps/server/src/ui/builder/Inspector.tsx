import {
	type Attribute,
	attributeProblem,
	type ElementTree,
	hasText,
	labelProblem,
	readExpression,
	readFormat,
	safeUrl,
	type TreeNode,
	URL_ATTRIBUTES,
	writeExpression,
	writeFormat,
} from "@webcraft/renderer/builder";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Field, FieldDescription, FieldError, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import { PlusIcon, TypeIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";

import { useT } from "../i18n.tsx";
import { Tabs } from "../Tabs.tsx";
import { type Catalogue, excerpt, layerName, readParts, type Selection, writeParts } from "./model.ts";
import { StylePanel } from "./StylePanel.tsx";
import { isFixedText, type NodePath, nodeAt, pathKey } from "./tree.ts";

/**
 * The selected layer's settings beside the canvas: for an element, its layer label, tag and
 * attributes and, in the Style tab, its Classes and one-off style; for text, its words and "Make it
 * a Prop / Field / Global"; for a value, what it reads; for a Placement, its Prop values; for a
 * Condition, its tests; for a Loop, what it lists. Each change applies when the field is left (or
 * Enter is pressed), so undo takes it back in one step.
 */
export function Inspector({
	siteId,
	tree,
	selection,
	catalogue,
	oneOffOf,
	fixedTextAction,
	onReplace,
	onClasses,
	onOneOff,
	onCatalogue,
	onMakeEditable,
}: {
	siteId: string;
	tree: ElementTree;
	selection: Selection | null;
	catalogue: Catalogue;
	/** An element's one-off style: unsaved declarations, or its generated Classes'. */
	oneOffOf(elementId: string, classIds: readonly string[]): string;
	/** What fixed text can become here: a Prop, a Field or a Global. */
	fixedTextAction: "prop" | "field" | "global";
	/** Replaces the node at a path; answers why not when the tree would refuse it. */
	onReplace(path: NodePath, node: TreeNode, announcement: string): string | undefined;
	onClasses(path: NodePath, classIds: string[], announcement: string): void;
	onOneOff(path: NodePath, elementId: string, declarations: string): void;
	onCatalogue(classes: Catalogue["classes"]): void;
	onMakeEditable(path: NodePath, trigger: HTMLElement): void;
}) {
	const t = useT();
	const node = selection?.kind === "node" ? nodeAt(tree, selection.path) : undefined;
	const path = selection?.kind === "node" ? selection.path : null;
	let body: ReactNode;
	if (!selection) {
		body = <p className="text-muted-foreground text-sm">{t("builder.inspector.nothing")}</p>;
	} else if (!node || !path) {
		body = <p className="text-muted-foreground text-sm">{t("builder.inspector.branch")}</p>;
	} else {
		const settings = (
			<Settings
				key={pathKey(path)}
				node={node}
				path={path}
				catalogue={catalogue}
				fixedTextAction={fixedTextAction}
				onReplace={onReplace}
				onMakeEditable={onMakeEditable}
			/>
		);
		body =
			node.type === "element" ? (
				<Tabs
					key={node.id}
					label={t("builder.inspector.tabs")}
					tabs={[
						{ id: "builder-settings", label: t("builder.inspector.settings"), panel: settings },
						{
							id: "builder-style",
							label: t("builder.inspector.style"),
							panel: (
								<StylePanel
									siteId={siteId}
									catalogue={catalogue}
									classIds={node.classes}
									oneOff={oneOffOf(node.id, node.classes)}
									onClasses={(classIds, announcement) => onClasses(path, classIds, announcement)}
									onOneOff={(declarations) => onOneOff(path, node.id, declarations)}
									onCatalogue={onCatalogue}
								/>
							),
						},
					]}
				/>
			) : (
				settings
			);
	}
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<h2 id="inspector-heading" className="border-b px-3 py-2 text-sm font-semibold">
				{node ? layerName(t, node, catalogue).name : t("builder.inspector.heading")}
			</h2>
			<div className="min-h-0 flex-1 overflow-auto p-3">{body}</div>
		</div>
	);
}

/** A text box that applies its value when it is left or Enter is pressed, showing why when refused. */
function CommitInput({
	label,
	value,
	onCommit,
	help,
	mono,
	multiline,
	list,
}: {
	label: string;
	/** The id of a datalist of suggestions. */
	list?: string;
	value: string;
	/** Applies the value; answers why not. */
	onCommit(value: string): string | undefined;
	help?: string;
	mono?: boolean;
	multiline?: boolean;
}) {
	const id = useId();
	const [text, setText] = useState(value);
	const [problem, setProblem] = useState<string | null>(null);
	useEffect(() => {
		setText(value);
		setProblem(null);
	}, [value]);
	const commit = () => {
		if (text === value) return;
		const refused = onCommit(text);
		setProblem(refused ?? null);
	};
	const shared = {
		id,
		value: text,
		spellCheck: !mono,
		className: mono ? "font-mono text-xs" : undefined,
		"aria-invalid": problem ? true : undefined,
		"aria-describedby":
			[help ? `${id}-help` : null, problem ? `${id}-problem` : null].filter(Boolean).join(" ") || undefined,
		onBlur: commit,
	};
	return (
		<Field data-invalid={problem ? true : undefined}>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			{multiline ? (
				<Textarea
					{...shared}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) commit();
					}}
				/>
			) : (
				<Input
					{...shared}
					list={list}
					autoComplete="off"
					onChange={(event) => setText(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							commit();
						}
					}}
				/>
			)}
			{help ? <FieldDescription id={`${id}-help`}>{help}</FieldDescription> : null}
			{problem ? <FieldError id={`${id}-problem`}>{problem}</FieldError> : null}
		</Field>
	);
}

function Settings({
	node,
	path,
	catalogue,
	fixedTextAction,
	onReplace,
	onMakeEditable,
}: {
	node: TreeNode;
	path: NodePath;
	catalogue: Catalogue;
	fixedTextAction: "prop" | "field" | "global";
	onReplace(path: NodePath, node: TreeNode, announcement: string): string | undefined;
	onMakeEditable(path: NodePath, trigger: HTMLElement): void;
}) {
	const t = useT();
	const id = useId();
	const changed = t("builder.inspector.changed");
	const replace = (next: TreeNode) => onReplace(path, next, changed);
	const makeButton = (at: NodePath) => (
		<Button
			type="button"
			variant="outline"
			className="justify-self-start"
			onClick={(event) => onMakeEditable(at, event.currentTarget)}
		>
			<TypeIcon aria-hidden="true" />
			{t(`builder.fixedText.make.${fixedTextAction}`)}
		</Button>
	);
	switch (node.type) {
		case "element": {
			const fixed = node.children.map((child, index) => ({ child, index })).filter(({ child }) => isFixedText(child));
			return (
				<div className="grid gap-4">
					{node.tag === "img" ? (
						<label className="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								checked={node.decorative === true}
								onChange={(event) => replace({ ...node, decorative: event.target.checked })}
							/>
							{t("checks.decorative")}
						</label>
					) : null}
					<CommitInput
						label={t("builder.inspector.label")}
						value={node.label ?? ""}
						help={t("builder.inspector.labelHelp")}
						onCommit={(label) => {
							const refused = labelProblem(label);
							if (refused) return refused;
							const { label: _, ...rest } = node;
							return onReplace(
								path,
								label.trim() ? { ...rest, label } : rest,
								label.trim() ? t("builder.layers.renamed", { name: label }) : t("builder.layers.unnamed"),
							);
						}}
					/>
					<CommitInput
						label={t("builder.inspector.tag")}
						value={node.tag}
						mono
						help={t("builder.inspector.tagHelp")}
						onCommit={(tag) => {
							const next = tag.trim().toLowerCase();
							const { decorative, ...rest } = node;
							return replace({ ...rest, tag: next, ...(next === "img" && decorative ? { decorative } : {}) });
						}}
					/>
					<AttributesEditor attributes={node.attributes} onChange={(attributes) => replace({ ...node, attributes })} />
					{fixed.length > 0 ? (
						<section aria-labelledby={`${id}-fixed`} className="grid gap-2">
							<h3 id={`${id}-fixed`} className="text-sm font-semibold">
								{t("builder.fixedText.heading")}
							</h3>
							<p className="text-muted-foreground text-xs">{t("builder.fixedText.help")}</p>
							{fixed.map(({ child, index }) => (
								<div key={index} className="grid gap-1 rounded-md border border-dashed border-amber-500 p-2">
									<p className="text-sm">“{excerpt(child.type === "text" ? child.text : "", 60)}”</p>
									{makeButton([...path, 0, index])}
								</div>
							))}
						</section>
					) : null}
				</div>
			);
		}
		case "text":
			return (
				<div className="grid gap-4">
					<CommitInput
						label={t("builder.inspector.text")}
						value={node.text}
						multiline
						help={node.translations ? t("builder.inspector.translations") : t("builder.inspector.textHelp")}
						onCommit={(text) => replace({ ...node, text })}
					/>
					{hasText(node) ? (
						<section aria-labelledby={`${id}-fixed`} className="grid gap-2">
							<h3 id={`${id}-fixed`} className="text-sm font-semibold">
								{t("builder.fixedText.heading")}
							</h3>
							<p className="text-muted-foreground text-xs">{t("builder.fixedText.help")}</p>
							{makeButton(path)}
						</section>
					) : null}
				</div>
			);
		case "value":
			return (
				<div className="grid gap-4">
					<datalist id={`${id}-values`}>
						{catalogue.values.map((value) => (
							<option key={value.path} value={value.path}>
								{value.label ?? value.path}
							</option>
						))}
					</datalist>
					<CommitInput
						label={t("builder.inspector.valuePath")}
						value={node.path}
						mono
						list={`${id}-values`}
						help={t("builder.inspector.valuePathHelp")}
						onCommit={(value) => replace({ ...node, path: value.trim() })}
					/>
					<CommitInput
						label={t("builder.inspector.format")}
						value={node.format ? writeFormat(node.format) : ""}
						mono
						help={t("builder.inspector.formatHelp")}
						onCommit={(text) => {
							if (!text.trim()) {
								const { format: _, ...rest } = node;
								return replace(rest);
							}
							const read = readFormat(text);
							return "problem" in read ? read.problem : replace({ ...node, format: read.format });
						}}
					/>
				</div>
			);
		case "comment":
			return (
				<CommitInput
					label={t("builder.inspector.comment")}
					value={node.text}
					multiline
					help={t("builder.inspector.commentHelp")}
					onCommit={(text) => replace({ ...node, text })}
				/>
			);
		case "component": {
			const component = catalogue.components.find((each) => each.id === node.component);
			return (
				<div className="grid gap-4">
					<p className="text-muted-foreground text-sm">{t("builder.inspector.placement")}</p>
					{(component?.props ?? []).map((prop) => {
						const given = node.props.find((each) => each.name === prop.key);
						return (
							<CommitInput
								key={prop.key}
								label={prop.required ? t("builder.insert.requiredProp", { label: prop.label }) : prop.label}
								value={given ? writeParts(given.value) : ""}
								help={t("builder.inspector.propHelp", { key: prop.key })}
								onCommit={(text) => {
									const read = readParts(text);
									if ("problem" in read) return read.problem;
									const rest = node.props.filter((each) => each.name !== prop.key);
									const props = text === "" && !prop.required ? rest : [...rest, { name: prop.key, value: read.parts }];
									return replace({ ...node, props });
								}}
							/>
						);
					})}
				</div>
			);
		}
		case "condition":
			return (
				<div className="grid gap-4">
					{node.branches.map((branch, index) => (
						<CommitInput
							// biome-ignore lint/suspicious/noArrayIndexKey: a branch is where it is.
							key={index}
							label={index === 0 ? t("builder.inspector.test") : t("builder.inspector.elseIfTest", { number: index })}
							value={writeExpression(branch.test)}
							mono
							help={index === 0 ? t("builder.insert.testHelp") : undefined}
							onCommit={(text) => {
								const read = readExpression(text);
								if ("problem" in read) return read.problem.message;
								return replace({
									...node,
									branches: node.branches.map((each, at) => (at === index ? { ...each, test: read.expression } : each)),
								});
							}}
						/>
					))}
					<Button
						type="button"
						variant="outline"
						className="justify-self-start"
						onClick={() => replace({ ...node, otherwise: node.otherwise ? null : [] })}
					>
						{node.otherwise ? t("builder.inspector.removeElse") : t("builder.inspector.addElse")}
					</Button>
				</div>
			);
		case "loop":
			return (
				<div className="grid gap-4">
					<datalist id={`${id}-loops`}>
						{catalogue.loops.map((loop) => (
							<option key={loop.name} value={loop.name} />
						))}
					</datalist>
					<CommitInput
						label={t("builder.inspector.loopSource")}
						value={node.source}
						mono
						list={`${id}-loops`}
						help={t("builder.insert.loopListHelp")}
						onCommit={(source) => replace({ ...node, source: source.trim() })}
					/>
					<CommitInput
						label={t("builder.insert.loopAlias")}
						value={node.alias}
						mono
						onCommit={(alias) => replace({ ...node, alias: alias.trim() || "item" })}
					/>
					<Button
						type="button"
						variant="outline"
						className="justify-self-start"
						onClick={() => replace({ ...node, empty: node.empty ? null : [] })}
					>
						{node.empty ? t("builder.inspector.removeEmpty") : t("builder.inspector.addEmpty")}
					</Button>
				</div>
			);
		case "form":
			return (
				<Field>
					<FieldLabel htmlFor={`${id}-form`}>{t("builder.insert.formChoice")}</FieldLabel>
					<NativeSelect
						id={`${id}-form`}
						value={node.form}
						onChange={(event) => replace({ ...node, form: event.target.value })}
					>
						{catalogue.forms.map((form) => (
							<NativeSelectOption key={form.id} value={form.id}>
								{`${form.name} (${form.key})`}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</Field>
			);
		case "pagination":
			return (
				<Field>
					<FieldLabel htmlFor={`${id}-loop`}>{t("builder.insert.loopChoice")}</FieldLabel>
					<NativeSelect
						id={`${id}-loop`}
						value={node.loop}
						onChange={(event) => replace({ ...node, loop: event.target.value })}
					>
						{[...new Set([node.loop, ...catalogue.loops.map((loop) => loop.name)])].map((name) => (
							<NativeSelectOption key={name} value={name}>
								{name}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</Field>
			);
		default:
			return <p className="text-muted-foreground text-sm">{t(`builder.commandHelp.${node.type}`)}</p>;
	}
}

/**
 * An element's attributes as rows of name and value. A value may hold values (`/blog/{{ slug }}`);
 * names the tree refuses (`on…`, `style`, `class`, `data-wc-…`) and addresses pages may not use are
 * refused here, in the same words.
 */
function AttributesEditor({
	attributes,
	onChange,
}: {
	attributes: readonly Attribute[];
	onChange(attributes: Attribute[]): string | undefined;
}) {
	const t = useT();
	const id = useId();
	const [rows, setRows] = useState(() =>
		attributes.map((attribute) => ({ name: attribute.name, value: writeParts(attribute.value) })),
	);
	const [problem, setProblem] = useState<string | null>(null);
	useEffect(() => {
		setRows(attributes.map((attribute) => ({ name: attribute.name, value: writeParts(attribute.value) })));
	}, [attributes]);

	const commit = (next: { name: string; value: string }[]) => {
		const read: Attribute[] = [];
		for (const row of next) {
			const name = row.name.trim().toLowerCase();
			if (!name) continue;
			const refused = attributeProblem(name);
			if (refused) return setProblem(refused);
			if (read.some((each) => each.name === name)) return setProblem(t("builder.inspector.attributeTwice", { name }));
			const parts = readParts(row.value);
			if ("problem" in parts) return setProblem(parts.problem);
			// The text the attribute will hold (character references read), for the URL check.
			const fixed = parts.parts.every((part) => part.type === "text")
				? parts.parts
						.map((part) => (part.type === "text" ? part.text : ""))
						.join("")
						.trim()
				: "";
			if (URL_ATTRIBUTES.has(name) && fixed && !/^media:/i.test(fixed) && safeUrl(fixed) !== fixed) {
				return setProblem(t("builder.inspector.unsafeUrl", { name }));
			}
			read.push({ name, value: parts.parts });
		}
		const refused = onChange(read);
		setProblem(refused ?? null);
	};

	return (
		<fieldset className="grid gap-2">
			<legend className="mb-1 text-sm font-medium">{t("builder.inspector.attributes")}</legend>
			{rows.length === 0 ? (
				<p className="text-muted-foreground text-sm">{t("builder.inspector.noAttributes")}</p>
			) : null}
			<ol className="grid gap-2">
				{rows.map((row, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: attributes are edited in place.
					<li key={index} className="grid grid-cols-[1fr_1.5fr_auto] gap-1">
						<Input
							aria-label={t("builder.inspector.attributeName", { number: index + 1 })}
							value={row.name}
							className="font-mono text-xs"
							spellCheck={false}
							autoComplete="off"
							onChange={(event) =>
								setRows((before) =>
									before.map((each, at) => (at === index ? { ...each, name: event.target.value } : each)),
								)
							}
							onBlur={() => commit(rows)}
						/>
						<Input
							aria-label={t("builder.inspector.attributeValue", { number: index + 1 })}
							value={row.value}
							className="font-mono text-xs"
							spellCheck={false}
							autoComplete="off"
							onChange={(event) =>
								setRows((before) =>
									before.map((each, at) => (at === index ? { ...each, value: event.target.value } : each)),
								)
							}
							onBlur={() => commit(rows)}
						/>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label={t("builder.inspector.removeAttribute", { name: row.name || String(index + 1) })}
							onClick={() => {
								const next = rows.filter((_, at) => at !== index);
								setRows(next);
								commit(next);
							}}
						>
							<XIcon aria-hidden="true" />
						</Button>
					</li>
				))}
			</ol>
			{problem ? <FieldError id={`${id}-problem`}>{problem}</FieldError> : null}
			<Button
				type="button"
				variant="outline"
				size="sm"
				className="justify-self-start"
				onClick={() => setRows((before) => [...before, { name: "", value: "" }])}
			>
				<PlusIcon aria-hidden="true" />
				{t("builder.inspector.addAttribute")}
			</Button>
		</fieldset>
	);
}
