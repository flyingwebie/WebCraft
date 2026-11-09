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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { CircleAlertIcon, CornerDownRightIcon, DatabaseIcon, PlusIcon, SearchIcon } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { formatUtcDate } from "../format.ts";
import { useT } from "../i18n.tsx";
import { initials } from "../shell/context.ts";
import { languageName, StatusBadge } from "./DraftParts.tsx";
import type { EntryView } from "./model.ts";

/** The statuses the list filters by. */
export const ENTRY_STATUSES = ["published", "draft", "changed"] as const;

export type EntryStatusFilter = (typeof ENTRY_STATUSES)[number];

export type EntriesSearch = { q?: string; status?: EntryStatusFilter };

type ListedPostType = { id: string; name: string; builtIn: "page" | null };

/**
 * A Post Type's Entries: searched by title or slug, filtered by status, with their status, the
 * languages they are written in, author and last change. Pages show as a tree, each under its
 * parent Page. Opening one opens the Entry editor.
 */
export function EntriesList({
	siteId,
	postType,
	entries,
	languages,
	permissions,
	search,
	onSearch,
}: {
	siteId: string;
	postType: ListedPostType;
	entries: readonly EntryView[];
	languages: { default: string; all: readonly string[] };
	permissions: readonly string[];
	search: EntriesSearch;
	onSearch(next: EntriesSearch, options?: { replace?: boolean }): void;
}) {
	const t = useT();
	const isPage = postType.builtIn === "page";
	const query = (search.q ?? "").trim().toLocaleLowerCase();
	const filtering = Boolean(query || search.status);
	const shown = entries.filter(
		(entry) =>
			(!search.status || entry.status === search.status) &&
			(!query ||
				entry.draft.title.toLocaleLowerCase().includes(query) ||
				entry.draft.slug.toLocaleLowerCase().includes(query)),
	);
	const rows = isPage && !filtering ? pageTree(shown) : shown.map((entry) => ({ entry, depth: 0 }));
	const counts = Object.fromEntries(
		ENTRY_STATUSES.map((status) => [status, entries.filter((entry) => entry.status === status).length]),
	) as Record<EntryStatusFilter, number>;
	const untitled = t("content.relationship.untitled");

	return (
		<div className="grid gap-6">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div className="grid gap-1">
					<h1 className="text-2xl font-semibold tracking-tight">{postType.name}</h1>
					<p className="text-muted-foreground">
						{t("entries.list.intro", {
							count: entries.length,
							languages: languages.all.map(languageName).join(", "),
						})}
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					{permissions.includes("structure.edit") ? (
						<Button
							variant="ghost"
							render={<Link to="/sites/$siteId/post-types/$postTypeId" params={{ siteId, postTypeId: postType.id }} />}
						>
							<DatabaseIcon aria-hidden="true" />
							{t("entries.list.fields")}
						</Button>
					) : null}
					{permissions.includes("entry.edit") ? (
						<NewEntryDialog siteId={siteId} postType={postType} pages={isPage ? entries : null} />
					) : null}
				</div>
			</div>

			<Toolbar search={search} onSearch={onSearch} counts={counts} total={entries.length} name={postType.name} />

			{entries.length === 0 ? (
				<p className="text-muted-foreground rounded-lg border border-dashed p-8 text-center">
					{t("entries.list.empty", { name: postType.name })}
				</p>
			) : (
				<div className="rounded-lg border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="ps-4">{t("content.builtIn.title")}</TableHead>
								<TableHead>{t("content.builtIn.status")}</TableHead>
								<TableHead>{t("entries.list.languages")}</TableHead>
								<TableHead>{t("content.builtIn.author")}</TableHead>
								<TableHead className="pe-4">{t("content.builtIn.updatedAt")}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows.length === 0 ? (
								<TableRow>
									<TableCell colSpan={5} className="text-muted-foreground p-6 text-center">
										{t("entries.list.noMatch")}
									</TableCell>
								</TableRow>
							) : (
								rows.map(({ entry, depth }) => (
									<TableRow key={entry.id}>
										<TableCell className="ps-4 whitespace-normal">
											<div className="flex items-center gap-2" style={{ paddingInlineStart: `${depth * 1.5}rem` }}>
												{depth > 0 ? (
													<CornerDownRightIcon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
												) : null}
												<div className="grid min-w-0">
													<Link
														to="/sites/$siteId/entries/$postTypeId/$entryId"
														params={{ siteId, postTypeId: postType.id, entryId: entry.id }}
														className="focus-visible:ring-ring/50 rounded-sm font-medium outline-none hover:underline focus-visible:ring-3"
													>
														{entry.draft.title || untitled}
													</Link>
													{isPage ? (
														<span className="text-muted-foreground truncate font-mono text-xs">
															{draftPath(entries, entry)}
														</span>
													) : null}
												</div>
												{entry.problems.length > 0 ? (
													<Badge variant="outline" className="border-destructive/60 ms-auto">
														<CircleAlertIcon className="text-destructive" aria-hidden="true" />
														{t("entries.list.toFix", { count: entry.problems.length })}
													</Badge>
												) : null}
											</div>
										</TableCell>
										<TableCell>
											<StatusBadge status={entry.status} />
										</TableCell>
										<TableCell>
											<ul
												className="flex gap-1"
												aria-label={t("entries.list.languagesOf", { title: entry.draft.title || untitled })}
											>
												{languages.all.map((language) => (
													<li key={language}>
														<abbr
															title={languageName(language)}
															className="rounded-sm border px-1.5 py-0.5 font-mono text-xs uppercase no-underline"
														>
															{language}
														</abbr>
													</li>
												))}
											</ul>
										</TableCell>
										<TableCell>
											{entry.author ? (
												<span className="flex items-center gap-2">
													<Avatar size="sm">
														<AvatarFallback aria-hidden="true">{initials(entry.author.name)}</AvatarFallback>
													</Avatar>
													{entry.author.name}
												</span>
											) : (
												"—"
											)}
										</TableCell>
										<TableCell className="pe-4">{formatUtcDate(entry.updatedAt)}</TableCell>
									</TableRow>
								))
							)}
						</TableBody>
					</Table>
				</div>
			)}
		</div>
	);
}

/** Search by title or slug, and the status filter, each with how many Entries it holds. */
function Toolbar({
	search,
	onSearch,
	counts,
	total,
	name,
}: {
	search: EntriesSearch;
	onSearch(next: EntriesSearch, options?: { replace?: boolean }): void;
	counts: Record<EntryStatusFilter, number>;
	total: number;
	name: string;
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

	const filters: { status: EntryStatusFilter | undefined; label: string }[] = [
		{ status: undefined, label: t("entries.list.all", { count: total }) },
		{ status: "published", label: t("entries.list.published", { count: counts.published }) },
		{ status: "draft", label: t("entries.list.drafts", { count: counts.draft }) },
		{ status: "changed", label: t("entries.list.changed", { count: counts.changed }) },
	];
	return (
		<div className="flex flex-wrap items-center gap-3">
			<div className="w-full max-w-xs">
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
			<fieldset className="bg-muted flex flex-wrap gap-1 rounded-lg p-1">
				<legend className="sr-only">{t("entries.list.statusFilter")}</legend>
				{filters.map((filter) => (
					<Button
						key={filter.status ?? "all"}
						type="button"
						size="sm"
						variant={search.status === filter.status ? "outline" : "ghost"}
						aria-pressed={search.status === filter.status}
						onClick={() => onSearch({ status: filter.status })}
					>
						{filter.label}
					</Button>
				))}
			</fieldset>
		</div>
	);
}

/** Pages in tree order: each followed by the Pages under it, siblings by title, with their depth. */
function pageTree(entries: readonly EntryView[]): { entry: EntryView; depth: number }[] {
	const known = new Set(entries.map((entry) => entry.id));
	const children = new Map<string | null, EntryView[]>();
	for (const entry of entries) {
		const parent = entry.draft.parentId && known.has(entry.draft.parentId) ? entry.draft.parentId : null;
		const list = children.get(parent) ?? [];
		list.push(entry);
		children.set(parent, list);
	}
	const ordered: { entry: EntryView; depth: number }[] = [];
	const seen = new Set<string>();
	const visit = (parent: string | null, depth: number) => {
		const list = [...(children.get(parent) ?? [])].sort((a, b) => a.draft.title.localeCompare(b.draft.title));
		for (const entry of list) {
			if (seen.has(entry.id)) continue;
			seen.add(entry.id);
			ordered.push({ entry, depth });
			visit(entry.id, depth + 1);
		}
	};
	visit(null, 0);
	return ordered;
}

/** A Page's address as its Draft puts it: its parents' slugs, then its own. */
function draftPath(entries: readonly EntryView[], entry: EntryView): string {
	const byId = new Map(entries.map((each) => [each.id, each]));
	const parts = [entry.draft.slug];
	let parent = entry.draft.parentId ? byId.get(entry.draft.parentId) : undefined;
	for (let depth = 0; parent && depth < 12; depth++) {
		parts.unshift(parent.draft.slug);
		parent = parent.draft.parentId ? byId.get(parent.draft.parentId) : undefined;
	}
	return entry.path ?? `/${parts.join("/")}`;
}

/** Creates an Entry from its title (and, for a Page, its parent), then opens it in the editor. */
function NewEntryDialog({
	siteId,
	postType,
	pages,
}: {
	siteId: string;
	postType: ListedPostType;
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
				{t("entries.create.open", { name: postType.name })}
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
										{pageTree(pages).map(({ entry, depth }) => (
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
