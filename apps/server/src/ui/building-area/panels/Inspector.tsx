import { type ElementNode, parseAttributeText, printAttributeText, type TreeNode } from "@webcraft/renderer/builder";
import { ComponentIcon, PlusIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useState, useSyncExternalStore } from "react";

import { replaceAt } from "../../builder/tree.ts";
import { fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";
import type { Structure, StructureSelection, StructureSource } from "../editing/selection.ts";

/**
 * The Inspector panel for Staff (SPEC 5, `builder/02`; BA-08): what the selected element of a Template
 * or Component is. Element: its Tag, its Layer label, its Classes as chips with "+ Class" (a name the
 * Site doesn't have yet makes a Class), its Content as the Template has it, its `id` and its other
 * attributes ("Add attribute"), and, for an element of a Component, "Inside the {name} Component". Each
 * change is one Undo step, made through the Template's or Component's shared Draft; the page in the
 * frame is drawn again in place. A Module's Component is shown read only, with the reason.
 *
 * A Placement, a Loop and a Condition get their own panels with BA-09; until then the Inspector names them.
 */
export function Inspector({
	structure,
	words,
	onOpenComponent,
}: {
	structure: Structure;
	words: Words;
	/** Opens a Component as the document (its id). */
	onOpenComponent(componentId: string): void;
}) {
	const snapshot = useSyncExternalStore(structure.subscribe, structure.snapshot);
	const said = words.structure.inspector;
	const selection = snapshot.selection;
	if (!selection) return null;
	const source = snapshot.sources.get(selection.source);
	const placement =
		selection.kind === "placement" && !selection.key
			? snapshot.layout?.find((each) => `content/${each.id}` === selection.ref)
			: undefined;
	if (placement) {
		return <Note>{fill(said.placementOf, { name: placement.name })}</Note>;
	}
	if (!source || !selection.node || !selection.path) return <Note>{said.notOpen}</Note>;
	if (selection.node.type !== "element") {
		return <Note>{nodeTitle(selection.node, source)}</Note>;
	}
	const inside = selection.source.includes("/") && source.kind === "component" ? source : null;
	return (
		<ElementInspector
			key={selection.ref}
			structure={structure}
			words={words}
			selection={selection}
			node={selection.node}
			source={source}
			inside={inside}
			onOpenComponent={onOpenComponent}
		/>
	);
}

/** What a node that isn't an element is called, until its own panel comes (BA-09). */
function nodeTitle(node: TreeNode, source: StructureSource): string {
	if (node.type === "component")
		return source.catalogue.components.find((component) => component.id === node.component)?.name ?? node.component;
	if (node.type === "loop") return `{{@loop ${node.source}}}`;
	return `{{@${node.type}}}`;
}

function Note({ children }: { children: ReactNode }) {
	return <p className="text-chrome-muted px-1 py-1 text-[12px]">{children}</p>;
}

/** A raised box with a small label above its value (`builder/02`). */
function Field({
	label,
	htmlFor,
	aside,
	children,
}: {
	label: string;
	htmlFor?: string;
	aside?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="bg-chrome-raised flex min-w-0 flex-col gap-1 rounded-md px-2 pt-1.5 pb-2">
			<div className="flex items-baseline justify-between gap-2">
				{htmlFor ? (
					<label htmlFor={htmlFor} className="text-chrome-muted text-[11px]">
						{label}
					</label>
				) : (
					<span className="text-chrome-muted text-[11px]">{label}</span>
				)}
				{aside}
			</div>
			{children}
		</div>
	);
}

const INPUT =
	"w-full min-w-0 rounded-[4px] bg-transparent text-[12px] font-medium text-chrome-strong placeholder:text-chrome-faint disabled:text-chrome-muted outline-none focus-visible:ring-2 focus-visible:ring-chrome-focus";

/** A text field that commits on Enter and when left, and goes back to the stored value on Escape. */
function CommitInput({
	id,
	value,
	onCommit,
	disabled,
	placeholder,
	mono,
	label,
}: {
	id?: string;
	value: string;
	onCommit(value: string): void;
	disabled: boolean;
	placeholder?: string;
	mono?: boolean;
	label?: string;
}) {
	const [text, setText] = useState(value);
	useEffect(() => setText(value), [value]);
	const commit = () => {
		if (text !== value) onCommit(text);
	};
	return (
		<input
			id={id}
			aria-label={label}
			value={text}
			disabled={disabled}
			placeholder={placeholder}
			spellCheck={false}
			onChange={(event) => setText(event.target.value)}
			onBlur={commit}
			onKeyDown={(event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					commit();
				}
				if (event.key === "Escape" && text !== value) {
					event.preventDefault();
					event.stopPropagation();
					setText(value);
				}
			}}
			className={`${INPUT} ${mono ? "font-mono" : ""}`}
		/>
	);
}

/** What an element holds, as its Template's markup says it (read only here: the HTML pane and the page change it). */
function contentOf(node: ElementNode): string {
	return node.children
		.map((child) => {
			if (child.type === "text") return child.text;
			if (child.type === "value") return `{{ ${child.path} }}`;
			if (child.type === "element") return `<${child.tag}>`;
			if (child.type === "component") return "<…/>";
			if (child.type === "comment") return "";
			return `{{@${child.type}}}`;
		})
		.join("")
		.replace(/\s+/g, " ")
		.trim();
}

function ElementInspector({
	structure,
	words,
	selection,
	node,
	source,
	inside,
	onOpenComponent,
}: {
	structure: Structure;
	words: Words;
	selection: StructureSelection;
	node: ElementNode;
	source: StructureSource;
	inside: StructureSource | null;
	onOpenComponent(componentId: string): void;
}) {
	const said = words.structure;
	const ids = { tag: useId(), label: useId(), id: useId(), classInput: useId() };
	const readOnly = !source.editable;
	const reason = source.id
		? fill(said.readOnly, { name: source.name ?? said.thisSource })
		: source.kind === "template"
			? said.notMade
			: fill(said.readOnly, { name: source.name ?? said.thisSource });
	const name = node.label ?? node.tag;
	const [chosen, setChosen] = useState<string | null>(node.classes[0] ?? null);
	const [adding, setAdding] = useState(false);
	const [className, setClassName] = useState("");
	const [newAttribute, setNewAttribute] = useState<{ name: string; value: string } | null>(null);
	const [problem, setProblem] = useState<string | null>(null);

	/** Changes the element; says why not when refused. */
	const update = (next: ElementNode, label: string) => {
		if (!selection.path) return false;
		const refused = structure.change(selection.source, replaceAt(source.tree, selection.path, next), label);
		setProblem(refused);
		return refused === null;
	};

	const classNameOf = (id: string) =>
		source.catalogue.classes.find((each) => each.id === id)?.name ??
		source.catalogue.utilities.find((each) => each.id === id)?.name ??
		id;

	const addClass = async (typed: string) => {
		const wanted = typed.trim().replace(/^\./, "");
		if (!wanted) return;
		const known =
			source.catalogue.classes.find((each) => each.name === wanted) ??
			source.catalogue.utilities.find((each) => each.name === wanted);
		let id = known?.id;
		if (!id) {
			const made = await structure.createClass(wanted);
			if ("refused" in made) {
				setProblem(made.refused);
				return;
			}
			id = made.id;
		}
		if (node.classes.includes(id)) {
			setAdding(false);
			setClassName("");
			return;
		}
		if (update({ ...node, classes: [...node.classes, id] }, fill(said.steps.addClass, { className: wanted, name }))) {
			setAdding(false);
			setClassName("");
			setChosen(id);
		}
	};

	const attributeText = (attributeName: string) => {
		const found = node.attributes.find((attribute) => attribute.name === attributeName);
		return found ? printAttributeText(found.value) : "";
	};

	const setAttribute = (attributeName: string, text: string, label: string) => {
		const others = node.attributes.filter((attribute) => attribute.name !== attributeName);
		if (text === "") return update({ ...node, attributes: others }, label);
		const parsed = parseAttributeText(text);
		if ("problem" in parsed) {
			setProblem(parsed.problem);
			return false;
		}
		const at = node.attributes.findIndex((attribute) => attribute.name === attributeName);
		const attribute = { name: attributeName, value: parsed.parts };
		const attributes =
			at < 0
				? [...node.attributes, attribute]
				: node.attributes.map((each, index) => (index === at ? attribute : each));
		return update({ ...node, attributes }, label);
	};

	const others = node.attributes.filter((attribute) => attribute.name !== "id");
	const known = source.catalogue.classes.filter((each) => !each.generated && !node.classes.includes(each.id));

	return (
		<div className="flex min-h-0 grow flex-col gap-1.5 overflow-auto pb-2" data-wc-inspector="">
			{readOnly ? (
				<p className="text-chrome-warn px-1 text-[12px]" data-wc-read-only="">
					{reason}
				</p>
			) : null}
			<div className="grid grid-cols-2 gap-1.5">
				<Field label={said.inspector.tag} htmlFor={ids.tag}>
					<select
						id={ids.tag}
						value={node.tag}
						disabled={readOnly}
						onChange={(event) =>
							update({ ...node, tag: event.target.value }, fill(said.steps.tag, { name, tag: event.target.value }))
						}
						className={`${INPUT} bg-chrome-raised font-mono`}
					>
						{(source.catalogue.elements.includes(node.tag)
							? source.catalogue.elements
							: [node.tag, ...source.catalogue.elements]
						).map((tag) => (
							<option key={tag} value={tag}>
								{tag}
							</option>
						))}
					</select>
				</Field>
				<Field label={said.inspector.label} htmlFor={ids.label}>
					<CommitInput
						id={ids.label}
						value={node.label ?? ""}
						disabled={readOnly}
						placeholder={said.inspector.labelPlaceholder}
						onCommit={(label) => {
							const { label: _old, ...rest } = node;
							update(label.trim() ? { ...rest, label: label.trim() } : rest, fill(said.steps.label, { name }));
						}}
					/>
				</Field>
			</div>
			<Field
				label={said.inspector.classes}
				aside={<span className="text-chrome-faint truncate text-[11px]">{said.inspector.classesHint}</span>}
			>
				<div className="flex flex-wrap items-center gap-1" data-wc-classes="">
					{node.classes.map((id) => {
						const named = classNameOf(id);
						const on = chosen === id;
						return (
							<span
								key={id}
								className={`inline-flex h-[22px] items-center rounded-[4px] border font-mono text-[11px] ${
									on ? "text-chrome-strong border-[#6366f1] bg-[#6366f1]/20" : "border-chrome-line text-chrome-text"
								}`}
								data-wc-class={named}
							>
								<button
									type="button"
									aria-pressed={on}
									aria-label={fill(said.inspector.chooseClass, { name: named })}
									onClick={() => setChosen(id)}
									className={`h-full rounded-s-[4px] ps-1.5 pe-1 ${FOCUS_RING}`}
								>
									.{named}
								</button>
								<button
									type="button"
									disabled={readOnly}
									aria-label={fill(said.inspector.removeClass, { name: named })}
									onClick={() =>
										update(
											{ ...node, classes: node.classes.filter((each) => each !== id) },
											fill(said.steps.removeClass, { className: named, name }),
										)
									}
									className={`text-chrome-muted hover:text-chrome-strong grid h-full place-items-center rounded-e-[4px] pe-1 disabled:hidden ${FOCUS_RING}`}
								>
									<XIcon aria-hidden="true" className="size-3" />
								</button>
							</span>
						);
					})}
					{adding ? (
						<>
							<input
								id={ids.classInput}
								// biome-ignore lint/a11y/noAutofocus: it opens from the button just pressed, where typing goes next.
								autoFocus
								aria-label={said.inspector.addClassLabel}
								list={`${ids.classInput}-list`}
								value={className}
								placeholder={said.inspector.classPlaceholder}
								spellCheck={false}
								onChange={(event) => setClassName(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										event.preventDefault();
										void addClass(className);
									}
									if (event.key === "Escape") {
										event.preventDefault();
										event.stopPropagation();
										setAdding(false);
										setClassName("");
									}
								}}
								onBlur={() => {
									if (!className.trim()) setAdding(false);
								}}
								className={`border-chrome-line text-chrome-strong h-[22px] w-36 rounded-[4px] border bg-transparent px-1.5 font-mono text-[11px] ${FOCUS_RING}`}
							/>
							<datalist id={`${ids.classInput}-list`}>
								{known.map((each) => (
									<option key={each.id} value={each.name} />
								))}
							</datalist>
						</>
					) : (
						<button
							type="button"
							disabled={readOnly}
							aria-label={said.inspector.addClassLabel}
							onClick={() => setAdding(true)}
							className={`border-chrome-line text-chrome-muted hover:text-chrome-strong hover:bg-chrome-hover inline-flex h-[22px] items-center gap-1 rounded-[4px] border px-1.5 text-[11px] disabled:hidden ${CHROME_EASE} ${FOCUS_RING}`}
							data-wc-add-class=""
						>
							<PlusIcon aria-hidden="true" className="size-3" />
							{said.inspector.addClass}
						</button>
					)}
				</div>
			</Field>
			<Field label={said.inspector.content}>
				<p className="text-chrome-strong truncate font-mono text-[12px]" data-wc-content="">
					{contentOf(node) || <span className="text-chrome-faint font-sans">{said.inspector.noContent}</span>}
				</p>
			</Field>
			<Field label={said.inspector.id} htmlFor={ids.id}>
				<CommitInput
					id={ids.id}
					mono
					value={attributeText("id")}
					disabled={readOnly}
					onCommit={(value) => setAttribute("id", value.trim(), fill(said.steps.id, { name }))}
				/>
			</Field>
			{others.map((attribute) => (
				<Field
					key={attribute.name}
					label={attribute.name}
					aside={
						readOnly ? null : (
							<button
								type="button"
								aria-label={fill(said.inspector.removeAttribute, { name: attribute.name })}
								onClick={() =>
									setAttribute(
										attribute.name,
										"",
										fill(said.steps.removeAttribute, { attribute: attribute.name, name }),
									)
								}
								className={`text-chrome-muted hover:text-chrome-strong rounded-[4px] ${FOCUS_RING}`}
							>
								<XIcon aria-hidden="true" className="size-3" />
							</button>
						)
					}
				>
					<CommitInput
						mono
						label={fill(said.inspector.attributeValue, { name: attribute.name })}
						value={printAttributeText(attribute.value)}
						disabled={readOnly}
						onCommit={(value) =>
							setAttribute(attribute.name, value, fill(said.steps.attribute, { attribute: attribute.name, name }))
						}
					/>
				</Field>
			))}
			{newAttribute ? (
				<div className="bg-chrome-raised grid grid-cols-2 gap-1.5 rounded-md px-2 py-1.5" data-wc-new-attribute="">
					<input
						// biome-ignore lint/a11y/noAutofocus: it opens from "Add attribute", where typing goes next.
						autoFocus
						aria-label={said.inspector.attributeName}
						placeholder={said.inspector.attributeName}
						value={newAttribute.name}
						spellCheck={false}
						onChange={(event) => setNewAttribute({ ...newAttribute, name: event.target.value.toLowerCase() })}
						className={`${INPUT} font-mono`}
					/>
					<input
						aria-label={said.inspector.newAttributeValue}
						placeholder={said.inspector.newAttributeValue}
						value={newAttribute.value}
						spellCheck={false}
						onChange={(event) => setNewAttribute({ ...newAttribute, value: event.target.value })}
						onKeyDown={(event) => {
							if (event.key === "Enter" && newAttribute.name.trim()) {
								event.preventDefault();
								const attributeName = newAttribute.name.trim();
								if (
									setAttribute(
										attributeName,
										newAttribute.value,
										fill(said.steps.attribute, { attribute: attributeName, name }),
									)
								)
									setNewAttribute(null);
							}
							if (event.key === "Escape") {
								event.preventDefault();
								event.stopPropagation();
								setNewAttribute(null);
							}
						}}
						className={`${INPUT} font-mono`}
					/>
				</div>
			) : (
				<button
					type="button"
					disabled={readOnly}
					onClick={() => setNewAttribute({ name: "", value: "" })}
					className={`border-chrome-line text-chrome-text hover:bg-chrome-hover flex h-8 items-center justify-center gap-1.5 rounded-md border text-[12px] font-medium disabled:opacity-50 ${CHROME_EASE} ${FOCUS_RING}`}
					data-wc-add-attribute=""
				>
					<PlusIcon aria-hidden="true" className="size-3.5" />
					{said.inspector.addAttribute}
				</button>
			)}
			{problem ? (
				<p role="alert" className="text-chrome-danger px-1 text-[12px]">
					{problem}
				</p>
			) : null}
			{inside?.id ? (
				<button
					type="button"
					onClick={() => onOpenComponent(inside.id as string)}
					className={`flex h-8 items-center gap-2 rounded-md bg-[#2e1065] px-2.5 text-[12px] font-medium text-[#ddd6fe] hover:bg-[#3b0f80] ${CHROME_EASE} ${FOCUS_RING}`}
					data-wc-inside=""
				>
					<ComponentIcon aria-hidden="true" className="size-3.5 text-[#a78bfa]" />
					{fill(said.inspector.inside, { name: inside.name ?? "" })}
				</button>
			) : null}
		</div>
	);
}
