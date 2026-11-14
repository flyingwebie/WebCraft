import type { BuildingAreaApiClient } from "@webcraft/api";
import { AsteriskIcon, CornerDownRightIcon, GripVerticalIcon, PlusIcon } from "lucide-react";
import {
	type DragEvent,
	type KeyboardEvent,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

import { fill, type Words } from "../../../api.ts";
import { CHROME_EASE, FOCUS_RING, Tip } from "../../../controls.tsx";
import type { PostTypeRow } from "../../../management.ts";
import { Badge, buttonLook } from "../ui.tsx";
import { BARE_INPUT, Card, problemsOf, problemText, reasonText } from "./controls.tsx";
import { type FieldChange, FieldDetails } from "./FieldDetails.tsx";
import {
	addTo,
	type FieldDefinition,
	type FieldRow,
	type FieldType,
	fieldAt,
	freeKey,
	holdsFields,
	inputsOf,
	isFieldKey,
	keysAt,
	made,
	moveTo,
	offeredKinds,
	problemPlace,
	removeAt,
	replaceAt,
	rowsOf,
} from "./fields.ts";
import { KIND_ICONS } from "./kinds.ts";

/** Problems the last save had, by the Field's path, then by setting. */
type Problems = ReadonlyMap<string, ReadonlyMap<string, string>>;

/**
 * A Post Type's Fields tab in the Content place (SPEC 8, `places-content/03`): its Fields as one
 * indented list (those inside a Group or Repeater under it, 22 px further in), each with its kind's
 * icon, label, key, a mark when required, Translatable and its kind; "New Field" at the foot; and the
 * details panel (320 wide) of the one chosen, whose path is the place's view (`field=…`), so a
 * reload or Back shows it again.
 *
 * A Field moves among its siblings by dragging its grip, or with the up and down arrows on the grip.
 * Every change saves the whole list with `postTypes.update` (Structure has no Draft, so it applies at
 * once), one save at a time, the newest list last; the bottom bar's Draft state says Saving… and
 * Saved. A refused save keeps the change on screen and shows each problem at its setting.
 */
export function FieldsTab({
	words,
	api,
	siteId,
	postType,
	postTypes,
	selected,
	admin,
	onSelect,
	onSaved,
	onSaving,
	announce,
}: {
	words: Words;
	api: BuildingAreaApiClient;
	siteId: string;
	postType: PostTypeRow;
	postTypes: readonly PostTypeRow[];
	/** The chosen Field's path (from the place's view), if any. */
	selected: string | null;
	/** This Post Type in the admin. */
	admin: string;
	onSelect(path: string | null): void;
	onSaved(postType: PostTypeRow): void;
	onSaving(status: "saving" | "saved" | "failed"): void;
	announce(text: string, urgent?: boolean): void;
}) {
	const shown = words.postTypes.fields;
	const [fields, setFields] = useState<FieldDefinition[]>(() => [...postType.fields]);
	const [problems, setProblems] = useState<Problems>(new Map());
	const [adding, setAdding] = useState<{ parent: string | null } | null>(null);
	const latest = useRef(fields);
	const queued = useRef(false);
	const running = useRef<Promise<void>>(Promise.resolve());
	const refocus = useRef<string | null>(null);
	const list = useRef<HTMLDivElement>(null);
	const listId = useId();
	const pages = postType.builtIn === "page";
	const name = pages ? words.content.pages : postType.name;

	const save = useCallback(async () => {
		queued.current = false;
		const sending = latest.current;
		onSaving("saving");
		try {
			const { postType: saved } = await api.postTypes.update({
				siteId,
				postTypeId: postType.id,
				fields: inputsOf(sending),
			});
			onSaved(saved as PostTypeRow);
			onSaving("saved");
			setProblems(new Map());
			// The server's list (its defaults filled in), unless something changed meanwhile.
			if (latest.current === sending) {
				latest.current = saved.fields as FieldDefinition[];
				setFields(saved.fields as FieldDefinition[]);
			}
		} catch (error) {
			onSaving("failed");
			const found = new Map<string, Map<string, string>>();
			for (const problem of problemsOf(error)) {
				const place = problemPlace(sending, problem.at);
				const key = place.path ?? "";
				const settings = found.get(key) ?? new Map<string, string>();
				settings.set(place.setting, problemText(words, problem));
				found.set(key, settings);
			}
			setProblems(found);
			announce(fill(shown.saveFailed, { label: name, reason: reasonText(words, error) }), true);
		}
	}, [api, siteId, postType.id, onSaved, onSaving, announce, words, shown.saveFailed, name]);

	/** Takes a new list of Fields and saves it, after any save under way. */
	const commit = useCallback(
		(next: FieldDefinition[]) => {
			latest.current = next;
			setFields(next);
			if (queued.current) return;
			queued.current = true;
			running.current = running.current.then(save);
		},
		[save],
	);

	// A moved Field keeps the focus on its grip.
	useLayoutEffect(() => {
		const path = refocus.current;
		if (path === null) return;
		refocus.current = null;
		list.current?.querySelector<HTMLElement>(`[data-wc-field-grip="${CSS.escape(path)}"]`)?.focus();
	});

	const rows = rowsOf(fields);
	const chosen = selected ? fieldAt(fields, selected) : null;

	const move = (row: FieldRow, to: number) => {
		if (to < 0 || to >= row.siblings || to === row.index) return;
		refocus.current = row.path;
		commit(moveTo(fields, row.path, to));
		announce(
			fill(shown.moved, {
				label: row.field.label || row.field.key,
				place: String(to + 1),
				count: String(row.siblings),
			}),
		);
	};

	const change = (path: string, update: FieldChange) => commit(replaceAt(latest.current, path, update));

	const remove = (path: string) => {
		const field = fieldAt(latest.current, path);
		commit(removeAt(latest.current, path));
		onSelect(null);
		announce(fill(shown.deletedField, { label: field?.label || path }));
		list.current?.querySelector<HTMLElement>("[data-wc-field-new]")?.focus();
	};

	const add = (parent: string | null, field: FieldDefinition) => {
		commit(addTo(latest.current, parent, field));
		setAdding(null);
		const path = parent === null ? field.key : `${parent}.${field.key}`;
		onSelect(path);
		announce(fill(shown.added, { label: field.label }));
	};

	return (
		<div className="flex min-h-0 grow" data-wc-fields={postType.key}>
			<div ref={list} className="flex min-w-0 grow flex-col gap-0.5 overflow-y-auto p-4">
				<h3 id={listId} className="sr-only">
					{fill(shown.list, { name })}
				</h3>
				{problems.get("")?.size ? (
					<p role="alert" className="text-chrome-danger m-0 px-2 pb-2 text-[12px]">
						{[...(problems.get("")?.values() ?? [])].join(" ")}
					</p>
				) : null}
				{rows.length === 0 ? <p className="text-chrome-muted m-0 px-2 py-2 text-[12px]">{shown.empty}</p> : null}
				<ul aria-labelledby={listId} className="m-0 flex list-none flex-col gap-0.5 p-0">
					{rows.map((row) => (
						<FieldListRow
							key={row.path}
							words={words}
							row={row}
							current={row.path === selected}
							flagged={problems.has(row.path)}
							onChoose={() => {
								setAdding(null);
								onSelect(row.path);
							}}
							onMove={(to) => move(row, to)}
							onDrop={(from, to) => {
								const dragged = rows.find((each) => each.path === from);
								if (dragged && dragged.parent === row.parent) move(dragged, to);
							}}
						/>
					))}
				</ul>
				<button
					type="button"
					onClick={() => {
						setAdding({ parent: null });
						onSelect(null);
					}}
					aria-expanded={adding?.parent === null}
					className={`text-chrome-faint hover:bg-chrome-raised hover:text-chrome-text flex h-9 items-center gap-2 rounded-md px-2 text-start text-[12px] ${CHROME_EASE} ${FOCUS_RING}`}
					data-wc-field-new=""
				>
					<PlusIcon aria-hidden="true" className="size-3.5" />
					{shown.newField}
				</button>
			</div>

			<aside
				aria-label={chosen ? chosen.label || chosen.key : adding ? shown.newField : fill(shown.list, { name })}
				className="border-chrome-line flex w-80 shrink-0 flex-col overflow-y-auto border-s p-4"
				data-wc-field-panel=""
			>
				{adding ? (
					<NewField
						key={adding.parent ?? ""}
						words={words}
						fields={fields}
						parent={adding.parent}
						pages={pages}
						postTypeName={name}
						onAdd={(field) => add(adding.parent, field)}
						onCancel={() => {
							setAdding(null);
							list.current?.querySelector<HTMLElement>("[data-wc-field-new]")?.focus();
						}}
					/>
				) : chosen && selected ? (
					<FieldDetails
						key={selected}
						words={words}
						field={chosen}
						path={selected}
						postTypes={postTypes}
						admin={admin}
						problems={problems.get(selected) ?? new Map()}
						canAddInside={holdsFields(chosen, selected)}
						onChange={(update) => change(selected, update)}
						onAddInside={() => setAdding({ parent: selected })}
						onDelete={() => remove(selected)}
					/>
				) : (
					<p className="text-chrome-muted m-0 text-[12px]">{shown.selectHint}</p>
				)}
			</aside>
		</div>
	);
}

/** The data type a dragged Field carries: its path. */
const DRAG_TYPE = "application/x-webcraft-field";

/** One Field in the list: its grip (drag, or the arrows), and the row that chooses it. */
function FieldListRow({
	words,
	row,
	current,
	flagged,
	onChoose,
	onMove,
	onDrop,
}: {
	words: Words;
	row: FieldRow;
	current: boolean;
	flagged: boolean;
	onChoose(): void;
	onMove(to: number): void;
	onDrop(from: string, to: number): void;
}) {
	const shown = words.postTypes.fields;
	const [over, setOver] = useState<"before" | "after" | null>(null);
	const help = useId();
	const label = row.field.label || row.field.key;
	const Glyph = KIND_ICONS[row.field.type];
	const Grip = row.depth > 1 ? CornerDownRightIcon : GripVerticalIcon;

	const onKey = (event: KeyboardEvent<HTMLButtonElement>) => {
		const step = { ArrowUp: -1, ArrowDown: 1 }[event.key];
		if (step === undefined) return;
		event.preventDefault();
		onMove(row.index + step);
	};

	const where = (event: DragEvent<HTMLLIElement>) => {
		const box = event.currentTarget.getBoundingClientRect();
		return event.clientY < box.top + box.height / 2 ? "before" : "after";
	};

	return (
		<li
			className="relative"
			onDragOver={(event) => {
				if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "move";
				setOver(where(event));
			}}
			onDragLeave={() => setOver(null)}
			onDrop={(event) => {
				const from = event.dataTransfer.getData(DRAG_TYPE);
				const side = where(event);
				setOver(null);
				if (!from) return;
				event.preventDefault();
				const fromIndex = Number(event.dataTransfer.getData("text/x-webcraft-index") || "-1");
				// Dropped after a row: its place, or the next one when coming from above.
				let to = side === "before" ? row.index : row.index + 1;
				if (fromIndex >= 0 && fromIndex < to) to -= 1;
				onDrop(from, to);
			}}
			data-wc-field-row={row.path}
		>
			{over ? (
				<span
					aria-hidden="true"
					className={`bg-selection absolute inset-x-2 h-0.5 rounded-full ${over === "before" ? "-top-px" : "-bottom-px"}`}
				/>
			) : null}
			<div
				className={`flex h-9 items-center gap-2 rounded-md pe-2 ${current ? "bg-chrome-raised" : "hover:bg-chrome-raised"} ${CHROME_EASE}`}
				style={{ paddingInlineStart: 8 + (row.depth - 1) * 22 }}
			>
				<span className="group relative inline-flex shrink-0">
					<button
						type="button"
						draggable
						onDragStart={(event) => {
							event.dataTransfer.setData(DRAG_TYPE, row.path);
							event.dataTransfer.setData("text/x-webcraft-index", String(row.index));
							event.dataTransfer.effectAllowed = "move";
						}}
						onKeyDown={onKey}
						aria-label={fill(shown.move, { label })}
						aria-describedby={help}
						aria-keyshortcuts="ArrowUp ArrowDown"
						className={`text-chrome-faint hover:text-chrome-text inline-grid size-5 cursor-grab place-items-center rounded-sm ${FOCUS_RING}`}
						data-wc-field-grip={row.path}
					>
						<Grip aria-hidden="true" className="size-3.5" />
					</button>
					<span id={help} className="sr-only">
						{shown.moveHelp}
					</span>
					<Tip label={fill(shown.move, { label })} keys="↑ ↓" side="bottom" />
				</span>
				<button
					type="button"
					onClick={onChoose}
					aria-current={current ? "true" : undefined}
					className={`flex h-7 min-w-0 grow items-center gap-2 rounded-sm text-start ${FOCUS_RING}`}
					data-wc-field-choose={row.path}
				>
					<Glyph aria-hidden="true" className="text-chrome-muted size-3.5 shrink-0" />
					<span className={`truncate text-[12px] font-medium ${flagged ? "text-chrome-danger" : "text-chrome-text"}`}>
						{label}
					</span>
					<span className="text-chrome-faint shrink-0 font-mono text-[11px]">{row.field.key}</span>
					{row.field.required ? (
						<>
							<AsteriskIcon aria-hidden="true" className="text-chrome-danger size-2.5 shrink-0" />
							<span className="sr-only">{shown.requiredMark}</span>
						</>
					) : null}
					<span className="ms-auto flex shrink-0 items-center gap-1.5">
						{row.field.translatable ? <Badge kind="info">{shown.translatable}</Badge> : null}
						<Badge kind="neutral">{shown.kinds[row.field.type]}</Badge>
					</span>
				</button>
			</div>
		</li>
	);
}

/**
 * The details panel while a Field is being added: its label (the key follows it until it is typed),
 * its kind (the kinds this place may hold) and, for a Group or Repeater, its first Field, which every
 * Group and Repeater needs. "Add Field" adds it at the end of its list and saves.
 */
function NewField({
	words,
	fields,
	parent,
	pages,
	postTypeName,
	onAdd,
	onCancel,
}: {
	words: Words;
	fields: readonly FieldDefinition[];
	parent: string | null;
	pages: boolean;
	postTypeName: string;
	onAdd(field: FieldDefinition): void;
	onCancel(): void;
}) {
	const shown = words.postTypes.fields;
	const kinds = offeredKinds(fields, parent, pages);
	const [label, setLabel] = useState("");
	const [key, setKey] = useState("");
	const [kind, setKind] = useState<FieldType>("text");
	const [inner, setInner] = useState("");
	const [tried, setTried] = useState(false);
	const labelBox = useRef<HTMLInputElement>(null);
	const id = useId();
	const taken = keysAt(fields, parent);
	const madeKey = key.trim() || freeKey(label, taken);
	const container = kind === "group" || kind === "repeater";
	const parentField = parent ? fieldAt(fields, parent) : null;

	useEffect(() => {
		labelBox.current?.focus();
	}, []);

	const keyProblem =
		tried && (!isFieldKey(madeKey) || taken.includes(madeKey))
			? taken.includes(madeKey)
				? words.postTypes.problems.keyTwice
				: words.postTypes.problems.keyFormat
			: null;
	const labelProblem = tried && !label.trim() ? words.postTypes.problems.labelLength : null;
	const innerProblem = tried && container && !inner.trim() ? words.postTypes.problems.fieldsEmpty : null;

	const submit = () => {
		setTried(true);
		if (!label.trim() || !isFieldKey(madeKey) || taken.includes(madeKey) || (container && !inner.trim())) return;
		onAdd(made(kind, madeKey, label.trim(), inner.trim()));
	};

	return (
		<form
			className="flex min-h-full flex-col gap-2.5"
			aria-labelledby={`${id}-heading`}
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
			data-wc-new-field={parent ?? ""}
		>
			<div className="flex flex-col gap-0.5">
				<h3 id={`${id}-heading`} className="text-chrome-strong m-0 text-[14px] font-semibold">
					{parentField ? fill(shown.newIn, { label: parentField.label || parentField.key }) : shown.newField}
				</h3>
				<p className="text-chrome-muted m-0 text-[12px]">
					{parentField
						? fill(shown.inside, { label: parentField.label || parentField.key })
						: fill(shown.top, { name: postTypeName })}
				</p>
			</div>
			<Card label={shown.label} htmlFor={`${id}-label`} problem={labelProblem}>
				<input
					ref={labelBox}
					id={`${id}-label`}
					type="text"
					value={label}
					maxLength={100}
					onChange={(event) => setLabel(event.target.value)}
					aria-invalid={labelProblem ? true : undefined}
					className={BARE_INPUT}
					data-wc-new-field-label=""
				/>
			</Card>
			<Card label={shown.key} htmlFor={`${id}-key`} problem={keyProblem} help={shown.keyNew} helpId={`${id}-key-help`}>
				<input
					id={`${id}-key`}
					type="text"
					value={key}
					maxLength={64}
					placeholder={madeKey}
					onChange={(event) => setKey(event.target.value)}
					aria-describedby={`${id}-key-help`}
					aria-invalid={keyProblem ? true : undefined}
					className={`${BARE_INPUT} font-mono`}
					data-wc-new-field-key=""
				/>
			</Card>
			<Card label={shown.kind} htmlFor={`${id}-kind`}>
				<select
					id={`${id}-kind`}
					value={kind}
					onChange={(event) => setKind(event.target.value as FieldType)}
					className={`${BARE_INPUT} bg-chrome-raised`}
					data-wc-new-field-kind=""
				>
					{kinds.map((each) => (
						<option key={each} value={each}>
							{shown.kinds[each]}
						</option>
					))}
				</select>
			</Card>
			{container ? (
				<Card
					label={shown.firstInner}
					htmlFor={`${id}-inner`}
					problem={innerProblem}
					help={shown.firstInnerHelp}
					helpId={`${id}-inner-help`}
				>
					<input
						id={`${id}-inner`}
						type="text"
						value={inner}
						maxLength={100}
						onChange={(event) => setInner(event.target.value)}
						aria-describedby={`${id}-inner-help`}
						aria-invalid={innerProblem ? true : undefined}
						className={BARE_INPUT}
						data-wc-new-field-inner=""
					/>
				</Card>
			) : null}
			<div className="flex items-center justify-end gap-2 pt-1">
				<button type="button" onClick={onCancel} className={buttonLook("outline")}>
					{shown.cancelNew}
				</button>
				<button type="submit" className={buttonLook("primary")} data-wc-new-field-add="">
					{shown.add}
				</button>
			</div>
		</form>
	);
}
