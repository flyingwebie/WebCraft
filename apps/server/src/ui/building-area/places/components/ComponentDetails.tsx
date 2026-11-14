import { Trash2Icon } from "lucide-react";
import { type ReactNode, type Ref, useId } from "react";

import { fill, type Words } from "../../api.ts";
import type { GoToData } from "../../management.ts";
import { Card, Switch } from "../content/post-types/controls.tsx";
import { dangerLook } from "../content/post-types/DeleteDialog.tsx";
import { buttonLook } from "../content/ui.tsx";
import { type ComponentRow, nameOfUse, orderedUses } from "./data.ts";

/** A part of the details panel: its label over what it holds (radius 6, on the raised colour). */
function Part({
	label,
	children,
	data,
}: {
	label: string;
	children: ReactNode;
	data?: Record<`data-${string}`, string>;
}) {
	const id = useId();
	return (
		<section aria-labelledby={id} className="bg-chrome-raised flex flex-col gap-1.5 rounded-md px-2 py-1.5" {...data}>
			<h3 id={id} className="text-chrome-muted m-0 text-[11px] font-medium">
				{label}
			</h3>
			{children}
		</section>
	);
}

/**
 * The details panel of the Components place (`places-content/05`, 300 wide at the place's end): the
 * Component's name, its Props (key and kind), the Allowed for Members switch, where it is used, then
 * Edit and Duplicate, and Delete. A Module's Component changes with its Module: it shows what it is,
 * with the switch only.
 */
export function ComponentDetails({
	words,
	component,
	allowed,
	goTo,
	busy,
	onAllowed,
	onEdit,
	onDuplicate,
	onDelete,
	deleteRef,
}: {
	words: Words;
	component: ComponentRow;
	allowed: boolean;
	goTo: GoToData;
	/** Something is being done to it (a duplicate): its actions wait. */
	busy: "duplicate" | null;
	onAllowed(allowed: boolean): void;
	onEdit(): void;
	onDuplicate(): void;
	onDelete(): void;
	deleteRef: Ref<HTMLButtonElement>;
}) {
	const shown = words.components;
	const kinds = words.postTypes.fields.kinds as Record<string, string>;
	const switchId = useId();
	const helpId = useId();
	const uses = orderedUses(component.usage.usedIn);
	const props = component.draft.props;
	return (
		<>
			<h2 className="text-chrome-strong m-0 truncate text-[15px] font-semibold" data-wc-component-details-name="">
				{component.name}
			</h2>
			<Part label={shown.props} data={{ "data-wc-component-props": "" }}>
				{props.length === 0 ? (
					<p className="text-chrome-muted m-0 text-[12px]">{shown.noProps}</p>
				) : (
					<ul className="m-0 flex list-none flex-col gap-1.5 p-0">
						{props.map((prop) => (
							<li key={prop.key} className="flex items-center justify-between gap-2">
								<span className="text-chrome-text min-w-0 truncate text-[12px]">{prop.key}</span>
								<span className="text-chrome-muted shrink-0 font-mono text-[11px]">
									{kinds[prop.type] ?? prop.type}
								</span>
							</li>
						))}
					</ul>
				)}
			</Part>
			<Card label={shown.allowedSwitch} htmlFor={switchId} help={shown.allowedHelp} helpId={helpId}>
				<Switch
					id={switchId}
					checked={allowed}
					onChange={onAllowed}
					words={{ on: shown.on, off: shown.off }}
					describedBy={helpId}
					data={{ "data-wc-component-allowed": "" }}
				/>
			</Card>
			<Part label={shown.usedOn} data={{ "data-wc-component-used-on": "" }}>
				{uses.length === 0 ? (
					<p className="text-chrome-muted m-0 text-[12px]">{shown.notUsed}</p>
				) : (
					<ul className="m-0 flex list-none flex-col gap-1 p-0">
						{uses.map((use) => (
							<li key={`${use.kind}:${use.id}`} className="text-chrome-text truncate text-[12px]">
								{nameOfUse(words, use, goTo)}
							</li>
						))}
					</ul>
				)}
			</Part>
			<div className="grow" />
			{component.module ? (
				<p className="text-chrome-muted m-0 text-[12px]">{fill(shown.fromModule, { module: component.module.id })}</p>
			) : (
				<>
					<div className="flex gap-2">
						<button
							type="button"
							onClick={onEdit}
							className={`${buttonLook("primary")} flex-1`}
							data-wc-component-edit=""
						>
							{shown.edit}
						</button>
						<button
							type="button"
							onClick={onDuplicate}
							disabled={busy !== null}
							className={`${buttonLook("outline")} flex-1`}
							data-wc-component-duplicate=""
						>
							{busy === "duplicate" ? shown.duplicating : shown.duplicate}
						</button>
					</div>
					<button
						ref={deleteRef}
						type="button"
						onClick={onDelete}
						disabled={busy !== null}
						aria-label={fill(shown.deleteNamed, { name: component.name })}
						className={`${dangerLook} w-full`}
						data-wc-component-delete=""
					>
						<Trash2Icon aria-hidden="true" className="size-3.5" />
						{shown.delete}
					</button>
				</>
			)}
		</>
	);
}
