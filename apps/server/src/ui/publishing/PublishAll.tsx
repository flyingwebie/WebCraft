import { useRouter } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@webcraft/ui/components/dialog.tsx";
import {
	BlocksIcon,
	CalendarClockIcon,
	CalendarOffIcon,
	CircleAlertIcon,
	ClipboardCheckIcon,
	CodeIcon,
	FileTextIcon,
	FilterIcon,
	InfoIcon,
	LayoutTemplateIcon,
	ListIcon,
	type LucideIcon,
	MailIcon,
	PaletteIcon,
	RepeatIcon,
	ShieldCheckIcon,
	SlidersHorizontalIcon,
	UploadIcon,
} from "lucide-react";
import { type RefObject, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { ReviewBadge } from "../review/Review.tsx";
import { useOpenStaging } from "../shell/StagingButton.tsx";
import { CancelScheduleDialog, ScheduleDialog, ScheduledTime } from "./schedule.tsx";

/** One Draft of the Site, as `publishing.drafts` lists it. */
export type SiteDraft = Awaited<ReturnType<ApiClient["publishing"]["drafts"]>>["drafts"][number];

/** One Scheduled publish of the Site, as `publishing.scheduled` lists it. */
type Scheduled = Awaited<ReturnType<ApiClient["publishing"]["scheduled"]>>["scheduled"][number];

type Item = SiteDraft["item"];

/** An item's key, to tick it and find it again. */
function keyOf(item: Item): string {
	return `${item.kind}:${"id" in item ? item.id : ""}`;
}

/**
 * Publish all (ADR 0014), in the admin's top bar: every Draft of the Site the person may publish, with
 * how many there are. It opens the list (variant A of the navigation prototype): Content, then
 * Structure (Staff only, shown to Members but never theirs to tick), each item with what changed and
 * who changed it last, ticked unless the person unticks it, and a link to see it on the Staging
 * address. Publishing goes through the Management API's two calls: the preview, then its confirmation.
 */
export function PublishAllButton({
	siteId,
	count,
	open: openAtStart = false,
}: {
	siteId: string;
	/** How many Drafts the person may publish. */
	count: number;
	/** Open the list at once: the editing bar links here to Publish all. */
	open?: boolean;
}) {
	const t = useT();
	const [open, setOpen] = useState(openAtStart);
	const trigger = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (openAtStart) setOpen(true);
	}, [openAtStart]);
	return (
		<>
			<Button ref={trigger} size="sm" onClick={() => setOpen(true)} aria-haspopup="dialog">
				<UploadIcon aria-hidden="true" />
				{t("publishAll.button")}{" "}
				<Badge variant="secondary" className="ms-1 tabular-nums">
					{count}
				</Badge>
				{/* Its name says what the number counts: "Publish all 3 changes". */}
				<span className="sr-only"> {t("publishAll.changesCounted", { count })}</span>
			</Button>
			{open ? <PublishAllDialog siteId={siteId} onClose={() => setOpen(false)} finalFocus={trigger} /> : null}
		</>
	);
}

/** The list of Drafts, ticked, and the publish that follows. */
function PublishAllDialog({
	siteId,
	onClose,
	finalFocus,
}: {
	siteId: string;
	onClose: () => void;
	finalFocus: RefObject<HTMLButtonElement | null>;
}) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const [drafts, setDrafts] = useState<SiteDraft[] | null>(null);
	const [scheduled, setScheduled] = useState<Scheduled[]>([]);
	const [inReview, setInReview] = useState<ReadonlySet<string>>(new Set());
	const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const [scheduling, setScheduling] = useState(false);
	const scheduleButton = useRef<HTMLButtonElement>(null);

	// The Drafts and the Scheduled publishes, read again after each change made here.
	const load = useCallback(async () => {
		const api = await getApi();
		const [{ drafts: listed }, { scheduled: waiting }, { reviews }] = await Promise.all([
			api.publishing.drafts({ siteId }),
			api.publishing.scheduled({ siteId }),
			api.reviews.list({ siteId }),
		]);
		setDrafts(listed);
		setScheduled(waiting);
		setInReview(new Set(reviews.map((review) => keyOf(review.item))));
	}, [siteId]);
	const reload = useCallback(() => {
		load().catch((failure: unknown) => setProblem(t(errorMessage(failure))));
	}, [load, t]);
	useEffect(() => reload(), [reload]);

	// Each item waiting in a Scheduled publish of its Draft: when, and whether its Draft changed since.
	const waiting = useMemo(() => {
		const found = new Map<string, { at: Date | string; changedSinceScheduled: boolean }>();
		for (const each of scheduled) {
			if (each.action !== "publish") continue;
			for (const one of each.items)
				found.set(keyOf(one.item), { at: each.at, changedSinceScheduled: one.changedSinceScheduled });
		}
		return found;
	}, [scheduled]);

	const mine = useMemo(() => (drafts ?? []).filter((draft) => draft.canPublish), [drafts]);
	const ticked = mine.filter((draft) => !unticked.has(keyOf(draft.item)));
	const allTicked = ticked.length === mine.length && mine.length > 0;

	const toggle = (draft: SiteDraft, on: boolean) => {
		const next = new Set(unticked);
		if (on) next.delete(keyOf(draft.item));
		else next.add(keyOf(draft.item));
		setUnticked(next);
	};
	const toggleAll = (on: boolean) => setUnticked(on ? new Set() : new Set(mine.map((draft) => keyOf(draft.item))));

	const publish = async () => {
		setBusy(true);
		setProblem(null);
		try {
			const api = await getApi();
			const items = ticked.map((draft) => draft.item);
			const preview = await api.publishing.publishAll({ siteId, items });
			if (preview.published || !preview.confirmation) return;
			const done = await api.publishing.publishAll({ siteId, items, confirmation: preview.confirmation.id });
			toast.success(t("publishAll.published", { count: done.published ? done.items.length : 0 }));
			onClose();
			await router.invalidate();
		} catch (failure) {
			setProblem(refusalText(t, failure));
		} finally {
			setBusy(false);
		}
	};

	// "Publish all at…": the same two calls as Publish all, with the time chosen.
	const scheduleAll = async (at: Date) => {
		const api = await getApi();
		const items = ticked.map((draft) => draft.item);
		try {
			const preview = await api.publishing.scheduleAll({ siteId, items, at });
			if (!("confirmation" in preview)) return;
			await api.publishing.scheduleAll({ siteId, items, at, confirmation: preview.confirmation.id });
		} catch (failure) {
			throw new Error(refusalText(t, failure));
		}
		setScheduling(false);
		toast.success(t("schedule.scheduled", { time: formatUtc(at) }));
		reload();
		await router.invalidate();
	};

	const groups: { key: "content" | "structure"; label: MessageKey }[] = [
		{ key: "content", label: "publishAll.content" },
		{ key: "structure", label: "publishAll.structure" },
	];
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("publishAll.close")} finalFocus={finalFocus} className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>{t("publishAll.title")}</DialogTitle>
					<DialogDescription>
						{drafts === null
							? t("publishAll.loading")
							: drafts.length === 0
								? t("publishAll.none")
								: t("publishAll.intro", { count: drafts.length })}
					</DialogDescription>
				</DialogHeader>
				{scheduled.length > 0 || (drafts && drafts.length > 0) ? (
					<div className="-mx-1 grid max-h-[60vh] gap-4 overflow-y-auto px-1">
						{scheduled.length > 0 ? (
							<ScheduledSection siteId={siteId} scheduled={scheduled} onChanged={reload} />
						) : null}
						{inReview.size > 0 ? (
							<p className="flex items-center gap-2 text-sm">
								<ClipboardCheckIcon aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
								{t("publishAll.inReview", { count: inReview.size })}
							</p>
						) : null}
						{drafts && drafts.length > 0 ? (
							<div className="flex items-center gap-3">
								<Checkbox
									id={`${id}-all`}
									checked={allTicked}
									indeterminate={ticked.length > 0 && !allTicked}
									disabled={mine.length === 0}
									onCheckedChange={(value) => toggleAll(value === true)}
								/>
								<label htmlFor={`${id}-all`} className="text-sm font-medium">
									{t("publishAll.selected", { selected: ticked.length, total: mine.length })}
								</label>
							</div>
						) : null}
						{groups.map((group) => {
							const listed = (drafts ?? []).filter((draft) => draft.group === group.key);
							if (listed.length === 0) return null;
							const staffOnly = group.key === "structure" && listed.every((draft) => !draft.canPublish);
							return (
								<section key={group.key} aria-labelledby={`${id}-${group.key}`} className="grid gap-2">
									<h3
										id={`${id}-${group.key}`}
										className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase"
									>
										{t(group.label)}
										{staffOnly ? (
											<Badge variant="outline" className="font-normal normal-case">
												{t("publishAll.staffOnly")}
											</Badge>
										) : null}
									</h3>
									<ul className="grid gap-2">
										{listed.map((draft) => (
											<DraftRow
												key={keyOf(draft.item)}
												id={`${id}-${keyOf(draft.item)}`}
												siteId={siteId}
												draft={draft}
												waiting={waiting.get(keyOf(draft.item)) ?? null}
												inReview={inReview.has(keyOf(draft.item))}
												ticked={draft.canPublish && !unticked.has(keyOf(draft.item))}
												onToggle={(on) => toggle(draft, on)}
											/>
										))}
									</ul>
								</section>
							);
						})}
					</div>
				) : null}
				{problem ? (
					<p role="alert" className="text-destructive text-sm">
						{problem}
					</p>
				) : null}
				<DialogFooter className="items-center sm:justify-between">
					<p className="text-muted-foreground flex items-center gap-2 text-sm">
						<InfoIcon aria-hidden="true" className="size-4 shrink-0" />
						{t("publishAll.cacheNote")}
					</p>
					<div className="flex flex-wrap gap-2">
						<DialogClose render={<Button variant="outline" type="button" />}>{t("publishAll.cancel")}</DialogClose>
						<Button
							ref={scheduleButton}
							variant="outline"
							onClick={() => setScheduling(true)}
							disabled={busy || ticked.length === 0}
							aria-haspopup="dialog"
						>
							<CalendarClockIcon aria-hidden="true" />
							{t("schedule.publishAllAtCount", { count: ticked.length })}
						</Button>
						<Button onClick={publish} disabled={busy || ticked.length === 0}>
							<UploadIcon aria-hidden="true" />
							{t("publishAll.publish", { count: ticked.length })}
						</Button>
					</div>
				</DialogFooter>
				{scheduling ? (
					<ScheduleDialog
						title={t("schedule.scheduleAllTitle")}
						description={t("schedule.scheduleAllDescription", { count: ticked.length })}
						submitLabel={t("schedule.scheduleAllSubmit", { count: ticked.length })}
						onSubmit={scheduleAll}
						onClose={() => setScheduling(false)}
						finalFocus={scheduleButton}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

/** Which of a Scheduled publish's dialogs is open. */
type ScheduledDialog = { kind: "time" | "cancel"; scheduled: Scheduled } | null;

/**
 * The Site's Scheduled publishes, soonest first: what each publishes or unpublishes and when (UTC,
 * with the person's local time), who scheduled it, items changed since (their edits stay in the
 * Draft) or deleted since; changed, given the current Drafts or cancelled by whoever may publish
 * every item of it.
 */
function ScheduledSection({
	siteId,
	scheduled,
	onChanged,
}: {
	siteId: string;
	scheduled: readonly Scheduled[];
	onChanged: () => void;
}) {
	const t = useT();
	const id = useId();
	const [open, setOpen] = useState<ScheduledDialog>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const trigger = useRef<HTMLElement | null>(null);
	const close = () => setOpen(null);
	const after = (message: string) => {
		close();
		toast.success(message);
		onChanged();
	};
	const nameOf = (each: Scheduled) =>
		each.items
			.slice(0, 3)
			.map((one) => titleOf(t, one))
			.join(", ") + (each.items.length > 3 ? "…" : "");
	const takeDrafts = async (each: Scheduled) => {
		setProblem(null);
		try {
			const api = await getApi();
			await api.publishing.updateScheduled({ siteId, scheduleId: each.id });
			toast.success(t("schedule.updated"));
			onChanged();
		} catch (failure) {
			setProblem(refusalText(t, failure));
		}
	};
	return (
		<section aria-labelledby={`${id}-heading`} className="grid gap-2">
			<h3 id={`${id}-heading`} className="text-muted-foreground text-xs font-medium uppercase">
				{t("schedule.scheduledHeading")}
			</h3>
			<ul className="grid gap-2">
				{scheduled.map((each) => {
					const name = nameOf(each);
					const changed = each.items.some((one) => one.changedSinceScheduled);
					const missing = each.items.some((one) => one.missing);
					return (
						<li key={each.id} className="grid gap-2 rounded-lg border p-3">
							<div className="flex items-start gap-3">
								{each.action === "unpublish" ? (
									<CalendarOffIcon aria-hidden="true" className="text-muted-foreground mt-0.5 size-5 shrink-0" />
								) : (
									<CalendarClockIcon aria-hidden="true" className="text-muted-foreground mt-0.5 size-5 shrink-0" />
								)}
								<div className="grid min-w-0 flex-1 gap-0.5 text-sm">
									<p className="font-medium">
										{t(each.action === "unpublish" ? "schedule.unpublishAction" : "schedule.publishAction")}{" "}
										<ScheduledTime value={each.at} />
									</p>
									<p className="text-muted-foreground truncate text-xs">
										{t("schedule.items", { count: each.items.length })} · {name}
										{each.createdBy
											? ` · ${
													each.createdBy.via
														? t("schedule.byVia", { person: each.createdBy.name, client: each.createdBy.via })
														: t("schedule.by", { person: each.createdBy.name })
												}`
											: ""}
									</p>
								</div>
								<div className="flex flex-wrap justify-end gap-1">
									{changed ? (
										<Badge variant="outline">
											<CircleAlertIcon aria-hidden="true" />
											{t("schedule.changedSince")}
										</Badge>
									) : null}
									{missing ? (
										<Badge variant="outline" className="border-destructive/60">
											<CircleAlertIcon aria-hidden="true" className="text-destructive" />
											{t("schedule.missing")}
										</Badge>
									) : null}
								</div>
							</div>
							{each.canChange ? (
								<div className="flex flex-wrap gap-2 ps-8">
									<Button
										type="button"
										variant="outline"
										size="sm"
										aria-label={t("schedule.changeTimeOf", { name })}
										onClick={(event) => {
											trigger.current = event.currentTarget;
											setOpen({ kind: "time", scheduled: each });
										}}
									>
										{t("schedule.changeTime")}
									</Button>
									{each.action === "publish" && changed ? (
										<Button
											type="button"
											variant="outline"
											size="sm"
											aria-label={t("schedule.takeDraftsOf", { name })}
											onClick={() => void takeDrafts(each)}
										>
											{t("schedule.takeDrafts")}
										</Button>
									) : null}
									<Button
										type="button"
										variant="ghost"
										size="sm"
										aria-label={t("schedule.cancelScheduleOf", { name })}
										onClick={(event) => {
											trigger.current = event.currentTarget;
											setOpen({ kind: "cancel", scheduled: each });
										}}
									>
										{t("schedule.cancelSchedule")}
									</Button>
								</div>
							) : null}
						</li>
					);
				})}
			</ul>
			{problem ? (
				<p role="alert" className="text-destructive text-sm">
					{problem}
				</p>
			) : null}
			{open?.kind === "time" ? (
				<ScheduleDialog
					title={t("schedule.changeTimeTitle")}
					description={t(
						open.scheduled.action === "unpublish"
							? "schedule.changeUnpublishTimeDescription"
							: "schedule.changeTimeDescription",
					)}
					submitLabel={t("schedule.changeTimeSubmit")}
					initial={open.scheduled.at}
					onSubmit={async (at) => {
						const api = await getApi();
						await api.publishing.reschedule({ siteId, scheduleId: open.scheduled.id, at });
						after(t("schedule.rescheduled", { time: formatUtc(at) }));
					}}
					onClose={close}
					finalFocus={trigger}
				/>
			) : null}
			{open?.kind === "cancel" ? (
				<CancelScheduleDialog
					onConfirm={async () => {
						const api = await getApi();
						await api.publishing.cancelScheduled({ siteId, scheduleId: open.scheduled.id });
						after(t("schedule.cancelled"));
					}}
					onClose={close}
					finalFocus={trigger}
				/>
			) : null}
		</section>
	);
}

/** One Draft: its tick, what it is, what changed and who changed it, its status, and View on the Staging address. */
function DraftRow({
	id,
	siteId,
	draft,
	waiting,
	inReview,
	ticked,
	onToggle,
}: {
	id: string;
	siteId: string;
	draft: SiteDraft;
	/** The Scheduled publish it waits in, if any: when, and whether its Draft changed since. */
	waiting: { at: Date | string; changedSinceScheduled: boolean } | null;
	/** Its Author submitted it for Review, and it waits: publishing it ends the Review. */
	inReview: boolean;
	ticked: boolean;
	onToggle: (on: boolean) => void;
}) {
	const t = useT();
	const Icon = iconOf(draft);
	const title = titleOf(t, draft);
	const details = [
		kindOf(t, draft),
		draft.changes.length > 0
			? t("publishAll.changes", { list: draft.changes.map((change) => changeLabel(t, draft, change)).join(", ") })
			: null,
		draft.changedBy
			? draft.changedBy.via
				? t("publishAll.changedVia", { person: draft.changedBy.name, client: draft.changedBy.via })
				: draft.changedBy.name
			: null,
		formatUtc(draft.changedAt),
	].filter((part): part is string => part !== null);
	return (
		<li className="flex items-center gap-3 rounded-lg border p-3">
			<Checkbox
				id={id}
				checked={ticked}
				disabled={!draft.canPublish}
				onCheckedChange={(value) => onToggle(value === true)}
				aria-describedby={`${id}-details`}
			/>
			<Icon aria-hidden="true" className="text-muted-foreground size-5 shrink-0" />
			<div className="grid min-w-0 flex-1 gap-0.5">
				<label htmlFor={id} className="truncate text-sm font-medium">
					{title}
				</label>
				<p id={`${id}-details`} className="text-muted-foreground truncate text-xs">
					{details.join(" · ")}
					{!draft.canPublish ? ` · ${t("publishAll.staffOnly")}` : ""}
				</p>
			</div>
			{waiting ? (
				<Badge variant="outline" title={formatUtc(waiting.at)}>
					<CalendarClockIcon aria-hidden="true" />
					{t(waiting.changedSinceScheduled ? "schedule.changedSince" : "schedule.badge")}
					<span className="sr-only"> {formatUtc(waiting.at)}</span>
				</Badge>
			) : null}
			{inReview ? <ReviewBadge status="inReview" /> : null}
			<Badge variant={draft.status === "new" ? "secondary" : "outline"}>
				{t(draft.status === "new" ? "publishAll.new" : "publishAll.changed")}
			</Badge>
			<ViewOnStaging siteId={siteId} path={draft.path ?? "/"} name={title} />
		</li>
	);
}

/** Opens the Staging address at the item's page, through the single-use link the admin asks for. */
function ViewOnStaging({ siteId, path, name }: { siteId: string; path: string; name: string }) {
	const t = useT();
	const { opening, open } = useOpenStaging(siteId);
	const view = () => open(path);
	return (
		<Button
			variant="ghost"
			size="sm"
			onClick={view}
			disabled={opening}
			aria-label={t("publishAll.viewLabel", { name })}
		>
			{t("publishAll.view")}
		</Button>
	);
}

type T = ReturnType<typeof useT>;

/** What a refused Publish all says: which item stopped it, and why, or the error's own words. */
function refusalText(t: T, failure: unknown): string {
	const refusal = failure as {
		code?: unknown;
		data?: { name?: unknown; item?: { kind?: unknown }; code?: unknown; data?: unknown };
	};
	if (refusal.code === "PUBLISH_ALL_REFUSED" && refusal.data) {
		const name =
			typeof refusal.data.name === "string" && refusal.data.name !== "" ? refusal.data.name : t("publishAll.untitled");
		return t("publishAll.refused", {
			name,
			reason: t(errorMessage({ code: refusal.data.code, data: refusal.data.data })),
		});
	}
	return t(errorMessage(failure));
}

/** What Publish all names an item by: a Draft, or an item of a Scheduled publish. */
type Named = Pick<SiteDraft, "item" | "name" | "postType" | "templateKind"> & {
	/** History also names Component scripts (`component`); Publish all lists them as their Components. */
	scriptKind: SiteDraft["scriptKind"] | "component";
};

/** What the Draft is called: its name, or what it is when it has none (the Globals, the Design system). */
function titleOf(t: T, draft: Named): string {
	if (draft.name !== null && draft.name !== "") return draft.name;
	if (draft.item.kind === "entry") return t("publishAll.untitled");
	return kindOf(t, draft);
}

/** What kind of item a Draft is: an Entry's Post Type, a Template's kind, or the item's kind. */
function kindOf(t: T, draft: Named): string {
	switch (draft.item.kind) {
		case "entry":
			return draft.postType?.name ?? t("publishAll.kinds.entry");
		case "template":
			switch (draft.templateKind) {
				case "site":
					return t("publishAll.kinds.siteTemplate");
				case "archive":
					return t("publishAll.kinds.archiveTemplate", { postType: draft.postType?.name ?? "" });
				case "search":
					return t("publishAll.kinds.searchTemplate");
				default:
					return t("publishAll.kinds.entryTemplate", { postType: draft.postType?.name ?? "" });
			}
		case "script":
			return draft.scriptKind === "page" ? t("publishAll.kinds.pageScript") : t("publishAll.kinds.siteScript");
		case "component":
			return t("publishAll.kinds.component");
		case "loop":
			return t("publishAll.kinds.loop");
		case "filter":
			return t("publishAll.kinds.filter");
		case "popup":
		case "popupContent":
			return t("popups.title");
		case "form":
			return t("publishAll.kinds.form");
		case "formEmails":
			return t("publishAll.kinds.formEmails");
		case "globals":
			return t("publishAll.kinds.globals");
		case "consentBanner":
			return t("publishAll.kinds.consentBanner");
		case "designSystem":
			return t("publishAll.kinds.designSystem");
	}
}

/** One changed value: a Field by its label, a built-in value or a Design system section by its name. */
function changeLabel(t: T, draft: SiteDraft, change: SiteDraft["changes"][number]): string {
	if (change.label !== null) return change.label;
	if (draft.item.kind === "formEmails") {
		if (change.key === "notifications") return t("publishAll.sections.notifications");
		if (change.key === "autoReply") return t("publishAll.sections.autoReply");
	}
	if (draft.item.kind === "designSystem") {
		switch (change.key) {
			case "tokens":
				return t("publishAll.sections.tokens");
			case "classes":
				return t("publishAll.sections.classes");
			case "baseStyles":
				return t("publishAll.sections.baseStyles");
			case "customCss":
				return t("publishAll.sections.customCss");
			case "darkMode":
				return t("publishAll.sections.darkMode");
		}
	}
	switch (change.key) {
		case "title":
			return t("publishAll.builtIns.title");
		case "slug":
			return t("publishAll.builtIns.slug");
		case "parent":
			return t("publishAll.builtIns.parent");
		case "seo":
			return t("publishAll.builtIns.seo");
		case "hiddenLanguages":
			return t("publishAll.builtIns.hiddenLanguages");
		default:
			return change.key;
	}
}

function iconOf(draft: SiteDraft): LucideIcon {
	switch (draft.item.kind) {
		case "entry":
			return FileTextIcon;
		case "globals":
			return SlidersHorizontalIcon;
		case "consentBanner":
			return ShieldCheckIcon;
		case "designSystem":
			return PaletteIcon;
		case "component":
			return BlocksIcon;
		case "loop":
			return RepeatIcon;
		case "filter":
			return FilterIcon;
		case "popup":
		case "popupContent":
		case "form":
			return ListIcon;
		case "formEmails":
			return MailIcon;
		case "template":
			return LayoutTemplateIcon;
		case "script":
			return CodeIcon;
	}
}
