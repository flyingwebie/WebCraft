import { Link, useNavigate, useRouteContext, useRouter, useRouterState } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import { REVIEW_LIMITS } from "@webcraft/core/field-rules";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@webcraft/ui/components/card.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@webcraft/ui/components/dialog.tsx";
import { Label } from "@webcraft/ui/components/label.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import {
	ArrowUpRightIcon,
	CircleAlertIcon,
	ClipboardCheckIcon,
	FilePlusIcon,
	MessageSquareWarningIcon,
	PencilLineIcon,
	QuoteIcon,
	SendIcon,
	Undo2Icon,
} from "lucide-react";
import { type RefObject, useCallback, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { useAfterRender } from "../after-render.ts";
import { getApi } from "../api.ts";
import { whenWords } from "../content/When.tsx";
import { errorCode, errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { useT } from "../i18n.tsx";
import { PageSheet } from "../shell/page.tsx";

/** A Review, as the API answers it. */
export type ReviewView = Awaited<ReturnType<ApiClient["reviews"]["get"]>>["review"];

/** What can be reviewed: an Entry, the Globals or the Consent banner's words. */
export type ReviewItem = ReviewView["item"];

/** The error codes that mean the Draft has problems to fix before it can be submitted. */
const PROBLEM_CODES = [
	"ENTRY_INVALID",
	"ENTRY_INCOMPLETE",
	"GLOBALS_INVALID",
	"POPUP_INVALID",
	"GLOBALS_INCOMPLETE",
	"CONSENT_BANNER_INVALID",
];

/**
 * "Submit for review" (GLOSSARY.md › Review), for those who may edit a Draft but not publish it:
 * opens a dialog with an optional note, saves what is waiting first, then submits. The people who may
 * publish it are emailed and see it In review.
 */
export function SubmitForReview({
	siteId,
	items,
	disabled,
	flush,
	onSubmitted,
	onProblems,
}: {
	siteId: string;
	items: readonly ReviewItem[];
	disabled?: boolean;
	/** Saves what is waiting, so what is submitted is the Draft on screen; false when it couldn't. */
	flush: () => Promise<boolean>;
	onSubmitted: () => Promise<void>;
	/** The Draft has problems to fix first: the editor shows where. */
	onProblems?: () => void;
}) {
	const t = useT();
	const id = useId();
	const trigger = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const afterRender = useAfterRender();

	const submit = async () => {
		setBusy(true);
		setProblem(null);
		try {
			if (!(await flush())) {
				setProblem(t("entries.editor.saveFirst"));
				return;
			}
			const api = await getApi();
			await api.reviews.submit({ siteId, items: [...items], note: note.trim() || null });
			setOpen(false);
			setNote("");
			toast.success(t("review.submitted"));
			await onSubmitted();
		} catch (failure) {
			if (PROBLEM_CODES.includes(errorCode(failure) ?? "")) {
				setOpen(false);
				toast.error(t("review.fixFirst"));
				afterRender(() => onProblems?.());
			} else {
				setProblem(t(errorMessage(failure)));
			}
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<Button ref={trigger} type="button" disabled={disabled} onClick={() => setOpen(true)}>
				<SendIcon aria-hidden="true" />
				{t("review.submit")}
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent closeLabel={t("review.close")} finalFocus={trigger}>
					<DialogHeader>
						<DialogTitle>{t("review.submitTitle")}</DialogTitle>
						<DialogDescription>{t("review.submitBody")}</DialogDescription>
					</DialogHeader>
					<div className="grid gap-2">
						<Label htmlFor={`${id}-note`}>{t("review.noteLabel")}</Label>
						<Textarea
							id={`${id}-note`}
							value={note}
							maxLength={REVIEW_LIMITS.noteMax}
							aria-describedby={`${id}-note-help`}
							onChange={(event) => setNote(event.target.value)}
						/>
						<p id={`${id}-note-help`} className="text-muted-foreground text-xs">
							{t("review.noteHelp")}
						</p>
					</div>
					{problem ? (
						<p role="alert" className="text-destructive text-sm">
							{problem}
						</p>
					) : null}
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>{t("review.cancel")}</DialogClose>
						<Button type="button" disabled={busy} onClick={submit}>
							{t("review.submitConfirm")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

/**
 * Sends a waiting Review back with a comment saying why (required), for those who may publish it.
 */
export function SendBackDialog({
	siteId,
	reviewId,
	onClose,
	onSentBack,
	finalFocus,
}: {
	siteId: string;
	reviewId: string;
	onClose: () => void;
	onSentBack: () => Promise<void>;
	finalFocus?: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const id = useId();
	const field = useRef<HTMLTextAreaElement>(null);
	const [comment, setComment] = useState("");
	const [missing, setMissing] = useState(false);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);

	const send = async () => {
		if (!comment.trim()) {
			setMissing(true);
			field.current?.focus();
			return;
		}
		setBusy(true);
		setProblem(null);
		try {
			const api = await getApi();
			await api.reviews.sendBack({ siteId, reviewId, comment: comment.trim() });
			toast.success(t("review.sentBackDone"));
			await onSentBack();
		} catch (failure) {
			setProblem(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("review.close")} finalFocus={finalFocus}>
				<DialogHeader>
					<DialogTitle>{t("review.sendBackTitle")}</DialogTitle>
					<DialogDescription>{t("review.sendBackBody")}</DialogDescription>
				</DialogHeader>
				<div className="grid gap-2">
					<Label htmlFor={`${id}-comment`}>
						{t("review.commentLabel")}
						<span aria-hidden="true" className="text-destructive">
							*
						</span>
					</Label>
					<Textarea
						ref={field}
						id={`${id}-comment`}
						value={comment}
						required
						maxLength={REVIEW_LIMITS.commentMax}
						aria-invalid={missing ? true : undefined}
						aria-describedby={missing ? `${id}-comment-missing` : undefined}
						onChange={(event) => {
							setComment(event.target.value);
							setMissing(false);
						}}
					/>
					{missing ? (
						<p id={`${id}-comment-missing`} className="text-destructive flex items-center gap-1.5 text-sm">
							<CircleAlertIcon className="size-4 shrink-0" aria-hidden="true" />
							{t("review.commentRequired")}
						</p>
					) : null}
				</div>
				{problem ? (
					<p role="alert" className="text-destructive text-sm">
						{problem}
					</p>
				) : null}
				<DialogFooter>
					<DialogClose render={<Button variant="outline" type="button" />}>{t("review.cancel")}</DialogClose>
					<Button type="button" disabled={busy} onClick={send}>
						{t("review.sendBackConfirm")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Who acted, as the admin names them: "you", or their name ("<person> via <client>" for an API client). */
function usePersonName() {
	const t = useT();
	const you = useRouteContext({ from: "__root__" }).shell.person?.id ?? null;
	return (person: ReviewView["submittedBy"]) => {
		if (!person) return t("review.someone");
		if (person.id === you) return t("review.you");
		return person.via ? t("review.via", { name: person.name, client: person.via }) : person.name;
	};
}

/**
 * Where an item's Review stands, in its editor's Status card: In review (who submitted it, when,
 * their note, whether the Draft changed since; Withdraw for its Author; Send back for those who may
 * publish it, who publish or schedule it with the card's own buttons), or sent back, with the comment,
 * until it is submitted again or published.
 */
export function ReviewStatus({
	siteId,
	review,
	onChanged,
}: {
	siteId: string;
	review: ReviewView | null;
	/** Reads the item again, with its Review. */
	onChanged: () => Promise<void>;
}) {
	const t = useT();
	const id = useId();
	const name = usePersonName();
	const sendBackButton = useRef<HTMLButtonElement>(null);
	const openReview = useOpenReview();
	const [sendingBack, setSendingBack] = useState(false);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	if (!review) return null;

	const withdraw = async () => {
		setBusy(true);
		setProblem(null);
		try {
			const api = await getApi();
			await api.reviews.withdraw({ siteId, reviewId: review.id });
			toast.success(t("review.withdrawn"));
			await onChanged();
		} catch (failure) {
			setProblem(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};

	if (review.status === "sentBack") {
		return (
			<section aria-labelledby={`${id}-heading`} className="grid gap-2 rounded-lg border border-dashed p-3 text-sm">
				<h3 id={`${id}-heading`} className="flex items-center gap-2 font-medium">
					<MessageSquareWarningIcon aria-hidden="true" className="size-4 shrink-0" />
					{t("review.sentBackHeading")}
				</h3>
				<p className="text-muted-foreground">
					{t("review.sentBackBy", {
						name: name(review.decidedBy),
						time: formatUtc(review.decidedAt ?? review.submittedAt),
					})}
				</p>
				<blockquote className="border-s-2 ps-3 whitespace-pre-wrap">{review.comment}</blockquote>
				<p className="text-muted-foreground text-xs">{t("review.sentBackHelp")}</p>
			</section>
		);
	}

	return (
		<section aria-labelledby={`${id}-heading`} className="grid gap-2 rounded-lg border p-3 text-sm">
			<h3 id={`${id}-heading`} className="flex flex-wrap items-center gap-2 font-medium">
				<ReviewBadge status="inReview" />
			</h3>
			<p className="text-muted-foreground">
				{t("review.submittedBy", {
					name: name(review.submittedBy),
					time: formatUtc(review.submittedAt),
				})}
			</p>
			{review.note ? (
				<figure className="grid gap-1">
					<figcaption className="text-muted-foreground text-xs">{t("review.noteHeading")}</figcaption>
					<blockquote className="border-s-2 ps-3 whitespace-pre-wrap">{review.note}</blockquote>
				</figure>
			) : null}
			{review.changedSinceSubmitted ? (
				<div className="grid gap-1">
					<Badge variant="outline" className="w-fit">
						<CircleAlertIcon aria-hidden="true" />
						{t("review.changedSince")}
					</Badge>
					<p className="text-muted-foreground text-xs">{t("review.changedSinceHelp")}</p>
				</div>
			) : null}
			{review.canAct ? <p className="text-muted-foreground text-xs">{t("review.actHelp")}</p> : null}
			<div className="flex flex-wrap gap-2">
				{review.canAct ? (
					<Button type="button" size="sm" onClick={() => openReview(review.id)} aria-haspopup="dialog">
						<ClipboardCheckIcon aria-hidden="true" />
						{t("review.sheet.openReview")}
					</Button>
				) : null}
				{review.canAct ? (
					<Button ref={sendBackButton} type="button" variant="outline" size="sm" onClick={() => setSendingBack(true)}>
						<Undo2Icon aria-hidden="true" className="rtl:-scale-x-100" />
						{t("review.sendBack")}
					</Button>
				) : null}
				{review.canWithdraw ? (
					<Button type="button" variant="outline" size="sm" disabled={busy} onClick={withdraw}>
						{t("review.withdraw")}
					</Button>
				) : null}
			</div>
			{problem ? (
				<p role="alert" className="text-destructive text-sm">
					{problem}
				</p>
			) : null}
			{sendingBack ? (
				<SendBackDialog
					siteId={siteId}
					reviewId={review.id}
					finalFocus={sendBackButton}
					onClose={() => setSendingBack(false)}
					onSentBack={async () => {
						setSendingBack(false);
						await onChanged();
					}}
				/>
			) : null}
		</section>
	);
}

/** A list's chip for an item's Review: "In review", or "Sent back". Words and an icon, never colour alone. */
export function ReviewBadge({ status }: { status: ReviewView["status"] }) {
	const t = useT();
	if (status === "inReview") {
		return (
			<Badge variant="outline">
				<ClipboardCheckIcon aria-hidden="true" />
				{t("review.badge")}
			</Badge>
		);
	}
	if (status === "sentBack") {
		return (
			<Badge variant="outline">
				<MessageSquareWarningIcon aria-hidden="true" />
				{t("review.sentBackBadge")}
			</Badge>
		);
	}
	return null;
}

/** Where an item under review is edited in the admin. */
export function reviewItemLink(siteId: string, review: ReviewView) {
	if (review.item.kind === "entry") {
		return {
			to: "/sites/$siteId/entries/$postTypeId/$entryId" as const,
			params: { siteId, postTypeId: review.postType?.id ?? "", entryId: review.item.id },
		};
	}
	if (review.item.kind === "popupContent")
		return { to: "/sites/$siteId/popups" as const, params: { siteId }, search: { popup: review.item.id } };
	return review.item.kind === "globals"
		? { to: "/sites/$siteId/globals" as const, params: { siteId } }
		: { to: "/sites/$siteId/consent-banner" as const, params: { siteId } };
}

/**
 * "Waiting for review": the Site's Reviews nobody has acted on yet, longest waiting first, each with
 * who submitted it, when, their note, and a link to the item, where it is published, scheduled or
 * sent back. Everyone who sees the Site sees it; it says how many the person may act on.
 */
export function WaitingForReview({
	siteId,
	reviews,
	headingLevel = "h2",
}: {
	siteId: string;
	reviews: readonly ReviewView[];
	headingLevel?: "h2" | "h3";
}) {
	const t = useT();
	const name = usePersonName();
	const Heading = headingLevel;
	const toAct = reviews.filter((review) => review.canAct).length;
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Heading>{t("review.waitingHeading")}</Heading>
				</CardTitle>
				<CardDescription>
					{reviews.length === 0
						? t("review.waitingNone")
						: toAct > 0
							? t("review.waitingToAct", { count: toAct })
							: t("review.waitingCount", { count: reviews.length })}
				</CardDescription>
			</CardHeader>
			{reviews.length > 0 ? (
				<CardContent>
					<ul className="grid gap-3">
						{reviews.map((review) => (
							<li key={review.id} className="grid gap-1 rounded-lg border p-3 text-sm">
								<div className="flex flex-wrap items-center gap-2">
									<Link
										{...reviewItemLink(siteId, review)}
										className="focus-visible:ring-ring/50 rounded-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-3"
									>
										{reviewItemName(t, review)}
									</Link>
									{review.changedSinceSubmitted ? (
										<Badge variant="outline">
											<CircleAlertIcon aria-hidden="true" />
											{t("review.changedSince")}
										</Badge>
									) : null}
								</div>
								<p className="text-muted-foreground">
									{t("review.submittedBy", {
										name: name(review.submittedBy),
										time: formatUtc(review.submittedAt),
									})}
								</p>
								{review.note ? <p className="whitespace-pre-wrap">{review.note}</p> : null}
							</li>
						))}
					</ul>
				</CardContent>
			) : null}
		</Card>
	);
}

/** How the admin names a reviewed item: an Entry by its title (and Post Type), the Globals and the Consent banner's words by what they are. */
export function reviewItemName(
	t: ReturnType<typeof useT>,
	review: Pick<ReviewView, "item" | "name" | "postType">,
): string {
	if (review.item.kind === "globals") return t("review.items.globals");
	if (review.item.kind === "consentBanner") return t("review.items.consentBanner");
	const title = review.name || t("content.relationship.untitled");
	return review.postType ? `${title} · ${review.postType.name}` : title;
}

/** Opens the Review sheet at the Review the address names (`?review=<id>`), from wherever the person is on the Site. */
export function useOpenReview(): (reviewId: string) => void {
	const navigate = useNavigate();
	return useCallback(
		(reviewId: string) =>
			void navigate({
				to: ".",
				search: ((before: Record<string, unknown>) => ({
					...before,
					review: reviewId,
					publishAll: undefined,
				})) as never,
				resetScroll: false,
			}),
		[navigate],
	);
}

/**
 * The Review sheet, while the address names a Review (`?review=<id>`): the top bar holds it, so a link
 * from any screen of the Site opens it over that screen. A Dashboard's Reports page is the one screen
 * whose own `review` names something else (a Report's send waiting for review, which its email links
 * to): the address is that page's there.
 */
export function ReviewFromAddress({ siteId }: { siteId: string }) {
	const navigate = useNavigate();
	const reviewId = useRouterState({
		select: (state) => {
			if (state.matches.some((match) => match.routeId.endsWith("/reports"))) return null;
			const value = (state.location.search as { review?: unknown }).review;
			return typeof value === "string" && value !== "" ? value : null;
		},
	});
	if (!reviewId) return null;
	const close = () =>
		void navigate({
			to: ".",
			search: ((before: Record<string, unknown>) => ({ ...before, review: undefined })) as never,
			resetScroll: false,
			replace: true,
		});
	return <ReviewSheet key={reviewId} siteId={siteId} reviewId={reviewId} onClose={close} />;
}

/** One changed value of the item under review, as Publish all lists it. */
type Change = { key: string; label: string | null };

/**
 * A Review (frame "Review"), in a sheet over the page: who sent it and when, their note as a quote,
 * what changed in its Draft, a link to the page, and a comment for its Author. Those who may publish
 * the item send it back (the comment is needed then: it says why) or publish it; its Author may
 * withdraw it.
 */
function ReviewSheet({ siteId, reviewId, onClose }: { siteId: string; reviewId: string; onClose: () => void }) {
	const t = useT();
	const id = useId();
	const router = useRouter();
	const field = useRef<HTMLTextAreaElement>(null);
	const [review, setReview] = useState<ReviewView | null>(null);
	const [changes, setChanges] = useState<{ status: "new" | "changed"; list: Change[] } | null>(null);
	const [comment, setComment] = useState("");
	const [missing, setMissing] = useState(false);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);

	useEffect(() => {
		let current = true;
		(async () => {
			const api = await getApi();
			const { review: found } = await api.reviews.get({ siteId, reviewId });
			if (!current) return;
			setReview(found);
			// What changed comes from the Site's Drafts: advice, so the sheet goes on without it.
			const { drafts } = await api.publishing.drafts({ siteId }).catch(() => ({ drafts: [] }));
			const draft = drafts.find(
				(each) =>
					each.item.kind === found.item.kind && ("id" in each.item ? each.item.id : null) === itemIdOf(found.item),
			);
			if (current) setChanges(draft ? { status: draft.status, list: draft.changes } : { status: "changed", list: [] });
		})().catch((failure: unknown) => {
			if (current) setProblem(t(errorMessage(failure)));
		});
		return () => {
			current = false;
		};
	}, [siteId, reviewId, t]);

	const after = async (message: string) => {
		toast.success(message);
		onClose();
		await router.invalidate();
	};
	const act = async (work: () => Promise<void>) => {
		setBusy(true);
		setProblem(null);
		try {
			await work();
		} catch (failure) {
			setProblem(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};
	const sendBack = () => {
		if (!comment.trim()) {
			setMissing(true);
			field.current?.focus();
			return;
		}
		void act(async () => {
			await (await getApi()).reviews.sendBack({ siteId, reviewId, comment: comment.trim() });
			await after(t("review.sentBackDone"));
		});
	};
	// Publishing the item ends its Review: the same two calls as Publish all, for this one item.
	const publish = () =>
		act(async () => {
			if (!review) return;
			const api = await getApi();
			const items = [review.item];
			const preview = await api.publishing.publishAll({ siteId, items });
			if (!preview.published && preview.confirmation)
				await api.publishing.publishAll({ siteId, items, confirmation: preview.confirmation.id });
			await after(t("publishAll.published", { count: 1 }));
		});
	const withdraw = () =>
		act(async () => {
			await (await getApi()).reviews.withdraw({ siteId, reviewId });
			await after(t("review.withdrawn"));
		});

	const author = review?.submittedBy?.name ?? t("review.someone");
	const firstName = author.split(" ")[0] ?? author;
	const waiting = review?.status === "inReview";
	return (
		<PageSheet
			open
			onOpenChange={(open) => !open && onClose()}
			title={review ? t("review.sheet.title", { name: reviewItemTitle(t, review) }) : t("review.sheet.loading")}
			description={
				review
					? t("review.sheet.sent", { name: author, when: whenWords(t, new Date(review.submittedAt), new Date()) })
					: undefined
			}
			className="data-[side=right]:sm:max-w-[520px]"
			footer={
				review && waiting ? (
					<div className="flex w-full items-center justify-between gap-2">
						{review.canAct ? (
							<Button type="button" variant="outline" disabled={busy} onClick={sendBack}>
								{t("review.sendBackConfirm")}
							</Button>
						) : review.canWithdraw ? (
							<Button type="button" variant="outline" disabled={busy} onClick={() => void withdraw()}>
								{t("review.withdraw")}
							</Button>
						) : (
							<span />
						)}
						{review.canAct ? (
							<Button type="button" disabled={busy} onClick={() => void publish()}>
								{t("review.sheet.publish")}
							</Button>
						) : null}
					</div>
				) : undefined
			}
		>
			{review ? (
				<div className="grid gap-5">
					{review.note ? (
						<figure className="bg-muted flex gap-2.5 rounded-lg p-3.5 text-sm">
							<QuoteIcon aria-hidden="true" className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
							<blockquote className="whitespace-pre-wrap">{review.note}</blockquote>
							<figcaption className="sr-only">{t("review.noteHeading")}</figcaption>
						</figure>
					) : null}
					{!waiting ? (
						<p className="text-muted-foreground text-sm">{t("review.sheet.decided")}</p>
					) : review.changedSinceSubmitted ? (
						<div className="grid gap-1">
							<Badge variant="outline" className="w-fit">
								<CircleAlertIcon aria-hidden="true" />
								{t("review.changedSince")}
							</Badge>
							<p className="text-muted-foreground text-xs">{t("review.changedSinceHelp")}</p>
						</div>
					) : null}
					<div>
						<Button variant="outline" render={<Link {...reviewItemLink(siteId, review)} />}>
							<ArrowUpRightIcon aria-hidden="true" className="rtl:-scale-x-100" />
							{t("review.sheet.open")}
						</Button>
					</div>
					<section aria-labelledby={`${id}-changed`} className="grid gap-3">
						<h3 id={`${id}-changed`} className="text-muted-foreground text-sm font-medium">
							{t("review.sheet.whatChanged")}
						</h3>
						{changes === null ? (
							<p className="text-muted-foreground text-sm">{t("review.sheet.loading")}</p>
						) : changes.status === "new" ? (
							<ChangeRow icon={FilePlusIcon} title={t("review.sheet.new")} line={t("review.sheet.newLine")} />
						) : changes.list.length === 0 ? (
							<p className="text-muted-foreground text-sm">{t("review.sheet.noDetail")}</p>
						) : (
							<ul className="grid gap-3">
								{changes.list.map((change) => (
									<li key={change.key}>
										<ChangeRow
											icon={PencilLineIcon}
											title={change.label ?? builtInLabel(t, change.key)}
											line={t("review.sheet.changedLine")}
										/>
									</li>
								))}
							</ul>
						)}
					</section>
					{waiting && review.canAct ? (
						<div className="grid gap-2">
							<Label htmlFor={`${id}-comment`}>{t("review.sheet.commentFor", { name: firstName })}</Label>
							<Textarea
								ref={field}
								id={`${id}-comment`}
								value={comment}
								rows={3}
								maxLength={REVIEW_LIMITS.commentMax}
								placeholder={t("review.sheet.commentPlaceholder")}
								aria-invalid={missing ? true : undefined}
								aria-describedby={`${id}-comment-help`}
								onChange={(event) => {
									setComment(event.target.value);
									setMissing(false);
								}}
							/>
							<p
								id={`${id}-comment-help`}
								className={
									missing ? "text-destructive flex items-center gap-1.5 text-sm" : "text-muted-foreground text-xs"
								}
							>
								{missing ? <CircleAlertIcon className="size-4 shrink-0" aria-hidden="true" /> : null}
								{missing ? t("review.commentRequired") : t("review.sheet.commentHelp", { name: firstName })}
							</p>
						</div>
					) : null}
				</div>
			) : null}
			{problem ? (
				<p role="alert" className="text-destructive mt-4 text-sm">
					{problem}
				</p>
			) : null}
		</PageSheet>
	);
}

/** One row of "What changed": an icon, what changed, and a line about it. */
function ChangeRow({ icon: Icon, title, line }: { icon: typeof PencilLineIcon; title: string; line: string }) {
	return (
		<div className="flex items-start gap-2.5">
			<Icon aria-hidden="true" className="text-muted-foreground mt-0.5 size-4 shrink-0" />
			<div className="grid gap-0.5">
				<p className="text-sm font-medium">{title}</p>
				<p className="text-muted-foreground text-[13px]">{line}</p>
			</div>
		</div>
	);
}

/** A reviewed item's id, when its kind has several on a Site. */
function itemIdOf(item: ReviewItem): string | null {
	return "id" in item ? item.id : null;
}

/** How the sheet's title names the item: an Entry by its title, the rest by what they are. */
function reviewItemTitle(t: ReturnType<typeof useT>, review: Pick<ReviewView, "item" | "name">): string {
	if (review.item.kind === "globals") return t("review.items.globals");
	if (review.item.kind === "consentBanner") return t("review.items.consentBanner");
	return review.name || t("content.relationship.untitled");
}

/** A built-in value's name, as Publish all says it. */
function builtInLabel(t: ReturnType<typeof useT>, key: string): string {
	switch (key) {
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
			return key;
	}
}
