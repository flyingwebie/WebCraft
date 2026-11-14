import { Link, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
import { cn } from "@webcraft/ui/lib/utils.ts";
import {
	BlocksIcon,
	CalendarClockIcon,
	CalendarOffIcon,
	CircleAlertIcon,
	ClipboardCheckIcon,
	CodeIcon,
	FileTextIcon,
	FilterIcon,
	LayoutTemplateIcon,
	ListIcon,
	type LucideIcon,
	MailIcon,
	PaletteIcon,
	RepeatIcon,
	SearchCheckIcon,
	ShieldCheckIcon,
	SlidersHorizontalIcon,
	UploadIcon,
} from "lucide-react";
import { type RefObject, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { When } from "../content/When.tsx";
import { errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { useT } from "../i18n.tsx";
import { useOpenReview } from "../review/Review.tsx";
import { Switch } from "../settings/layout.tsx";
import type { AdminPlace } from "../shell/levels.ts";
import { PageSheet } from "../shell/page.tsx";
import { useOpenStaging } from "../shell/StagingButton.tsx";
import {
	CancelScheduleDialog,
	ScheduleDialog,
	ScheduledTime,
	ScheduleFields,
	scheduleProblem,
	useScheduleBoxes,
} from "./schedule.tsx";

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
	const navigate = useNavigate();
	const [open, setOpen] = useState(openAtStart);
	const trigger = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (openAtStart) setOpen(true);
	}, [openAtStart]);
	const close = () => {
		setOpen(false);
		// Opened by its address: closing takes `publishAll` out of it, so a link to that address (the
		// Overview's own "Publish all") opens the list again.
		if (openAtStart) {
			void navigate({
				to: ".",
				search: ((before: Record<string, unknown>) => ({ ...before, publishAll: undefined })) as never,
				replace: true,
				resetScroll: false,
			});
		}
	};
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
			{open ? <PublishAllDialog siteId={siteId} onClose={close} finalFocus={trigger} /> : null}
		</>
	);
}

/** A group of the list: its heading, and the Drafts in it. */
type DraftGroup = { key: string; label: string; staffOnly: boolean; drafts: SiteDraft[] };

/**
 * The Drafts in the groups people know them by: the Entries of each Post Type (Pages first, as the
 * Site lists them), then the Site's other content by kind, the Emails of Forms, and Structure last
 * (Templates and Components, Staff only).
 */
function groupsOf(t: T, drafts: readonly SiteDraft[], postTypeOrder: readonly string[]): DraftGroup[] {
	const groups = new Map<string, DraftGroup>();
	const add = (key: string, label: string, staffOnly: boolean, draft: SiteDraft) => {
		const group = groups.get(key) ?? { key, label, staffOnly, drafts: [] };
		group.drafts.push(draft);
		groups.set(key, group);
	};
	const structure: SiteDraft[] = [];
	const emails: SiteDraft[] = [];
	for (const draft of drafts) {
		if (draft.group === "structure") structure.push(draft);
		else if (draft.item.kind === "formEmails") emails.push(draft);
		else if (draft.item.kind === "entry")
			add(`postType:${draft.postType?.id ?? ""}`, draft.postType?.name ?? t("publishAll.kinds.entry"), false, draft);
		else add(`kind:${contentGroupOf(draft.item.kind)}`, contentGroupLabel(t, draft.item.kind), false, draft);
	}
	for (const draft of emails) add("formEmails", t("publishAll.groups.formEmails"), false, draft);
	// "Templates and Components" while that is all there is; Structure when it holds more kinds.
	const onlyTemplates = structure.every((draft) => draft.item.kind === "template" || draft.item.kind === "component");
	const structureLabel = onlyTemplates ? t("publishAll.groups.templatesAndComponents") : t("publishAll.structure");
	for (const draft of structure) add("structure", structureLabel, true, draft);
	// Post Types in the order the Site lists them (Pages first); the rest after them as they came.
	const rank = (group: DraftGroup) => {
		const at = postTypeOrder.indexOf(group.key.replace(/^postType:/, ""));
		return group.key.startsWith("postType:") ? (at === -1 ? postTypeOrder.length : at) : postTypeOrder.length + 1;
	};
	return [...groups.values()].sort((a, b) => rank(a) - rank(b));
}

/** The Site's Post Types' ids in the order its sidebar lists them, Pages first. */
function usePostTypeOrder(): readonly string[] {
	const order = useRouterState({
		select: (state) => {
			for (const match of state.matches) {
				const place = (match.context as { place?: AdminPlace } | undefined)?.place;
				if (place?.level === "site")
					return [...place.postTypes]
						.sort((a, b) => Number(b.builtIn === "page") - Number(a.builtIn === "page"))
						.map((postType) => postType.id)
						.join(" ");
			}
			return "";
		},
	});
	return useMemo(() => order.split(" ").filter(Boolean), [order]);
}

/** The content groups other than Entries: Popups' parts go together. */
function contentGroupOf(kind: Item["kind"]): string {
	return kind === "popupContent" ? "popup" : kind;
}

function contentGroupLabel(t: T, kind: Item["kind"]): string {
	switch (kind) {
		case "globals":
			return t("publishAll.groups.globals");
		case "consentBanner":
			return t("publishAll.groups.consentBanner");
		case "form":
			return t("publishAll.groups.forms");
		case "popup":
		case "popupContent":
			return t("popups.title");
		default:
			return t("publishAll.content");
	}
}

/** A Check's item, keyed as a Draft's item is. */
function checkKeyOf(item: { kind: string; id: string }): string {
	return item.kind === "designSystem" ? "designSystem:" : `${item.kind}:${item.id}`;
}

/**
 * Publish all's sheet (frame "Publish all"): the Drafts in their groups, each ticked, with what
 * changed, who changed it and when; the open Checks on them (they never stop publishing); Publish
 * later, which opens the date and time; and at the foot Select all, Cancel and Publish N.
 */
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
	// The Reviews waiting, by the item they are of.
	const [inReview, setInReview] = useState<ReadonlyMap<string, string>>(new Map());
	const openReview = useOpenReview();
	const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const [later, setLater] = useState(false);
	const when = useScheduleBoxes();
	// The Site's open Checks by item; null until they are read (they take longer than the list).
	const [checks, setChecks] = useState<ReadonlyMap<string, number> | null>(null);

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
		setInReview(new Map(reviews.map((review) => [keyOf(review.item), review.id])));
	}, [siteId]);
	const reload = useCallback(() => {
		load().catch((failure: unknown) => setProblem(t(errorMessage(failure))));
	}, [load, t]);
	useEffect(() => reload(), [reload]);
	useEffect(() => {
		let current = true;
		getApi()
			.then((api) => api.checks.list({ siteId }))
			.then(({ checks: open }) => {
				if (!current) return;
				const counted = new Map<string, number>();
				for (const check of open) counted.set(checkKeyOf(check.item), (counted.get(checkKeyOf(check.item)) ?? 0) + 1);
				setChecks(counted);
			})
			// Checks are advice: when they can't be read, the list goes on without them.
			.catch(() => undefined);
		return () => {
			current = false;
		};
	}, [siteId]);

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

	const postTypeOrder = usePostTypeOrder();
	const groups = useMemo(() => groupsOf(t, drafts ?? [], postTypeOrder), [t, drafts, postTypeOrder]);
	const mine = useMemo(() => (drafts ?? []).filter((draft) => draft.canPublish), [drafts]);
	const ticked = mine.filter((draft) => !unticked.has(keyOf(draft.item)));
	const allTicked = ticked.length === mine.length && mine.length > 0;
	const openChecks = (drafts ?? []).reduce((sum, draft) => sum + (checks?.get(keyOf(draft.item)) ?? 0), 0);

	const toggle = (draft: SiteDraft, on: boolean) => {
		const next = new Set(unticked);
		if (on) next.delete(keyOf(draft.item));
		else next.add(keyOf(draft.item));
		setUnticked(next);
	};
	const toggleAll = (on: boolean) => setUnticked(on ? new Set() : new Set(mine.map((draft) => keyOf(draft.item))));

	const publishNow = async () => {
		const api = await getApi();
		const items = ticked.map((draft) => draft.item);
		const preview = await api.publishing.publishAll({ siteId, items });
		if (preview.published || !preview.confirmation) return;
		const done = await api.publishing.publishAll({ siteId, items, confirmation: preview.confirmation.id });
		toast.success(t("publishAll.published", { count: done.published ? done.items.length : 0 }));
	};

	// Publish later: the same two calls as Publish all, with the time chosen.
	const publishLater = async (at: Date) => {
		const api = await getApi();
		const items = ticked.map((draft) => draft.item);
		const preview = await api.publishing.scheduleAll({ siteId, items, at });
		if (!("confirmation" in preview)) return;
		await api.publishing.scheduleAll({ siteId, items, at, confirmation: preview.confirmation.id });
		toast.success(t("schedule.scheduled", { time: formatUtc(at) }));
	};

	const publish = async () => {
		setProblem(null);
		const at = later ? when.chosen : null;
		if (later) {
			const refused = scheduleProblem(t, at);
			if (refused) {
				setProblem(refused);
				return;
			}
		}
		setBusy(true);
		try {
			if (at) await publishLater(at);
			else await publishNow();
			onClose();
			await router.invalidate();
		} catch (failure) {
			setProblem(refusalText(t, failure));
		} finally {
			setBusy(false);
		}
	};

	const count = ticked.length;
	return (
		<PageSheet
			open
			onOpenChange={(open) => !open && onClose()}
			finalFocus={finalFocus}
			title={t("publishAll.title")}
			description={
				drafts === null
					? t("publishAll.loading")
					: drafts.length === 0
						? t("publishAll.none")
						: t("publishAll.intro", { count: drafts.length })
			}
			className="data-[side=right]:sm:max-w-[520px]"
			footer={
				<div className="flex w-full items-center justify-between gap-2">
					{mine.length > 0 ? (
						<div className="flex items-center gap-2 ps-2.5">
							<Checkbox
								id={`${id}-all`}
								checked={allTicked}
								indeterminate={count > 0 && !allTicked}
								onCheckedChange={(value) => toggleAll(value === true)}
							/>
							<label htmlFor={`${id}-all`} className="text-sm font-medium">
								{t("publishAll.selectAll")}
							</label>
						</div>
					) : (
						<span />
					)}
					<div className="flex gap-2">
						<Button type="button" variant="outline" onClick={onClose}>
							{t("publishAll.cancel")}
						</Button>
						<Button type="button" onClick={publish} disabled={busy || count === 0}>
							{later ? t("schedule.scheduleAllSubmit", { count }) : t("publishAll.publish", { count })}
						</Button>
					</div>
				</div>
			}
		>
			<div className="grid gap-5">
				{scheduled.length > 0 ? (
					<>
						<ScheduledSection siteId={siteId} scheduled={scheduled} onChanged={reload} />
						<hr />
					</>
				) : null}
				{inReview.size > 0 ? (
					<p className="flex items-center gap-2 text-sm">
						<ClipboardCheckIcon aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
						{t("publishAll.inReview", { count: inReview.size })}
					</p>
				) : null}
				{groups.map((group, index) => (
					<section
						key={group.key}
						aria-labelledby={`${id}-${group.key}`}
						className={cn("grid gap-2.5", index > 0 && "border-t pt-5")}
					>
						<h3
							id={`${id}-${group.key}`}
							className="text-muted-foreground flex items-center gap-2 text-xs font-semibold"
						>
							{group.label}
							{group.staffOnly ? (
								<Badge variant="outline" className="text-foreground font-medium">
									{t("publishAll.staffOnly")}
								</Badge>
							) : null}
						</h3>
						<ul className="grid gap-2.5">
							{group.drafts.map((draft) => (
								<DraftRow
									key={keyOf(draft.item)}
									id={`${id}-${keyOf(draft.item)}`}
									siteId={siteId}
									draft={draft}
									waiting={waiting.get(keyOf(draft.item)) ?? null}
									review={inReview.get(keyOf(draft.item)) ?? null}
									onReview={(reviewId) => {
										onClose();
										openReview(reviewId);
									}}
									ticked={draft.canPublish && !unticked.has(keyOf(draft.item))}
									onToggle={(on) => toggle(draft, on)}
								/>
							))}
						</ul>
					</section>
				))}
				{openChecks > 0 ? (
					<div className="grid gap-1.5 border-t pt-5">
						<div className="flex items-center gap-2">
							<SearchCheckIcon aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
							<p id={`${id}-checks`} className="flex-1 text-sm">
								{t("publishAll.checksOpen", { count: openChecks })}
							</p>
							<Button
								variant="link"
								size="sm"
								aria-describedby={`${id}-checks`}
								render={<Link to="/sites/$siteId/checks" params={{ siteId }} />}
							>
								{t("publishAll.seeChecks")}
							</Button>
						</div>
						<p className="text-muted-foreground text-xs">{t("publishAll.checksNeverStop")}</p>
					</div>
				) : null}
				{mine.length > 0 ? (
					<div className="grid gap-4 border-t pt-5">
						<div className="flex items-center justify-between gap-4">
							<div className="grid gap-0.5">
								<label htmlFor={`${id}-later`} className="text-sm font-medium">
									{t("publishAll.later")}
								</label>
								<p id={`${id}-later-help`} className="text-muted-foreground text-sm">
									{t("publishAll.laterHelp")}
								</p>
							</div>
							<Switch
								id={`${id}-later`}
								checked={later}
								onCheckedChange={setLater}
								aria-describedby={`${id}-later-help`}
							/>
						</div>
						{later ? <ScheduleFields state={when} /> : null}
					</div>
				) : null}
				{problem ? (
					<p role="alert" className="text-destructive text-sm">
						{problem}
					</p>
				) : null}
			</div>
		</PageSheet>
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

/** What changed, in a few words: new, the values that differ, or that it changed. */
function changeWords(t: T, draft: SiteDraft): string {
	if (draft.status === "new") return t("publishAll.new");
	if (draft.changes.length === 0) return t("publishAll.changed");
	const labels = draft.changes.map((change) => changeLabel(t, draft, change));
	if (labels.length <= 2) return t("publishAll.changes", { list: labels.join(", ") });
	return t("publishAll.changesMore", { list: labels.slice(0, 2).join(", "), count: labels.length - 2 });
}

/**
 * One Draft: its tick and its name, then what changed, who changed it and when; a Scheduled publish or
 * a Review it waits in, and View on the Staging address.
 */
function DraftRow({
	id,
	siteId,
	draft,
	waiting,
	review,
	onReview,
	ticked,
	onToggle,
}: {
	id: string;
	siteId: string;
	draft: SiteDraft;
	/** The Scheduled publish it waits in, if any: when, and whether its Draft changed since. */
	waiting: { at: Date | string; changedSinceScheduled: boolean } | null;
	/** The Review it waits in, if its Author submitted it: publishing it ends the Review. */
	review: string | null;
	/** Opens that Review's sheet. */
	onReview: (reviewId: string) => void;
	ticked: boolean;
	onToggle: (on: boolean) => void;
}) {
	const t = useT();
	const Icon = iconOf(draft);
	const title = titleOf(t, draft);
	const who = draft.changedBy
		? draft.changedBy.via
			? t("publishAll.changedVia", { person: draft.changedBy.name, client: draft.changedBy.via })
			: draft.changedBy.name
		: null;
	// Structure's kind says what an item is when the group holds several kinds.
	const kind = draft.group === "structure" && draft.name ? kindOf(t, draft) : null;
	return (
		<li className="flex items-start gap-2.5">
			<Checkbox
				id={id}
				className="mt-0.5"
				checked={ticked}
				disabled={!draft.canPublish}
				onCheckedChange={(value) => onToggle(value === true)}
				aria-describedby={`${id}-details`}
			/>
			<Icon aria-hidden="true" className="text-muted-foreground mt-0.5 size-4 shrink-0" />
			<div className="grid min-w-0 flex-1 gap-0.5">
				<label htmlFor={id} className="truncate text-sm font-medium">
					{title}
				</label>
				<p id={`${id}-details`} className="text-muted-foreground text-[13px]">
					{kind ? `${kind} · ` : ""}
					{changeWords(t, draft)}
					{who ? ` · ${who}` : ""} · <When value={draft.changedAt} />
					{!draft.canPublish ? ` · ${t("publishAll.staffOnly")}` : ""}
				</p>
				{waiting || review ? (
					<div className="flex flex-wrap gap-1 pt-1">
						{waiting ? (
							<Badge variant="outline" title={formatUtc(waiting.at)}>
								<CalendarClockIcon aria-hidden="true" />
								{t(waiting.changedSinceScheduled ? "schedule.changedSince" : "schedule.badge")}
								<span className="sr-only"> {formatUtc(waiting.at)}</span>
							</Badge>
						) : null}
						{review ? (
							<Button
								type="button"
								variant="outline"
								size="xs"
								aria-haspopup="dialog"
								aria-label={t("publishAll.openReview", { name: title })}
								onClick={() => onReview(review)}
							>
								<ClipboardCheckIcon aria-hidden="true" />
								{t("review.badge")}
							</Button>
						) : null}
					</div>
				) : null}
			</div>
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
			size="xs"
			className="text-muted-foreground"
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
