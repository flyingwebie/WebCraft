import type { FormField, FormFieldType } from "@webcraft/renderer/forms";
import { FORM_LIMITS } from "@webcraft/renderer/forms";
import { formWords as formWordsIn } from "@webcraft/renderer/forms/words";
import { PlusIcon } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { editorHistory } from "../../../../builder/editor-history.ts";
import { FIELD_ICONS } from "../../../../forms/icons.ts";
import { duplicateField, fieldIndexOf, newField } from "../../../../forms/model.ts";
import { fill, type ShellConfig, type Words } from "../../../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../../../controls.tsx";
import { managementApi } from "../../../management.ts";
import { notify } from "../../media/toasts.tsx";
import type { FormEditor } from "../editor.ts";
import type { BuildView } from "../view.ts";
import { AddField } from "./AddField.tsx";
import { FieldSettings } from "./FieldSettings.tsx";
import { type CanvasActions, FormCanvas, type Naming } from "./FormCanvas.tsx";
import {
	addStep,
	type Box,
	type Drop,
	dropAt,
	type FieldWidth,
	insertAt,
	moveStep,
	moveTo,
	nudge,
	removeAt,
	snapWidth,
	stepOf,
	stepRange,
	stepsOf,
} from "./layout.ts";
import { Sheet, type SheetHandle } from "./Sheet.tsx";
import { TryForm } from "./TryForm.tsx";

/** How far the pointer moves before a press becomes a drag. */
const DRAG_AFTER_PX = 4;

/** Languages written right to left, for the sheet's direction. */
const RTL = new Set(["ar", "he", "fa", "ur", "ps", "yi", "dv", "ku", "sd", "ug"]);

/** What is being dragged: a kind from the panel, a field by its grip, or a step's tab. */
type Dragging = { kind: "add"; type: FormFieldType } | { kind: "move"; index: number } | { kind: "step"; step: number };

/** A drag under way: what, where the pointer is, and where it would land. */
type DragState = {
	what: Dragging;
	x: number;
	y: number;
	drop: Drop | null;
	/** Over a step's tab: into that step (a field), or to its place (a step). */
	step: number | null;
};

/** The step whose tab is under the point, if any. */
function stepAt(x: number, y: number): number | null {
	for (const tab of document.querySelectorAll<HTMLElement>("[data-wc-step-tab]")) {
		const rect = tab.getBoundingClientRect();
		if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return Number(tab.dataset.wcStepTab);
	}
	return null;
}

/** An item's name: its label, else its key. */
function nameOf(field: FormField | undefined): string {
	return field ? field.label.text || field.key : "";
}

/** A field's rule as its chip says it: "Shown when Cake is Wedding cake". */
export function ruleText(words: Words, fields: readonly FormField[], field: FormField): string | null {
	const condition = field.condition;
	const first = condition?.rules[0];
	if (!condition || !first) return null;
	const target = fields.find((each) => each.key === first.field);
	const value = target?.options.find((option) => option.value === first.value)?.label.text ?? first.value ?? "";
	const phrase = fill(words.forms.rule.ops[first.op], { field: target?.label.text || first.field, value });
	const all =
		condition.rules.length > 1
			? fill(condition.match === "any" ? words.forms.rule.orMore : words.forms.rule.andMore, {
					rule: phrase,
					count: String(condition.rules.length - 1),
				})
			: phrase;
	return fill(words.forms.rule.shownWhen, { rule: all });
}

/**
 * The Build tab (BA-26, SPEC 15.2; `forms-builder/01`, `02`, `03`, `06`): the Form on a page sheet with
 * the Site's own styles, its steps as tabs above it ("+ Step" adds one), and the right panel (320):
 * "Add a field" with nothing chosen, else the chosen field's settings.
 *
 * - **Add**: drag a kind onto the Form (a line shows where it lands), or click it to add it where the
 *   panel says (after the field chosen with "+" or "Add a field after", else at the step's end).
 * - **Move**: a field's grip, dragged; across sections, and onto a step's tab into that step.
 * - **Width**: a field's right edge, dragged: whole, half or third, snapping; or the Width setting.
 * - **Keys** (`forms-builder/06`): arrows move through the fields, Space picks one up and drops it
 *   (arrows move it meanwhile, Escape puts it back), Delete removes it with an Undo toast, Tab goes into
 *   its settings, Escape clears the choice.
 * - **Try it** (`trying`): the Form fillable on its sheet, its rules and steps working, nothing sent.
 *
 * Every change is a step of the shell's Undo history and saves the Draft after a pause (`FormEditor`).
 */
export function Build({
	config,
	words,
	editor,
	formName,
	view,
	onView,
	trying,
	announce,
}: {
	config: ShellConfig;
	words: Words;
	editor: FormEditor;
	formName: string;
	view: BuildView;
	/** Shows another field or step (the address's view, replaced). */
	onView(view: BuildView): void;
	trying: boolean;
	announce(text: string, urgent?: boolean): void;
}) {
	const shown = words.forms;
	const fields = editor.version.fields;
	const language = config.languages.default;
	const direction = RTL.has(language.split("-")[0] ?? "") ? "rtl" : "ltr";
	const formWords = useMemo(() => formWordsIn(language), [language]);
	const sheet = useRef<SheetHandle>(null);
	const sheetBox = useRef<HTMLDivElement>(null);
	const scroller = useRef<HTMLDivElement>(null);
	const panelId = useId();
	const tabId = useId();
	const [stylesheet, setStylesheet] = useState<string | null>(null);
	const [adding, setAdding] = useState<{ at: number; after: string | null } | null>(null);
	const [lifted, setLifted] = useState<{ index: number; original: FormField[] } | null>(null);
	const [drag, setDrag] = useState<DragState | null>(null);
	const [widthPreview, setWidthPreview] = useState<{ index: number; width: FieldWidth } | null>(null);
	const justDragged = useRef(false);

	// The Site's stylesheet: its Design system's Draft, compiled as its pages get it.
	useEffect(() => {
		let current = true;
		managementApi(config.token)
			.designSystem.preview({ siteId: config.site.id })
			.then(({ preview }) => {
				if (current) setStylesheet(preview.stylesheet);
			})
			.catch(() => {
				if (current) setStylesheet("");
			});
		return () => {
			current = false;
		};
	}, [config.token, config.site.id]);

	const steps = stepsOf(fields);
	const selected = view.field !== null && view.field < fields.length ? view.field : null;
	const step = Math.min(
		Math.max(view.step ?? (selected !== null ? stepOf(fields, selected) : 1), 1),
		Math.max(1, steps.length),
	);
	const range = stepRange(fields, step);
	const latest = useRef({ fields, step, range, selected, editor, view });
	latest.current = { fields, step, range, selected, editor, view };

	const kindOf = useCallback((field: FormField) => shown.kinds[field.type], [shown]);
	const naming = useMemo<Naming>(
		() => ({
			kind: kindOf,
			rule: (field) => ruleText(words, fields, field),
			source: (field) =>
				field.source?.kind === "query"
					? fill(shown.source.query, { name: field.source.name })
					: field.source?.kind === "fixed"
						? shown.source.fixed
						: shown.source.page,
		}),
		[words, shown, fields, kindOf],
	);

	const choose = useCallback(
		(index: number | null, focus = false) => {
			const { fields: now, view: was } = latest.current;
			const nextStep = index === null ? was.step : stepOf(now, index);
			onView({ field: index, step: nextStep });
			setAdding(null);
			if (focus && index !== null) {
				requestAnimationFrame(() =>
					sheet.current?.root
						?.querySelector<HTMLElement>(`[data-wcb-index="${index}"] > [data-wcb-hit]`)
						?.focus({ preventScroll: false }),
				);
			}
		},
		[onView],
	);

	/** Adds a kind: a step at the Form's end, any other at `at` (the step's end unless given). */
	const add = useCallback(
		(type: FormFieldType, at?: number) => {
			const { fields: now, range: shownRange } = latest.current;
			if (now.length >= FORM_LIMITS.fields) return;
			if (type === "step") {
				const made = addStep(now, (number, all) =>
					newField(all, "step", fill(shown.stepTitle, { number: String(number) }), shown.option),
				);
				editor.change(made.items, fill(shown.history.added, { kind: shown.kinds.step }));
				onView({ field: null, step: made.step });
				setAdding(null);
				announce(fill(shown.stepAdded, { number: String(made.step) }));
				return;
			}
			const place = at ?? shownRange.end;
			const field = newField(now, type, shown.kinds[type], shown.option);
			editor.change(insertAt(now, place, field), fill(shown.history.added, { kind: shown.kinds[type] }));
			announce(fill(shown.added, { kind: shown.kinds[type] }));
			choose(place, true);
		},
		[editor, shown, onView, announce, choose],
	);

	const remove = useCallback(
		(index: number) => {
			const { fields: now } = latest.current;
			const field = now[index];
			if (!field) return;
			const next = removeAt(now, index);
			editor.change(next, fill(shown.history.removed, { label: nameOf(field) }));
			notify("success", fill(shown.removed, { label: nameOf(field) }), {
				label: shown.undo,
				run: () => void editorHistory().undo(),
			});
			announce(fill(shown.removed, { label: nameOf(field) }));
			// The choice stays in the step shown: the item after, else the one before, else none.
			const shownStep = Math.min(latest.current.step, Math.max(1, stepsOf(next).length));
			const left = stepRange(next, shownStep).indexes;
			const following = left.find((each) => each >= index) ?? left.at(-1) ?? null;
			if (following === null) onView({ field: null, step: shownStep });
			else choose(following, true);
		},
		[editor, shown, announce, choose, onView],
	);

	const duplicate = useCallback(
		(index: number) => {
			const { fields: now } = latest.current;
			const field = now[index];
			if (!field || now.length >= FORM_LIMITS.fields) return;
			editor.change(duplicateField(now, index), fill(shown.history.duplicated, { label: nameOf(field) }));
			announce(fill(shown.duplicated, { label: nameOf(field) }));
			choose(index + 1, true);
		},
		[editor, shown, announce, choose],
	);

	const setWidth = useCallback(
		(index: number, width: FieldWidth) => {
			const { fields: now } = latest.current;
			const field = now[index];
			if (!field || (field.width ?? "whole") === width) return;
			editor.change(
				now.map((each, at) => (at === index ? { ...each, width } : each)),
				fill(shown.history.width, { label: nameOf(field) }),
			);
			announce(fill(shown.widthSet, { label: nameOf(field), width: shown.width[width] }));
		},
		[editor, shown, announce],
	);

	// --- Dragging: kinds from the panel, fields by their grip, steps by their tab ------------------

	/** The boxes of the items the step shows (a section by its title), on the screen, but `skip`. */
	const boxes = useCallback((skip: number | null): { index: number; box: Box }[] => {
		const root = sheet.current?.root;
		if (!root) return [];
		const found: { index: number; box: Box }[] = [];
		for (const index of latest.current.range.indexes) {
			if (index === skip) continue;
			const element = root.querySelector<HTMLElement>(`[data-wcb-index="${index}"]`);
			const measured = element?.hasAttribute("data-wcb-section")
				? element.querySelector<HTMLElement>(":scope > legend")
				: element;
			if (!measured) continue;
			const rect = measured.getBoundingClientRect();
			found.push({ index, box: { top: rect.top, left: rect.left, width: rect.width, height: rect.height } });
		}
		return found;
	}, []);

	const startDrag = useCallback(
		(event: PointerEvent<HTMLElement>, what: Dragging) => {
			if (event.button !== 0) return;
			const startX = event.clientX;
			const startY = event.clientY;
			let active = false;
			let state: DragState | null = null;
			const where = (x: number, y: number): DragState => {
				const over = stepAt(x, y);
				const area = sheetBox.current?.getBoundingClientRect();
				const inSheet = area
					? x >= area.left - 40 && x <= area.right + 40 && y >= area.top - 24 && y <= area.bottom + 24
					: false;
				if (what.kind === "step") return { what, x, y, drop: null, step: over };
				const drop =
					!over && inSheet
						? dropAt(boxes(what.kind === "move" ? what.index : null), { x, y }, direction === "rtl")
						: null;
				return { what, x, y, drop, step: over };
			};
			const move = (moved: globalThis.PointerEvent) => {
				if (!active) {
					if (Math.hypot(moved.clientX - startX, moved.clientY - startY) < DRAG_AFTER_PX) return;
					active = true;
					if (what.kind === "move") setLifted({ index: what.index, original: [...latest.current.fields] });
				}
				document.getSelection()?.removeAllRanges();
				const area = scroller.current?.getBoundingClientRect();
				if (area && scroller.current) {
					if (moved.clientY < area.top + 40) scroller.current.scrollTop -= 12;
					else if (moved.clientY > area.bottom - 40) scroller.current.scrollTop += 12;
				}
				state = where(moved.clientX, moved.clientY);
				setDrag(state);
			};
			const finish = (apply: boolean) => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
				window.removeEventListener("pointercancel", cancel);
				window.removeEventListener("keydown", onEscape, true);
				setDrag(null);
				setLifted(null);
				if (!active) return;
				justDragged.current = true;
				setTimeout(() => {
					justDragged.current = false;
				}, 0);
				if (!apply || !state) return;
				const { fields: now, range: shownRange } = latest.current;
				if (what.kind === "step") {
					if (state.step !== null && state.step !== what.step) {
						editor.change(moveStep(now, what.step, state.step), shown.history.stepMoved);
						onView({ field: null, step: state.step });
						announce(fill(shown.stepMoved, { from: String(what.step), to: String(state.step) }));
					}
					return;
				}
				const into = state.step !== null ? stepRange(now, state.step).end : null;
				const before = into ?? (state.drop ? (state.drop.before ?? shownRange.end) : null);
				if (before === null) return;
				if (what.kind === "add") add(what.type, before);
				else {
					const field = now[what.index];
					const moved = moveTo(now, what.index, before);
					if (moved.index === what.index && moved.items.every((each, at) => each === now[at])) return;
					editor.change(moved.items, fill(shown.history.moved, { label: nameOf(field) }));
					announce(fill(shown.movedTo, { label: nameOf(field) }));
					choose(moved.index, true);
				}
			};
			const up = () => finish(true);
			const cancel = () => finish(false);
			const onEscape = (pressed: globalThis.KeyboardEvent) => {
				if (pressed.key !== "Escape" || !active) return;
				pressed.preventDefault();
				pressed.stopPropagation();
				finish(false);
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
			window.addEventListener("pointercancel", cancel);
			window.addEventListener("keydown", onEscape, true);
		},
		[boxes, direction, editor, shown, add, announce, choose, onView],
	);

	/** A field's right edge, dragged: its share of the line, snapped to whole, half or third. */
	const startWidth = useCallback(
		(event: PointerEvent<HTMLElement>, index: number) => {
			if (event.button !== 0) return;
			event.preventDefault();
			event.stopPropagation();
			const field = event.currentTarget.parentElement;
			const holder = field?.parentElement;
			if (!field || !holder) return;
			const rtl = getComputedStyle(field).direction === "rtl";
			let width: FieldWidth = (latest.current.fields[index]?.width as FieldWidth | null) ?? "whole";
			const move = (moved: globalThis.PointerEvent) => {
				const own = field.getBoundingClientRect();
				const line = holder.getBoundingClientRect();
				const share = (rtl ? own.right - moved.clientX : moved.clientX - own.left) / Math.max(1, line.width);
				width = snapWidth(share);
				setWidthPreview({ index, width });
			};
			const up = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
				window.removeEventListener("pointercancel", up);
				setWidthPreview(null);
				setWidth(index, width);
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
			window.addEventListener("pointercancel", up);
		},
		[setWidth],
	);

	// --- The keyboard on the canvas ------------------------------------------------------------------

	const focusOption = (index: number) =>
		requestAnimationFrame(() =>
			sheet.current?.root?.querySelector<HTMLElement>(`[data-wcb-index="${index}"] > [data-wcb-hit]`)?.focus(),
		);

	const onKey = (event: KeyboardEvent<HTMLElement>, index: number) => {
		const { fields: now, range: shownRange } = latest.current;
		const order = shownRange.indexes;
		const at = order.indexOf(index);
		const field = now[index];
		const handled = () => {
			event.preventDefault();
			event.stopPropagation();
		};
		if (lifted) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				handled();
				const moved = nudge(now, lifted.index, event.key === "ArrowDown" ? 1 : -1);
				if (moved.index === lifted.index) return;
				editor.change(
					moved.items,
					fill(shown.history.moved, { label: nameOf(field) }),
					`lift:${lifted.original.length}`,
				);
				setLifted({ index: moved.index, original: lifted.original });
				onView({ field: moved.index, step: stepOf(moved.items, moved.index) });
				const position = stepRange(moved.items, stepOf(moved.items, moved.index)).indexes.indexOf(moved.index) + 1;
				announce(fill(shown.keys.moved, { label: nameOf(field), position: String(position) }));
				focusOption(moved.index);
				return;
			}
			if (event.key === " " || event.key === "Enter") {
				handled();
				setLifted(null);
				editorHistory().boundary();
				announce(fill(shown.keys.dropped, { label: nameOf(field) }));
				return;
			}
			if (event.key === "Escape") {
				handled();
				const original = lifted.original;
				const key = now[lifted.index]?.key;
				setLifted(null);
				editor.change(original, fill(shown.history.moved, { label: nameOf(field) }));
				const back = original.findIndex((each) => each.key === key);
				if (back >= 0) {
					onView({ field: back, step: stepOf(original, back) });
					focusOption(back);
				}
				announce(fill(shown.keys.putBack, { label: nameOf(field) }));
				return;
			}
			if (event.key !== "Tab") handled();
			return;
		}
		switch (event.key) {
			case "ArrowDown":
			case "ArrowUp":
			case "Home":
			case "End": {
				handled();
				// Focused but not chosen yet (reached by Tab): the first arrow chooses it.
				const unchosen = latest.current.selected !== index && (event.key === "ArrowDown" || event.key === "ArrowUp");
				const next = unchosen
					? index
					: event.key === "Home"
						? order[0]
						: event.key === "End"
							? order.at(-1)
							: order[Math.min(Math.max(at + (event.key === "ArrowDown" ? 1 : -1), 0), order.length - 1)];
				if (next !== undefined) choose(next, true);
				return;
			}
			case " ":
				handled();
				if (latest.current.selected !== index) choose(index);
				editorHistory().boundary();
				setLifted({ index, original: [...now] });
				announce(fill(shown.keys.picked, { label: nameOf(field) }));
				return;
			case "Delete":
			case "Backspace":
				handled();
				remove(index);
				return;
			case "Enter":
				handled();
				if (latest.current.selected !== index) {
					choose(index, true);
					return;
				}
				document.querySelector<HTMLElement>("[data-wc-field-settings] input, [data-wc-field-settings] button")?.focus();
				return;
			case "Escape":
				// Clears the choice; a second Escape leaves the place (the place hears what isn't handled here).
				if (latest.current.selected === null) return;
				handled();
				onView({ field: null, step: latest.current.step });
				announce(shown.keys.cleared);
				return;
		}
	};

	const actions: CanvasActions = {
		select: (index) => {
			if (latest.current.selected !== index) choose(index);
		},
		key: onKey,
		grip: (event, index) => {
			event.preventDefault();
			event.stopPropagation();
			choose(index);
			startDrag(event, { kind: "move", index });
		},
		width: startWidth,
		addAfter: (index) => {
			const field = latest.current.fields[index];
			onView({ field: null, step: latest.current.step });
			setAdding({ at: index + 1, after: nameOf(field) });
			requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-wc-add-field] button")?.focus());
		},
	};

	const chosen = selected !== null ? fields[selected] : undefined;
	const full = fields.length >= FORM_LIMITS.fields;
	const problems = new Set(
		editor.problems.map((problem) => fieldIndexOf(problem)).filter((index): index is number => index !== null),
	);
	const lastStep = steps.length === 0 || step >= steps.length;
	const draggedLabel =
		drag?.what.kind === "add"
			? shown.kinds[drag.what.type]
			: drag?.what.kind === "move"
				? nameOf(fields[drag.what.index])
				: drag?.what.kind === "step"
					? nameOf(fields[steps[drag.what.step - 1]?.index ?? -1])
					: "";
	const DraggedIcon = drag?.what.kind === "add" ? FIELD_ICONS[drag.what.type] : null;
	const sentMessage = editor.version.success.kind === "message" ? editor.version.success.message.text : null;

	return (
		<div className="flex min-h-0 grow gap-2.5" data-wc-build="" data-wc-trying={trying ? "" : undefined}>
			<div
				ref={scroller}
				className="flex min-h-0 min-w-0 grow flex-col items-center gap-1.5 overflow-y-auto px-6 py-1.5"
			>
				<StepTabs
					words={words}
					fields={fields}
					step={step}
					tabId={tabId}
					panelId={panelId}
					dragging={drag?.what.kind === "step" ? drag : null}
					onShow={(number) => {
						const item = steps[number - 1];
						// The tab of the step shown, chosen again: the step's own settings (its title, help, rule).
						if (number === step && item && !trying) choose(item.index);
						else onView({ field: null, step: number });
					}}
					onAdd={() => add("step")}
					onMove={(from, to) => {
						editor.change(moveStep(fields, from, to), shown.history.stepMoved);
						onView({ field: null, step: to });
						announce(fill(shown.stepMoved, { from: String(from), to: String(to) }));
					}}
					onDrag={(event, number) => startDrag(event, { kind: "step", step: number })}
				/>
				<div ref={sheetBox} className="flex w-full justify-center pb-6">
					<Sheet
						stylesheet={stylesheet}
						language={language}
						direction={direction}
						label={fill(shown.sheet.label, { name: formName })}
						panel={steps.length > 0 ? { id: panelId, tab: `${tabId}-${step}` } : null}
						handle={sheet}
					>
						{stylesheet === null ? null : trying ? (
							<TryForm
								key={editor.formId}
								words={words}
								fields={fields}
								formWords={formWords}
								submitLabel={editor.version.submitLabel.text}
								sentMessage={sentMessage}
								step={step}
								onStep={(number) => onView({ field: latest.current.selected, step: number })}
								announce={announce}
							/>
						) : (
							<FormCanvas
								words={words}
								naming={naming}
								listLabel={fill(shown.sheet.list, { name: formName })}
								on={actions}
								state={{
									fields,
									shown: range.indexes,
									lastStep,
									submitLabel: editor.version.submitLabel.text,
									formWords,
									selected,
									lifted: lifted?.index ?? (drag?.what.kind === "move" ? drag.what.index : null),
									problems,
									widthPreview,
									dragging: drag !== null,
								}}
							/>
						)}
					</Sheet>
				</div>
			</div>
			<aside
				aria-label={shown.panel}
				className="border-chrome-line flex w-80 shrink-0 flex-col overflow-y-auto border-s p-4"
				data-wc-build-panel=""
			>
				{chosen && selected !== null && !adding ? (
					<FieldSettings
						key={selected}
						words={words}
						field={chosen}
						index={selected}
						kind={kindOf(chosen)}
						before={fields.slice(0, selected)}
						problems={editor.problems.filter((problem) => fieldIndexOf(problem) === selected)}
						keyLocked={editor.published?.fields.some((each) => each.key === chosen.key) ?? false}
						onChange={(field) =>
							editor.change(
								fields.map((each, at) => (at === selected ? field : each)),
								fill(shown.history.changed, { label: nameOf(chosen) }),
								`field:${selected}`,
							)
						}
						onWidth={(width) => setWidth(selected, width)}
						onDuplicate={() => duplicate(selected)}
						onRemove={() => remove(selected)}
						onAddAfter={() => {
							onView({ field: null, step });
							setAdding({ at: selected + 1, after: nameOf(chosen) });
							requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-wc-add-field] button")?.focus());
						}}
					/>
				) : (
					<AddField
						words={words}
						heading={adding?.after ? fill(shown.addAfterHeading, { label: adding.after }) : shown.addField}
						full={full}
						onAdd={(type) => {
							if (justDragged.current) return;
							add(type, adding?.at);
						}}
						onDrag={(event, type) => startDrag(event, { kind: "add", type })}
					/>
				)}
			</aside>
			{drag && drag.what.kind !== "step" ? (
				<>
					<div
						aria-hidden="true"
						className="bg-chrome-raised text-chrome-strong ring-selection pointer-events-none fixed z-50 flex h-8 items-center gap-1.5 rounded-[7px] px-2.5 text-[12px] font-medium shadow-[0_8px_24px_rgba(0,0,0,0.5)] ring-2"
						style={{ left: drag.x + 12, top: drag.y - 44 }}
						data-wc-drag-ghost=""
					>
						{DraggedIcon ? <DraggedIcon aria-hidden="true" className="size-3.5" /> : null}
						{draggedLabel}
					</div>
					{drag.drop ? <DropLine drop={drag.drop} label={fill(shown.goesHere, { label: draggedLabel })} /> : null}
				</>
			) : null}
		</div>
	);
}

/** The line where a dragged field lands, with "{kind} goes here" on it (`forms-builder/02`; above it, down a line of fields). */
function DropLine({ drop, label }: { drop: Drop; label: string }) {
	const { line } = drop;
	return (
		<div
			aria-hidden="true"
			className="pointer-events-none fixed z-40"
			style={
				line.vertical
					? { left: line.x - 1, top: line.y, width: 2, height: line.length }
					: { left: line.x, top: line.y - 1, width: line.length, height: 2 }
			}
			data-wc-drop-line=""
		>
			<div className="bg-selection absolute inset-0 rounded-full" />
			<span
				className={`bg-selection absolute rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-white ${
					line.vertical
						? "bottom-full left-1/2 mb-1 -translate-x-1/2"
						: "top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
				}`}
			>
				{label}
			</span>
		</div>
	);
}

/**
 * The Form's steps as tabs above the sheet ("1 Your details · 2 Your cake · + Step"), the sheet their
 * panel. A tab is dragged to a new place, or moved with Alt and the arrows; the tab shown, chosen again,
 * opens the step's own settings. Without steps only "+ Step" shows.
 */
function StepTabs({
	words,
	fields,
	step,
	tabId,
	panelId,
	dragging,
	onShow,
	onAdd,
	onMove,
	onDrag,
}: {
	words: Words;
	fields: readonly FormField[];
	step: number;
	tabId: string;
	panelId: string;
	dragging: DragState | null;
	onShow(step: number): void;
	onAdd(): void;
	onMove(from: number, to: number): void;
	onDrag(event: PointerEvent<HTMLButtonElement>, step: number): void;
}) {
	const shown = words.forms;
	const steps = stepsOf(fields);
	const list = useRef<HTMLDivElement>(null);
	const focusTab = (number: number) =>
		requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-wc-step-tab="${number}"]`)?.focus());
	return (
		<div className="flex shrink-0 items-center gap-1.5 py-1" data-wc-steps="">
			{steps.length > 0 ? (
				<div ref={list} role="tablist" aria-label={shown.steps} className="flex items-center gap-1.5">
					{steps.map(({ index, number }) => {
						const current = number === step;
						const target = dragging?.step === number && dragging.what.kind === "step" && dragging.what.step !== number;
						return (
							<button
								key={index}
								id={`${tabId}-${number}`}
								type="button"
								role="tab"
								aria-selected={current}
								aria-controls={current ? panelId : undefined}
								aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
								tabIndex={current ? 0 : -1}
								onClick={() => onShow(number)}
								onPointerDown={(event) => onDrag(event, number)}
								onKeyDown={(event) => {
									const by = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
									if (event.key === "Home" || event.key === "End") {
										event.preventDefault();
										const to = event.key === "Home" ? 1 : steps.length;
										onShow(to);
										focusTab(to);
										return;
									}
									if (by === 0) return;
									event.preventDefault();
									const to = Math.min(Math.max(number + by, 1), steps.length);
									if (to === number) return;
									if (event.altKey) onMove(number, to);
									else onShow(to);
									focusTab(to);
								}}
								className={`border-chrome-hover h-8 touch-none rounded-[7px] border px-3.5 text-[12px] font-medium ${
									current ? "bg-chrome-raised text-chrome-strong" : "text-chrome-muted hover:text-chrome-text"
								} ${target ? "ring-selection ring-2" : ""} ${dragging?.what.kind === "step" && dragging.what.step === number ? "opacity-50" : ""} ${CHROME_EASE} ${FOCUS_RING}`}
								data-wc-step-tab={number}
							>
								{fill(shown.stepTab, { number: String(number), title: fields[index]?.label.text ?? "" })}
							</button>
						);
					})}
				</div>
			) : null}
			<button
				type="button"
				onClick={onAdd}
				aria-label={shown.addStep}
				className={`border-chrome-hover text-chrome-muted hover:text-chrome-text inline-flex h-8 items-center gap-1 rounded-[7px] border border-dashed px-3 text-[12px] ${CHROME_EASE} ${FOCUS_RING}`}
				data-wc-add-step=""
			>
				<PlusIcon aria-hidden="true" className="size-3.5" />
				{shown.step}
			</button>
		</div>
	);
}
