import { Link, useNavigate } from "@tanstack/react-router";
import { Avatar, AvatarFallback } from "@webcraft/ui/components/avatar.tsx";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@webcraft/ui/components/dialog.tsx";
import { Field, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@webcraft/ui/components/input-group.tsx";
import { Label } from "@webcraft/ui/components/label.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { Skeleton } from "@webcraft/ui/components/skeleton.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { CircleAlertIcon, CornerDownRightIcon, DatabaseIcon, PlusIcon, SearchIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { Segmented } from "../filters/Segmented.tsx";
import { useT } from "../i18n.tsx";
import { ScheduleBadges } from "../publishing/schedule.tsx";
import { ReviewBadge } from "../review/Review.tsx";
import { initials } from "../shell/context.ts";
import { PageHeader } from "../shell/page.tsx";
import { languageName, StatusBadge } from "./DraftParts.tsx";
import type { EntryView } from "./model.ts";
import { pageTree, type TreePage } from "./page-tree.ts";
import { When } from "./When.tsx";

/** The statuses the list filters by: In review only while something of the Post Type waits for review. */
export const ENTRY_STATUSES = ["published", "draft", "changed", "review"] as const;

export type EntryStatusFilter = (typeof ENTRY_STATUSES)[number];

export type EntriesSearch = { q?: string; status?: EntryStatusFilter; language?: string; create?: boolean };

type ListedPostType = { id: string; name: string; builtIn: "page" | null };

/** How many rows show at first, and how many more each "Show more" adds. */
const PAGE_SIZE = 50;

/** The table's columns, for the rows and the skeleton alike. */
const COLUMNS = "grid-cols-[minmax(0,1fr)_10rem_8.75rem_11.25rem_7.5rem_4.5rem]";

/**
 * A Post Type's Entries: searched by title or slug, filtered by status and language, with their
 * status, the languages they are shown in, author and last change. Pages show as a tree, each under
 * its parent Page. A create row at the top makes a Draft from a title and opens it; opening a row
 * opens the Entry editor.
 */
export function EntriesList({
	siteId,
	postType,
	entries,
	languages,
	permissions,
	search,
	onSearch,
	actions,
}: {
	siteId: string;
	postType: ListedPostType;
	entries: readonly EntryView[];
	languages: { default: string; all: readonly string[] };
	permissions: readonly string[];
	search: EntriesSearch;
	onSearch(next: EntriesSearch, options?: { replace?: boolean }): void;
	/** More actions beside New, such as Import CSV. */
	actions?: ReactNode;
}) {
	const t = useT();
	const isPage = postType.builtIn === "page";
	const [shownCount, setShownCount] = useState(PAGE_SIZE);
	const query = (search.q ?? "").trim().toLocaleLowerCase();
	const language = search.language && languages.all.includes(search.language) ? search.language : undefined;
	const filtering = Boolean(query || search.status || language);
	const matches = entries.filter(
		(entry) =>
			matchesStatus(entry, search.status) &&
			(!language || !entry.draft.hiddenLanguages.includes(language)) &&
			(!query ||
				entry.draft.title.toLocaleLowerCase().includes(query) ||
				entry.draft.slug.toLocaleLowerCase().includes(query)),
	);
	const rows = isPage && !filtering ? entryTree(matches) : matches.map((entry) => ({ entry, depth: 0 }));
	const counts = Object.fromEntries(
		ENTRY_STATUSES.map((status) => [status, entries.filter((entry) => matchesStatus(entry, status)).length]),
	) as Record<EntryStatusFilter, number>;
	const untitled = t("content.relationship.untitled");
	const canCreate = permissions.includes("entry.edit");
	const newLabel = isPage ? t("entries.create.newPage") : t("entries.create.newEntry");

	return (
		<>
			<PageHeader
				heading={postType.name}
				action={
					<>
						{actions}
						{permissions.includes("structure.edit") ? (
							<Button
								variant="outline"
								nativeButton={false}
								render={
									<Link to="/sites/$siteId/post-types/$postTypeId" params={{ siteId, postTypeId: postType.id }} />
								}
							>
								<DatabaseIcon aria-hidden="true" />
								{t("entries.list.fields")}
							</Button>
						) : null}
						{canCreate ? (
							<NewEntryDialog siteId={siteId} postType={postType} label={newLabel} pages={isPage ? entries : null} />
						) : null}
					</>
				}
			>
				{t("entries.list.intro", {
					count: entries.length,
					languages: languages.all.map(languageName).join(", "),
				})}
			</PageHeader>

			<div className="grid gap-6">
				<Toolbar
					search={search}
					onSearch={onSearch}
					counts={counts}
					total={entries.length}
					name={postType.name}
					languages={languages.all}
					language={language}
				/>

				<div className="overflow-hidden rounded-lg border">
					<Table aria-label={postType.name} className="table-fixed">
						<colgroup>
							<col />
							<col className="w-40" />
							<col className="w-35" />
							<col className="w-45" />
							<col className="w-30" />
							<col className="w-18" />
						</colgroup>
						<TableHeader className="bg-muted/50">
							<TableRow className="hover:bg-transparent">
								<TableHead className="text-muted-foreground px-4">{t("content.builtIn.title")}</TableHead>
								<TableHead className="text-muted-foreground px-4">{t("content.builtIn.status")}</TableHead>
								<TableHead className="text-muted-foreground px-4">{t("entries.list.languages")}</TableHead>
								<TableHead className="text-muted-foreground px-4">{t("content.builtIn.author")}</TableHead>
								<TableHead className="text-muted-foreground px-4">{t("content.builtIn.updatedAt")}</TableHead>
								<TableHead className="px-4">
									<span className="sr-only">{t("entries.list.actions")}</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{canCreate ? <CreateRow siteId={siteId} postType={postType} focus={search.create === true} /> : null}
							{rows.length === 0 ? (
								<TableRow className="hover:bg-transparent">
									<TableCell colSpan={6} className="text-muted-foreground px-4 py-8 text-center whitespace-normal">
										{entries.length === 0
											? t(canCreate ? "entries.list.emptyCreate" : "entries.list.empty", { name: postType.name })
											: t("entries.list.noMatch")}
									</TableCell>
								</TableRow>
							) : (
								rows
									.slice(0, shownCount)
									.map(({ entry, depth }) => (
										<EntryRow
											key={entry.id}
											siteId={siteId}
											postTypeId={postType.id}
											entry={entry}
											depth={depth}
											languages={languages.all}
											untitled={untitled}
										/>
									))
							)}
						</TableBody>
					</Table>
				</div>

				{rows.length > shownCount ? (
					<p className="text-muted-foreground flex items-center justify-center gap-1 text-sm">
						<span role="status">{t("entries.list.shown", { shown: shownCount, total: rows.length })}</span>
						<span aria-hidden="true">·</span>
						<Button variant="link" className="h-auto p-0" onClick={() => setShownCount((count) => count + PAGE_SIZE)}>
							{t("entries.list.showMore")}
						</Button>
					</p>
				) : null}
			</div>
		</>
	);
}

/** Whether an Entry is in a status filter: In review counts the Reviews waiting, whatever the Entry's status. */
function matchesStatus(entry: EntryView, status: EntryStatusFilter | undefined): boolean {
	if (!status) return true;
	if (status === "review") return entry.review?.status === "inReview";
	return entry.status === status;
}

/** One Entry's row: its title, status, languages, author, last change and Edit. */
function EntryRow({
	siteId,
	postTypeId,
	entry,
	depth,
	languages,
	untitled,
}: {
	siteId: string;
	postTypeId: string;
	entry: EntryView;
	depth: number;
	languages: readonly string[];
	untitled: string;
}) {
	const t = useT();
	const title = entry.draft.title || untitled;
	const link = {
		to: "/sites/$siteId/entries/$postTypeId/$entryId",
		params: { siteId, postTypeId, entryId: entry.id },
	} as const;
	return (
		<TableRow className="group/row">
			<TableCell className="px-4 py-3 whitespace-normal">
				<div className="flex min-w-0 items-center gap-2" style={{ paddingInlineStart: `${depth * 1.5}rem` }}>
					{depth > 0 ? (
						<CornerDownRightIcon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
					) : null}
					<Link
						{...link}
						className="focus-visible:ring-ring/50 min-w-0 truncate rounded-sm font-medium outline-none hover:underline focus-visible:ring-3"
					>
						{title}
					</Link>
					{entry.problems.length > 0 ? (
						<Badge variant="outline" className="border-destructive/60 ms-auto">
							<CircleAlertIcon className="text-destructive" aria-hidden="true" />
							{t("entries.list.toFix", { count: entry.problems.length })}
						</Badge>
					) : null}
				</div>
			</TableCell>
			<TableCell className="px-4 py-3">
				<div className="flex flex-wrap items-center gap-1">
					<StatusBadge status={entry.status} />
					<ScheduleBadges scheduled={entry.scheduled} />
					{entry.review ? <ReviewBadge status={entry.review.status} /> : null}
				</div>
			</TableCell>
			<TableCell className="px-4 py-3">
				<ul className="flex gap-1" aria-label={t("entries.list.languagesOf", { title })}>
					{languages.map((language) => {
						const hidden = entry.draft.hiddenLanguages.includes(language);
						return (
							<li key={language}>
								<abbr
									title={
										hidden ? t("entries.list.hiddenIn", { language: languageName(language) }) : languageName(language)
									}
									className={`inline-flex h-5 items-center rounded-full border px-1.5 text-[11px] font-semibold uppercase no-underline ${
										hidden ? "text-muted-foreground border-dashed" : ""
									}`}
								>
									{language}
									{hidden ? <span className="sr-only"> {t("entries.list.hidden")}</span> : null}
								</abbr>
							</li>
						);
					})}
				</ul>
			</TableCell>
			<TableCell className="px-4 py-3">
				{entry.author ? (
					<span className="text-muted-foreground flex min-w-0 items-center gap-2">
						<Avatar size="sm">
							<AvatarFallback aria-hidden="true" className="text-[10px] font-semibold">
								{initials(entry.author.name)}
							</AvatarFallback>
						</Avatar>
						<span className="truncate">{entry.author.name}</span>
					</span>
				) : (
					"—"
				)}
			</TableCell>
			<TableCell className="text-muted-foreground px-4 py-3">
				<When value={entry.updatedAt} />
			</TableCell>
			<TableCell className="px-4 py-2 text-end">
				{/* The title is the row's link; Edit says so under the pointer, and is not a second stop for the keyboard. */}
				<Button
					variant="outline"
					size="sm"
					tabIndex={-1}
					aria-hidden="true"
					nativeButton={false}
					className="opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100"
					render={<Link {...link} />}
				>
					{t("entries.list.edit")}
				</Button>
			</TableCell>
		</TableRow>
	);
}

/** The row at the top of the list: a title, then Enter makes a Draft with it and opens it. */
function CreateRow({ siteId, postType, focus }: { siteId: string; postType: ListedPostType; focus: boolean }) {
	const t = useT();
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (focus) input.current?.focus();
	}, [focus]);
	const navigate = useNavigate();
	const [title, setTitle] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const label = postType.builtIn === "page" ? t("entries.create.rowPage") : t("entries.create.rowEntry");

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!title.trim()) {
			setError(t("entries.create.titleRequired"));
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			const { entry } = await api.entries.create({ siteId, postTypeId: postType.id, title: title.trim() });
			await navigate({
				to: "/sites/$siteId/entries/$postTypeId/$entryId",
				params: { siteId, postTypeId: postType.id, entryId: entry.id },
			});
		} catch (failure) {
			setError(t(errorMessage(failure)));
			setBusy(false);
		}
	};

	return (
		<TableRow className="border-dashed hover:bg-transparent">
			<TableCell colSpan={6} className="px-4 py-1.5 whitespace-normal">
				<form onSubmit={submit} noValidate className="grid gap-1">
					<div className="flex items-center gap-3">
						<PlusIcon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
						<label htmlFor="entries-create" className="sr-only">
							{label}
						</label>
						<input
							ref={input}
							id="entries-create"
							value={title}
							onChange={(event) => setTitle(event.target.value)}
							placeholder={label}
							maxLength={300}
							autoComplete="off"
							disabled={busy}
							aria-invalid={error ? true : undefined}
							aria-describedby={error ? "entries-create-error" : "entries-create-help"}
							className="placeholder:text-muted-foreground focus-visible:ring-ring/50 -ms-2 h-9 min-w-0 flex-1 rounded-md bg-transparent px-2 text-sm outline-none focus-visible:ring-3"
						/>
						<span id="entries-create-help" className="text-muted-foreground hidden text-xs @2xl/page:inline">
							{t("entries.create.rowHelp")}
						</span>
					</div>
					{error ? (
						<p id="entries-create-error" className="text-destructive ps-7 pb-1 text-sm">
							{error}
						</p>
					) : null}
				</form>
			</TableCell>
		</TableRow>
	);
}

/** Search by title or slug, the status filter with how many Entries each holds, and the language. */
function Toolbar({
	search,
	onSearch,
	counts,
	total,
	name,
	languages,
	language,
}: {
	search: EntriesSearch;
	onSearch(next: EntriesSearch, options?: { replace?: boolean }): void;
	counts: Record<EntryStatusFilter, number>;
	total: number;
	name: string;
	languages: readonly string[];
	language: string | undefined;
}) {
	const t = useT();
	const [query, setQuery] = useState(search.q ?? "");
	const latest = useRef(onSearch);
	latest.current = onSearch;

	// The list follows the search box a moment after typing stops.
	useEffect(() => {
		const trimmed = query.trim();
		if (trimmed === (search.q ?? "")) return;
		const timer = setTimeout(() => latest.current({ q: trimmed || undefined }, { replace: true }), 250);
		return () => clearTimeout(timer);
	}, [query, search.q]);

	const filters: { status: EntryStatusFilter | "all"; label: string }[] = [
		{ status: "all", label: t("entries.list.all", { count: total }) },
		{ status: "published", label: t("entries.list.published", { count: counts.published }) },
		{ status: "draft", label: t("entries.list.drafts", { count: counts.draft }) },
		{ status: "changed", label: t("entries.list.changed", { count: counts.changed }) },
		...(counts.review > 0 || search.status === "review"
			? [{ status: "review" as const, label: t("entries.list.inReview", { count: counts.review }) }]
			: []),
	];
	return (
		<div className="flex flex-wrap items-center gap-3">
			<div className="w-full max-w-80">
				<Label htmlFor="entries-search" className="sr-only">
					{t("entries.list.search", { name })}
				</Label>
				<InputGroup>
					<InputGroupAddon>
						<SearchIcon aria-hidden="true" />
					</InputGroupAddon>
					<InputGroupInput
						id="entries-search"
						type="search"
						placeholder={t("entries.list.search", { name })}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
				</InputGroup>
			</div>
			<Segmented
				label={t("entries.list.statusFilter")}
				value={search.status ?? "all"}
				options={filters.map((filter) => ({ value: filter.status, label: filter.label }))}
				onChange={(status) => onSearch({ status: status === "all" ? undefined : status })}
			/>
			{languages.length > 1 ? (
				<div className="ms-auto w-44">
					<Label htmlFor="entries-language" className="sr-only">
						{t("entries.list.language")}
					</Label>
					<NativeSelect
						id="entries-language"
						className="w-full"
						value={language ?? ""}
						onChange={(event) => onSearch({ language: event.target.value || undefined })}
					>
						<NativeSelectOption value="">{t("entries.list.languageAll")}</NativeSelectOption>
						{languages.map((code) => (
							<NativeSelectOption key={code} value={code}>
								{t("entries.list.languageOne", { language: languageName(code) })}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>
			) : null}
		</div>
	);
}

/** The list while it loads: the header, the toolbar and skeleton rows. */
export function EntriesListSkeleton() {
	const t = useT();
	return (
		<div aria-busy="true" className="grid gap-6">
			<p className="sr-only" role="status">
				{t("entries.list.loading")}
			</p>
			<div className="grid gap-2">
				<Skeleton className="h-8 w-40" />
				<Skeleton className="h-5 w-72" />
			</div>
			<div className="flex gap-3">
				<Skeleton className="h-9 w-80" />
				<Skeleton className="h-9 w-80" />
			</div>
			<div className="overflow-hidden rounded-lg border">
				<div className="bg-muted/50 h-10 border-b" />
				{[0, 1, 2, 3, 4].map((row) => (
					<div key={row} className={`grid h-13 items-center gap-4 border-b px-4 last:border-0 ${COLUMNS}`}>
						<Skeleton className="h-4 w-2/3" />
						<Skeleton className="h-5 w-20 rounded-full" />
						<Skeleton className="h-5 w-24 rounded-full" />
						<Skeleton className="h-4 w-28" />
						<Skeleton className="h-4 w-16" />
						<span />
					</div>
				))}
			</div>
		</div>
	);
}

/** Pages as a tree in order, with their depth. */
function entryTree(entries: readonly EntryView[]): { entry: EntryView; depth: number }[] {
	return pageTree(entries.map((entry) => ({ ...treePageOf(entry), entry }))).map(({ page, depth }) => ({
		entry: page.entry,
		depth,
	}));
}

function treePageOf(entry: EntryView): TreePage {
	return { id: entry.id, title: entry.draft.title, slug: entry.draft.slug, parentId: entry.draft.parentId };
}

/** Creates an Entry from its title (and, for a Page, its parent), then opens it in the editor. */
function NewEntryDialog({
	siteId,
	postType,
	label,
	pages,
}: {
	siteId: string;
	postType: ListedPostType;
	/** The button's words: "New page", "New Entry". */
	label: string;
	pages: readonly EntryView[] | null;
}) {
	const t = useT();
	const navigate = useNavigate();
	const [open, setOpen] = useState(false);
	const [title, setTitle] = useState("");
	const [parentId, setParentId] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!title.trim()) {
			setError(t("entries.create.titleRequired"));
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			const { entry } = await api.entries.create({
				siteId,
				postTypeId: postType.id,
				title: title.trim(),
				...(pages ? { parentId: parentId || null } : {}),
			});
			setOpen(false);
			setTitle("");
			await navigate({
				to: "/sites/$siteId/entries/$postTypeId/$entryId",
				params: { siteId, postTypeId: postType.id, entryId: entry.id },
			});
		} catch (failure) {
			setError(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<Button ref={trigger} onClick={() => setOpen(true)}>
				<PlusIcon aria-hidden="true" />
				{label}
			</Button>
			<Dialog
				open={open}
				onOpenChange={(next) => {
					setOpen(next);
					if (!next) setError(null);
				}}
			>
				<DialogContent closeLabel={t("entries.create.close")} finalFocus={trigger}>
					<form onSubmit={submit} className="grid gap-6" noValidate>
						<DialogHeader>
							<DialogTitle>{t("entries.create.title", { name: postType.name })}</DialogTitle>
							<DialogDescription>{t("entries.create.intro")}</DialogDescription>
						</DialogHeader>
						<FieldGroup className="gap-4">
							<Field data-invalid={error ? true : undefined}>
								<FieldLabel htmlFor="new-entry-title">{t("content.builtIn.title")}</FieldLabel>
								<Input
									id="new-entry-title"
									value={title}
									onChange={(event) => setTitle(event.target.value)}
									maxLength={300}
									autoComplete="off"
									aria-invalid={error ? true : undefined}
									aria-describedby={error ? "new-entry-title-error" : undefined}
								/>
								{error ? <FieldError id="new-entry-title-error">{error}</FieldError> : null}
							</Field>
							{pages ? (
								<Field>
									<FieldLabel htmlFor="new-entry-parent">{t("content.builtIn.parent")}</FieldLabel>
									<NativeSelect
										id="new-entry-parent"
										value={parentId}
										onChange={(event) => setParentId(event.target.value)}
										className="w-full"
									>
										<NativeSelectOption value="">{t("entries.editor.topLevel")}</NativeSelectOption>
										{entryTree(pages).map(({ entry, depth }) => (
											<NativeSelectOption key={entry.id} value={entry.id}>
												{`${"— ".repeat(depth)}${entry.draft.title || t("content.relationship.untitled")}`}
											</NativeSelectOption>
										))}
									</NativeSelect>
								</Field>
							) : null}
						</FieldGroup>
						<DialogFooter>
							<DialogClose render={<Button variant="outline" type="button" />}>
								{t("entries.create.cancel")}
							</DialogClose>
							<Button type="submit" disabled={busy}>
								{t("entries.create.submit")}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}
