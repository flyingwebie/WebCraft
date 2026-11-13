import type { FieldInput } from "@webcraft/core";
import { FIELD_KEY, FIELD_TYPES, type FieldType } from "@webcraft/core/field-rules";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Field, FieldDescription, FieldError, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import {
	AtSignIcon,
	BracesIcon,
	CalendarIcon,
	HashIcon,
	ImageIcon,
	LinkIcon,
	ListIcon,
	ListOrderedIcon,
	type LucideIcon,
	PilcrowIcon,
	PlusIcon,
	ToggleLeftIcon,
	Trash2Icon,
	TypeIcon,
	WaypointsIcon,
} from "lucide-react";
import { useEffect, useId, useState } from "react";

import { draftsOf, freeKey, newField } from "../content/field-drafts.ts";
import { useT } from "../i18n.tsx";

/** Each Prop type's icon, as the Post Types screen shows them (no Body: a Component takes none). */
const TYPE_ICONS: { readonly [Type in Exclude<FieldType, "body">]: LucideIcon } = {
	text: TypeIcon,
	richText: PilcrowIcon,
	number: HashIcon,
	boolean: ToggleLeftIcon,
	date: CalendarIcon,
	select: ListIcon,
	media: ImageIcon,
	link: LinkIcon,
	email: AtSignIcon,
	relationship: WaypointsIcon,
	group: BracesIcon,
	repeater: ListOrderedIcon,
};

/** The Field types a Prop can be: the Post Types' types, Body aside. */
const PROP_TYPES = FIELD_TYPES.filter((type): type is Exclude<FieldType, "body"> => type !== "body");

/** A Prop as the Inspector edits it: a stored declaration, or a new one. */
type Prop = FieldInput & { id?: string; exposed?: boolean };

/**
 * The Inspector's Props section (#134, decided in #121): the Component's Props, each with its name,
 * Field type (the types Post Types offer, Body aside), whether it is required, its default and
 * whether its value is exposed to the Component script. Each change writes the Props at once, which
 * rewrites the `{{@props}}` block at the top of the Component's markup; the server checks them as it
 * checks the block, and a refusal leaves both as they were. A renamed Prop keeps its identity, so
 * every Placement's value follows it.
 */
export function PropsSection({
	name,
	props,
	disabled,
	onChange,
}: {
	/** The Component's name. */
	name: string;
	props: readonly Prop[];
	disabled?: boolean;
	/** Writes the Props; answers why not. */
	onChange(props: FieldInput[], announcement: string): string | undefined;
}) {
	const t = useT();
	const id = useId();
	const [problem, setProblem] = useState<string | null>(null);
	const change = (next: Prop[], announcement: string) => setProblem(onChange(next, announcement) ?? null);
	const update = (index: number, prop: Prop, announcement = t("builder.props.changed", { name: prop.key })) =>
		change(
			props.map((each, at) => (at === index ? prop : each)),
			announcement,
		);
	const add = () => {
		const key = freeKey("prop", draftsOf(props as never));
		const made = newField("text", key, t("builder.props.newLabel")) as Prop;
		change([...props, made], t("builder.props.added", { name: key }));
	};
	return (
		<section aria-labelledby={`${id}-heading`} className="grid gap-3 border-t pt-3">
			<h3 id={`${id}-heading`} className="text-sm font-semibold">
				{t("builder.props.heading", { name })}
			</h3>
			<p className="text-muted-foreground text-xs">{t("builder.props.help", { block: "{{@props}}" })}</p>
			{props.length === 0 ? <p className="text-muted-foreground text-sm">{t("builder.props.none")}</p> : null}
			<ul className="grid gap-3">
				{props.map((prop, index) => (
					<li key={prop.id ?? `${prop.key}-${index}`} className="grid gap-3 rounded-md border p-2">
						<PropRow
							prop={prop}
							all={props}
							disabled={disabled}
							onChange={(next, announcement) => update(index, next, announcement)}
							onRemove={() =>
								change(
									props.filter((_, at) => at !== index),
									t("builder.props.removed", { name: prop.key }),
								)
							}
						/>
					</li>
				))}
			</ul>
			{problem ? <FieldError role="alert">{problem}</FieldError> : null}
			<Button
				type="button"
				variant="outline"
				size="sm"
				className="justify-self-start"
				disabled={disabled}
				onClick={add}
			>
				<PlusIcon aria-hidden="true" />
				{t("builder.props.add")}
			</Button>
		</section>
	);
}

function PropRow({
	prop,
	all,
	disabled,
	onChange,
	onRemove,
}: {
	prop: Prop;
	all: readonly Prop[];
	disabled?: boolean;
	onChange(prop: Prop, announcement?: string): void;
	onRemove(): void;
}) {
	const t = useT();
	const id = useId();
	const [key, setKey] = useState(prop.key);
	const [keyProblem, setKeyProblem] = useState<string | null>(null);
	useEffect(() => {
		setKey(prop.key);
		setKeyProblem(null);
	}, [prop.key]);
	const types = PROP_TYPES;
	const Icon = TYPE_ICONS[prop.type as Exclude<FieldType, "body">] ?? TYPE_ICONS.text;
	const commitKey = () => {
		const next = key.trim();
		if (next === prop.key) return;
		if (!FIELD_KEY.test(next)) return setKeyProblem(t("builder.props.keyInvalid"));
		if (all.some((each) => each !== prop && each.key.toLowerCase() === next.toLowerCase()))
			return setKeyProblem(t("builder.props.keyTaken", { name: next }));
		setKeyProblem(null);
		onChange({ ...prop, key: next }, t("builder.props.renamed", { name: next }));
	};
	return (
		<>
			<div className="flex items-center gap-2">
				<Icon aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
				<span className="truncate text-sm font-medium">{prop.label || prop.key}</span>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className="ms-auto"
					disabled={disabled}
					aria-label={t("builder.props.remove", { name: prop.key })}
					onClick={onRemove}
				>
					<Trash2Icon aria-hidden="true" />
				</Button>
			</div>
			<Field data-invalid={keyProblem ? true : undefined}>
				<FieldLabel htmlFor={`${id}-key`}>{t("builder.props.name")}</FieldLabel>
				<Input
					id={`${id}-key`}
					value={key}
					disabled={disabled}
					className="font-mono text-xs"
					spellCheck={false}
					autoComplete="off"
					aria-invalid={keyProblem ? true : undefined}
					aria-describedby={keyProblem ? `${id}-key-problem` : `${id}-key-help`}
					onChange={(event) => setKey(event.target.value)}
					onBlur={commitKey}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							commitKey();
						}
					}}
				/>
				{keyProblem ? (
					<FieldError id={`${id}-key-problem`}>{keyProblem}</FieldError>
				) : (
					<FieldDescription id={`${id}-key-help`}>
						{t("builder.props.nameHelp", { binding: `{{ props.${prop.key} }}` })}
					</FieldDescription>
				)}
			</Field>
			<Field>
				<FieldLabel htmlFor={`${id}-type`}>{t("builder.props.type")}</FieldLabel>
				<NativeSelect
					id={`${id}-type`}
					value={prop.type}
					disabled={disabled}
					onChange={(event) => {
						const type = event.target.value as FieldType;
						const made = newField(type, prop.key, prop.label) as Prop;
						onChange(
							{
								...made,
								...(prop.id ? { id: prop.id } : {}),
								required: prop.required ?? false,
								...(prop.exposed ? { exposed: true } : {}),
							},
							t("builder.props.retyped", { name: prop.key, type: t(`content.types.${type}`) }),
						);
					}}
				>
					{types.map((type) => (
						<NativeSelectOption key={type} value={type}>
							{t(`content.types.${type}`)}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</Field>
			<label className="flex items-center gap-2 text-sm">
				<input
					type="checkbox"
					className="accent-primary size-4"
					checked={prop.required === true}
					disabled={disabled}
					onChange={(event) => onChange({ ...prop, required: event.target.checked })}
				/>
				{t("builder.props.required")}
			</label>
			<DefaultInput prop={prop} disabled={disabled} onChange={(value) => onChange({ ...prop, default: value })} />
			<label className="flex items-center gap-2 text-sm">
				<input
					type="checkbox"
					className="accent-primary size-4"
					checked={prop.exposed === true}
					disabled={disabled}
					onChange={(event) => onChange({ ...prop, exposed: event.target.checked })}
				/>
				{t("builder.props.exposed")}
			</label>
		</>
	);
}

/** What a default is written as in the box: the text itself, a link's address, `media:<id>` for media. */
function defaultText(prop: Prop): string {
	const value = prop.default;
	if (value === null || value === undefined) return "";
	if (prop.type === "media") return `media:${String(value)}`;
	if (prop.type === "link")
		return typeof value === "object" ? String((value as { url?: string }).url ?? "") : String(value);
	return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

/** A default as stored, from what the box holds; null for an empty box. */
function defaultValue(prop: Prop, text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed) return null;
	if (prop.type === "number") return Number.isFinite(Number(trimmed)) ? Number(trimmed) : trimmed;
	if (prop.type === "media") return trimmed.replace(/^media:/i, "");
	if (prop.type === "link") return { url: trimmed, text: "" };
	return text;
}

/** The default's box: a checkbox for true or false, nothing for types whose defaults are written in the markup. */
function DefaultInput({
	prop,
	disabled,
	onChange,
}: {
	prop: Prop;
	disabled?: boolean;
	onChange(value: unknown): void;
}) {
	const t = useT();
	const id = useId();
	const shown = defaultText(prop);
	const [text, setText] = useState(shown);
	useEffect(() => setText(shown), [shown]);
	if (prop.type === "boolean")
		return (
			<label className="flex items-center gap-2 text-sm">
				<input
					type="checkbox"
					className="accent-primary size-4"
					checked={prop.default === true}
					disabled={disabled}
					onChange={(event) => onChange(event.target.checked)}
				/>
				{t("builder.props.defaultOn")}
			</label>
		);
	if (prop.type === "group" || prop.type === "repeater" || prop.type === "relationship")
		return (
			<p className="text-muted-foreground text-xs">{t("builder.props.defaultInMarkup", { block: "{{@props}}" })}</p>
		);
	const commit = () => {
		if (text === shown) return;
		onChange(defaultValue(prop, text));
	};
	return (
		<Field>
			<FieldLabel htmlFor={`${id}-default`}>{t("builder.props.default")}</FieldLabel>
			<Input
				id={`${id}-default`}
				value={text}
				disabled={disabled}
				autoComplete="off"
				onChange={(event) => setText(event.target.value)}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						commit();
					}
				}}
			/>
			<FieldDescription>
				{t(`builder.props.defaultHelp.${prop.type === "media" ? "media" : prop.type === "link" ? "link" : "text"}`)}
			</FieldDescription>
		</Field>
	);
}
