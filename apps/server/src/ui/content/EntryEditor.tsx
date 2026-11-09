import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { ENTRY_TITLE_MAX_LENGTH } from "@webcraft/core/field-rules";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@webcraft/ui/components/card.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@webcraft/ui/components/dialog.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@webcraft/ui/components/input-group.tsx";
import { Label } from "@webcraft/ui/components/label.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { ArrowLeftIcon, CircleAlertIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorCode, errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import type { MediaItem } from "../media/preview.ts";
import { useAutosave } from "./autosave.ts";
import { LanguageTabs, ProblemSummary, SaveStatusText, StatusBadge } from "./DraftParts.tsx";
import { FieldValueList, type ValueContext } from "./FieldValues.tsx";
import { type EntryView, type FieldValues, type Json, type PostTypeView, type Problem, problemsAt } from "./model.ts";
import { problemText } from "./problems.ts";
import type { RelationshipTargets } from "./RelationshipPicker.tsx";

/** A change to an Entry's Draft, as `entries.saveDraft` takes it. */
type EntryChange = { title?: string; slug?: string; parentId?: string | null; fields?: Record<string, Json> };

/** A Page another Page can be under. */
export type PageOption = { id: string; title: string; slug: string; parentId: string | null };

function mergeChanges(older: EntryChange, newer: EntryChange): EntryChange {
	const fields = older.fields || newer.fields ? { ...older.fields, ...newer.fields } : undefined;
	return { ...older, ...newer, ...(fields ? { fields } : {}) };
}

/**
 * The Entry editor: an Entry's title, slug (and parent Page, for a Page) and every Field of its Post
 * Type, in one language. Changes save to the Draft by themselves; what keeps the Draft from being
 * published shows next to each value and in the Status card. Editors, Owners and Staff publish;
 * Authors save Drafts only (Review comes later).
 */
export function EntryEditor({
	siteId,
	postType,
	entry: loaded,
	permissions,
	languages,
	relationships,
	media: knownMedia,
	pages,
}: {
	siteId: string;
	postType: PostTypeView;
	entry: EntryView;
	permissions: readonly string[];
	languages: { default: string; all: readonly string[] };
	relationships: RelationshipTargets;
	media: Readonly<Record<string, MediaItem>>;
	/** For a Page: the Site's other Pages, which can be its parent. */
	pages: readonly PageOption[] | null;
}) {
	const t = useT();
	const router = useRouter();
	const [entry, setEntry] = useState(loaded);
	const [values, setValues] = useState(() => ({
		title: loaded.draft.title,
		slug: loaded.draft.slug,
		parentId: loaded.draft.parentId,
		fields: loaded.draft.fields as FieldValues,
	}));
	const [refused, setRefused] = useState<Problem[]>([]);
	const [slugTaken, setSlugTaken] = useState(false);
	const [saveError, setSaveError] = useState<MessageKey | null>(null);
	const [publishError, setPublishError] = useState<string | null>(null);
	const [publishing, setPublishing] = useState(false);
	const [media, setMedia] = useState(knownMedia);
	const summary = useRef<HTMLDivElement>(null);
	const canPublish = permissions.includes("entry.publish");
	const isPage = postType.builtIn === "page";

	const autosave = useAutosave<EntryChange>({
		merge: mergeChanges,
		save: async (change) => {
			const api = await getApi();
			const { entry: saved } = await api.entries.saveDraft({
				siteId,
				entryId: entry.id,
				language: entry.language,
				...change,
			});
			setEntry(saved);
			setRefused([]);
			setSlugTaken(false);
			setSaveError(null);
		},
		onFailed: (error) => {
			const code = errorCode(error);
			const data = (error as { data?: { problems?: Problem[] } }).data;
			if (code === "ENTRY_INVALID" && data?.problems) {
				setRefused(data.problems);
				setSaveError("errors.ENTRY_INVALID");
			} else if (code === "ENTRY_SLUG_TAKEN") {
				setSlugTaken(true);
				setSaveError("errors.ENTRY_SLUG_TAKEN");
			} else {
				setSaveError(errorMessage(error));
			}
		},
	});

	const change = (part: EntryChange) => {
		setValues((before) => ({ ...before, ...part, fields: { ...before.fields, ...part.fields } }));
		autosave.change(part);
	};

	const problems = [...entry.problems, ...refused];
	const context: ValueContext = {
		siteId,
		idPrefix: "entry",
		language: entry.language,
		defaultLanguage: languages.default,
		problems,
		relationships,
		media,
		onMediaChosen: (item) => setMedia((before) => ({ ...before, [item.id]: item })),
		markShared: true,
	};

	const publish = async () => {
		setPublishing(true);
		setPublishError(null);
		try {
			if (!(await autosave.flush())) {
				setPublishError(t("entries.editor.saveFirst"));
				return;
			}
			const api = await getApi();
			const { entry: published } = await api.entries.publish({ siteId, entryId: entry.id });
			setEntry(published);
			toast.success(t("entries.editor.published", { title: values.title || t("content.relationship.untitled") }));
			await router.invalidate();
		} catch (error) {
			const code = errorCode(error);
			if (code === "ENTRY_INVALID" || code === "ENTRY_INCOMPLETE") {
				setPublishError(t("entries.editor.fixFirst"));
				requestAnimationFrame(() => summary.current?.focus());
			} else {
				setPublishError(t(errorMessage(error)));
			}
		} finally {
			setPublishing(false);
		}
	};

	const titleProblems = problemsAt(problems, "title");
	const slugProblems = problemsAt(problems, "slug");
	const parentProblems = problemsAt(problems, "parentId");
	const slugPrefix = isPage ? pagePath(pages ?? [], values.parentId) : patternPrefix(postType.urlPattern);
	const untitled = t("content.relationship.untitled");

	return (
		<div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_20rem]">
			<div className="grid min-w-0 content-start gap-6">
				<div className="flex items-start gap-3">
					<Button
						variant="ghost"
						size="icon-sm"
						className="mt-1"
						aria-label={t("entries.editor.back", { name: postType.name })}
						render={<Link to="/sites/$siteId/entries/$postTypeId" params={{ siteId, postTypeId: postType.id }} />}
					>
						<ArrowLeftIcon className="rtl:rotate-180" aria-hidden="true" />
					</Button>
					<div className="grid min-w-0 gap-1">
						<div className="flex flex-wrap items-center gap-3">
							<h1 className="text-2xl font-semibold tracking-tight break-words">{values.title.trim() || untitled}</h1>
							<StatusBadge status={entry.status} />
						</div>
						<p className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-sm">
							<span>{postType.name}</span>
							<span aria-hidden="true">·</span>
							<SaveStatusText status={autosave.status} savedAt={entry.updatedAt} />
						</p>
					</div>
				</div>

				<LanguageTabs
					languages={languages}
					current={entry.language}
					link={(language) => ({
						to: "/sites/$siteId/entries/$postTypeId/$entryId",
						params: { siteId, postTypeId: postType.id, entryId: entry.id },
						search: { language: language === languages.default ? undefined : language },
					})}
				/>

				{saveError ? (
					<div
						role="alert"
						className="border-destructive/50 text-destructive flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm"
					>
						<CircleAlertIcon className="size-4 shrink-0" aria-hidden="true" />
						<span className="flex-1">{t(saveError)}</span>
						<Button type="button" size="sm" variant="outline" onClick={() => void autosave.flush()}>
							{t("entries.editor.retry")}
						</Button>
						{saveError === "errors.CHANGED_MEANWHILE" ? (
							<Button type="button" size="sm" variant="outline" onClick={() => window.location.reload()}>
								{t("entries.editor.reload")}
							</Button>
						) : null}
					</div>
				) : null}

				<div className="grid gap-6">
					<BuiltInValue
						id="entry-title"
						label={t("content.builtIn.title")}
						required
						problems={titleProblems}
						subject="title"
					>
						{(described) => (
							<Input
								id="entry-title"
								value={values.title}
								maxLength={ENTRY_TITLE_MAX_LENGTH}
								lang={entry.language}
								autoComplete="off"
								className="h-11 text-lg"
								aria-describedby={described}
								aria-invalid={titleProblems.length > 0 ? true : undefined}
								onChange={(event) => change({ title: event.target.value })}
							/>
						)}
					</BuiltInValue>
					<BuiltInValue
						id="entry-slug"
						label={t("content.builtIn.slug")}
						required
						help={t("entries.editor.slugHelp")}
						problems={slugProblems}
						extra={slugTaken ? t("errors.ENTRY_SLUG_TAKEN") : null}
						subject="slug"
					>
						{(described) => (
							<InputGroup>
								<InputGroupAddon className="font-mono" aria-hidden="true">
									{slugPrefix}
								</InputGroupAddon>
								<InputGroupInput
									id="entry-slug"
									value={values.slug}
									lang={entry.language}
									autoComplete="off"
									spellCheck={false}
									className="font-mono"
									aria-describedby={described}
									aria-invalid={slugProblems.length > 0 || slugTaken ? true : undefined}
									onChange={(event) => change({ slug: event.target.value })}
								/>
							</InputGroup>
						)}
					</BuiltInValue>
					{isPage && pages ? (
						<BuiltInValue
							id="entry-parentId"
							label={t("content.builtIn.parent")}
							help={t("entries.editor.parentHelp")}
							problems={parentProblems}
							subject="parentId"
						>
							{(described) => (
								<NativeSelect
									id="entry-parentId"
									value={values.parentId ?? ""}
									aria-describedby={described}
									aria-invalid={parentProblems.length > 0 ? true : undefined}
									onChange={(event) => change({ parentId: event.target.value || null })}
									className="w-full"
								>
									<NativeSelectOption value="">{t("entries.editor.topLevel")}</NativeSelectOption>
									{parentOptions(pages, entry.id).map((page) => (
										<NativeSelectOption key={page.id} value={page.id}>
											{`${"— ".repeat(page.depth)}${page.title || untitled}`}
										</NativeSelectOption>
									))}
								</NativeSelect>
							)}
						</BuiltInValue>
					) : null}
					<FieldValueList
						fields={postType.fields}
						values={values.fields}
						onChange={(key, value) => change({ fields: { [key]: value } })}
						context={context}
					/>
				</div>
			</div>

			<div className="grid content-start gap-6">
				<Card>
					<CardHeader>
						<CardTitle>
							<h2>{t("entries.editor.statusHeading")}</h2>
						</CardTitle>
					</CardHeader>
					<CardContent className="grid gap-4">
						<div className="flex flex-wrap items-center justify-between gap-2 text-sm">
							<StatusBadge status={entry.status} />
							{entry.lastPublishedAt ? (
								<span className="text-muted-foreground">
									{t("entries.editor.liveSince", { date: formatUtc(entry.lastPublishedAt) })}
								</span>
							) : null}
						</div>
						<div className="flex flex-wrap gap-2">
							<Button
								type="button"
								variant="outline"
								disabled={autosave.status === "saved"}
								onClick={() => void autosave.flush()}
							>
								{t("entries.editor.saveDraft")}
							</Button>
							{canPublish ? (
								<Button type="button" disabled={publishing} onClick={publish}>
									<UploadIcon aria-hidden="true" />
									{t("entries.editor.publish")}
								</Button>
							) : null}
						</div>
						<p className="text-muted-foreground text-sm">
							{t(canPublish ? "entries.editor.publishHelp" : "entries.editor.authorHelp")}
						</p>
						{publishError ? (
							<p role="alert" className="text-destructive flex items-start gap-2 text-sm">
								<CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
								{publishError}
							</p>
						) : null}
						<div ref={summary} tabIndex={-1} className="outline-none">
							<ProblemSummary
								problems={problems}
								fields={postType.fields}
								idPrefix="entry"
								headingId="entry-problems-heading"
							/>
						</div>
						{entry.path ? (
							<p className="text-muted-foreground text-sm">
								{t("entries.editor.liveAt")} <span className="text-foreground font-mono">{entry.path}</span>
							</p>
						) : null}
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>
							<h2>{t("entries.editor.detailsHeading")}</h2>
						</CardTitle>
					</CardHeader>
					<CardContent>
						<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
							<dt className="text-muted-foreground">{t("content.builtIn.author")}</dt>
							<dd className="text-end">{entry.author?.name ?? "—"}</dd>
							<dt className="text-muted-foreground">{t("content.builtIn.createdAt")}</dt>
							<dd className="text-end">{formatUtc(entry.createdAt)}</dd>
							<dt className="text-muted-foreground">{t("content.builtIn.updatedAt")}</dt>
							<dd className="text-end">{formatUtc(entry.updatedAt)}</dd>
							<dt className="text-muted-foreground">{t("content.builtIn.publishedAt")}</dt>
							<dd className="text-end">{entry.publishedAt ? formatUtc(entry.publishedAt) : "—"}</dd>
						</dl>
					</CardContent>
				</Card>

				{entry.linkedFrom.length > 0 ? (
					<Card>
						<CardHeader>
							<CardTitle>
								<h2>{t("entries.editor.linkedFrom")}</h2>
							</CardTitle>
						</CardHeader>
						<CardContent>
							<ul className="grid gap-2 text-sm">
								{entry.linkedFrom.map((link) => (
									<li key={`${link.entryId}:${link.field}`}>
										<Link
											to="/sites/$siteId/entries/$postTypeId/$entryId"
											params={{ siteId, postTypeId: link.postTypeId, entryId: link.entryId }}
											className="focus-visible:ring-ring/50 rounded-sm underline underline-offset-4 outline-none focus-visible:ring-3"
										>
											{link.title || untitled}
										</Link>
									</li>
								))}
							</ul>
						</CardContent>
					</Card>
				) : null}

				{permissions.includes("entry.delete") ? (
					<DeleteEntry siteId={siteId} postType={postType} entryId={entry.id} title={values.title || untitled} />
				) : null}
			</div>
		</div>
	);
}

/** A built-in value's label, control, help and problems. */
function BuiltInValue({
	id,
	label,
	required,
	help,
	problems,
	extra,
	subject,
	children,
}: {
	id: string;
	label: string;
	required?: boolean;
	help?: string;
	problems: readonly Problem[];
	extra?: string | null;
	subject: "title" | "slug" | "parentId";
	children(describedBy: string | undefined): React.ReactNode;
}) {
	const t = useT();
	const shown = problems.length > 0 || Boolean(extra);
	const described =
		[help ? `${id}-help` : null, shown ? `${id}-problems` : null].filter(Boolean).join(" ") || undefined;
	return (
		<div className="grid gap-2">
			<Label htmlFor={id}>
				{label}
				{required ? (
					<>
						<span aria-hidden="true" className="text-destructive">
							*
						</span>
						<span className="sr-only">{t("content.requiredToPublish")}</span>
					</>
				) : null}
			</Label>
			{children(described)}
			{help ? (
				<p id={`${id}-help`} className="text-muted-foreground text-sm">
					{help}
				</p>
			) : null}
			{shown ? (
				<ul id={`${id}-problems`} className="text-destructive grid gap-1 text-sm">
					{problems.map((problem) => (
						<li key={`${problem.at}:${problem.rule ?? problem.message}`} className="flex items-start gap-1.5">
							<CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
							<span>{problemText(t, problem, subject)}</span>
						</li>
					))}
					{extra ? (
						<li className="flex items-start gap-1.5">
							<CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
							<span>{extra}</span>
						</li>
					) : null}
				</ul>
			) : null}
		</div>
	);
}

/** What comes before an Entry's slug in its address: `/blog/` for `/blog/{slug}`. */
function patternPrefix(urlPattern: string): string {
	return urlPattern.split("{slug}")[0] ?? "/";
}

/** A Page's address up to its own slug: its parents' slugs (from their Drafts). */
function pagePath(pages: readonly PageOption[], parentId: string | null): string {
	const byId = new Map(pages.map((page) => [page.id, page]));
	const parts: string[] = [];
	let current = parentId ? byId.get(parentId) : undefined;
	for (let depth = 0; current && depth < 12; depth++) {
		parts.unshift(current.slug);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return `/${parts.map((part) => `${part}/`).join("")}`;
}

/** The Pages that can be a Page's parent (not itself, not one under it), as a tree in order. */
function parentOptions(pages: readonly PageOption[], self: string): (PageOption & { depth: number })[] {
	const children = new Map<string | null, PageOption[]>();
	for (const page of pages) {
		const list = children.get(page.parentId) ?? [];
		list.push(page);
		children.set(page.parentId, list);
	}
	const known = new Set(pages.map((page) => page.id));
	const roots = pages.filter((page) => page.parentId === null || !known.has(page.parentId));
	const ordered: (PageOption & { depth: number })[] = [];
	const visit = (page: PageOption, depth: number) => {
		if (page.id === self || depth > 10) return;
		ordered.push({ ...page, depth });
		for (const child of (children.get(page.id) ?? []).sort(byTitle)) visit(child, depth + 1);
	};
	for (const root of roots.sort(byTitle)) visit(root, 0);
	return ordered;
}

function byTitle(a: { title: string }, b: { title: string }): number {
	return a.title.localeCompare(b.title);
}

/**
 * Deletes an Entry in two steps, as the API asks: the first call says how many other Entries link to
 * it; the second, confirmed, deletes it and removes those links.
 */
function DeleteEntry({
	siteId,
	postType,
	entryId,
	title,
}: {
	siteId: string;
	postType: PostTypeView;
	entryId: string;
	title: string;
}) {
	const t = useT();
	const navigate = useNavigate();
	const [open, setOpen] = useState(false);
	const [preview, setPreview] = useState<{ links: number; confirmation: string } | null>(null);
	const [blockedBy, setBlockedBy] = useState<{ entryId: string; postTypeId: string; title: string }[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);

	const ask = async () => {
		setBusy(true);
		setError(null);
		setBlockedBy([]);
		setPreview(null);
		try {
			const api = await getApi();
			const result = await api.entries.delete({ siteId, entryId });
			if (!result.deleted) setPreview({ links: result.links, confirmation: result.confirmation.id });
		} catch (failure) {
			const data = (failure as { data?: { blockedBy?: { entryId: string; postTypeId: string; title: string }[] } })
				.data;
			if (errorCode(failure) === "ENTRY_LINKED" && data?.blockedBy) setBlockedBy(data.blockedBy);
			setError(t(errorMessage(failure)));
		} finally {
			setBusy(false);
			setOpen(true);
		}
	};

	const confirm = async () => {
		if (!preview) return;
		setBusy(true);
		try {
			const api = await getApi();
			await api.entries.delete({ siteId, entryId, confirmation: preview.confirmation });
			setOpen(false);
			toast.success(t("entries.delete.deleted", { title }));
			await navigate({ to: "/sites/$siteId/entries/$postTypeId", params: { siteId, postTypeId: postType.id } });
		} catch (failure) {
			setPreview(null);
			setError(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div>
			<Button ref={trigger} type="button" variant="outline" disabled={busy} onClick={ask}>
				<Trash2Icon aria-hidden="true" />
				{t("entries.delete.open")}
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent closeLabel={t("entries.delete.close")} finalFocus={trigger}>
					<DialogHeader>
						<DialogTitle>{t("entries.delete.title", { title })}</DialogTitle>
						<DialogDescription>
							{preview
								? `${t("entries.delete.body")}${preview.links > 0 ? ` ${t("entries.delete.links", { count: preview.links })}` : ""}`
								: (error ?? t("entries.delete.checking"))}
						</DialogDescription>
					</DialogHeader>
					{blockedBy.length > 0 ? (
						<ul className="grid gap-1 text-sm">
							{blockedBy.map((blocking) => (
								<li key={blocking.entryId}>
									<Link
										to="/sites/$siteId/entries/$postTypeId/$entryId"
										params={{ siteId, postTypeId: blocking.postTypeId, entryId: blocking.entryId }}
										className="focus-visible:ring-ring/50 rounded-sm underline underline-offset-4 outline-none focus-visible:ring-3"
										onClick={() => setOpen(false)}
									>
										{blocking.title || t("content.relationship.untitled")}
									</Link>
								</li>
							))}
						</ul>
					) : null}
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>{t("entries.delete.cancel")}</DialogClose>
						{preview ? (
							<Button type="button" variant="destructive" disabled={busy} onClick={confirm}>
								{t("entries.delete.confirm")}
							</Button>
						) : error && blockedBy.length === 0 ? (
							<Button type="button" variant="outline" disabled={busy} onClick={ask}>
								{t("entries.delete.again")}
							</Button>
						) : null}
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
