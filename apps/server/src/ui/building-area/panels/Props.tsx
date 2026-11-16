import type { FieldDefinition } from "@webcraft/core";
import type { PlacementNode } from "@webcraft/renderer/builder";
import { ImageIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { Json } from "../../content/model.ts";
import { type NodePath, replaceAt } from "../../editor/tree.ts";
import { imagePreview, type MediaItem } from "../../media/preview.ts";
import { fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";
import type { PageLayoutEditor } from "../editing/page-layout.ts";
import type { LayoutPlacement, Structure, StructureSource } from "../editing/selection.ts";
import { managementApi } from "../management.ts";
import { pickMedia } from "../places/media/pick.ts";
import { CommitInput, FieldCard, INPUT, Note, printParts, readParts, Switch, type ValueChoice } from "./inputs.tsx";

/**
 * The Props panel for Staff (SPEC 5, `builder/05`; BA-09): the Inspector's body while a Placement is
 * selected, titled "Props" and the Component's name. When the Component shows on more than one page it
 * warns that editing the Component changes all of them; then one card per Prop.
 *
 * - A Page's Placement (its Page layout): each Prop's value as its Field takes it (text, a number, a
 *   switch, a choice, a Media file, a link), saved to the Page's Draft through its shared Draft.
 * - A Placement in a Template or Component: each Prop's value as the markup writes it, fixed text and
 *   values (`{{ title }}`, with `{{` offering what may be read there), saved to that Template's or
 *   Component's Draft.
 *
 * Each change is one Undo step, and the page in the frame is drawn again in place. "Edit Component"
 * (the panel's pencil, `onEditComponent`) opens the Component in place.
 */
export function PropsPanel({
	structure,
	words,
	token,
	siteId,
	layout,
	placement,
	source,
	path,
	node,
	component,
	values,
}: {
	structure: Structure;
	words: Words;
	token: string;
	siteId: string;
	layout: PageLayoutEditor;
	/** A Page's Placement, with the Page layout it is in; else the Placement node of a Template or Component. */
	placement: { placement: LayoutPlacement; all: readonly LayoutPlacement[]; canArrange: boolean } | null;
	/** For a Placement in a Template or Component: its source, where it is, and the node. */
	source: StructureSource | null;
	path: NodePath | null;
	node: PlacementNode | null;
	/** The Placement's Component as the page opened it (its Props and on how many pages it shows), once it has. */
	component: StructureSource | null;
	/** What `{{` offers in a Prop of a Template's Placement. */
	values: readonly ValueChoice[];
}) {
	const said = words.placements.props;
	const [problem, setProblem] = useState<string | null>(null);
	const pages = component?.pages ?? null;
	const warning =
		pages !== null && pages > 1 ? (
			<Note warn icon={<TriangleAlertIcon aria-hidden="true" className="mt-px size-3.5 shrink-0" />}>
				{fill(said.onPages, { count: String(pages) })}
			</Note>
		) : null;

	if (placement) {
		const { placement: shown, all, canArrange } = placement;
		const set = (field: FieldDefinition, value: Json) => {
			const refused = layout.setValue(all, shown.id, field, value);
			setProblem(refused);
			return refused === null;
		};
		return (
			<div className="flex min-h-0 grow flex-col gap-2 overflow-auto pb-2" data-wc-props="">
				{warning}
				{shown.props.length === 0 ? <Note>{said.none}</Note> : null}
				{shown.props.map((field) => (
					<PropField
						key={field.key}
						field={field}
						value={(shown.values[field.key] ?? null) as Json}
						words={words}
						siteId={siteId}
						token={token}
						disabled={!canArrange}
						onChange={(value) => set(field, value)}
					/>
				))}
				{problem ? (
					<p role="alert" className="text-chrome-warn px-1 text-[12px]">
						{problem}
					</p>
				) : null}
			</div>
		);
	}

	if (!source || !path || !node) return <Note>{words.structure.inspector.notOpen}</Note>;
	const declared =
		component?.props ??
		(source.catalogue.components.find((each) => each.id === node.component)?.props as FieldDefinition[] | undefined) ??
		[];
	const name = component?.name ?? source.catalogue.components.find((each) => each.id === node.component)?.name ?? "";
	const readOnly = !source.editable;
	const setText = (key: string, label: string, text: string) => {
		const rest = node.props.filter((each) => each.name !== key || each.retained);
		let next = rest;
		if (text !== "") {
			const read = readParts(text);
			if ("problem" in read) {
				setProblem(fill(words.structure.inspector.badValue, { value: read.problem }));
				return false;
			}
			const at = node.props.findIndex((each) => each.name === key && !each.retained);
			const written = { name: key, value: read.parts };
			next = at < 0 ? [...node.props, written] : node.props.map((each, index) => (index === at ? written : each));
		}
		const refused = structure.change(
			source.ref,
			replaceAt(source.tree, path, { ...node, props: next }),
			fill(words.placements.steps.prop, { name, prop: label }),
		);
		setProblem(refused);
		return refused === null;
	};
	return (
		<div className="flex min-h-0 grow flex-col gap-2 overflow-auto pb-2" data-wc-props="">
			{readOnly ? (
				<p className="text-chrome-warn px-1 text-[12px]" data-wc-read-only="">
					{fill(words.structure.readOnly, { name: source.name ?? words.structure.thisSource })}
				</p>
			) : null}
			{warning}
			{declared.length === 0 ? <Note>{said.none}</Note> : null}
			{declared.map((field) => {
				const given = node.props.find((each) => each.name === field.key && !each.retained);
				const text = given ? printParts(given.value) : "";
				const label = field.label || field.key;
				return (
					<TemplateProp
						key={field.key}
						field={field}
						text={text}
						words={words}
						siteId={siteId}
						token={token}
						values={values}
						disabled={readOnly}
						onChange={(next) => setText(field.key, label, next)}
					/>
				);
			})}
			{problem ? (
				<p role="alert" className="text-chrome-warn px-1 text-[12px]">
					{problem}
				</p>
			) : null}
		</div>
	);
}

/** A Prop of a Placement in a Template or Component: its value as the markup writes it. */
function TemplateProp({
	field,
	text,
	words,
	siteId,
	token,
	values,
	disabled,
	onChange,
}: {
	field: Pick<FieldDefinition, "key" | "label" | "type">;
	text: string;
	words: Words;
	siteId: string;
	token: string;
	values: readonly ValueChoice[];
	disabled: boolean;
	onChange(text: string): boolean;
}) {
	const id = useId();
	const said = words.placements.props;
	const label = field.label || field.key;
	if (field.type === "boolean" && (text === "" || text === "true" || text === "false")) {
		return (
			<FieldCard label={label}>
				<Switch
					checked={text === "true"}
					label={label}
					on={said.on}
					off={said.off}
					disabled={disabled}
					onChange={(on) => onChange(on ? "true" : "false")}
				/>
			</FieldCard>
		);
	}
	if (field.type === "media" && (text === "" || text.startsWith("media:"))) {
		return (
			<FieldCard label={label}>
				<MediaChoice
					id={text ? text.slice("media:".length) : null}
					words={words}
					label={label}
					disabled={disabled}
					siteId={siteId}
					token={token}
					onChange={(chosen) => onChange(chosen ? `media:${chosen}` : "")}
				/>
			</FieldCard>
		);
	}
	return (
		<FieldCard label={label} htmlFor={id}>
			<CommitInput
				id={id}
				value={text}
				disabled={disabled}
				values={values}
				valuesLabel={words.placements.values}
				multiline={field.type === "richText"}
				onCommit={onChange}
			/>
		</FieldCard>
	);
}

/** A Prop of a Page's Placement: its value as its Field takes it. */
function PropField({
	field,
	value,
	words,
	siteId,
	token,
	disabled,
	onChange,
}: {
	field: FieldDefinition;
	value: Json;
	words: Words;
	siteId: string;
	token: string;
	disabled: boolean;
	onChange(value: Json): boolean;
}) {
	const id = useId();
	const said = words.placements.props;
	const label = field.label || field.key;
	const text = typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
	switch (field.type) {
		case "text":
		case "email":
		case "richText":
			return (
				<FieldCard label={label} htmlFor={id}>
					<CommitInput
						id={id}
						value={text}
						disabled={disabled}
						multiline={field.type === "richText"}
						type={field.type === "email" ? "email" : "text"}
						onCommit={(next) => onChange(next === "" ? null : next)}
					/>
				</FieldCard>
			);
		case "number":
			return (
				<FieldCard label={label} htmlFor={id}>
					<CommitInput
						id={id}
						value={text}
						disabled={disabled}
						type="number"
						onCommit={(next) => (next.trim() === "" ? onChange(null) : onChange(Number(next)))}
					/>
				</FieldCard>
			);
		case "date":
			return (
				<FieldCard label={label} htmlFor={id}>
					<CommitInput
						id={id}
						value={text}
						disabled={disabled}
						type={field.mode === "date" ? "date" : "text"}
						onCommit={(next) => onChange(next === "" ? null : next)}
					/>
				</FieldCard>
			);
		case "boolean":
			return (
				<FieldCard label={label}>
					<Switch
						checked={value === true}
						label={label}
						on={said.on}
						off={said.off}
						disabled={disabled}
						onChange={(on) => onChange(on)}
					/>
				</FieldCard>
			);
		case "select":
			if (field.multiple) break;
			return (
				<FieldCard label={label} htmlFor={id}>
					<select
						id={id}
						value={text}
						disabled={disabled}
						onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
						className={`${INPUT} bg-chrome-raised`}
					>
						<option value="">{said.noChoice}</option>
						{field.options.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				</FieldCard>
			);
		case "media":
			return (
				<FieldCard label={label}>
					<MediaChoice
						id={typeof value === "string" ? value : null}
						words={words}
						label={label}
						disabled={disabled}
						siteId={siteId}
						token={token}
						onChange={(chosen) => onChange(chosen)}
					/>
				</FieldCard>
			);
		case "link": {
			const link = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, Json>) : {};
			const url = typeof link.url === "string" ? link.url : "";
			const shown = typeof link.text === "string" ? link.text : "";
			return (
				<FieldCard label={label}>
					<CommitInput
						value={url}
						label={fill(said.url, { name: label })}
						placeholder={said.urlPlaceholder}
						disabled={disabled}
						onCommit={(next) => onChange(next === "" && shown === "" ? null : { url: next, text: shown })}
					/>
					<CommitInput
						value={shown}
						label={fill(said.linkText, { name: label })}
						placeholder={said.linkTextPlaceholder}
						disabled={disabled}
						onCommit={(next) => onChange(next === "" && url === "" ? null : { url, text: next })}
					/>
				</FieldCard>
			);
		}
		default:
			break;
	}
	return (
		<FieldCard label={label}>
			<p className="text-chrome-muted text-[12px]">{said.notHere}</p>
		</FieldCard>
	);
}

/** A Media file's thumbnail and name, "Choose" (the Media picker) and remove (`builder/05`'s Photo). */
function MediaChoice({
	id,
	words,
	label,
	disabled,
	siteId,
	token,
	onChange,
}: {
	id: string | null;
	words: Words;
	label: string;
	disabled: boolean;
	siteId?: string;
	token?: string;
	onChange(id: string | null): boolean;
}) {
	const said = words.placements.props;
	const [item, setItem] = useState<MediaItem | null>(null);
	useEffect(() => {
		if (!id || !siteId || !token) {
			setItem(null);
			return;
		}
		if (item?.id === id) return;
		let current = true;
		managementApi(token)
			.media.get({ siteId, mediaId: id })
			.then((read) => current && setItem(read.media as MediaItem))
			.catch(() => current && setItem(null));
		return () => {
			current = false;
		};
	}, [id, siteId, token, item?.id]);
	const preview = item && siteId ? imagePreview(siteId, item, 56, true) : null;
	return (
		<div className="flex min-w-0 items-center gap-2">
			<span className="bg-chrome grid size-7 shrink-0 place-items-center overflow-hidden rounded-md">
				{preview ? (
					<img src={preview} alt="" className="size-full object-cover" />
				) : (
					<ImageIcon aria-hidden="true" className="text-chrome-faint size-3.5" />
				)}
			</span>
			<span className="text-chrome-strong min-w-0 grow truncate text-[12px] font-medium" data-wc-media-name="">
				{item?.fileName ?? (id ? id : said.noFile)}
			</span>
			<button
				type="button"
				disabled={disabled}
				onClick={async () => {
					const chosen = await pickMedia({ current: id });
					if (!chosen) return;
					setItem(chosen);
					onChange(chosen.id);
				}}
				className={`text-chrome-strong hover:bg-chrome-hover h-6 shrink-0 rounded-[5px] border border-[#2a2a30] px-2 text-[12px] font-medium disabled:opacity-50 ${CHROME_EASE} ${FOCUS_RING}`}
				aria-label={fill(said.chooseFor, { name: label })}
			>
				{said.choose}
			</button>
			{id ? (
				<button
					type="button"
					disabled={disabled}
					onClick={() => {
						setItem(null);
						onChange(null);
					}}
					className={`text-chrome-muted hover:bg-chrome-hover hover:text-chrome-strong grid size-6 shrink-0 place-items-center rounded-[4px] ${CHROME_EASE} ${FOCUS_RING}`}
					aria-label={fill(said.removeFile, { name: label })}
				>
					<XIcon aria-hidden="true" className="size-3.5" />
				</button>
			) : null}
		</div>
	);
}
