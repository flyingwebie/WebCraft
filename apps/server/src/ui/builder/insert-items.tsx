import { type ElementTree, elementProblem, readExpression, type TreeNode } from "@webcraft/renderer/builder";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Field, FieldDescription, FieldError, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { type FormEvent, useState } from "react";

import type { MessageKey, useT } from "../i18n.tsx";
import { useT as useTranslator } from "../i18n.tsx";
import { MediaPicker } from "../media/MediaPicker.tsx";
import { type Catalogue, readParts } from "./model.ts";
import { newElement, withNewIds } from "./tree.ts";

type T = ReturnType<typeof useT>;

/** Where a new layer goes: inside the selected one (at its end), after it, or before it. */
export type InsertWhere = "inside" | "after" | "before";

export type InsertStepKind =
	| "image"
	| "value"
	| "component"
	| "loop"
	| "form"
	| "popup"
	| "filter"
	| "pagination"
	| "condition"
	| "tag";

/** One thing Insert offers: one set of insert rules for the Command menu and the insert toolbar. */
export type InsertItem = {
	id: string;
	group: "sections" | "text" | "media" | "values" | "commands" | "components" | "elements" | "other";
	label: string;
	/** What it is, for screen readers and the search. */
	hint: string;
	build?: () => TreeNode[];
	step?: InsertStepKind;
	/** For a Component: its id. */
	componentId?: string;
};

const SECTION_TAGS = ["section", "header", "nav", "main", "article", "aside", "footer", "search", "div", "address"];
const HEADINGS = ["h1", "h2", "h3", "h4", "h5", "h6"];

/**
 * What Insert shows before anything is typed: the insert toolbar's five items (a heading, a
 * paragraph, an image, a Loop, a Component), plus Section and every heading level.
 */
export const SHORT_LIST = ["h2", "p", "image", "command-loop", "components", "section", "h1", "h3", "h4", "h5", "h6"];

/** Builds an element for the tree, with fresh ids and plain-text attributes. */
export function elementBuilder(tree: ElementTree) {
	return (tag: string, children: TreeNode[] = [], attributes: Record<string, string> = {}): TreeNode => {
		const made = newElement(tree, tag, children);
		return {
			...made,
			attributes: Object.entries(attributes).map(([name, value]) => ({ name, value: [{ type: "text", text: value }] })),
		};
	};
}

/**
 * Everything Insert offers where this kind of tree may hold it: semantic elements first (sections,
 * headings, text, lists, links, a link styled as a button, figures, Media images, tables), then
 * values, Template commands, Components, text and comments, and every other allowed HTML element by
 * its tag. What needs a choice (a Media image, a value, a Component's required Props, a Loop, a
 * Form, a Condition's test, a tag) asks for it next (`InsertStep`).
 */
export function insertItems(t: T, tree: ElementTree, catalogue: Catalogue): InsertItem[] {
	const allowed = new Set(catalogue.elements);
	const commands = new Set(catalogue.commands);
	const element = elementBuilder(tree);
	const words = (key: MessageKey) => ({ type: "text", text: t(key) }) as TreeNode;
	type Item = InsertItem;
	type Step = InsertStepKind;
	const items: Item[] = [
		...SECTION_TAGS.filter((tag) => allowed.has(tag)).map((tag) => ({
			id: tag,
			group: "sections" as const,
			label: `<${tag}>`,
			hint: t(`builder.insert.tags.${tag as "section"}`),
			build: () => [element(tag)],
		})),
		...HEADINGS.filter((tag) => allowed.has(tag)).map((tag) => ({
			id: tag,
			group: "text" as const,
			label: t("builder.insert.heading", { level: tag.slice(1) }),
			hint: `<${tag}>`,
			build: () => [element(tag, [words("builder.insert.defaults.heading")])],
		})),
		{
			id: "p",
			group: "text",
			label: t("builder.insert.paragraph"),
			hint: "<p>",
			build: () => [element("p", [words("builder.insert.defaults.paragraph")])],
		},
		{
			id: "ul",
			group: "text",
			label: t("builder.insert.list"),
			hint: "<ul>",
			build: () => [element("ul", [element("li", [words("builder.insert.defaults.listItem")])])],
		},
		{
			id: "ol",
			group: "text",
			label: t("builder.insert.numberedList"),
			hint: "<ol>",
			build: () => [element("ol", [element("li", [words("builder.insert.defaults.listItem")])])],
		},
		{
			id: "li",
			group: "text",
			label: t("builder.insert.listItem"),
			hint: "<li>",
			build: () => [element("li", [words("builder.insert.defaults.listItem")])],
		},
		{
			id: "a",
			group: "text",
			label: t("builder.insert.link"),
			hint: "<a>",
			build: () => [element("a", [words("builder.insert.defaults.link")], { href: "/" })],
		},
		{
			id: "button",
			group: "text",
			label: t("builder.insert.button"),
			hint: t("builder.insert.buttonHint"),
			build: () => [element("a", [words("builder.insert.defaults.button")], { href: "/" })],
		},
		{
			id: "blockquote",
			group: "text",
			label: t("builder.insert.quote"),
			hint: "<blockquote>",
			build: () => [element("blockquote", [element("p", [words("builder.insert.defaults.quote")])])],
		},
		{
			id: "image",
			group: "media",
			label: t("builder.insert.image"),
			hint: t("builder.insert.imageHint"),
			step: "image",
		},
		{
			id: "figure",
			group: "media",
			label: t("builder.insert.figure"),
			hint: "<figure> <figcaption>",
			build: () => [element("figure", [element("figcaption", [words("builder.insert.defaults.caption")])])],
		},
		{
			id: "table",
			group: "media",
			label: t("builder.insert.table"),
			hint: "<table>",
			build: () => [
				element("table", [element("tbody", [element("tr", [element("td", [words("builder.insert.defaults.cell")])])])]),
			],
		},
		{
			id: "details",
			group: "media",
			label: t("builder.insert.details"),
			hint: "<details> <summary>",
			build: () => [element("details", [element("summary", [words("builder.insert.defaults.summary")])])],
		},
		{
			id: "value",
			group: "values",
			label: t("builder.insert.value"),
			hint: t("builder.insert.valueHint"),
			step: "value",
		},
		...(
			[
				"if",
				"loop",
				"form",
				"popup",
				"filter",
				"pagination",
				"outlet",
				"search",
				"themeToggle",
				"languageSwitcher",
				"consentSettings",
			] as const
		)
			.filter((name) => commands.has(name))
			.map((name): Item => {
				const node: Record<string, () => TreeNode> = {
					outlet: () => ({ type: "outlet" }) as TreeNode,
					search: () => ({ type: "search" }) as TreeNode,
					themeToggle: () => ({ type: "themeToggle" }) as TreeNode,
					languageSwitcher: () => ({ type: "languageSwitcher" }) as TreeNode,
					consentSettings: () => ({ type: "consentSettings" }) as TreeNode,
				};
				const steps: Record<string, Step> = {
					if: "condition",
					loop: "loop",
					form: "form",
					popup: "popup",
					filter: "filter",
					pagination: "pagination",
				};
				const build = node[name];
				return {
					id: `command-${name}`,
					group: "commands",
					label: t(`builder.insert.commands.${name}`),
					hint: `{{@${name}}}`,
					...(build ? { build: () => [build()] } : { step: steps[name] }),
				};
			}),
		...catalogue.components.map(
			(component): Item => ({
				id: `component-${component.id}`,
				group: "components",
				label: component.name,
				hint: t("builder.insert.componentHint"),
				step: "component",
				componentId: component.id,
			}),
		),
		{
			id: "text",
			group: "other",
			label: t("builder.insert.text"),
			hint: t("builder.insert.textHint"),
			build: () => [words("builder.insert.defaults.text")],
		},
		{
			id: "comment",
			group: "other",
			label: t("builder.insert.comment"),
			hint: "<!-- -->",
			build: () => [{ type: "comment", text: ` ${t("builder.insert.defaults.comment")} ` }],
		},
		{
			id: "tag",
			group: "other",
			label: t("builder.insert.anyElement"),
			hint: t("builder.insert.anyElementHint"),
			step: "tag",
		},
	];
	const named = new Set(items.map((item) => item.id));
	const elements = [...allowed]
		.filter((tag) => !named.has(tag))
		.sort()
		.map(
			(tag): Item => ({
				id: `tag-${tag}`,
				group: "elements",
				label: `<${tag}>`,
				hint: tag,
				build: () => [element(tag)],
			}),
		);
	return [...items, ...elements];
}

/** A Component with no required Prop goes in at once; anything else asks first. */
export function insertNow(item: InsertItem, tree: ElementTree, catalogue: Catalogue): TreeNode[] | null {
	if (item.componentId) {
		const component = catalogue.components.find((each) => each.id === item.componentId);
		if (component && !component.props.some((prop) => prop.required))
			return withNewIds(tree, [{ type: "component", id: "new", component: component.id, props: [] }]);
		return null;
	}
	return item.build ? item.build() : null;
}

/** What an insert that needs a choice asks for, then the node it makes. */
export function InsertStep({
	step: chosen,
	siteId: site,
	catalogue: offered,
	allowed: tags,
	build,
	onBack,
	onInsert: put,
	problem: refused,
	tree: current,
	baseId,
}: {
	step: InsertItem;
	siteId: string;
	catalogue: Catalogue;
	allowed: ReadonlySet<string>;
	build(tag: string, children?: TreeNode[], attributes?: Record<string, string>): TreeNode;
	onBack(): void;
	onInsert(nodes: TreeNode[]): void;
	problem: string | null;
	tree: ElementTree;
	baseId: string;
}) {
	const t = useTranslator();
	const [text, setText] = useState("");
	const [choice, setChoice] = useState("");
	const [alias, setAlias] = useState("item");
	const [control, setControl] = useState("");
	const [props, setProps] = useState<Record<string, string>>({});
	const [media, setMedia] = useState<{ id: string; item: Parameters<typeof MediaPicker>[0]["item"] } | null>(null);
	const [own, setOwn] = useState<string | null>(null);
	const component = offered.components.find((each) => each.id === chosen.componentId);
	const submit = (event: FormEvent) => {
		event.preventDefault();
		setOwn(null);
		switch (chosen.step) {
			case "image":
				if (!media) return setOwn(t("builder.insert.chooseImage"));
				return put([build("img", [], { src: `media:${media.id}` })]);
			case "value": {
				const path = (text || choice).trim();
				if (!path) return setOwn(t("builder.insert.chooseValue"));
				return put([{ type: "value", path }]);
			}
			case "component": {
				if (!component) return;
				const given: { name: string; value: ReturnType<typeof readParts> }[] = component.props
					.filter((prop) => (props[prop.key] ?? "") !== "" || prop.required)
					.map((prop) => ({ name: prop.key, value: readParts(props[prop.key] ?? "") }));
				const unreadable = given.find((each) => "problem" in each.value);
				if (unreadable && "problem" in unreadable.value) return setOwn(unreadable.value.problem);
				const placed = {
					type: "component",
					id: "new",
					component: component.id,
					props: given.map((each) => ({ name: each.name, value: "parts" in each.value ? each.value.parts : [] })),
				} as TreeNode;
				return put(withNewIds(current, [placed]));
			}
			case "loop":
				if (!(text || choice).trim()) return setOwn(t("builder.insert.chooseLoop"));
				return put([
					{ type: "loop", source: (text || choice).trim(), alias: alias.trim() || "item", children: [], empty: null },
				]);
			case "popup":
				if (!choice) return setOwn(t("builder.insert.choosePopup"));
				return put([{ type: "popup", popup: choice }]);
			case "form":
				if (!choice) return setOwn(t("builder.insert.chooseForm"));
				return put([{ type: "form", form: choice }]);
			case "filter": {
				const filter = offered.filters.find((each) => each.id === choice);
				if (!filter) return setOwn(t("builder.insert.chooseFilter"));
				return put([
					{ type: "filter", filter: filter.id, loop: filter.loop, ...(control ? { control } : {}) } as TreeNode,
				]);
			}
			case "pagination":
				if (!choice) return setOwn(t("builder.insert.chooseLoop"));
				return put([{ type: "pagination", loop: choice }]);
			case "condition": {
				const read = readExpression(text);
				if ("problem" in read) return setOwn(read.problem.message);
				return put([{ type: "condition", branches: [{ test: read.expression, children: [] }], otherwise: null }]);
			}
			case "tag": {
				const tag = text.trim().toLowerCase();
				const why = elementProblem(tag) ?? (tags.has(tag) ? undefined : t("builder.insert.tagRefused", { tag }));
				if (why) return setOwn(why);
				return put([build(tag)]);
			}
		}
	};
	const message = own ?? refused;
	const fieldId = `${baseId}-step`;
	return (
		<form onSubmit={submit} className="grid gap-4" noValidate>
			{chosen.step === "image" ? (
				<Field>
					<FieldLabel id={`${fieldId}-label`}>{t("builder.insert.image")}</FieldLabel>
					<MediaPicker
						siteId={site}
						id={fieldId}
						labelledBy={`${fieldId}-label`}
						value={media?.id ?? null}
						item={media?.item ?? null}
						onChange={(next) => setMedia(next)}
					/>
				</Field>
			) : null}
			{chosen.step === "value" ? (
				<>
					<Field>
						<FieldLabel htmlFor={`${fieldId}-choice`}>{t("builder.insert.valueChoice")}</FieldLabel>
						<NativeSelect id={`${fieldId}-choice`} value={choice} onChange={(event) => setChoice(event.target.value)}>
							<NativeSelectOption value="">{t("builder.insert.valueNone")}</NativeSelectOption>
							{offered.values.map((value) => (
								<NativeSelectOption key={value.path} value={value.path}>
									{value.label ? `${value.label} (${value.path})` : value.path}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</Field>
					<Field>
						<FieldLabel htmlFor={`${fieldId}-path`}>{t("builder.insert.valuePath")}</FieldLabel>
						<Input
							id={`${fieldId}-path`}
							value={text}
							onChange={(event) => setText(event.target.value)}
							className="font-mono"
							spellCheck={false}
							aria-describedby={`${fieldId}-path-help`}
						/>
						<FieldDescription id={`${fieldId}-path-help`}>{t("builder.insert.valuePathHelp")}</FieldDescription>
					</Field>
				</>
			) : null}
			{chosen.step === "component" && component
				? component.props.map((prop) => (
						<Field key={prop.key}>
							<FieldLabel htmlFor={`${fieldId}-${prop.key}`}>
								{prop.required ? t("builder.insert.requiredProp", { label: prop.label }) : prop.label}
							</FieldLabel>
							<Input
								id={`${fieldId}-${prop.key}`}
								value={props[prop.key] ?? ""}
								onChange={(event) => setProps((before) => ({ ...before, [prop.key]: event.target.value }))}
							/>
						</Field>
					))
				: null}
			{chosen.step === "loop" ? (
				<>
					<Field>
						<FieldLabel htmlFor={`${fieldId}-choice`}>{t("builder.insert.loopChoice")}</FieldLabel>
						<NativeSelect id={`${fieldId}-choice`} value={choice} onChange={(event) => setChoice(event.target.value)}>
							<NativeSelectOption value="">{t("builder.insert.valueNone")}</NativeSelectOption>
							{offered.loops.map((loop) => (
								<NativeSelectOption key={loop.name} value={loop.name}>
									{loop.name}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</Field>
					<Field>
						<FieldLabel htmlFor={`${fieldId}-list`}>{t("builder.insert.loopList")}</FieldLabel>
						<Input
							id={`${fieldId}-list`}
							value={text}
							onChange={(event) => setText(event.target.value)}
							className="font-mono"
							spellCheck={false}
							aria-describedby={`${fieldId}-list-help`}
						/>
						<FieldDescription id={`${fieldId}-list-help`}>{t("builder.insert.loopListHelp")}</FieldDescription>
					</Field>
					<Field>
						<FieldLabel htmlFor={`${fieldId}-alias`}>{t("builder.insert.loopAlias")}</FieldLabel>
						<Input
							id={`${fieldId}-alias`}
							value={alias}
							onChange={(event) => setAlias(event.target.value)}
							className="font-mono"
							spellCheck={false}
						/>
					</Field>
				</>
			) : null}
			{chosen.step === "form" ? (
				<Field>
					<FieldLabel htmlFor={`${fieldId}-choice`}>{t("builder.insert.formChoice")}</FieldLabel>
					<NativeSelect id={`${fieldId}-choice`} value={choice} onChange={(event) => setChoice(event.target.value)}>
						<NativeSelectOption value="">{t("builder.insert.valueNone")}</NativeSelectOption>
						{offered.forms.map((form) => (
							<NativeSelectOption key={form.id} value={form.id}>
								{`${form.name} (${form.key})`}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</Field>
			) : null}
			{chosen.step === "popup" ? (
				<Field>
					<FieldLabel htmlFor={`${fieldId}-choice`}>{t("builder.insert.popupChoice")}</FieldLabel>
					<NativeSelect id={`${fieldId}-choice`} value={choice} onChange={(event) => setChoice(event.target.value)}>
						<NativeSelectOption value="">{t("builder.insert.valueNone")}</NativeSelectOption>
						{offered.popups.map((popup) => (
							<NativeSelectOption key={popup.id} value={popup.id}>
								{`${popup.name} (${popup.key})`}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</Field>
			) : null}
			{chosen.step === "filter" ? (
				<>
					<Field>
						<FieldLabel htmlFor={`${fieldId}-choice`}>{t("builder.insert.filterChoice")}</FieldLabel>
						<NativeSelect
							id={`${fieldId}-choice`}
							value={choice}
							aria-describedby={`${fieldId}-choice-help`}
							onChange={(event) => {
								setChoice(event.target.value);
								setControl("");
							}}
						>
							<NativeSelectOption value="">{t("builder.insert.valueNone")}</NativeSelectOption>
							{offered.filters.map((filter) => (
								<NativeSelectOption key={filter.id} value={filter.id}>
									{`${filter.name} (${filter.loop})`}
								</NativeSelectOption>
							))}
						</NativeSelect>
						<FieldDescription id={`${fieldId}-choice-help`}>{t("builder.insert.filterHint")}</FieldDescription>
					</Field>
					<Field>
						<FieldLabel htmlFor={`${fieldId}-control`}>{t("builder.insert.filterControl")}</FieldLabel>
						<NativeSelect
							id={`${fieldId}-control`}
							value={control}
							onChange={(event) => setControl(event.target.value)}
							disabled={!choice}
						>
							<NativeSelectOption value="">{t("builder.insert.filterWhole")}</NativeSelectOption>
							{(offered.filters.find((filter) => filter.id === choice)?.controls ?? []).map((each) => (
								<NativeSelectOption key={each.id} value={each.id}>
									{t("builder.insert.filterOne", { name: each.label ?? each.type, id: each.id })}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</Field>
				</>
			) : null}
			{chosen.step === "pagination" ? (
				<Field>
					<FieldLabel htmlFor={`${fieldId}-choice`}>{t("builder.insert.loopChoice")}</FieldLabel>
					<NativeSelect id={`${fieldId}-choice`} value={choice} onChange={(event) => setChoice(event.target.value)}>
						<NativeSelectOption value="">{t("builder.insert.valueNone")}</NativeSelectOption>
						{offered.loops.map((loop) => (
							<NativeSelectOption key={loop.name} value={loop.name}>
								{loop.name}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</Field>
			) : null}
			{chosen.step === "condition" || chosen.step === "tag" ? (
				<Field data-invalid={message ? true : undefined}>
					<FieldLabel htmlFor={`${fieldId}-text`}>
						{chosen.step === "condition" ? t("builder.insert.test") : t("builder.insert.tag")}
					</FieldLabel>
					<Input
						id={`${fieldId}-text`}
						value={text}
						onChange={(event) => setText(event.target.value)}
						className="font-mono"
						spellCheck={false}
						autoComplete="off"
						aria-invalid={message ? true : undefined}
						aria-describedby={`${fieldId}-help`}
					/>
					<FieldDescription id={`${fieldId}-help`}>
						{chosen.step === "condition" ? t("builder.insert.testHelp") : t("builder.insert.tagHelp")}
					</FieldDescription>
				</Field>
			) : null}
			{message ? <FieldError>{message}</FieldError> : null}
			<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
				<Button type="button" variant="outline" onClick={onBack}>
					{t("builder.insert.back")}
				</Button>
				<Button type="submit">{t("builder.insert.submit")}</Button>
			</div>
		</form>
	);
}
