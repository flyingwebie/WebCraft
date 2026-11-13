import { Link, useRouteContext } from "@tanstack/react-router";
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
import { CircleAlertIcon, ClipboardCheckIcon, MessageSquareWarningIcon, SendIcon, Undo2Icon } from "lucide-react";
import { type RefObject, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { useAfterRender } from "../after-render.ts";
import { getApi } from "../api.ts";
import { errorCode, errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { useT } from "../i18n.tsx";

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
function itemLink(siteId: string, review: ReviewView) {
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
										{...itemLink(siteId, review)}
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
