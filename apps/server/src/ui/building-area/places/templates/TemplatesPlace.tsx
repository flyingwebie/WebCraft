import { ArrowRightIcon, LayoutTemplateIcon, PlusIcon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";

import { fill, type Words } from "../../api.ts";
import { CHROME_EASE, FOCUS_RING, Tip } from "../../controls.tsx";
import { Badge } from "../content/ui.tsx";
import { rememberPlace, rememberScroll, scrollOf } from "../memory.ts";
import { Place } from "../Place.tsx";
import type { PlaceProps } from "../registry.ts";
import {
	codeOf,
	documentOf,
	makeTemplate,
	revertTemplate,
	type TemplateCard,
	type TemplateColumn,
	type TemplateKind,
	useTemplatesData,
} from "./data.ts";

/** How long "Revert to published" waits for its second click (SPEC 10: a small thing, a second click). */
const ARMED_MS = 4000;

/** "24 pages", in the person's language. */
function counted(forms: { one: string; other: string }, count: number, language: string): string {
	return fill(forms[new Intl.PluralRules(language).select(count) === "one" ? "one" : "other"], {
		count: String(count),
	});
}

/** A Template's name: "Site template", "Entry template" (its column names the Post Type). */
function kindName(words: Words, kind: TemplateKind): string {
	const shown = words.documents;
	return {
		site: shown.siteTemplate,
		search: shown.searchTemplate,
		entry: shown.entryTemplate,
		archive: shown.archiveTemplate,
	}[kind];
}

/** A Template's full name, for announcements and screen readers: "Entry template · Blog posts". */
function fullName(words: Words, card: Pick<TemplateCard, "kind" | "postType">): string {
	const kind = kindName(words, card.kind);
	return card.postType ? fill(words.templates.named, { kind, postType: card.postType.name }) : kind;
}

/**
 * The Templates place (SPEC 8, `places-content/04`): 200 px columns, the Site's (Site template,
 * Search results template), one per Post Type (Entry template, Archive template) and a note for
 * Pages, which are arranged with Components. Each Template made is a 167 × 209 card with a picture of
 * its kind, Draft or Published and on how many pages it shows; under the pointer or the keyboard it
 * offers Edit (opens it as the document) and, with unpublished changes, Revert to published. A
 * column's "+" lists only the kinds not made yet: choosing one makes its first Draft and opens it.
 */
export function TemplatesPlace(props: PlaceProps) {
	const { config, words, place, view, documents, leave, open, announce, onSaving } = props;
	const shown = words.templates;
	const { data, failed, reload, api } = useTemplatesData(config.token, config.site.id);
	const scroller = useRef<HTMLDivElement>(null);
	const restored = useRef(false);

	useEffect(() => rememberPlace(place, view), [place, view]);
	useEffect(() => {
		if (!data || restored.current || !scroller.current) return;
		restored.current = true;
		scroller.current.scrollTop = scrollOf(place, view);
	}, [data, place, view]);

	const make = useCallback(
		async (card: TemplateCard) => {
			const name = fullName(words, card);
			const document = documentOf(card);
			announce(fill(shown.making, { name }));
			onSaving("saving");
			try {
				await makeTemplate(api, config.site.id, card);
				onSaving("saved");
				announce(fill(shown.made, { name }));
				if (document) open(document);
				else await reload();
			} catch (error) {
				onSaving("failed");
				announce(fill(shown.makeFailed, { name, reason: codeOf(error) }), true);
			}
		},
		[api, config.site.id, words, shown, announce, onSaving, open, reload],
	);

	const revert = useCallback(
		async (card: TemplateCard) => {
			const name = fullName(words, card);
			onSaving("saving");
			try {
				await revertTemplate(api, config.site.id, card);
				onSaving("saved");
				await reload();
				announce(fill(shown.reverted, { name }));
			} catch (error) {
				onSaving("failed");
				announce(fill(shown.revertFailed, { name, reason: codeOf(error) }), true);
			}
		},
		[api, config.site.id, words, shown, announce, onSaving, reload],
	);

	let body: ReactNode;
	if (failed) {
		body = (
			<p role="alert" className="text-chrome-danger m-0 px-4 py-2 text-[12px]">
				{fill(shown.loadFailed, { reason: failed })}
			</p>
		);
	} else if (!data) {
		body = (
			<p role="status" className="text-chrome-muted m-0 px-4 py-2 text-[12px]">
				{shown.loading}
			</p>
		);
	} else if ("forbidden" in data) {
		body = <p className="text-chrome-muted m-0 px-4 py-2 text-[12px]">{shown.staffOnly}</p>;
	} else {
		body = (
			<div className="flex w-max min-w-full flex-col px-4 pb-6" data-wc-template-columns="">
				<h2 className="sr-only">{shown.columns}</h2>
				<div className="flex items-start gap-2">
					{data.columns.map((column) => (
						<Column
							key={column.key}
							words={words}
							language={config.language}
							column={column}
							onMake={make}
							onEdit={(card) => {
								const document = documentOf(card);
								if (document) open(document);
							}}
							onRevert={revert}
						/>
					))}
					<section
						aria-labelledby={`${place}-pages`}
						className="flex w-[200px] shrink-0 flex-col"
						data-wc-template-column="pages"
					>
						<ColumnHead id={`${place}-pages`} name={shown.pages} />
						<div className="px-2 pt-2">
							<div className="bg-chrome-raised flex flex-col gap-2 rounded-lg p-4">
								<p className="text-chrome-muted m-0 text-[12px]">{shown.pagesNote}</p>
								<button
									type="button"
									onClick={() => documents.openPlace("content/pages")}
									className={`text-chrome-accent inline-flex w-fit items-center gap-1 rounded-sm text-[12px] font-semibold hover:underline ${FOCUS_RING}`}
									data-wc-open-pages=""
								>
									{shown.openPages}
									<ArrowRightIcon aria-hidden="true" className="size-3 rtl:rotate-180" />
								</button>
							</div>
						</div>
					</section>
				</div>
			</div>
		);
	}

	return (
		<Place words={words} title={words.places.templates} backTo={null} onBack={leave} place={place}>
			<div
				ref={scroller}
				className="min-h-0 grow overflow-auto pt-2"
				onScroll={(event) => rememberScroll(place, view, event.currentTarget.scrollTop)}
				data-wc-place-scroll=""
			>
				{body}
			</div>
		</Place>
	);
}

/** A column's head (200 × 44, radius 8): its name, and the "+" when some kinds are made and others aren't. */
function ColumnHead({ id, name, add }: { id: string; name: string; add?: ReactNode }) {
	return (
		<div className="bg-chrome-raised flex h-11 items-center gap-1.5 rounded-lg px-2" data-wc-column-head="">
			<h3 id={id} className="text-chrome-strong m-0 min-w-0 grow truncate text-[12px] font-semibold">
				{name}
			</h3>
			{add}
		</div>
	);
}

/** One column: its head, its Templates (20 apart), or the dashed box that makes the first one. */
function Column({
	words,
	language,
	column,
	onMake,
	onEdit,
	onRevert,
}: {
	words: Words;
	language: string;
	column: TemplateColumn;
	onMake(card: TemplateCard): void;
	onEdit(card: TemplateCard): void;
	onRevert(card: TemplateCard): void;
}) {
	const shown = words.templates;
	const id = useId();
	const name = column.postType?.name ?? shown.site;
	const menu = (size: 24 | 26) => (
		<MakeMenu words={words} column={name} cards={column.makeable} size={size} onMake={onMake} />
	);
	return (
		<section aria-labelledby={id} className="flex w-[200px] shrink-0 flex-col" data-wc-template-column={column.key}>
			<ColumnHead
				id={id}
				name={name}
				add={column.made.length > 0 && column.makeable.length > 0 ? menu(24) : undefined}
			/>
			{column.made.length > 0 ? (
				<ul className="m-0 flex list-none flex-col gap-5 px-2 pt-2">
					{column.made.map((card) => (
						<li key={card.kind}>
							<Card words={words} language={language} card={card} onEdit={onEdit} onRevert={onRevert} />
						</li>
					))}
				</ul>
			) : (
				<div className="px-2 pt-2">
					<div
						className="border-chrome-hover flex h-[209px] w-[167px] flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed"
						data-wc-template-empty=""
					>
						<p className="text-chrome-muted m-0 text-center text-[12px]">{shown.emptyTitle}</p>
						<p className="text-chrome-muted m-0 text-center text-[12px]">{shown.emptyText}</p>
						{column.makeable.length > 0 ? menu(26) : null}
					</div>
				</div>
			)}
		</section>
	);
}

/** The picture of a Template's kind (`places-content/04`): a sketch of what it lays out, not its page. */
function Thumbnail({ kind }: { kind: TemplateKind }) {
	const bar = "bg-chrome-hover rounded-[3px]";
	switch (kind) {
		case "site":
			return (
				<div className="flex grow flex-col justify-between p-3">
					<div className={`${bar} h-4`} />
					<div className={`${bar} h-3`} />
				</div>
			);
		case "search":
			return (
				<div className="flex grow flex-col gap-2.5 p-3">
					<div className="bg-chrome-hover h-[22px] rounded-full" />
					<div className={`${bar} h-[9px]`} />
					<div className={`${bar} h-[9px]`} />
					<div className={`${bar} h-[9px]`} />
				</div>
			);
		case "entry":
			return (
				<div className="flex grow flex-col gap-1.5 p-3">
					<div className={`${bar} h-2.5 w-[84px]`} />
					<div className={`${bar} h-1.5 w-12`} />
					<div className="bg-chrome-hover h-16 rounded" />
					<div className={`${bar} h-1.5`} />
					<div className={`${bar} h-1.5`} />
					<div className={`${bar} h-1.5 w-14`} />
				</div>
			);
		case "archive":
			return (
				<div className="flex grow flex-col gap-2 p-3">
					<div className={`${bar} h-2.5 w-[84px]`} />
					{[0, 1, 2].map((row) => (
						<div key={row} className="flex gap-2">
							<div className="bg-chrome-hover h-9 w-12 shrink-0 rounded" />
							<div className="flex grow flex-col gap-1.5 pt-1">
								<div className={`${bar} h-1.5`} />
								<div className={`${bar} h-1.5 w-2/3`} />
							</div>
						</div>
					))}
				</div>
			);
	}
}

/** A made Template: its picture with Edit and Revert to published over it, its name, its status and where it shows. */
function Card({
	words,
	language,
	card,
	onEdit,
	onRevert,
}: {
	words: Words;
	language: string;
	card: TemplateCard;
	onEdit(card: TemplateCard): void;
	onRevert(card: TemplateCard): void;
}) {
	const shown = words.templates;
	const status = words.content.status;
	const name = kindName(words, card.kind);
	const full = fullName(words, card);
	const [armed, setArmed] = useState(false);
	useEffect(() => {
		if (!armed) return;
		const timer = setTimeout(() => setArmed(false), ARMED_MS);
		return () => clearTimeout(timer);
	}, [armed]);
	const overlayButton = `bg-chrome-menu border-chrome-hover inline-flex h-[30px] items-center justify-center rounded-md border px-3.5 text-[12px] font-semibold hover:bg-chrome-hover ${CHROME_EASE} ${FOCUS_RING}`;
	return (
		<div
			className="flex w-[167px] flex-col gap-2"
			data-wc-template-card={`${card.kind}${card.postType ? `:${card.postType.id}` : ""}`}
		>
			<div className="group/card relative h-[209px] w-[167px]">
				<div
					aria-hidden="true"
					className={`bg-chrome-raised border-chrome-hover flex h-full w-full flex-col overflow-hidden rounded-md border group-focus-within/card:opacity-45 group-hover/card:opacity-45 ${CHROME_EASE}`}
				>
					<Thumbnail kind={card.kind} />
				</div>
				<div
					className={`absolute inset-0 flex flex-col items-center justify-center gap-2 opacity-0 group-focus-within/card:opacity-100 group-hover/card:opacity-100 ${CHROME_EASE}`}
				>
					<button
						type="button"
						onClick={() => onEdit(card)}
						className={`${overlayButton} text-chrome-strong`}
						data-wc-template-edit=""
					>
						{shown.edit}
						<span className="sr-only">{`: ${full}`}</span>
					</button>
					{card.template?.status === "changed" ? (
						<button
							type="button"
							onClick={() => {
								if (!armed) {
									setArmed(true);
									return;
								}
								setArmed(false);
								onRevert(card);
							}}
							aria-label={armed ? shown.revertAgain : fill(shown.revertNamed, { name: full })}
							className={`${overlayButton} ${armed ? "border-[#b91c1c] bg-[#450a0a] text-[#fecaca]" : "text-chrome-danger"}`}
							data-wc-template-revert={armed ? "armed" : ""}
						>
							{armed ? shown.revertAgain : shown.revert}
						</button>
					) : null}
				</div>
			</div>
			<h4 className="text-chrome-strong m-0 text-[12px] font-semibold">{name}</h4>
			<div className="flex flex-wrap items-center gap-1.5">
				{card.template?.status === "published" ? (
					<Badge kind="live">{status.published}</Badge>
				) : card.template?.status === "changed" ? (
					<Badge kind="info">{status.changed}</Badge>
				) : (
					<Badge kind="draft">{status.draft}</Badge>
				)}
				{card.shownOn !== null ? (
					<span className="text-chrome-muted text-[11px]" data-wc-template-shown-on="">
						{card.shownOn === "every" ? shown.everyPage : counted(shown.shownOn, card.shownOn, language)}
					</span>
				) : null}
			</div>
		</div>
	);
}

/** A column's "+": a menu of the kinds not made yet ("Not made yet"), each making that Template. */
function MakeMenu({
	words,
	column,
	cards,
	size,
	onMake,
}: {
	words: Words;
	column: string;
	cards: readonly TemplateCard[];
	size: 24 | 26;
	onMake(card: TemplateCard): void;
}) {
	const shown = words.templates;
	const [open, setOpen] = useState(false);
	const button = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const id = useId();
	const label = fill(shown.add, { column });

	useEffect(() => {
		if (!open) return;
		menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
		const outside = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (target && (menu.current?.contains(target) || button.current?.contains(target))) return;
			setOpen(false);
		};
		document.addEventListener("pointerdown", outside, true);
		return () => document.removeEventListener("pointerdown", outside, true);
	}, [open]);

	const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
		const all = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
		const at = all.indexOf(document.activeElement as HTMLElement);
		const move = (index: number) => all[(index + all.length) % all.length]?.focus();
		switch (event.key) {
			case "ArrowDown":
				move(at + 1);
				break;
			case "ArrowUp":
				move(at - 1);
				break;
			case "Home":
				move(0);
				break;
			case "End":
				move(all.length - 1);
				break;
			case "Escape":
				setOpen(false);
				button.current?.focus();
				break;
			case "Tab":
				setOpen(false);
				return;
			default:
				return;
		}
		event.preventDefault();
		event.stopPropagation();
	};

	return (
		<span className="group relative inline-flex">
			<button
				ref={button}
				type="button"
				aria-label={label}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				onClick={() => setOpen((was) => !was)}
				className={`text-chrome-muted hover:bg-chrome-hover hover:text-chrome-strong inline-grid shrink-0 place-items-center rounded-[5px] ${
					size === 26 ? "size-[26px]" : "size-6"
				} ${CHROME_EASE} ${FOCUS_RING}`}
				data-wc-template-add=""
			>
				<PlusIcon aria-hidden="true" className="size-3.5" />
			</button>
			{open ? null : <Tip label={label} side="bottom" />}
			{open ? (
				<div
					ref={menu}
					id={id}
					role="menu"
					aria-label={label}
					tabIndex={-1}
					onKeyDown={onKey}
					className="border-chrome-hover bg-chrome-menu absolute start-0 top-[calc(100%+4px)] z-50 flex w-44 flex-col gap-0.5 rounded-lg border p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.55)]"
					data-wc-template-make-menu=""
				>
					{/* biome-ignore lint/a11y/useSemanticElements: a menu groups its items with role="group", never a fieldset. */}
					<div role="group" aria-label={shown.notMade} className="flex flex-col gap-0.5">
						<div aria-hidden="true" className="text-chrome-muted px-1.5 pt-1 pb-0.5 text-[11px] font-semibold">
							{shown.notMade}
						</div>
						{cards.map((card) => (
							<button
								key={card.kind}
								type="button"
								role="menuitem"
								tabIndex={-1}
								onClick={() => {
									setOpen(false);
									onMake(card);
								}}
								className={`text-chrome-text hover:bg-chrome-hover focus:bg-chrome-hover flex h-7 items-center gap-2 rounded-[5px] px-1.5 text-start text-[12px] font-medium ${FOCUS_RING}`}
								data-wc-template-make={card.kind}
							>
								<LayoutTemplateIcon aria-hidden="true" className="text-chrome-muted size-3.5 shrink-0" />
								{kindName(words, card.kind)}
							</button>
						))}
					</div>
				</div>
			) : null}
		</span>
	);
}
