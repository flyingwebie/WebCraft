import type { FormFieldType } from "@webcraft/renderer/forms";
import type { PointerEvent } from "react";

import { FIELD_ICONS } from "../../../../forms/icons.ts";
import type { Words } from "../../../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../../../controls.tsx";

/** The kinds a field can be, in the panel's order (SPEC 15.2), then the layout items. */
export const FIELD_KINDS = [
	"text",
	"email",
	"phone",
	"url",
	"textarea",
	"number",
	"date",
	"select",
	"radio",
	"checkboxes",
	"consent",
	"file",
	"hidden",
] as const satisfies readonly FormFieldType[];

export const LAYOUT_KINDS = ["section", "step"] as const satisfies readonly FormFieldType[];

/**
 * "Add a field" (SPEC 15.2, `forms-builder/02` and `06`): the right panel with nothing chosen on the
 * canvas, or after "+": the kinds as small cards, then Section and Step under Layout. Clicking a card
 * (or Enter on it) adds that kind where the panel says; dragging it onto the Form adds it where the
 * line shows. Every card is greyed while the Form holds as many items as it may.
 */
export function AddField({
	words,
	heading,
	full,
	onAdd,
	onDrag,
}: {
	words: Words;
	/** "Add a field", or where the field goes ("Add a field after Email"). */
	heading: string;
	/** The Form holds as many items as it may: nothing more can go in. */
	full: boolean;
	onAdd(type: FormFieldType): void;
	onDrag(event: PointerEvent<HTMLButtonElement>, type: FormFieldType): void;
}) {
	const shown = words.forms;
	const card = (type: FormFieldType) => {
		const Glyph = FIELD_ICONS[type];
		return (
			<li key={type} className="flex">
				<button
					type="button"
					disabled={full}
					onClick={() => onAdd(type)}
					onPointerDown={(event) => {
						if (!full && event.button === 0) onDrag(event, type);
					}}
					aria-label={`${shown.add} ${shown.kinds[type]}`}
					className={`bg-chrome-raised text-chrome-text hover:bg-chrome-hover active:ring-selection flex h-11 w-full touch-none flex-col items-center justify-center gap-1 rounded-[7px] text-[11px] font-medium active:ring-2 disabled:cursor-default disabled:opacity-40 ${CHROME_EASE} ${FOCUS_RING}`}
					title={full ? shown.full : undefined}
					data-wc-kind={type}
				>
					<Glyph aria-hidden="true" className="text-chrome-muted size-3.5" />
					<span aria-hidden="true">{shown.kinds[type]}</span>
				</button>
			</li>
		);
	};
	return (
		<section aria-labelledby="wc-add-field" className="flex flex-col gap-2" data-wc-add-field="">
			<h2 id="wc-add-field" className="text-chrome-strong m-0 text-[14px] font-semibold">
				{heading}
			</h2>
			<ul className="m-0 grid list-none grid-cols-2 gap-1.5 p-0">{FIELD_KINDS.map(card)}</ul>
			<h3 className="text-chrome-muted m-0 mt-1.5 text-[11px] font-semibold tracking-wide uppercase">{shown.layout}</h3>
			<ul className="m-0 grid list-none grid-cols-2 gap-1.5 p-0">{LAYOUT_KINDS.map(card)}</ul>
			{full ? <p className="text-chrome-muted m-0 text-[11px]">{shown.full}</p> : null}
		</section>
	);
}
