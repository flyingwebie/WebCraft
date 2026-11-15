import type { FieldDefinition } from "@webcraft/core";
import type { FieldType } from "@webcraft/core/field-rules";
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
	ShapesIcon,
	ToggleLeftIcon,
	TypeIcon,
	WaypointsIcon,
	XIcon,
} from "lucide-react";
import { useRef, useState, useSyncExternalStore } from "react";

import { identifyNewProps } from "../../builder/prop-identities.ts";
import { draftsOf, freeKey, newField } from "../../content/field-drafts.ts";
import { fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";
import { ChromeMenu, type MenuEntry } from "../docks/Menu.tsx";
import { PanelButton } from "../docks/PanelFrame.tsx";
import type { InPlaceTarget } from "../editing/component-in-place.ts";
import type { Structure } from "../editing/selection.ts";
import { CommitInput, Note } from "./inputs.tsx";

/**
 * The Component panel (SPEC 5, `builder/06`; BA-09): in the left dock while a Component is edited in
 * place, titled with its name in the Component colour. It lists the Component's Props (each by its
 * type, label and the binding that reads it, `props.quote`), "No Props yet" when there are none, and
 * "+" adds one of a type from a menu. A label is renamed in place; × removes a Prop. Each change is
 * one Undo step through the Component's shared Draft, which the server checks as it checks the
 * `{{@props}}` block.
 */

/** The Prop types the "+" menu offers, in its order: the Field types, Body aside (a Component takes none). */
const PROP_TYPES: readonly Exclude<FieldType, "body">[] = [
	"text",
	"richText",
	"number",
	"boolean",
	"select",
	"media",
	"link",
	"date",
	"email",
	"relationship",
	"group",
	"repeater",
];

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

/** The panel's "+" (Add a Prop) and its menu of types, for the panel's header. */
export function AddPropButton({
	structure,
	words,
	target,
}: {
	structure: Structure;
	words: Words;
	target: InPlaceTarget;
}) {
	const said = words.placements.component;
	const button = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const menuId = "wc-add-prop";
	const add = (type: Exclude<FieldType, "body">) => {
		const source = structure.snapshot().sources.get(target.source);
		const props = source?.props ?? [];
		const key = freeKey(type === "boolean" ? "switch" : type.toLowerCase(), draftsOf(props as never));
		const label = said.types[type];
		const made = newField(type, key, label) as FieldDefinition;
		const next = identifyNewProps([...props, made] as never) as unknown as FieldDefinition[];
		structure.changeProps(
			target.source,
			next,
			fill(words.placements.steps.addProp, { prop: label, name: target.name }),
		);
	};
	const entries: MenuEntry[] = PROP_TYPES.map((type) => ({
		kind: "item",
		key: type,
		icon: TYPE_ICONS[type],
		label: said.types[type],
		onSelect: () => add(type),
	}));
	return (
		<>
			<PanelButton
				icon={PlusIcon}
				label={said.add}
				align="end"
				buttonRef={button}
				menu={{ open, id: menuId }}
				onClick={() => setOpen((was) => !was)}
				data={{ "data-wc-add-prop": "" }}
			/>
			<ChromeMenu
				id={menuId}
				open={open}
				onClose={(focusButton) => {
					setOpen(false);
					if (focusButton) button.current?.focus();
				}}
				anchor={button}
				placement="below"
				label={said.addMenu}
				entries={entries}
				width={200}
			/>
		</>
	);
}

export function ComponentPanel({
	structure,
	words,
	target,
}: {
	structure: Structure;
	words: Words;
	target: InPlaceTarget;
}) {
	const snapshot = useSyncExternalStore(structure.subscribe, structure.snapshot);
	const said = words.placements.component;
	const [problem, setProblem] = useState<string | null>(null);
	const source = snapshot.sources.get(target.source);
	if (!source) return <Note>{words.structure.loading}</Note>;
	const props = source.props ?? [];
	const readOnly = !source.editable;
	const change = (next: FieldDefinition[], label: string) => {
		const refused = structure.changeProps(target.source, next, label);
		setProblem(refused);
		return refused === null;
	};
	if (props.length === 0) {
		return (
			<div className="flex h-[140px] flex-col items-center justify-center gap-2 text-center" data-wc-no-props="">
				<ShapesIcon aria-hidden="true" className="text-chrome-muted size-5" />
				<p className="text-chrome-muted text-[12px] font-medium">{said.noProps}</p>
				<p className="text-chrome-faint text-[11px]">{said.addHint}</p>
			</div>
		);
	}
	return (
		<div className="flex min-h-0 grow flex-col gap-1.5 overflow-auto pb-2" data-wc-component-props="">
			{readOnly ? (
				<p className="text-chrome-warn px-1 text-[12px]">
					{fill(words.structure.readOnly, { name: source.name ?? words.structure.thisSource })}
				</p>
			) : null}
			<ul className="flex flex-col gap-1.5">
				{props.map((prop, index) => {
					const Icon = TYPE_ICONS[prop.type as Exclude<FieldType, "body">] ?? TypeIcon;
					const label = prop.label || prop.key;
					return (
						<li
							key={prop.id ?? prop.key}
							className="bg-chrome-raised flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5"
							data-wc-prop={prop.key}
						>
							<Icon aria-hidden="true" className="text-chrome-muted size-3.5 shrink-0" />
							<div className="flex min-w-0 grow flex-col">
								<CommitInput
									value={prop.label}
									label={fill(said.label, { name: prop.key })}
									disabled={readOnly}
									onCommit={(next) =>
										change(
											props.map((each, at) => (at === index ? { ...each, label: next.trim() || each.key } : each)),
											fill(words.placements.steps.renameProp, { prop: label, name: target.name }),
										)
									}
								/>
								<span className="text-chrome-muted truncate font-mono text-[11px]">{`props.${prop.key}`}</span>
							</div>
							<button
								type="button"
								disabled={readOnly}
								aria-label={fill(said.remove, { name: label })}
								onClick={() =>
									change(
										props.filter((_, at) => at !== index),
										fill(words.placements.steps.removeProp, { prop: label, name: target.name }),
									)
								}
								className={`text-chrome-muted hover:bg-chrome-hover hover:text-chrome-strong grid size-6 shrink-0 place-items-center rounded-[4px] disabled:opacity-50 ${CHROME_EASE} ${FOCUS_RING}`}
							>
								<XIcon aria-hidden="true" className="size-3.5" />
							</button>
						</li>
					);
				})}
			</ul>
			{problem ? (
				<p role="alert" className="text-chrome-warn px-1 text-[12px]">
					{problem}
				</p>
			) : null}
		</div>
	);
}
