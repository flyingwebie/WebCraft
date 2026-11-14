import { CopyIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useId } from "react";

import { FieldPanel } from "../../../../forms/FieldPanel.tsx";
import type { FormField, FormProblem } from "../../../../forms/model.ts";
import { fill, type Words } from "../../../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../../../controls.tsx";
import { buttonLook } from "../../content/ui.tsx";
import { type FieldWidth, WIDTH_SHARES } from "./layout.ts";

/**
 * The admin's field settings drawn as the frame's cards (`forms-builder/01`): each setting on a raised
 * card, its label small above a value with no box of its own. The settings are the admin's own parts
 * (`ui/forms/FieldPanel.tsx`, with the shared components), so this is their look on the chrome only.
 */
const CARDS = [
	"**:data-[slot=field-group]:gap-2.5",
	"**:data-[slot=field]:bg-chrome-raised **:data-[slot=field]:gap-1 **:data-[slot=field]:rounded-md **:data-[slot=field]:px-2 **:data-[slot=field]:py-1.5",
	"**:data-[slot=field-label]:text-chrome-muted **:data-[slot=field-label]:text-[11px] **:data-[slot=field-label]:font-medium",
	"**:data-[slot=input]:text-chrome-strong **:data-[slot=input]:h-6 **:data-[slot=input]:rounded-sm **:data-[slot=input]:border-0 **:data-[slot=input]:bg-transparent **:data-[slot=input]:px-0 **:data-[slot=input]:text-[12px] **:data-[slot=input]:font-medium **:data-[slot=input]:shadow-none",
	"**:data-[slot=input]:focus-visible:ring-chrome-focus **:data-[slot=input]:focus-visible:ring-2",
	"**:data-[slot=field-description]:text-[11px] **:data-[slot=field-error]:text-[11px]",
	"[&_fieldset]:text-[12px] [&_label]:text-[12px] [&_p]:text-[11px]",
].join(" ");

/**
 * The right panel with a field chosen (SPEC 15.2): its name and kind, then its settings (label, help,
 * placeholder, required and its message, its width, its kind's own rules, "Show only when" (which may
 * read only the fields before it), its key), Duplicate and Remove. A section's or a step's are its
 * title, help and when it shows.
 */
export function FieldSettings({
	words,
	field,
	index,
	kind,
	before,
	problems,
	keyLocked,
	onChange,
	onWidth,
	onDuplicate,
	onRemove,
	onAddAfter,
}: {
	words: Words;
	field: FormField;
	index: number;
	/** The field's kind, in the place's words. */
	kind: string;
	before: readonly FormField[];
	problems: readonly FormProblem[];
	/** Published under this key: it can't change any more. */
	keyLocked: boolean;
	onChange(field: FormField): void;
	onWidth(width: FieldWidth): void;
	onDuplicate(): void;
	onRemove(): void;
	onAddAfter(): void;
}) {
	const shown = words.forms;
	const heading = useId();
	const layout = field.type === "section" || field.type === "step";
	return (
		<section aria-labelledby={heading} className="flex min-h-full flex-col gap-2.5" data-wc-field-settings={field.key}>
			<div className="flex items-start gap-2">
				<div className="flex min-w-0 grow flex-col gap-0.5">
					<h2 id={heading} className="text-chrome-strong m-0 truncate text-[14px] font-semibold">
						{field.label.text || field.key}
					</h2>
					<p className="text-chrome-muted m-0 text-[12px]">{fill(shown.kindField, { kind })}</p>
				</div>
				{field.type === "step" ? null : (
					<span className="group relative inline-flex">
						<button
							type="button"
							onClick={onAddAfter}
							aria-label={fill(shown.addAfter, { label: field.label.text || field.key })}
							className={`text-chrome-muted hover:bg-chrome-hover hover:text-chrome-strong inline-grid size-7 shrink-0 place-items-center rounded-md ${CHROME_EASE} ${FOCUS_RING}`}
							data-wc-add-after=""
						>
							<PlusIcon aria-hidden="true" className="size-4" />
						</button>
					</span>
				)}
			</div>
			<div className={CARDS}>
				<FieldPanel
					key={`${index}:${field.type}`}
					field={field}
					onChange={onChange}
					problems={problems}
					index={index}
					before={before}
					layout="place"
					keyLocked={keyLocked ? shown.keyLocked : null}
					width={
						layout || field.type === "hidden" ? null : (
							<WidthSetting words={words} width={(field.width as FieldWidth | null) ?? "whole"} onWidth={onWidth} />
						)
					}
				/>
			</div>
			<div className="mt-auto flex gap-2 pt-2">
				<button type="button" className={`${buttonLook("outline")} grow`} onClick={onDuplicate} data-wc-duplicate="">
					<CopyIcon aria-hidden="true" className="size-3.5" />
					{shown.duplicate}
				</button>
				<button
					type="button"
					className={`${buttonLook("outline")} border-chrome-danger/60 text-chrome-danger grow`}
					onClick={onRemove}
					aria-keyshortcuts="Delete"
					data-wc-remove=""
				>
					<Trash2Icon aria-hidden="true" className="size-3.5" />
					{shown.remove}
				</button>
			</div>
		</section>
	);
}

/** Whole, half or a third of a line (UI-05's widths), as three buttons of one choice. */
function WidthSetting({
	words,
	width,
	onWidth,
}: {
	words: Words;
	width: FieldWidth;
	onWidth(width: FieldWidth): void;
}) {
	const shown = words.forms.width;
	const label = useId();
	const order = Object.keys(WIDTH_SHARES) as FieldWidth[];
	return (
		<div data-slot="field" className="flex flex-col" data-wc-width-setting="">
			<span id={label} data-slot="field-label">
				{shown.label}
			</span>
			<div
				role="radiogroup"
				aria-labelledby={label}
				className="flex gap-1.5"
				onKeyDown={(event) => {
					const at = order.indexOf(width);
					const next =
						event.key === "ArrowRight" || event.key === "ArrowDown"
							? order[(at + 1) % order.length]
							: event.key === "ArrowLeft" || event.key === "ArrowUp"
								? order[(at + order.length - 1) % order.length]
								: null;
					if (!next) return;
					event.preventDefault();
					onWidth(next);
					(event.currentTarget.querySelector(`[data-wc-width-choice="${next}"]`) as HTMLElement | null)?.focus();
				}}
			>
				{order.map((each) => (
					<button
						key={each}
						type="button"
						role="radio"
						aria-checked={width === each}
						tabIndex={width === each ? 0 : -1}
						onClick={() => onWidth(each)}
						className={`border-chrome-hover h-[27px] grow rounded-md border text-[11px] font-medium ${
							width === each ? "bg-chrome-hover text-chrome-strong" : "text-chrome-muted hover:text-chrome-text"
						} ${CHROME_EASE} ${FOCUS_RING}`}
						data-wc-width-choice={each}
					>
						{shown[each]}
					</button>
				))}
			</div>
		</div>
	);
}
