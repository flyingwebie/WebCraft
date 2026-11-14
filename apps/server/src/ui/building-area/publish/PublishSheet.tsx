import {
	BracesIcon,
	ComponentIcon,
	FileCodeIcon,
	GlobeIcon,
	ImageIcon,
	LanguagesIcon,
	LayoutGridIcon,
	type LucideIcon,
	PaletteIcon,
	RepeatIcon,
	Rows3Icon,
	SendIcon,
	TypeIcon,
	UploadIcon,
	XIcon,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";

import { fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";
import { type ChangeRow, changeText, countOf, type DraftRow, draftName, type PublishData, whoText } from "./data.ts";

/**
 * Publish's sheet (SPEC 13.8, `client-flows/04`): it opens above the button. One row per change of the
 * page (what, who, when) with Revert, then one row per whole item Staff publish with it (a Template, a
 * Component, the Design system…); a note about translations when there are any; Publish later with a
 * day and a time; "N other Drafts on this Site · Publish all" for those who may publish; "Discard all
 * changes" (asked first); Publish. An Author gets "Send for review" with a note instead, and Withdraw
 * while their Review waits.
 */

/** What the sheet asks the controller to do. */
export type SheetActions = {
	publish(): void;
	schedule(at: Date): void;
	revert(change: ChangeRow): Promise<void>;
	discard(): Promise<void>;
	submit(note: string | null): Promise<void>;
	withdraw(): Promise<void>;
	close(focusCell: boolean): void;
};

const ROW_ICONS: Record<string, LucideIcon> = {
	media: ImageIcon,
	loopItems: LayoutGridIcon,
	pageLayout: Rows3Icon,
	template: FileCodeIcon,
	component: ComponentIcon,
	loop: RepeatIcon,
	script: BracesIcon,
	designSystem: PaletteIcon,
	globals: GlobeIcon,
};

/** The day and the time Publish later starts at: tomorrow at 9:00, as the person's clock reads it. */
function tomorrowAtNine(): { day: string; time: string } {
	const at = new Date();
	at.setDate(at.getDate() + 1);
	const pad = (value: number) => String(value).padStart(2, "0");
	return { day: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`, time: "09:00" };
}

/** A filled button of the sheet: the primary orange, quiet, or the danger red. */
function sheetButton(variant: "primary" | "quiet" | "danger"): string {
	const look = {
		primary: "bg-primary text-primary-foreground hover:bg-primary/90",
		quiet: "bg-chrome-hover text-chrome-strong hover:bg-[#34343b]",
		danger: "border border-[#7f1d1d] bg-[#3b1212] text-[#fca5a5] hover:bg-[#4c1717]",
	}[variant];
	return `inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-[9px] px-3.5 text-[13px] font-semibold disabled:opacity-60 ${look} ${CHROME_EASE} ${FOCUS_RING}`;
}

export function PublishSheet({
	id,
	words,
	language,
	data,
	failed,
	busy,
	actions,
}: {
	id: string;
	words: Words;
	language: string;
	/** What Publish covers; null while it is read. */
	data: PublishData | null;
	/** Why it couldn't be read, if it couldn't. */
	failed: string | null;
	/** A publish, a schedule or a Review is under way: the sheet's actions wait. */
	busy: boolean;
	actions: SheetActions;
}) {
	const shown = words.publishing;
	const titleId = useId();
	const sheet = useRef<HTMLDivElement>(null);
	const [later, setLater] = useState(false);
	const [when, setWhen] = useState(tomorrowAtNine);
	const [laterProblem, setLaterProblem] = useState<string | null>(null);
	const [confirming, setConfirming] = useState(false);
	const [note, setNote] = useState("");
	const keep = useRef<HTMLButtonElement>(null);

	const latest = useRef(actions);
	latest.current = actions;

	// Opening puts focus in the sheet; a press outside it closes it, focus staying where it went.
	useEffect(() => {
		sheet.current?.focus({ preventScroll: true });
		const outside = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (!target || sheet.current?.contains(target)) return;
			if ((target as Element).closest?.("[data-wc-publish]")) return;
			latest.current.close(false);
		};
		document.addEventListener("pointerdown", outside, true);
		return () => document.removeEventListener("pointerdown", outside, true);
	}, []);

	useEffect(() => {
		if (confirming) keep.current?.focus();
	}, [confirming]);

	const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		if (confirming) {
			setConfirming(false);
			return;
		}
		actions.close(true);
	};

	const member = data ? !data.canCode : true;
	const author = data ? !data.canPublish : false;
	const page = data?.page ?? null;
	const title = author ? shown.review.title : page ? fill(shown.title, { title: page.title }) : shown.titleNoPage;
	const changes = data?.changes ?? [];
	const drafts = data?.drafts ?? [];
	const count = countOf(data);
	const withdrawable = data?.reviews.some((review) => review.status === "inReview" && review.canWithdraw) ?? false;
	const waiting = data?.reviews.find((review) => review.status === "inReview") ?? null;
	const sentBack = data?.reviews.find((review) => review.status === "sentBack" && review.comment) ?? null;
	const translating = !author && changes.length > 0 ? (data?.translations ?? []) : [];

	const scheduleNow = () => {
		const at = new Date(`${when.day}T${when.time}`);
		if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) {
			setLaterProblem(shown.laterPast);
			return;
		}
		setLaterProblem(null);
		actions.schedule(at);
	};

	let body: ReactNode;
	if (!data) {
		body = (
			<p className="text-chrome-muted m-0 text-[13px]" role={failed ? "alert" : undefined}>
				{failed ? fill(shown.readFailed, { reason: failed }) : shown.loading}
			</p>
		);
	} else if (changes.length === 0 && drafts.length === 0) {
		body = <p className="text-chrome-muted m-0 text-[13px]">{shown.empty}</p>;
	} else {
		body = (
			<ul aria-label={shown.rows} className="m-0 flex list-none flex-col gap-3.5 p-0" data-wc-publish-rows="">
				{changes.map((change) => (
					<ChangeItem
						key={`${change.item}|${change.key}`}
						change={change}
						words={words}
						language={language}
						staffOnly={!!change.structure && member}
						disabled={busy}
						onRevert={() => actions.revert(change)}
					/>
				))}
				{drafts.map((draft) => (
					<DraftItem key={JSON.stringify(draft.item)} draft={draft} words={words} language={language} member={member} />
				))}
			</ul>
		);
	}

	return (
		<div
			ref={sheet}
			id={id}
			role="dialog"
			aria-labelledby={titleId}
			tabIndex={-1}
			onKeyDown={onKey}
			className="border-chrome-hover text-chrome-text absolute end-0 bottom-[calc(100%+18px)] z-50 flex max-h-[calc(100dvh-96px)] w-[440px] max-w-[calc(100vw-24px)] flex-col gap-3.5 overflow-y-auto rounded-[14px] border bg-[#18181b] p-4 shadow-[0_20px_48px_rgba(0,0,0,0.4)] outline-none"
			data-wc-publish-sheet={author ? "review" : "publish"}
		>
			<div className="flex items-start gap-2.5">
				{author ? <SendIcon aria-hidden="true" className="text-chrome-text mt-0.5 size-[18px] shrink-0" /> : null}
				<div className="flex min-w-0 grow flex-col">
					<h2 id={titleId} className="text-chrome-strong m-0 truncate text-[15px] font-semibold">
						{title}
					</h2>
					{author ? null : <p className="text-chrome-muted m-0 truncate text-[12px]">{shown.intro}</p>}
				</div>
				<button
					type="button"
					aria-label={shown.close}
					onClick={() => actions.close(true)}
					className={`text-chrome-muted hover:bg-chrome-hover hover:text-chrome-strong inline-grid size-7 shrink-0 place-items-center rounded-[7px] ${CHROME_EASE} ${FOCUS_RING}`}
					data-wc-publish-close=""
				>
					<XIcon aria-hidden="true" className="size-4" />
				</button>
			</div>

			{body}

			{sentBack?.comment ? (
				<p className="bg-chrome-raised text-chrome-muted m-0 rounded-lg p-2.5 text-[12px]">
					{fill(shown.review.sentBack, { name: sentBack.by?.name ?? "", comment: sentBack.comment })}
				</p>
			) : null}

			{translating.length > 0 ? (
				<div className="bg-chrome-raised flex items-start gap-2 rounded-lg p-2.5" data-wc-publish-translations="">
					<LanguagesIcon aria-hidden="true" className="text-chrome-muted mt-px size-3.5 shrink-0" />
					<p className="text-chrome-muted m-0 grow text-[12px]">
						{translating
							.map((language) => fill(shown.translations[language.mode], { language: language.name }))
							.join(" ")}
					</p>
				</div>
			) : null}

			{data && !author && count > 0 ? (
				<LaterRow
					words={words}
					on={later}
					onToggle={(on) => {
						setLater(on);
						setLaterProblem(null);
					}}
					when={when}
					onWhen={setWhen}
					problem={laterProblem}
				/>
			) : null}

			{data && author ? (
				<ReviewPart
					words={words}
					language={language}
					note={note}
					onNote={setNote}
					waiting={waiting}
					canSend={changes.length > 0}
					withdrawable={withdrawable}
					busy={busy}
					onSend={() => void actions.submit(note.trim() || null)}
					onWithdraw={() => void actions.withdraw()}
				/>
			) : null}

			{data && !author && data.otherDrafts > 0 ? (
				<>
					<div aria-hidden="true" className="h-px bg-[#3f3f46]" />
					<p className="text-chrome-muted m-0 text-center text-[12px]" data-wc-publish-others="">
						{`${fill(
							shown.others[new Intl.PluralRules(language).select(data.otherDrafts) === "one" ? "one" : "other"],
							{
								count: String(data.otherDrafts),
							},
						)} · `}
						<a
							href={data.publishAll}
							target="_blank"
							rel="noopener noreferrer"
							aria-label={shown.publishAllName}
							className={`text-chrome-accent rounded-sm font-semibold hover:underline ${FOCUS_RING}`}
						>
							{shown.publishAll}
						</a>
					</p>
				</>
			) : null}

			{data && (changes.length > 0 || (!author && count > 0)) ? (
				confirming ? (
					<div className="flex flex-col gap-2.5" data-wc-publish-discard-confirm="">
						<p className="text-chrome-strong m-0 text-[13px]">
							{shown.discardConfirm}
							{drafts.length > 0 ? ` ${shown.discardStructure}` : ""}
						</p>
						<div className="flex justify-end gap-2">
							<button ref={keep} type="button" onClick={() => setConfirming(false)} className={sheetButton("quiet")}>
								{shown.discardNo}
							</button>
							<button
								type="button"
								disabled={busy}
								onClick={() => {
									setConfirming(false);
									void actions.discard();
								}}
								className={sheetButton("danger")}
								data-wc-publish-discard-yes=""
							>
								{shown.discardYes}
							</button>
						</div>
					</div>
				) : (
					<div className="flex items-center gap-2.5">
						{changes.length > 0 && page ? (
							<button
								type="button"
								disabled={busy}
								onClick={() => setConfirming(true)}
								className={`me-auto rounded-sm text-[13px] font-semibold text-[#fca5a5] hover:underline disabled:opacity-60 ${FOCUS_RING}`}
								data-wc-publish-discard=""
							>
								{shown.discard}
							</button>
						) : (
							<span className="me-auto" />
						)}
						{author ? null : (
							<button
								type="button"
								disabled={busy || count === 0}
								onClick={later ? scheduleNow : actions.publish}
								className={`${sheetButton("primary")} w-[190px]`}
								data-wc-publish-now={later ? "schedule" : "publish"}
							>
								<UploadIcon aria-hidden="true" className="size-4" />
								{later ? shown.schedule : shown.publish}
							</button>
						)}
					</div>
				)
			) : null}
		</div>
	);
}

/** One of the page's changes: its icon, "Intro: words changed", "you · 4 min ago", Revert. */
function ChangeItem({
	change,
	words,
	language,
	staffOnly,
	disabled,
	onRevert,
}: {
	change: ChangeRow;
	words: Words;
	language: string;
	staffOnly: boolean;
	disabled: boolean;
	onRevert(): Promise<void>;
}) {
	const shown = words.publishing;
	const Glyph = ROW_ICONS[change.type] ?? TypeIcon;
	const text = changeText(change, words);
	const [reverting, setReverting] = useState(false);
	return (
		<li className="flex items-center gap-3" data-wc-publish-change={`${change.item}|${change.key}`}>
			<span className="bg-chrome-raised inline-grid size-[30px] shrink-0 place-items-center rounded-lg">
				<Glyph aria-hidden="true" className="text-chrome-text size-[15px]" />
			</span>
			<span className="flex min-w-0 grow flex-col gap-px">
				<span className="text-chrome-strong truncate text-[13px] font-semibold">{text}</span>
				<span className="text-chrome-muted truncate text-[12px]">
					{whoText(change.by, change.at, words, language)}
					{staffOnly ? ` · ${shown.staffPublish}` : ""}
				</span>
			</span>
			<button
				type="button"
				disabled={disabled || reverting}
				aria-label={fill(shown.revertName, { name: text })}
				onClick={() => {
					setReverting(true);
					void onRevert().finally(() => setReverting(false));
				}}
				className={`text-chrome-accent shrink-0 rounded-sm text-[12px] font-medium hover:underline disabled:opacity-60 ${FOCUS_RING}`}
				data-wc-publish-revert=""
			>
				{shown.revert}
			</button>
		</li>
	);
}

/** A whole item published with the page: its icon, its name, who changed it and when. */
function DraftItem({
	draft,
	words,
	language,
	member,
}: {
	draft: DraftRow;
	words: Words;
	language: string;
	member: boolean;
}) {
	const Glyph = ROW_ICONS[draft.item.kind] ?? FileCodeIcon;
	const name = draftName(draft, words, member);
	const who = whoText(draft.by, draft.at, words, language);
	return (
		<li className="flex items-center gap-3" data-wc-publish-draft={draft.item.kind}>
			<span className="bg-chrome-raised inline-grid size-[30px] shrink-0 place-items-center rounded-lg">
				<Glyph aria-hidden="true" className="text-chrome-text size-[15px]" />
			</span>
			<span className="flex min-w-0 grow flex-col gap-px">
				<span className="text-chrome-strong truncate text-[13px] font-semibold">
					{fill(words.publishing.change, {
						name,
						what: draft.status === "new" ? words.publishing.what.new : words.publishing.what.changed,
					})}
				</span>
				<span className="text-chrome-muted truncate text-[12px]">{who}</span>
			</span>
		</li>
	);
}

/** Publish later: a switch, and the day and the time once it is on. */
function LaterRow({
	words,
	on,
	onToggle,
	when,
	onWhen,
	problem,
}: {
	words: Words;
	on: boolean;
	onToggle(on: boolean): void;
	when: { day: string; time: string };
	onWhen(when: { day: string; time: string }): void;
	problem: string | null;
}) {
	const shown = words.publishing;
	const id = useId();
	const field =
		"border-[#3f3f46] bg-chrome-raised text-chrome-strong h-9 rounded-lg border px-2.5 text-[13px] [color-scheme:dark] focus-visible:border-chrome-focus outline-none focus-visible:ring-1 focus-visible:ring-chrome-focus";
	return (
		<div className="flex flex-col gap-2.5" data-wc-publish-later={on ? "on" : "off"}>
			<div className="flex items-center gap-3">
				<span className="flex min-w-0 grow flex-col gap-0.5">
					<span id={`${id}-label`} className="text-chrome-strong text-[13px] font-medium">
						{shown.later}
					</span>
					<span id={`${id}-hint`} className="text-chrome-muted text-[12px]">
						{shown.laterHint}
					</span>
				</span>
				<button
					type="button"
					role="switch"
					aria-checked={on}
					aria-labelledby={`${id}-label`}
					aria-describedby={`${id}-hint`}
					onClick={() => onToggle(!on)}
					className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full px-[3px] ${
						on ? "bg-chrome-ok justify-end" : "justify-start bg-[#3f3f46]"
					} ${CHROME_EASE} ${FOCUS_RING}`}
					data-wc-publish-later-switch=""
				>
					<span aria-hidden="true" className={`size-[18px] rounded-full ${on ? "bg-[#052e16]" : "bg-[#e4e4e7]"}`} />
				</button>
			</div>
			{on ? (
				<div className="flex gap-2.5">
					<label className="flex grow flex-col gap-1">
						<span className="text-chrome-muted text-[12px]">{shown.day}</span>
						<input
							type="date"
							value={when.day}
							onChange={(event) => onWhen({ ...when, day: event.target.value })}
							aria-invalid={problem ? true : undefined}
							aria-describedby={problem ? `${id}-problem` : undefined}
							className={field}
							data-wc-publish-day=""
						/>
					</label>
					<label className="flex w-32 flex-col gap-1">
						<span className="text-chrome-muted text-[12px]">{shown.time}</span>
						<input
							type="time"
							value={when.time}
							onChange={(event) => onWhen({ ...when, time: event.target.value })}
							aria-invalid={problem ? true : undefined}
							aria-describedby={problem ? `${id}-problem` : undefined}
							className={field}
							data-wc-publish-time=""
						/>
					</label>
				</div>
			) : null}
			{problem ? (
				<p id={`${id}-problem`} role="alert" className="text-chrome-danger m-0 text-[12px]">
					{problem}
				</p>
			) : null}
		</div>
	);
}

/** An Author's part: the note and "Send for review", or the Review waiting with Withdraw. */
function ReviewPart({
	words,
	language,
	note,
	onNote,
	waiting,
	canSend,
	withdrawable,
	busy,
	onSend,
	onWithdraw,
}: {
	words: Words;
	language: string;
	note: string;
	onNote(note: string): void;
	waiting: PublishData["reviews"][number] | null;
	canSend: boolean;
	withdrawable: boolean;
	busy: boolean;
	onSend(): void;
	onWithdraw(): void;
}) {
	const shown = words.publishing.review;
	const id = useId();
	const at = waiting
		? new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(waiting.at))
		: "";
	return (
		<div className="flex flex-col gap-3" data-wc-publish-review="">
			{waiting ? <p className="text-chrome-muted m-0 text-[12px]">{fill(shown.waiting, { when: at })}</p> : null}
			{canSend ? (
				<>
					<label htmlFor={`${id}-note`} className="sr-only">
						{shown.note}
					</label>
					<textarea
						id={`${id}-note`}
						value={note}
						onChange={(event) => onNote(event.target.value)}
						placeholder={shown.note}
						rows={3}
						maxLength={2000}
						className="bg-chrome-raised text-chrome-strong placeholder:text-chrome-faint focus-visible:border-chrome-focus focus-visible:ring-chrome-focus min-h-20 resize-y rounded-lg border border-[#3f3f46] px-3 py-2.5 text-[14px] outline-none focus-visible:ring-1"
						data-wc-publish-note=""
					/>
					<button
						type="button"
						disabled={busy}
						onClick={onSend}
						className={`${sheetButton("primary")} h-10 w-full`}
						data-wc-publish-send=""
					>
						<SendIcon aria-hidden="true" className="size-4" />
						{shown.send}
					</button>
				</>
			) : null}
			{withdrawable ? (
				<button
					type="button"
					disabled={busy}
					onClick={onWithdraw}
					className={`${sheetButton("quiet")} w-full`}
					data-wc-publish-withdraw=""
				>
					{shown.withdraw}
				</button>
			) : null}
		</div>
	);
}
