import type { BuildingAreaApiClient } from "@webcraft/api";
import { PlusIcon, XIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import {
	DATE_BUILT_INS,
	type DateUnit,
	type DateWindow,
	type FieldOperator,
	type Filter,
	fieldFilter,
	filterOfType,
	newFilter,
	OPERATORS,
	type Query,
	type QueryField,
	type QueryStatus,
	queryReads,
	SORTS_MAX,
	type Sort,
	STATUSES,
	settingId,
	takesValue,
	UNITS,
	WINDOWS,
	withWindow,
} from "../../../content/loop-query.ts";
import { type AdminMessages, fill, type Words } from "../../api.ts";
import { CHROME_EASE, FOCUS_RING, Tip } from "../../controls.tsx";
import type { PostTypeRow } from "../../management.ts";
import { Switch } from "../content/post-types/controls.tsx";
import type { Problem } from "./data.ts";
import { CheckMenu, FIELD_LOOK, SectionLabel, Select } from "./parts.tsx";
import { orderChoices, orderKey, orderKindOf, sortOf } from "./view.ts";

/** How long after the last key a typed setting is saved, as the place's other settings are. */
const SAVE_AFTER_MS = 800;

/** The admin's words for a query (operators, windows, built-in dates, statuses), which the place reuses. */
type QueryWords = AdminMessages["loops"]["query"];

/**
 * A query Loop's definition as a form (`places-assets/08`): Match (rules as rows: what a rule reads,
 * how it compares, its value; every rule or any), Order (the first sort, then up to two more), Limit
 * and Offset, page by page and leaving out the page's own Entry, and where the content for no items
 * is written. Each change saves the Draft's whole query: a choice at once, typing 0.8 s after the last
 * key or when the box is left. What the server refuses shows at its rule or setting.
 */
export function QueryForm({
	words,
	admin,
	api,
	siteId,
	loopName,
	query: saved,
	postTypes,
	problems,
	onSave,
}: {
	words: Words;
	admin: AdminMessages;
	api: BuildingAreaApiClient;
	siteId: string;
	loopName: string;
	query: Query;
	postTypes: readonly PostTypeRow[];
	problems: readonly Problem[];
	onSave(query: Query): void;
}) {
	const shown = words.loops;
	const q = admin.loops.query;
	const [query, setQuery] = useState(saved);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pending = useRef<Query | null>(null);
	const latest = useRef(onSave);
	latest.current = onSave;
	const id = useId();

	// A query saved elsewhere (another Loop opened, a save answered) shows unless typing waits to be saved.
	useEffect(() => {
		if (!pending.current) setQuery(saved);
	}, [saved]);

	const flush = () => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
		const next = pending.current;
		pending.current = null;
		if (next) latest.current(next);
	};
	// What waits is saved when the form goes (another Loop opened, the place left).
	// oxlint-disable-next-line react-hooks/exhaustive-deps -- `flush` reads only refs.
	useEffect(() => () => flush(), []);

	/**
	 * Changes the query: saved at once, or after a pause while typing (`typed`). A rule still waiting for
	 * its value (a new one, say) isn't saved until it has one: the server would refuse it.
	 */
	const change = (next: Query, typed = false) => {
		setQuery(next);
		if (next.filters.some(waiting)) {
			if (timer.current) clearTimeout(timer.current);
			timer.current = null;
			pending.current = null;
			return;
		}
		pending.current = next;
		if (typed) {
			if (timer.current) clearTimeout(timer.current);
			timer.current = setTimeout(flush, SAVE_AFTER_MS);
		} else flush();
	};
	const setFilter = (index: number, filter: Filter, typed = false) =>
		change({ ...query, filters: query.filters.map((each, at) => (at === index ? filter : each)) }, typed);

	const reads = queryReads(postTypes, query);
	const problemAt = (at: string) =>
		problems
			.filter((problem) => problem.at === at)
			.map((problem) => problem.message)
			.join(" ") || null;
	const problemsUnder = (prefix: string) =>
		problems.filter((problem) => problem.at === prefix || problem.at.startsWith(`${prefix}.`));

	const sortable = [
		{ by: "title", label: admin.content.builtIn.title, kind: "text" as const },
		...DATE_BUILT_INS.map((by) => ({ by, label: admin.content.builtIn[by], kind: "date" as const })),
		...reads.sortable.map(({ path, label, field }) => ({ by: path, label, kind: orderKindOf(field.type) })),
	];
	const labels = new Map(sortable.map((each) => [each.by, each.label]));
	const choices = orderChoices(sortable).map((choice) => ({
		...choice,
		label: fill(shown.orders[`${choice.kind}${choice.direction === "asc" ? "Asc" : "Desc"}`], {
			field: labels.get(choice.by) ?? choice.by,
		}),
	}));
	const setSort = (sort: Sort[]) => change({ ...query, sort });

	return (
		<div className="flex flex-col gap-[18px]" data-wc-loop-form="">
			<section aria-labelledby={`${id}-match`} className="flex flex-col gap-2" data-wc-loop-match="">
				<div className="flex items-center gap-2">
					<SectionLabel id={`${id}-match`}>{shown.match}</SectionLabel>
					{query.filters.length > 1 ? (
						<span className="ms-auto flex items-center gap-2">
							<label htmlFor={`${id}-match-mode`} className="text-chrome-muted text-[11px]">
								{shown.matchLabel}
							</label>
							<Select
								id={`${id}-match-mode`}
								value={query.match}
								onChange={(event) => change({ ...query, match: event.target.value === "any" ? "any" : "all" })}
								className="w-36"
							>
								<option value="all">{shown.matchAll}</option>
								<option value="any">{shown.matchAny}</option>
							</Select>
						</span>
					) : null}
				</div>
				{query.filters.length === 0 ? <p className="text-chrome-muted m-0 text-[12px]">{shown.noRules}</p> : null}
				{query.filters.map((filter, index) => (
					<RuleRow
						// Rules have no ids of their own; their place in the list is who they are.
						// oxlint-disable-next-line react/no-array-index-key -- the list is edited in place, by position.
						key={index}
						words={words}
						q={q}
						admin={admin}
						api={api}
						siteId={siteId}
						index={index}
						filter={filter}
						reads={reads}
						postTypes={postTypes}
						problems={problemsUnder(`query.filters[${index}]`)}
						onChange={(next, typed) => setFilter(index, next, typed)}
						onBlur={flush}
						onRemove={() => change({ ...query, filters: query.filters.filter((_, at) => at !== index) })}
					/>
				))}
				<span>
					<button
						type="button"
						onClick={() => change({ ...query, filters: [...query.filters, newFilter(reads.filterable)] })}
						className={`text-chrome-muted hover:text-chrome-strong inline-flex h-7 items-center gap-1.5 rounded-md px-1 text-[12px] font-medium ${CHROME_EASE} ${FOCUS_RING}`}
						data-wc-loop-add-rule=""
					>
						<PlusIcon aria-hidden="true" className="size-3.5" />
						{shown.addRule}
					</button>
				</span>
			</section>

			<section aria-labelledby={`${id}-order`} className="flex flex-col gap-2" data-wc-loop-order="">
				<SectionLabel id={`${id}-order`}>{shown.order}</SectionLabel>
				<Select
					aria-labelledby={`${id}-order`}
					value={query.sort[0] ? orderKey(query.sort[0]) : ""}
					onChange={(event) => {
						const first = sortOf(event.target.value);
						setSort(first ? [first, ...query.sort.slice(1)] : []);
					}}
					aria-invalid={problemAt("query.sort[0].by") ? true : undefined}
					data-wc-loop-sort="0"
				>
					<option value="">{shown.orderDefault}</option>
					{choices.map((choice) => (
						<option key={choice.key} value={choice.key}>
							{choice.label}
						</option>
					))}
				</Select>
				{query.sort.slice(1).map((sort, offset) => {
					const index = offset + 1;
					return (
						<div key={index} className="flex items-center gap-2">
							<span className="text-chrome-muted w-14 shrink-0 text-[11px]">{shown.thenBy}</span>
							<Select
								aria-label={fill(shown.orderNumber, { number: String(index + 1) })}
								value={orderKey(sort)}
								onChange={(event) => {
									const next = sortOf(event.target.value);
									if (next) setSort(query.sort.map((each, at) => (at === index ? next : each)));
								}}
								className="grow"
								data-wc-loop-sort={String(index)}
							>
								{choices.map((choice) => (
									<option key={choice.key} value={choice.key}>
										{choice.label}
									</option>
								))}
							</Select>
							<RemoveButton
								label={fill(shown.removeOrder, { number: String(index + 1) })}
								onClick={() => setSort(query.sort.filter((_, at) => at !== index))}
							/>
						</div>
					);
				})}
				{query.sort.length > 0 && query.sort.length < SORTS_MAX ? (
					<span>
						<button
							type="button"
							onClick={() => setSort([...query.sort, { by: "title", direction: "asc" }])}
							className={`text-chrome-muted hover:text-chrome-strong inline-flex h-7 items-center gap-1.5 rounded-md px-1 text-[12px] font-medium ${CHROME_EASE} ${FOCUS_RING}`}
						>
							<PlusIcon aria-hidden="true" className="size-3.5" />
							{shown.addOrder}
						</button>
					</span>
				) : null}
				<ProblemText
					text={
						problemsUnder("query.sort")
							.map((problem) => problem.message)
							.join(" ") || null
					}
				/>
			</section>

			<div className="flex gap-4">
				<NumberField
					id={settingId("query.limit", id)}
					label={shown.limit}
					hint={shown.limitHelp}
					value={query.limit}
					problem={problemAt("query.limit")}
					onChange={(limit) => change({ ...query, limit }, true)}
					onBlur={flush}
					data={{ "data-wc-loop-limit": "" }}
				/>
				<NumberField
					id={settingId("query.offset", id)}
					label={shown.offset}
					hint={shown.offsetHelp}
					value={query.offset}
					problem={problemAt("query.offset")}
					onChange={(offset) => change({ ...query, offset }, true)}
					onBlur={flush}
					data={{ "data-wc-loop-offset": "" }}
				/>
			</div>

			<div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-2">
				<SwitchRow
					id={`${id}-paginate`}
					label={shown.paginate}
					help={fill(shown.paginateHelp, { example: `{{@pagination ${loopName}}}` })}
					checked={query.paginate}
					words={words}
					onChange={(paginate) => change({ ...query, paginate })}
				/>
				<SwitchRow
					id={`${id}-exclude`}
					label={shown.excludeCurrent}
					help={shown.excludeCurrentHelp}
					checked={query.excludeCurrent}
					words={words}
					onChange={(excludeCurrent) => change({ ...query, excludeCurrent })}
				/>
			</div>

			<section aria-labelledby={`${id}-empty`} className="flex flex-col gap-2">
				<SectionLabel id={`${id}-empty`}>{shown.empty}</SectionLabel>
				<p className="border-chrome-hover text-chrome-muted m-0 grid min-h-12 place-items-center rounded-md border border-dashed px-3 py-2 text-center text-[12px]">
					<span>
						{fill(shown.emptyText, { empty: "\u0000" })
							.split("\u0000")
							.flatMap((part, at) =>
								at === 0
									? [part]
									: [
											<code key="empty" className="text-chrome-text font-mono">
												{"{{@empty}}"}
											</code>,
											part,
										],
							)}
					</span>
				</p>
			</section>
		</div>
	);
}

/** Whether a rule still waits for what it compares with: an empty value, no Relationship, no Entry or status chosen. */
function waiting(filter: Filter): boolean {
	switch (filter.type) {
		case "field":
			return takesValue(filter.operator) && (filter.value === "" || filter.value === null);
		case "relationship":
			return filter.field === "" || (filter.to === "entries" && filter.entries.length === 0);
		case "date":
			return (
				((filter.window === "last" || filter.window === "next") && !filter.amount) ||
				(filter.window === "between" && !filter.from && !filter.to)
			);
		default:
			return filter.statuses.length === 0;
	}
}

/** One rule of Match: what it reads, how it compares, its value; and its remove button. */
function RuleRow({
	words,
	q,
	admin,
	api,
	siteId,
	index,
	filter,
	reads,
	postTypes,
	problems,
	onChange,
	onBlur,
	onRemove,
}: {
	words: Words;
	q: QueryWords;
	admin: AdminMessages;
	api: BuildingAreaApiClient;
	siteId: string;
	index: number;
	filter: Filter;
	reads: ReturnType<typeof queryReads>;
	postTypes: readonly PostTypeRow[];
	problems: readonly Problem[];
	onChange(filter: Filter, typed?: boolean): void;
	onBlur(): void;
	onRemove(): void;
}) {
	const shown = words.loops;
	const number = String(index + 1);
	const subject = filter.type === "status" ? "status" : `${filter.type}:${filter.field}`;
	const dateLabel = (field: string) =>
		(admin.content.builtIn as Record<string, string>)[field] ??
		reads.dates.find((each) => each.path === field)?.label ??
		field;
	const chooseSubject = (key: string) => {
		const [type, ...rest] = key.split(":");
		const path = rest.join(":");
		if (type === "field") {
			const chosen = reads.filterable.find((each) => each.path === path);
			if (chosen) onChange(fieldFilter(chosen));
		} else if (type === "date") {
			const base = filter.type === "date" ? filter : filterOfType("date", reads);
			if (base.type === "date") onChange({ ...base, field: path });
		} else if (type === "relationship") {
			const base = filter.type === "relationship" ? filter : filterOfType("relationship", reads);
			if (base.type === "relationship") onChange({ ...base, field: path, entries: [] });
		} else onChange(filterOfType("status", reads));
	};
	const chosenField: QueryField | undefined =
		filter.type === "field" ? reads.filterable.find((each) => each.path === filter.field) : undefined;
	const message = problems.map((problem) => problem.message).join(" ") || null;

	return (
		<div className="flex flex-col gap-1" data-wc-loop-rule={number}>
			<div className="flex flex-wrap items-center gap-2">
				<Select
					aria-label={fill(shown.ruleSubject, { number })}
					value={subject}
					onChange={(event) => chooseSubject(event.target.value)}
					className="w-[160px]"
					data-wc-rule-subject=""
				>
					{reads.filterable.length > 0 ? (
						<optgroup label={shown.subjectGroups.fields}>
							{reads.filterable.map(({ path, label }) => (
								<option key={path} value={`field:${path}`}>
									{label}
								</option>
							))}
						</optgroup>
					) : null}
					<optgroup label={shown.subjectGroups.dates}>
						{DATE_BUILT_INS.map((name) => (
							<option key={name} value={`date:${name}`}>
								{fill(shown.dateSubject, { field: admin.content.builtIn[name] })}
							</option>
						))}
						{reads.dates.map(({ path, label }) => (
							<option key={path} value={`date:${path}`}>
								{fill(shown.dateSubject, { field: label })}
							</option>
						))}
					</optgroup>
					{reads.relationships.length > 0 ? (
						<optgroup label={shown.subjectGroups.relationships}>
							{reads.relationships.map(({ path, label }) => (
								<option key={path} value={`relationship:${path}`}>
									{fill(shown.relationshipSubject, { field: label })}
								</option>
							))}
						</optgroup>
					) : null}
					<optgroup label={shown.subjectGroups.other}>
						<option value="status">{shown.statusSubject}</option>
					</optgroup>
					{/* A rule about something the chosen Post Types no longer have stays readable until changed. */}
					{filter.type === "field" && !chosenField ? (
						<option value={subject}>{filter.field}</option>
					) : filter.type === "date" &&
					  !DATE_BUILT_INS.includes(filter.field as (typeof DATE_BUILT_INS)[number]) &&
					  !reads.dates.some((each) => each.path === filter.field) ? (
						<option value={subject}>{fill(shown.dateSubject, { field: dateLabel(filter.field) })}</option>
					) : filter.type === "relationship" && !reads.relationships.some((each) => each.path === filter.field) ? (
						<option value={subject}>{fill(shown.relationshipSubject, { field: filter.field })}</option>
					) : null}
				</Select>

				{filter.type === "field" ? (
					<>
						<Select
							aria-label={fill(shown.ruleCompare, { number })}
							value={filter.operator}
							onChange={(event) => onChange({ ...filter, operator: event.target.value as FieldOperator })}
							className="w-[130px]"
							data-wc-rule-compare=""
						>
							{(chosenField ? (OPERATORS[chosenField.field.type] ?? []) : [filter.operator]).map((operator) => (
								<option key={operator} value={operator}>
									{q.operators[operator]}
								</option>
							))}
						</Select>
						{chosenField && takesValue(filter.operator) ? (
							<ValueInput
								label={fill(shown.ruleValue, { number })}
								field={chosenField}
								value={filter.value}
								q={q}
								invalid={Boolean(message)}
								onChange={(value, typed) => onChange({ ...filter, value }, typed)}
								onBlur={onBlur}
							/>
						) : null}
					</>
				) : null}

				{filter.type === "date" ? (
					<>
						<Select
							aria-label={fill(shown.ruleCompare, { number })}
							value={filter.window}
							onChange={(event) => onChange(withWindow(filter, event.target.value as DateWindow))}
							className="w-[150px]"
							data-wc-rule-compare=""
						>
							{WINDOWS.map((window) => (
								<option key={window} value={window}>
									{q.windows[window]}
								</option>
							))}
						</Select>
						{filter.window === "last" || filter.window === "next" ? (
							<>
								<input
									type="text"
									inputMode="numeric"
									aria-label={fill(shown.ruleAmount, { number })}
									value={filter.amount ?? ""}
									onChange={(event) => {
										const amount = Number(event.target.value.trim());
										onChange({ ...filter, amount: Number.isFinite(amount) ? amount : null }, true);
									}}
									onBlur={onBlur}
									className={`${FIELD_LOOK} w-16 font-mono`}
								/>
								<Select
									aria-label={fill(shown.ruleUnit, { number })}
									value={filter.unit ?? "months"}
									onChange={(event) => onChange({ ...filter, unit: event.target.value as DateUnit })}
									className="w-28"
								>
									{UNITS.map((unit) => (
										<option key={unit} value={unit}>
											{q.units[unit]}
										</option>
									))}
								</Select>
							</>
						) : null}
						{filter.window === "between" ? (
							<>
								<input
									type="date"
									aria-label={fill(shown.ruleFrom, { number })}
									value={filter.from ?? ""}
									onChange={(event) => onChange({ ...filter, from: event.target.value || null })}
									className={`${FIELD_LOOK} [color-scheme:dark]`}
								/>
								<input
									type="date"
									aria-label={fill(shown.ruleTo, { number })}
									value={filter.to ?? ""}
									onChange={(event) => onChange({ ...filter, to: event.target.value || null })}
									className={`${FIELD_LOOK} [color-scheme:dark]`}
								/>
							</>
						) : null}
					</>
				) : null}

				{filter.type === "relationship" ? (
					<>
						<Select
							aria-label={fill(shown.ruleCompare, { number })}
							value={filter.to}
							onChange={(event) => onChange({ ...filter, to: event.target.value as typeof filter.to, entries: [] })}
							className="w-[200px]"
							data-wc-rule-compare=""
						>
							<option value="current">{q.to.current}</option>
							<option value="sharedWithCurrent">{q.to.sharedWithCurrent}</option>
							<option value="entries">{q.to.entries}</option>
						</Select>
						{filter.to === "entries" ? (
							<ChosenEntries
								words={words}
								api={api}
								siteId={siteId}
								label={fill(shown.ruleValue, { number })}
								field={reads.relationships.find((each) => each.path === filter.field)}
								postTypes={postTypes}
								value={filter.entries}
								onChange={(entries) => onChange({ ...filter, entries })}
							/>
						) : null}
					</>
				) : null}

				{filter.type === "status" ? (
					<>
						<span className="text-chrome-muted w-5 text-[11px]">{shown.statusIs}</span>
						<span className="min-w-0 grow">
							<CheckMenu
								label={fill(shown.ruleValue, { number })}
								shown={filter.statuses.map((status) => admin.entries.status[status]).join(", ") || shown.postTypesNone}
								checks={STATUSES.map((status) => ({
									key: status,
									label: admin.entries.status[status],
									checked: filter.statuses.includes(status),
								}))}
								onToggle={(key, checked) =>
									onChange({
										...filter,
										statuses: checked
											? [...filter.statuses, key as QueryStatus]
											: filter.statuses.filter((status) => status !== key),
									})
								}
							/>
						</span>
					</>
				) : null}

				<span className="ms-auto">
					<RemoveButton label={fill(shown.removeRule, { number })} onClick={onRemove} />
				</span>
			</div>
			<ProblemText text={message} />
		</div>
	);
}

/** A rule's value, as its Field's type takes it: yes or no, a choice, a number, a day, or text. */
function ValueInput({
	label,
	field: { field },
	value,
	q,
	invalid,
	onChange,
	onBlur,
}: {
	label: string;
	field: QueryField;
	value: string | number | boolean | null;
	q: QueryWords;
	invalid: boolean;
	onChange(value: string | number | boolean | null, typed?: boolean): void;
	onBlur(): void;
}) {
	const common = { "aria-label": label, "aria-invalid": invalid || undefined, "data-wc-rule-value": "" };
	if (field.type === "boolean") {
		return (
			<Select
				{...common}
				value={String(value === true)}
				onChange={(event) => onChange(event.target.value === "true")}
				className="min-w-24 grow"
			>
				<option value="true">{q.yes}</option>
				<option value="false">{q.no}</option>
			</Select>
		);
	}
	if (field.type === "select") {
		return (
			<Select
				{...common}
				value={String(value ?? "")}
				onChange={(event) => onChange(event.target.value)}
				className="min-w-32 grow"
			>
				{field.options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</Select>
		);
	}
	if (field.type === "date") {
		return (
			<input
				{...common}
				type="date"
				value={typeof value === "string" ? value.slice(0, 10) : ""}
				onChange={(event) => onChange(event.target.value || null)}
				className={`${FIELD_LOOK} [color-scheme:dark]`}
			/>
		);
	}
	const numeric = field.type === "number";
	return (
		<input
			{...common}
			type="text"
			inputMode={numeric ? "decimal" : undefined}
			value={value === null || value === undefined ? "" : String(value)}
			onChange={(event) => {
				const text = event.target.value;
				if (!numeric) return onChange(text, true);
				const number = Number(text.trim());
				onChange(text.trim() === "" || Number.isNaN(number) ? null : number, true);
			}}
			onBlur={onBlur}
			className={`${FIELD_LOOK} min-w-32 grow font-mono`}
		/>
	);
}

/** The Entries a Relationship rule keeps Entries pointing at, chosen from those of the Relationship's Post Types. */
function ChosenEntries({
	words,
	api,
	siteId,
	label,
	field,
	postTypes,
	value,
	onChange,
}: {
	words: Words;
	api: BuildingAreaApiClient;
	siteId: string;
	label: string;
	field: QueryField | undefined;
	postTypes: readonly PostTypeRow[];
	value: readonly string[];
	onChange(entries: string[]): void;
}) {
	const shown = words.loops;
	const [entries, setEntries] = useState<{ id: string; title: string }[] | null>(null);
	const keys = field?.field.type === "relationship" ? field.field.postTypes.join(",") : "";

	useEffect(() => {
		let current = true;
		const wanted = new Set(keys.split(",").filter(Boolean));
		void Promise.all(
			postTypes
				.filter((postType) => wanted.has(postType.key))
				.map(async (postType) => (await api.entries.list({ siteId, postTypeId: postType.id })).entries),
		).then(
			(lists) => {
				if (current) setEntries(lists.flat().map((entry) => ({ id: entry.id, title: entry.draft.title })));
			},
			() => {
				if (current) setEntries([]);
			},
		);
		return () => {
			current = false;
		};
	}, [api, siteId, keys, postTypes]);

	const chosen = new Set(value);
	return (
		<span className="min-w-40 grow">
			<CheckMenu
				label={label}
				shown={value.length > 0 ? fill(shown.chosenEntries, { count: String(value.length) }) : shown.chooseEntries}
				disabled={entries === null}
				checks={
					entries?.length
						? entries.map((entry) => ({ key: entry.id, label: entry.title, checked: chosen.has(entry.id) }))
						: []
				}
				onToggle={(key, checked) => onChange(checked ? [...value, key] : value.filter((each) => each !== key))}
			/>
		</span>
	);
}

/** A number setting of 30 px (Limit, Offset), saved after a pause while typing and when left, with a hint at its end. */
function NumberField({
	id,
	label,
	hint,
	value,
	problem,
	onChange,
	onBlur,
	data,
}: {
	id: string;
	label: string;
	hint: string;
	value: number;
	problem: string | null;
	onChange(value: number): void;
	onBlur(): void;
	data?: Record<`data-${string}`, string>;
}) {
	const [text, setText] = useState(String(value));
	const typing = useRef(false);
	useEffect(() => {
		if (!typing.current) setText(String(value));
	}, [value]);
	return (
		<div className="flex min-w-0 grow flex-col gap-2">
			<label htmlFor={id} className="text-chrome-strong text-[13px] font-semibold">
				{label}
			</label>
			<span className="relative flex">
				<input
					id={id}
					type="text"
					inputMode="numeric"
					value={text}
					aria-invalid={problem ? true : undefined}
					aria-describedby={`${id}-hint${problem ? ` ${id}-problem` : ""}`}
					onChange={(event) => {
						typing.current = true;
						setText(event.target.value);
						const number = Number(event.target.value.trim());
						if (event.target.value.trim() !== "" && Number.isFinite(number)) onChange(number);
					}}
					onBlur={() => {
						typing.current = false;
						onBlur();
						setText(String(value));
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter") onBlur();
					}}
					className={`${FIELD_LOOK} w-full pe-32 font-mono ${problem ? "border-chrome-danger" : ""}`}
					{...data}
				/>
				<span
					id={`${id}-hint`}
					className="text-chrome-muted pointer-events-none absolute end-2 top-1/2 -translate-y-1/2 text-[11px]"
				>
					{hint}
				</span>
			</span>
			{problem ? (
				<p id={`${id}-problem`} role="alert" className="text-chrome-danger m-0 text-[11px]">
					{problem}
				</p>
			) : null}
		</div>
	);
}

/** A switch with its label and help on a raised row. */
function SwitchRow({
	id,
	label,
	help,
	checked,
	words,
	onChange,
}: {
	id: string;
	label: string;
	help: string;
	checked: boolean;
	words: Words;
	onChange(checked: boolean): void;
}) {
	return (
		<div className="bg-chrome flex items-center gap-3 rounded-md px-2.5 py-2">
			<div className="flex min-w-0 grow flex-col gap-0.5">
				<label htmlFor={id} className="text-chrome-strong text-[12px] font-medium">
					{label}
				</label>
				<p id={`${id}-help`} className="text-chrome-muted m-0 text-[11px]">
					{help}
				</p>
			</div>
			<Switch
				id={id}
				checked={checked}
				onChange={onChange}
				words={{ on: words.loops.on, off: words.loops.off }}
				describedBy={`${id}-help`}
			/>
		</div>
	);
}

/** A small remove button (×) with its name as a tooltip. */
function RemoveButton({ label, onClick }: { label: string; onClick(): void }) {
	return (
		<span className="group relative inline-flex">
			<button
				type="button"
				aria-label={label}
				onClick={onClick}
				className={`text-chrome-muted hover:bg-chrome-hover hover:text-chrome-strong inline-grid size-[30px] place-items-center rounded-md ${CHROME_EASE} ${FOCUS_RING}`}
			>
				<XIcon aria-hidden="true" className="size-3.5" />
			</button>
			<Tip label={label} side="bottom" align="end" />
		</span>
	);
}

/** What the server refused at a rule or setting, under it. */
function ProblemText({ text }: { text: string | null }) {
	return text ? (
		<p role="alert" className="text-chrome-danger m-0 text-[11px]">
			{text}
		</p>
	) : null;
}
