import { useNavigate, useRouter } from "@tanstack/react-router";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { Label } from "@webcraft/ui/components/label.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { CircleAlertIcon, PlusIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorCode, errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import type { MediaItem } from "../media/preview.ts";
import { Tabs } from "../Tabs.tsx";
import { useAutosave } from "./autosave.ts";
import { DataTab } from "./DataTab.tsx";
import { LanguageTabs, SaveStatusText, StatusBadge } from "./DraftParts.tsx";
import { FieldValue, type ValueContext } from "./FieldValues.tsx";
import { loadRelationshipTargets } from "./loaders.ts";
import type { FieldDefinition, Json, LoopView, PostTypeView, Problem } from "./model.ts";
import { RelationshipPicker, type RelationshipTargets } from "./RelationshipPicker.tsx";
import { StructureEditor } from "./StructureEditor.tsx";

type Query = LoopView["draft"]["query"];
type Filter = Query["filters"][number];
type Sort = Query["sort"][number];
type FieldOperator = Extract<Filter, { type: "field" }>["operator"];
type DateWindow = Extract<Filter, { type: "date" }>["window"];
type DateUnit = NonNullable<Extract<Filter, { type: "date" }>["unit"]>;
type QueryStatus = Extract<Filter, { type: "status" }>["statuses"][number];

/** The tabs of a Loop's screen. */
export type LoopTab = "settings" | "items" | "data";

/**
 * A Loop's screen (Structure, Staff only): where its items come from (a query over Entries, built
 * here, or its own Loop items with their Fields), its Loop items in each language, and its Data tab.
 * Settings save to the Loop's Draft; Publish makes the Draft what pages show.
 */
export function LoopEditor({
	siteId,
	loop: loaded,
	postTypes,
	languages,
	tab,
}: {
	siteId: string;
	loop: LoopView;
	postTypes: readonly PostTypeView[];
	languages: { default: string; all: readonly string[] };
	tab?: LoopTab;
}) {
	const t = useT();
	const router = useRouter();
	const navigate = useNavigate();
	const [loop, setLoop] = useState(loaded);
	const [publishProblems, setPublishProblems] = useState<Problem[] | null>(null);
	const [publishError, setPublishError] = useState<MessageKey | null>(null);
	const [publishing, setPublishing] = useState(false);
	const alert = useRef<HTMLDivElement>(null);
	const items = loop.draft.source === "items";

	const publish = async () => {
		setPublishing(true);
		setPublishError(null);
		setPublishProblems(null);
		try {
			const api = await getApi();
			const { loop: published } = await api.loops.publish({ siteId, loopId: loop.id });
			setLoop(published);
			toast.success(t("loops.published"));
			await router.invalidate();
		} catch (error) {
			const data = (error as { data?: { problems?: Problem[]; missing?: string[] } }).data;
			setPublishError(errorMessage(error));
			if (data?.problems) setPublishProblems(data.problems);
			else if (data?.missing) setPublishProblems(data.missing.map((at) => ({ at, message: t("loops.items.missing") })));
			requestAnimationFrame(() => alert.current?.focus());
		} finally {
			setPublishing(false);
		}
	};

	const load = useCallback(
		async (language: string) => (await getApi()).loops.data({ siteId, loopId: loop.id, language }),
		[siteId, loop.id],
	);

	const tabs = [
		{
			id: "settings",
			label: t("loops.tabs.settings"),
			panel: <LoopSettings siteId={siteId} loop={loop} postTypes={postTypes} onSaved={setLoop} />,
		},
		...(items
			? [
					{
						id: "items",
						label: t("loops.tabs.items"),
						panel: <LoopItems siteId={siteId} loop={loop} languages={languages} onSaved={setLoop} />,
					},
				]
			: []),
		{
			id: "data",
			label: t("loops.tabs.data"),
			panel: <DataTab load={load} languages={languages} intro="data.loopIntro" />,
		},
	];

	return (
		<div className="grid min-w-0 content-start gap-6">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div className="grid gap-1">
					<div className="flex flex-wrap items-center gap-3">
						<h1 className="font-mono text-2xl font-semibold tracking-tight">{loop.name}</h1>
						<StatusBadge status={loop.status} />
						<Badge variant="outline">{t("postTypes.staffOnly")}</Badge>
					</div>
					<p className="text-muted-foreground text-sm">
						{t("loops.markupHint", { opening: `{{@loop ${loop.name} as item}}`, closing: "{{/loop}}" })}
					</p>
				</div>
				<Button type="button" disabled={publishing} onClick={publish}>
					<UploadIcon aria-hidden="true" />
					{t("loops.publish")}
				</Button>
			</div>
			{publishError ? (
				<div
					ref={alert}
					tabIndex={-1}
					role="alert"
					className="border-destructive/50 text-destructive grid gap-2 rounded-lg border p-4 text-sm outline-none"
				>
					<p className="flex items-center gap-2 font-medium">
						<CircleAlertIcon className="size-4" aria-hidden="true" />
						{t(publishError)}
					</p>
					{publishProblems && publishProblems.length > 0 ? (
						<ul className="grid gap-1 ps-6">
							{publishProblems.map((problem) => (
								<li key={`${problem.at}:${problem.message}`}>
									<code className="font-mono">{problem.at}</code>: {problem.message}
								</li>
							))}
						</ul>
					) : null}
				</div>
			) : null}
			<Tabs
				label={t("loops.tabs.label")}
				tabs={tabs}
				initial={tab}
				onSelect={(id) =>
					void navigate({
						to: "/sites/$siteId/loops/$loopId",
						params: { siteId, loopId: loop.id },
						search: (before) => ({ ...before, tab: id === "settings" ? undefined : (id as LoopTab) }),
						replace: true,
					})
				}
			/>
		</div>
	);
}

// ---------------------------------------------------------------------------------------------------
// Settings: where the items come from, and the query

function LoopSettings({
	siteId,
	loop,
	postTypes,
	onSaved,
}: {
	siteId: string;
	loop: LoopView;
	postTypes: readonly PostTypeView[];
	onSaved(loop: LoopView): void;
}) {
	const t = useT();
	const [source, setSource] = useState(loop.draft.source);
	const [switching, setSwitching] = useState(false);

	const changeSource = async (next: "query" | "items") => {
		setSource(next);
		setSwitching(true);
		try {
			const api = await getApi();
			const { loop: saved } = await api.loops.saveDraft({ siteId, loopId: loop.id, source: next });
			onSaved(saved);
			toast.success(t("loops.saved"));
		} catch (error) {
			setSource(loop.draft.source);
			toast.error(t(errorMessage(error)));
		} finally {
			setSwitching(false);
		}
	};

	return (
		<div className="grid gap-8">
			<fieldset className="grid gap-3">
				<legend className="mb-2 font-semibold">{t("loops.source.heading")}</legend>
				{(["query", "items"] as const).map((option) => (
					<div key={option} className="flex items-start gap-2">
						<input
							type="radio"
							id={`loop-source-${option}`}
							name="loop-source"
							value={option}
							checked={source === option}
							disabled={switching}
							onChange={() => void changeSource(option)}
							aria-describedby={`loop-source-${option}-help`}
							className="accent-primary mt-1 size-4"
						/>
						<div className="grid gap-0.5">
							<Label htmlFor={`loop-source-${option}`}>{t(`loops.source.${option}`)}</Label>
							<p id={`loop-source-${option}-help`} className="text-muted-foreground text-sm">
								{t(`loops.source.${option}Help`)}
							</p>
						</div>
					</div>
				))}
				<p className="text-muted-foreground text-sm">
					{t("loops.source.fieldHelp", { example: "{{@loop gallery as photo}}" })}
				</p>
			</fieldset>
			{source === "query" ? (
				<QueryBuilder siteId={siteId} loop={loop} postTypes={postTypes} onSaved={onSaved} />
			) : (
				<StructureEditor
					key={`loop-fields-${loop.id}`}
					subject={{ kind: "loop", fields: loop.draft.fields }}
					siteId={siteId}
					defaultLanguage="en"
					postTypes={postTypes.map(({ key, name }) => ({ key, name }))}
					save={async ({ fields }) => {
						const api = await getApi();
						const { loop: saved } = await api.loops.saveDraft({ siteId, loopId: loop.id, fields });
						onSaved(saved);
						return saved.draft.fields;
					}}
				/>
			)}
		</div>
	);
}

/** The operators each Field type takes in a filter, as the content store checks them. */
const OPERATORS: Readonly<Record<string, readonly FieldOperator[]>> = {
	text: ["equals", "notEquals", "contains", "empty", "notEmpty"],
	email: ["equals", "notEquals", "contains", "empty", "notEmpty"],
	richText: ["contains", "empty", "notEmpty"],
	select: ["equals", "notEquals", "empty", "notEmpty"],
	number: ["equals", "notEquals", "lessThan", "atMost", "greaterThan", "atLeast", "empty", "notEmpty"],
	date: ["equals", "notEquals", "lessThan", "atMost", "greaterThan", "atLeast", "empty", "notEmpty"],
	boolean: ["equals", "notEquals"],
	media: ["empty", "notEmpty"],
	link: ["empty", "notEmpty"],
	body: ["empty", "notEmpty"],
};

const SORTABLE = new Set(["text", "email", "number", "date", "boolean", "select"]);
const DATE_BUILT_INS = ["publishedAt", "lastPublishedAt", "createdAt", "updatedAt"] as const;
const WINDOWS: readonly DateWindow[] = ["past", "future", "last", "next", "between"];
const UNITS: readonly DateUnit[] = ["days", "weeks", "months", "years"];
const STATUSES: readonly QueryStatus[] = ["published", "changed", "draft"];

/** A Field a query can read, at its path (`address.city`), with the words for it. */
type QueryField = { path: string; label: string; field: FieldDefinition };

/** The Fields of the chosen Post Types a query can read: top-level and Groups' Fields (Repeaters' too, `withRows`). */
function queryFields(postTypes: readonly PostTypeView[], withRows = false): QueryField[] {
	const found = new Map<string, QueryField>();
	const visit = (fields: readonly FieldDefinition[], path: string, label: string) => {
		for (const field of fields) {
			const here = `${path}${field.key}`;
			const named = label ? `${label} › ${field.label}` : field.label;
			if (field.type === "group" || (withRows && field.type === "repeater")) {
				visit(field.fields, `${here}.`, named);
			} else if (field.type !== "repeater" && !found.has(here)) {
				found.set(here, { path: here, label: named, field });
			}
		}
	};
	for (const postType of postTypes) visit(postType.fields, "", "");
	return [...found.values()];
}

/** A control's id from where its setting is (`query.filters[1].value`), as problems name it. */
function settingId(at: string): string {
	return `loop-${at.replace(/[^A-Za-z0-9]+/g, "-")}`;
}

function QueryBuilder({
	siteId,
	loop,
	postTypes,
	onSaved,
}: {
	siteId: string;
	loop: LoopView;
	postTypes: readonly PostTypeView[];
	onSaved(loop: LoopView): void;
}) {
	const t = useT();
	const [query, setQuery] = useState<Query>(loop.draft.query);
	const [baseline, setBaseline] = useState(() => JSON.stringify(loop.draft.query));
	const [problems, setProblems] = useState<Problem[]>([]);
	const [failure, setFailure] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);
	const summary = useRef<HTMLDivElement>(null);
	const dirty = JSON.stringify(query) !== baseline;
	const listed = postTypes.filter((postType) => query.postTypes.includes(postType.key));
	const fields = queryFields(listed);
	const relationships = queryFields(listed, true).filter(({ field }) => field.type === "relationship");
	const dates = fields.filter(({ field }) => field.type === "date" && field.mode !== "time");
	const change = (next: Partial<Query>) => setQuery((before) => ({ ...before, ...next }));
	const changeFilter = (index: number, next: Filter) =>
		change({ filters: query.filters.map((filter, at) => (at === index ? next : filter)) });
	const problemsAt = (at: string) => problems.filter((problem) => problem.at === at);

	const save = async () => {
		setBusy(true);
		setFailure(null);
		try {
			const api = await getApi();
			const { loop: saved } = await api.loops.saveDraft({ siteId, loopId: loop.id, query });
			setQuery(saved.draft.query);
			setBaseline(JSON.stringify(saved.draft.query));
			setProblems([]);
			onSaved(saved);
			toast.success(t("loops.saved"));
		} catch (error) {
			const data = (error as { data?: { problems?: Problem[] } }).data;
			setProblems(errorCode(error) === "LOOP_INVALID" ? (data?.problems ?? []) : []);
			setFailure(errorMessage(error));
			requestAnimationFrame(() => summary.current?.focus());
		} finally {
			setBusy(false);
		}
	};

	const newFilter = (): Filter => {
		const [first] = fields;
		if (!first) return { type: "status", statuses: ["published"] };
		const operator = OPERATORS[first.field.type]?.[0] ?? "empty";
		return { type: "field", field: first.path, operator, value: defaultValue(first.field) };
	};

	return (
		<div className="grid gap-8">
			{failure ? (
				<div
					ref={summary}
					tabIndex={-1}
					role="alert"
					className="border-destructive/50 text-destructive grid gap-2 rounded-lg border p-4 text-sm outline-none"
				>
					<p className="flex items-center gap-2 font-medium">
						<CircleAlertIcon className="size-4" aria-hidden="true" />
						{t(failure)}
					</p>
					{problems.length > 0 ? (
						<ul className="grid gap-1 ps-6">
							{problems.map((problem) => (
								<li key={`${problem.at}:${problem.message}`}>
									<button
										type="button"
										className="focus-visible:ring-ring/50 rounded-sm text-start underline underline-offset-4 outline-none focus-visible:ring-3"
										onClick={() => document.getElementById(settingId(problem.at))?.focus()}
									>
										{problem.message}
									</button>
								</li>
							))}
						</ul>
					) : null}
				</div>
			) : null}

			<fieldset className="grid gap-3">
				<legend id={settingId("query.postTypes")} tabIndex={-1} className="mb-2 font-semibold outline-none">
					{t("loops.query.postTypes")}
				</legend>
				<div className="flex flex-wrap gap-x-6 gap-y-3">
					{postTypes.map((postType) => (
						<div key={postType.key} className="flex items-center gap-2">
							<Checkbox
								id={`loop-post-type-${postType.key}`}
								checked={query.postTypes.includes(postType.key)}
								onCheckedChange={(checked) =>
									change({
										postTypes:
											checked === true
												? [...query.postTypes, postType.key]
												: query.postTypes.filter((key) => key !== postType.key),
									})
								}
							/>
							<Label htmlFor={`loop-post-type-${postType.key}`}>{postType.name}</Label>
						</div>
					))}
				</div>
			</fieldset>

			<fieldset className="grid gap-4">
				<legend className="mb-2 font-semibold">{t("loops.query.filters")}</legend>
				<div className="flex flex-wrap items-center gap-3">
					<Label htmlFor="loop-query-match">{t("loops.query.match")}</Label>
					<NativeSelect
						id="loop-query-match"
						value={query.match}
						onChange={(event) => change({ match: event.target.value === "any" ? "any" : "all" })}
					>
						<NativeSelectOption value="all">{t("loops.query.matchAll")}</NativeSelectOption>
						<NativeSelectOption value="any">{t("loops.query.matchAny")}</NativeSelectOption>
					</NativeSelect>
				</div>
				{query.filters.length === 0 ? (
					<p className="text-muted-foreground text-sm">{t("loops.query.noFilters")}</p>
				) : (
					<ol className="grid gap-3">
						{query.filters.map((filter, index) => (
							<li
								// Filters have no ids of their own; their place is who they are.
								// biome-ignore lint/suspicious/noArrayIndexKey: the list is edited in place, by position.
								key={index}
								className="grid gap-3 rounded-lg border p-4"
							>
								<FilterRow
									siteId={siteId}
									index={index}
									filter={filter}
									fields={fields}
									relationships={relationships}
									dates={dates}
									problemsAt={problemsAt}
									onChange={(next) => changeFilter(index, next)}
									onRemove={() => change({ filters: query.filters.filter((_, at) => at !== index) })}
								/>
							</li>
						))}
					</ol>
				)}
				<div>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => change({ filters: [...query.filters, newFilter()] })}
					>
						<PlusIcon aria-hidden="true" />
						{t("loops.query.addFilter")}
					</Button>
				</div>
			</fieldset>

			<fieldset className="grid gap-4">
				<legend className="mb-2 font-semibold">{t("loops.query.sort")}</legend>
				{query.sort.length === 0 ? (
					<p className="text-muted-foreground text-sm">{t("loops.query.newestFirst")}</p>
				) : null}
				<ol className="grid gap-3">
					{query.sort.map((sort, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: the list is edited in place, by position.
						<li key={index} className="flex flex-wrap items-end gap-3">
							<Setting
								id={settingId(`query.sort[${index}].by`)}
								label={t("loops.query.sortBy", { number: index + 1 })}
								problems={problemsAt(`query.sort[${index}].by`)}
							>
								{(id, described) => (
									<NativeSelect
										id={id}
										aria-describedby={described}
										value={sort.by}
										onChange={(event) =>
											change({
												sort: query.sort.map((each, at) => (at === index ? { ...each, by: event.target.value } : each)),
											})
										}
									>
										<NativeSelectOption value="title">{t("content.builtIn.title")}</NativeSelectOption>
										{DATE_BUILT_INS.map((name) => (
											<NativeSelectOption key={name} value={name}>
												{t(`content.builtIn.${name}`)}
											</NativeSelectOption>
										))}
										{fields
											.filter(({ field }) => SORTABLE.has(field.type) && !(field.type === "select" && field.multiple))
											.map(({ path, label }) => (
												<NativeSelectOption key={path} value={path}>
													{label}
												</NativeSelectOption>
											))}
									</NativeSelect>
								)}
							</Setting>
							<Setting
								id={settingId(`query.sort[${index}].direction`)}
								label={t("loops.query.direction")}
								problems={[]}
							>
								{(id) => (
									<NativeSelect
										id={id}
										value={sort.direction}
										onChange={(event) =>
											change({
												sort: query.sort.map((each, at) =>
													at === index ? { ...each, direction: event.target.value === "desc" ? "desc" : "asc" } : each,
												),
											})
										}
									>
										<NativeSelectOption value="asc">{t("loops.query.ascending")}</NativeSelectOption>
										<NativeSelectOption value="desc">{t("loops.query.descending")}</NativeSelectOption>
									</NativeSelect>
								)}
							</Setting>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								aria-label={t("loops.query.removeSort", { number: index + 1 })}
								onClick={() => change({ sort: query.sort.filter((_, at) => at !== index) })}
							>
								<Trash2Icon aria-hidden="true" />
							</Button>
						</li>
					))}
				</ol>
				{query.sort.length < 3 ? (
					<div>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => change({ sort: [...query.sort, { by: "publishedAt", direction: "desc" } satisfies Sort] })}
						>
							<PlusIcon aria-hidden="true" />
							{t("loops.query.addSort")}
						</Button>
					</div>
				) : null}
			</fieldset>

			<div className="grid max-w-xl gap-4 sm:grid-cols-2">
				<Setting
					id={settingId("query.limit")}
					label={t("loops.query.limit")}
					help={t("loops.query.limitHelp")}
					problems={problemsAt("query.limit")}
				>
					{(id, described) => (
						<Input
							id={id}
							type="number"
							min={1}
							max={100}
							aria-describedby={described}
							value={query.limit}
							onChange={(event) => change({ limit: Number(event.target.value) })}
						/>
					)}
				</Setting>
				<Setting
					id={settingId("query.offset")}
					label={t("loops.query.offset")}
					help={t("loops.query.offsetHelp")}
					problems={problemsAt("query.offset")}
				>
					{(id, described) => (
						<Input
							id={id}
							type="number"
							min={0}
							max={1000}
							aria-describedby={described}
							value={query.offset}
							onChange={(event) => change({ offset: Number(event.target.value) })}
						/>
					)}
				</Setting>
			</div>

			<div className="grid gap-4">
				<Toggle
					id="loop-query-paginate"
					label={t("loops.query.paginate")}
					help={t("loops.query.paginateHelp", { example: `{{@pagination ${loop.name}}}` })}
					checked={query.paginate}
					onChange={(paginate) => change({ paginate })}
				/>
				<Toggle
					id="loop-query-exclude"
					label={t("loops.query.excludeCurrent")}
					help={t("loops.query.excludeCurrentHelp")}
					checked={query.excludeCurrent}
					onChange={(excludeCurrent) => change({ excludeCurrent })}
				/>
			</div>

			<div className="flex flex-wrap items-center gap-3">
				<Button type="button" disabled={!dirty || busy} onClick={save}>
					{t("loops.save")}
				</Button>
				<Button
					type="button"
					variant="outline"
					disabled={!dirty || busy}
					onClick={() => setQuery(JSON.parse(baseline))}
				>
					{t("postTypes.discard")}
				</Button>
				<p role="status" className="text-muted-foreground text-sm">
					{dirty ? t("postTypes.unsaved") : ""}
				</p>
			</div>
		</div>
	);
}

function defaultValue(field: FieldDefinition): string | number | boolean | null {
	switch (field.type) {
		case "number":
			return 0;
		case "boolean":
			return true;
		case "select":
			return field.options[0]?.value ?? null;
		case "date":
			return "2026-01-01";
		default:
			return "";
	}
}

/** One filter of a query: what it is about, and its settings. */
function FilterRow({
	siteId,
	index,
	filter,
	fields,
	relationships,
	dates,
	problemsAt,
	onChange,
	onRemove,
}: {
	siteId: string;
	index: number;
	filter: Filter;
	fields: readonly QueryField[];
	relationships: readonly QueryField[];
	dates: readonly QueryField[];
	problemsAt(at: string): Problem[];
	onChange(filter: Filter): void;
	onRemove(): void;
}) {
	const t = useT();
	const at = (setting: string) => `query.filters[${index}].${setting}`;
	const switchType = (type: Filter["type"]) => {
		if (type === "field") {
			const [first] = fields;
			onChange({
				type: "field",
				field: first?.path ?? "",
				operator: first ? (OPERATORS[first.field.type]?.[0] ?? "empty") : "empty",
				value: first ? defaultValue(first.field) : null,
			});
		} else if (type === "relationship") {
			onChange({ type: "relationship", field: relationships[0]?.path ?? "", to: "current", entries: [] });
		} else if (type === "date") {
			onChange({ type: "date", field: "publishedAt", window: "past", amount: null, unit: null, from: null, to: null });
		} else {
			onChange({ type: "status", statuses: ["published"] });
		}
	};
	const chosen = filter.type === "field" ? fields.find((candidate) => candidate.path === filter.field) : undefined;

	return (
		<>
			<div className="flex flex-wrap items-end gap-3">
				<Setting
					id={settingId(at("type"))}
					label={t("loops.query.filterNumber", { number: index + 1 })}
					problems={problemsAt(at("type"))}
				>
					{(id, described) => (
						<NativeSelect
							id={id}
							aria-describedby={described}
							value={filter.type}
							onChange={(event) => switchType(event.target.value as Filter["type"])}
						>
							<NativeSelectOption value="field">{t("loops.query.filterType.field")}</NativeSelectOption>
							<NativeSelectOption value="relationship">{t("loops.query.filterType.relationship")}</NativeSelectOption>
							<NativeSelectOption value="date">{t("loops.query.filterType.date")}</NativeSelectOption>
							<NativeSelectOption value="status">{t("loops.query.filterType.status")}</NativeSelectOption>
						</NativeSelect>
					)}
				</Setting>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="ms-auto"
					aria-label={t("loops.query.removeFilter", { number: index + 1 })}
					onClick={onRemove}
				>
					<Trash2Icon aria-hidden="true" />
				</Button>
			</div>
			{filter.type === "field" ? (
				<div className="flex flex-wrap items-end gap-3">
					<Setting id={settingId(at("field"))} label={t("loops.query.field")} problems={problemsAt(at("field"))}>
						{(id, described) => (
							<NativeSelect
								id={id}
								aria-describedby={described}
								value={filter.field}
								onChange={(event) => {
									const next = fields.find((candidate) => candidate.path === event.target.value);
									if (!next) return;
									onChange({
										...filter,
										field: next.path,
										operator: OPERATORS[next.field.type]?.[0] ?? "empty",
										value: defaultValue(next.field),
									});
								}}
							>
								{fields
									.filter(({ field }) => (OPERATORS[field.type]?.length ?? 0) > 0)
									.map(({ path, label }) => (
										<NativeSelectOption key={path} value={path}>
											{label}
										</NativeSelectOption>
									))}
							</NativeSelect>
						)}
					</Setting>
					<Setting
						id={settingId(at("operator"))}
						label={t("loops.query.operator")}
						problems={problemsAt(at("operator"))}
					>
						{(id, described) => (
							<NativeSelect
								id={id}
								aria-describedby={described}
								value={filter.operator}
								onChange={(event) => onChange({ ...filter, operator: event.target.value as FieldOperator })}
							>
								{(chosen ? (OPERATORS[chosen.field.type] ?? []) : []).map((operator) => (
									<NativeSelectOption key={operator} value={operator}>
										{t(`loops.query.operators.${operator}`)}
									</NativeSelectOption>
								))}
							</NativeSelect>
						)}
					</Setting>
					{chosen && filter.operator !== "empty" && filter.operator !== "notEmpty" ? (
						<Setting id={settingId(at("value"))} label={t("loops.query.value")} problems={problemsAt(at("value"))}>
							{(id, described) => (
								<ValueInput
									id={id}
									describedBy={described}
									field={chosen.field}
									value={filter.value}
									onChange={(value) => onChange({ ...filter, value })}
								/>
							)}
						</Setting>
					) : null}
				</div>
			) : null}
			{filter.type === "relationship" ? (
				<div className="grid gap-3">
					<div className="flex flex-wrap items-end gap-3">
						<Setting
							id={settingId(at("field"))}
							label={t("loops.query.relationship")}
							problems={problemsAt(at("field"))}
						>
							{(id, described) => (
								<NativeSelect
									id={id}
									aria-describedby={described}
									value={filter.field}
									onChange={(event) => onChange({ ...filter, field: event.target.value, entries: [] })}
								>
									{relationships.map(({ path, label }) => (
										<NativeSelectOption key={path} value={path}>
											{label}
										</NativeSelectOption>
									))}
								</NativeSelect>
							)}
						</Setting>
						<Setting id={settingId(at("to"))} label={t("loops.query.relatedTo")} problems={problemsAt(at("to"))}>
							{(id, described) => (
								<NativeSelect
									id={id}
									aria-describedby={described}
									value={filter.to}
									onChange={(event) => onChange({ ...filter, to: event.target.value as typeof filter.to })}
								>
									<NativeSelectOption value="current">{t("loops.query.to.current")}</NativeSelectOption>
									<NativeSelectOption value="sharedWithCurrent">
										{t("loops.query.to.sharedWithCurrent")}
									</NativeSelectOption>
									<NativeSelectOption value="entries">{t("loops.query.to.entries")}</NativeSelectOption>
								</NativeSelect>
							)}
						</Setting>
					</div>
					{filter.to === "entries" ? (
						<ChosenEntries
							siteId={siteId}
							id={settingId(at("entries"))}
							field={relationships.find((candidate) => candidate.path === filter.field)?.field}
							value={filter.entries}
							problems={problemsAt(at("entries"))}
							onChange={(entries) => onChange({ ...filter, entries })}
						/>
					) : null}
				</div>
			) : null}
			{filter.type === "date" ? (
				<div className="flex flex-wrap items-end gap-3">
					<Setting id={settingId(at("field"))} label={t("loops.query.date")} problems={problemsAt(at("field"))}>
						{(id, described) => (
							<NativeSelect
								id={id}
								aria-describedby={described}
								value={filter.field}
								onChange={(event) => onChange({ ...filter, field: event.target.value })}
							>
								{DATE_BUILT_INS.map((name) => (
									<NativeSelectOption key={name} value={name}>
										{t(`content.builtIn.${name}`)}
									</NativeSelectOption>
								))}
								{dates.map(({ path, label }) => (
									<NativeSelectOption key={path} value={path}>
										{label}
									</NativeSelectOption>
								))}
							</NativeSelect>
						)}
					</Setting>
					<Setting id={settingId(at("window"))} label={t("loops.query.window")} problems={problemsAt(at("window"))}>
						{(id, described) => (
							<NativeSelect
								id={id}
								aria-describedby={described}
								value={filter.window}
								onChange={(event) => {
									const window = event.target.value as DateWindow;
									onChange({
										...filter,
										window,
										amount: window === "last" || window === "next" ? (filter.amount ?? 12) : null,
										unit: window === "last" || window === "next" ? (filter.unit ?? "months") : null,
										from: window === "between" ? (filter.from ?? "2026-01-01") : null,
										to: window === "between" ? filter.to : null,
									});
								}}
							>
								{WINDOWS.map((window) => (
									<NativeSelectOption key={window} value={window}>
										{t(`loops.query.windows.${window}`)}
									</NativeSelectOption>
								))}
							</NativeSelect>
						)}
					</Setting>
					{filter.window === "last" || filter.window === "next" ? (
						<>
							<Setting id={settingId(at("amount"))} label={t("loops.query.amount")} problems={problemsAt(at("amount"))}>
								{(id, described) => (
									<Input
										id={id}
										type="number"
										min={1}
										className="w-24"
										aria-describedby={described}
										value={filter.amount ?? ""}
										onChange={(event) => onChange({ ...filter, amount: Number(event.target.value) })}
									/>
								)}
							</Setting>
							<Setting id={settingId(at("unit"))} label={t("loops.query.unit")} problems={problemsAt(at("unit"))}>
								{(id, described) => (
									<NativeSelect
										id={id}
										aria-describedby={described}
										value={filter.unit ?? "months"}
										onChange={(event) => onChange({ ...filter, unit: event.target.value as DateUnit })}
									>
										{UNITS.map((unit) => (
											<NativeSelectOption key={unit} value={unit}>
												{t(`loops.query.units.${unit}`)}
											</NativeSelectOption>
										))}
									</NativeSelect>
								)}
							</Setting>
						</>
					) : null}
					{filter.window === "between" ? (
						<>
							<Setting id={settingId(at("from"))} label={t("loops.query.from")} problems={problemsAt(at("from"))}>
								{(id, described) => (
									<Input
										id={id}
										type="date"
										aria-describedby={described}
										value={filter.from ?? ""}
										onChange={(event) => onChange({ ...filter, from: event.target.value || null })}
									/>
								)}
							</Setting>
							<Setting id={settingId(at("to"))} label={t("loops.query.to.label")} problems={problemsAt(at("to"))}>
								{(id, described) => (
									<Input
										id={id}
										type="date"
										aria-describedby={described}
										value={filter.to ?? ""}
										onChange={(event) => onChange({ ...filter, to: event.target.value || null })}
									/>
								)}
							</Setting>
						</>
					) : null}
				</div>
			) : null}
			{filter.type === "status" ? (
				<fieldset className="grid gap-2">
					<legend id={settingId(at("statuses"))} tabIndex={-1} className="mb-1 text-sm font-medium outline-none">
						{t("loops.query.statuses")}
					</legend>
					<div className="flex flex-wrap gap-x-6 gap-y-2">
						{STATUSES.map((status) => (
							<div key={status} className="flex items-center gap-2">
								<Checkbox
									id={`loop-filter-${index}-status-${status}`}
									checked={filter.statuses.includes(status)}
									onCheckedChange={(checked) =>
										onChange({
											...filter,
											statuses:
												checked === true
													? [...filter.statuses, status]
													: filter.statuses.filter((each) => each !== status),
										})
									}
								/>
								<Label htmlFor={`loop-filter-${index}-status-${status}`}>{t(`entries.status.${status}`)}</Label>
							</div>
						))}
					</div>
				</fieldset>
			) : null}
		</>
	);
}

/** A filter's value, as its Field's type takes it. */
function ValueInput({
	id,
	describedBy,
	field,
	value,
	onChange,
}: {
	id: string;
	describedBy?: string;
	field: FieldDefinition;
	value: string | number | boolean | null;
	onChange(value: string | number | boolean | null): void;
}) {
	const t = useT();
	if (field.type === "boolean") {
		return (
			<NativeSelect
				id={id}
				aria-describedby={describedBy}
				value={String(value === true)}
				onChange={(event) => onChange(event.target.value === "true")}
			>
				<NativeSelectOption value="true">{t("loops.query.yes")}</NativeSelectOption>
				<NativeSelectOption value="false">{t("loops.query.no")}</NativeSelectOption>
			</NativeSelect>
		);
	}
	if (field.type === "select") {
		return (
			<NativeSelect
				id={id}
				aria-describedby={describedBy}
				value={String(value ?? "")}
				onChange={(event) => onChange(event.target.value)}
			>
				{field.options.map((option) => (
					<NativeSelectOption key={option.value} value={option.value}>
						{option.label}
					</NativeSelectOption>
				))}
			</NativeSelect>
		);
	}
	if (field.type === "number") {
		return (
			<Input
				id={id}
				type="number"
				className="w-32"
				aria-describedby={describedBy}
				value={typeof value === "number" ? value : ""}
				onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}
			/>
		);
	}
	if (field.type === "date") {
		return (
			<Input
				id={id}
				type="date"
				aria-describedby={describedBy}
				value={typeof value === "string" ? value.slice(0, 10) : ""}
				onChange={(event) => onChange(event.target.value || null)}
			/>
		);
	}
	return (
		<Input
			id={id}
			aria-describedby={describedBy}
			value={typeof value === "string" ? value : ""}
			onChange={(event) => onChange(event.target.value)}
		/>
	);
}

/** The Entries a Relationship filter keeps Entries pointing at: chosen from those of the Relationship's Post Types. */
function ChosenEntries({
	siteId,
	id,
	field,
	value,
	problems,
	onChange,
}: {
	siteId: string;
	id: string;
	field: FieldDefinition | undefined;
	value: readonly string[];
	problems: readonly Problem[];
	onChange(entries: string[]): void;
}) {
	const t = useT();
	const [targets, setTargets] = useState<RelationshipTargets | null>(null);
	const relationship = field?.type === "relationship" ? field : undefined;

	useEffect(() => {
		if (!relationship) return;
		let current = true;
		void getApi()
			.then((api) => loadRelationshipTargets(api, siteId, [relationship]))
			.then((found) => {
				if (current) setTargets(found);
			});
		return () => {
			current = false;
		};
	}, [relationship, siteId]);
	if (!relationship) return null;
	return (
		<div className="grid gap-2">
			<p id={`${id}-label`} className="text-sm font-medium">
				{t("loops.query.chosenEntries")}
			</p>
			<RelationshipPicker
				id={id}
				labelledBy={`${id}-label`}
				invalid={problems.length > 0}
				field={{ ...relationship, multiple: true }}
				value={[...value]}
				targets={targets ?? {}}
				onChange={(next) => onChange(Array.isArray(next) ? next : next ? [next] : [])}
			/>
			{problems.map((problem) => (
				<p key={problem.message} className="text-destructive text-sm">
					{problem.message}
				</p>
			))}
		</div>
	);
}

/** A labelled setting: its control (given its id and what describes it), help text and problems. */
function Setting({
	id,
	label,
	help,
	problems,
	children,
}: {
	id: string;
	label: string;
	help?: string;
	problems: readonly Problem[];
	children(id: string, describedBy: string | undefined): ReactNode;
}) {
	const describedBy = [help ? `${id}-help` : null, problems.length > 0 ? `${id}-problems` : null]
		.filter(Boolean)
		.join(" ");
	return (
		<div className="grid gap-2">
			<Label htmlFor={id}>{label}</Label>
			{children(id, describedBy || undefined)}
			{help ? (
				<p id={`${id}-help`} className="text-muted-foreground text-sm">
					{help}
				</p>
			) : null}
			{problems.length > 0 ? (
				<p id={`${id}-problems`} className="text-destructive text-sm">
					{problems.map((problem) => problem.message).join(" ")}
				</p>
			) : null}
		</div>
	);
}

function Toggle({
	id,
	label,
	help,
	checked,
	onChange,
}: {
	id: string;
	label: string;
	help: string;
	checked: boolean;
	onChange(checked: boolean): void;
}) {
	return (
		<div className="flex items-start gap-2">
			<Checkbox
				id={id}
				className="mt-0.5"
				checked={checked}
				aria-describedby={`${id}-help`}
				onCheckedChange={(value) => onChange(value === true)}
			/>
			<div className="grid gap-0.5">
				<Label htmlFor={id}>{label}</Label>
				<p id={`${id}-help`} className="text-muted-foreground text-sm">
					{help}
				</p>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------------------------------
// Loop items: their values, in each language, saved to the Draft as they change

function LoopItems({
	siteId,
	loop,
	languages,
	onSaved,
}: {
	siteId: string;
	loop: LoopView;
	languages: { default: string; all: readonly string[] };
	onSaved(loop: LoopView): void;
}) {
	const t = useT();
	const [items, setItems] = useState<Json>(loop.draft.items as Json);
	const [refused, setRefused] = useState<Problem[]>([]);
	const [saveError, setSaveError] = useState<MessageKey | null>(null);
	const [media, setMedia] = useState<Readonly<Record<string, MediaItem>>>({});
	const autosave = useAutosave<{ items: Json }>({
		merge: (_older, newer) => newer,
		save: async (change) => {
			const api = await getApi();
			const { loop: saved } = await api.loops.saveItems({
				siteId,
				loopId: loop.id,
				language: loop.language,
				items: Array.isArray(change.items) ? (change.items as Record<string, unknown>[]) : [],
			});
			onSaved(saved);
			setRefused([]);
			setSaveError(null);
		},
		onFailed: (error) => {
			const data = (error as { data?: { problems?: Problem[] } }).data;
			if (errorCode(error) === "LOOP_INVALID" && data?.problems) setRefused(data.problems);
			setSaveError(errorMessage(error));
		},
	});
	const field = {
		key: "items",
		label: t("loops.items.heading"),
		type: "repeater",
		help: t("loops.items.help"),
		required: false,
		translatable: false,
		default: null,
		fields: loop.draft.fields,
		min: null,
		max: null,
	} as FieldDefinition;
	const context: ValueContext = {
		siteId,
		idPrefix: "loop",
		language: loop.language,
		defaultLanguage: languages.default,
		problems: [...loop.problems, ...refused],
		relationships: {},
		media,
		onMediaChosen: (item) => setMedia((before) => ({ ...before, [item.id]: item })),
		markShared: true,
	};

	if (loop.draft.fields.length === 0) {
		return (
			<p className="text-muted-foreground rounded-lg border border-dashed p-8 text-center">
				{t("loops.items.noFields")}
			</p>
		);
	}
	return (
		<div className="grid gap-6">
			<LanguageTabs
				languages={languages}
				current={loop.language}
				link={(language) => ({
					to: "/sites/$siteId/loops/$loopId",
					params: { siteId, loopId: loop.id },
					search: { tab: "items", language: language === languages.default ? undefined : language },
				})}
			/>
			<p className="text-muted-foreground text-sm">
				<SaveStatusText status={autosave.status} savedAt={loop.updatedAt} />
			</p>
			{saveError ? (
				<p role="alert" className="text-destructive text-sm">
					{t(saveError)}
				</p>
			) : null}
			<FieldValue
				field={field}
				value={items}
				path="items"
				context={context}
				onChange={(value) => {
					setItems(value);
					autosave.change({ items: value });
				}}
			/>
		</div>
	);
}
