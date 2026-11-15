import {
	ArrowLeftIcon,
	CheckIcon,
	EyeIcon,
	LanguagesIcon,
	LifeBuoyIcon,
	LogOutIcon,
	PencilIcon,
	Redo2Icon,
	Rows3Icon,
	SendIcon,
	ShieldIcon,
	SlidersHorizontalIcon,
	UploadIcon,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { fill, type Words } from "../../api.ts";
import type { PageLanguage } from "../../bottom-bar/LanguageMenu.tsx";
import { pageScripts } from "../../canvas/scripts.ts";
import { CHROME_EASE, FOCUS_RING } from "../../controls.tsx";
import { type ClientDraftState, plural } from "../ClientBar.tsx";
import type { ClientMode } from "../marks.ts";
import { useHistoryState } from "./PhoneBar.tsx";
import { Sheet, SheetRow } from "./Sheet.tsx";

/** The phone bar's Publish cell (`publish/PublishCell.tsx`), which the sheet's Publish presses. */
function publishCell(): HTMLButtonElement | null {
	return document.querySelector<HTMLButtonElement>('[data-wc-client-bar="phone"] [data-wc-publish]');
}

/** The Draft's state in words, as the desktop bar says it (SPEC 13.8). */
function draftWords(draft: ClientDraftState, words: Words, language: string): string {
	const each = words.client.draftState;
	return draft.kind === "changes" ? plural(each.changes, draft.count, language) : each[draft.kind];
}

/**
 * The phone's "More" (SPEC 13.9, `client-flows/06`): a sheet from the bottom with what the desktop bar
 * and rail hold beyond the phone's one bar: Preview (Edit again in Preview), the page's language (a
 * list of its own in the same sheet), Sections where the Site lets Members arrange, Page details (Post
 * details on an Entry), Redo with the step it would take, Help and Exit; then the Draft's state in
 * words and Publish, which opens Publish's own sheet (an Author's "Send for review").
 */
export function MoreSheet({
	words,
	language,
	mode,
	onMode,
	languages,
	onLanguage,
	sections,
	onSections,
	detailsLabel,
	onDetails,
	draft,
	onRedo,
	onHelp,
	onExit,
	exiting,
	place,
	onClose,
}: {
	words: Words;
	/** The person's Admin language, for the plurals. */
	language: string;
	mode: ClientMode;
	onMode(mode: ClientMode): void;
	languages: readonly PageLanguage[];
	onLanguage(language: PageLanguage): void;
	/** Whether Sections is there: the Site lets Members arrange, and the page is a Page. */
	sections: boolean;
	onSections(): void;
	/** The details row's words: "Page details", or "Post details" on an Entry. */
	detailsLabel: string;
	onDetails(): void;
	draft: ClientDraftState;
	onRedo(): void;
	onHelp(): void;
	onExit(): void;
	exiting: boolean;
	/** Whether a place is open over the canvas: the page's own rows wait until it is left. */
	place: boolean;
	/** Asked to close; `returnFocus`: focus goes back to More. */
	onClose(returnFocus: boolean): void;
}) {
	const said = words.client;
	const phone = said.phone;
	const [view, setView] = useState<"menu" | "language">("menu");
	const history = useHistoryState();
	const safe = useSyncExternalStore(pageScripts.subscribe, () => pageScripts.get().safe);
	// Where focus goes as the sheet goes: More, unless what was chosen takes it elsewhere.
	const returnTo = useRef<() => HTMLElement | null>(() =>
		document.querySelector<HTMLElement>('[data-wc-phone-bar="more"]'),
	);
	const languageList = useRef<HTMLDivElement>(null);
	const languageRow = useRef<HTMLButtonElement>(null);
	const rows = useRef<HTMLDivElement>(null);
	const opened = useRef(false);

	// What Publish would do now, as its cell on the bar says (an Author's "Send for review"; off with nothing).
	const [cell] = useState(() => {
		const found = publishCell();
		return {
			review: found?.getAttribute("data-wc-publish") === "review",
			off: !found || found.getAttribute("aria-disabled") === "true",
		};
	});

	// Focus on the first row as it opens; on the chosen language in its list; back on Language from there.
	useEffect(() => {
		if (view === "language") {
			const list = languageList.current;
			(
				list?.querySelector<HTMLElement>('[aria-current="true"]') ?? list?.querySelector<HTMLElement>("button")
			)?.focus();
		} else if (opened.current) languageRow.current?.focus();
		else rows.current?.querySelector<HTMLElement>("button")?.focus();
		opened.current = true;
	}, [view]);

	/** Closes the sheet, then does what was chosen (which may open another sheet or a panel). */
	const then = (work: () => void, focus?: () => HTMLElement | null) => () => {
		if (focus) returnTo.current = focus;
		onClose(false);
		// After the sheet has gone and given focus back, so what opens next takes it.
		requestAnimationFrame(() => work());
	};

	const current = languages.find((each) => each.current) ?? languages[0];
	const redoLabel = history.redo ? fill(words.redoStep, { step: history.redo }) : words.redo;
	const changed = draft.kind === "changes";

	return (
		<Sheet
			label={view === "language" ? phone.languages : phone.more}
			closeLabel={phone.close}
			kind={view === "language" ? "language" : "more"}
			onClose={onClose}
			from={() => returnTo.current()}
			start={
				view === "language" ? (
					<button
						type="button"
						aria-label={phone.back}
						onClick={() => setView("menu")}
						className={`text-chrome-text hover:bg-chrome-hover grid size-11 place-items-center rounded-[10px] ${CHROME_EASE} ${FOCUS_RING}`}
						data-wc-phone-sheet-back=""
					>
						<ArrowLeftIcon aria-hidden="true" className="size-[18px] rtl:-scale-x-100" />
					</button>
				) : null
			}
		>
			{view === "language" ? (
				<div ref={languageList} className="flex flex-col pb-2" data-wc-phone-languages="">
					<h2 className="text-chrome-muted m-0 px-3.5 pb-1 text-[12px] font-semibold">{phone.languages}</h2>
					{languages.map((each) => (
						<button
							key={each.code}
							type="button"
							aria-current={each.current ? "true" : undefined}
							onClick={then(() => onLanguage(each))}
							className={`hover:bg-chrome-hover flex h-12 w-full items-center gap-2.5 px-3.5 text-start text-[14px] ${
								each.current ? "text-chrome-strong font-semibold" : "text-chrome-text font-medium"
							} ${CHROME_EASE} ${FOCUS_RING} focus-visible:ring-inset`}
							data-wc-phone-language={each.code}
						>
							<span className="grow">{each.name}</span>
							{each.current ? <CheckIcon aria-hidden="true" className="text-chrome-accent size-4" /> : null}
						</button>
					))}
				</div>
			) : (
				<>
					<div ref={rows} className="flex flex-col" data-wc-phone-rows="">
						{place ? null : (
							<SheetRow
								icon={mode === "edit" ? EyeIcon : PencilIcon}
								onClick={then(() => onMode(mode === "edit" ? "preview" : "edit"))}
								data={{ "data-wc-phone-row": "mode" }}
							>
								{mode === "edit" ? said.preview : said.edit}
							</SheetRow>
						)}
						{!place && languages.length > 1 ? (
							<SheetRow
								ref={languageRow}
								icon={LanguagesIcon}
								value={current?.name}
								onClick={() => setView("language")}
								data={{ "data-wc-phone-row": "language" }}
							>
								{phone.language}
							</SheetRow>
						) : null}
						{/* While the page runs none of the site's scripts: turning Safe mode off (BA-32). */}
						{safe ? (
							<SheetRow
								icon={ShieldIcon}
								onClick={then(() => void pageScripts.turn(false))}
								data={{ "data-wc-phone-row": "safe-mode" }}
							>
								{words.scripts.turnOffLabel}
							</SheetRow>
						) : null}
						{!place && sections ? (
							<SheetRow icon={Rows3Icon} onClick={then(onSections)} data={{ "data-wc-phone-row": "sections" }}>
								{said.sections}
							</SheetRow>
						) : null}
						{place ? null : (
							<SheetRow
								icon={SlidersHorizontalIcon}
								onClick={then(onDetails)}
								data={{ "data-wc-phone-row": "page-details" }}
							>
								{detailsLabel}
							</SheetRow>
						)}
						<SheetRow
							icon={Redo2Icon}
							chevron={false}
							disabled={!history.redo || history.busy}
							// The sheet goes first: what the step says is heard once the page can be reached again.
							onClick={then(onRedo)}
							data={{ "data-wc-phone-row": "redo" }}
						>
							{redoLabel}
						</SheetRow>
						<div aria-hidden="true" className="bg-chrome-line mx-3.5 my-1 h-px" />
						<SheetRow icon={LifeBuoyIcon} onClick={then(onHelp)} data={{ "data-wc-phone-row": "help" }}>
							{said.help}
						</SheetRow>
						<SheetRow
							icon={LogOutIcon}
							chevron={false}
							disabled={exiting}
							onClick={then(onExit)}
							data={{ "data-wc-phone-row": "exit" }}
						>
							{said.exit}
						</SheetRow>
					</div>
					<p
						className={`m-0 px-3.5 pt-3 pb-2.5 text-[13px] font-medium ${changed ? "text-[#f59e0b]" : draft.kind === "failed" ? "text-chrome-danger" : "text-chrome-muted"}`}
						data-wc-phone-draft-state={draft.kind}
					>
						<span className="sr-only">{`${words.draftState.label}: `}</span>
						{draftWords(draft, words, language)}
					</p>
					<div className="px-3.5">
						<button
							type="button"
							aria-disabled={cell.off || undefined}
							onClick={cell.off ? undefined : then(() => publishCell()?.click(), publishCell)}
							className={`bg-primary text-primary-foreground hover:bg-primary/90 aria-disabled:hover:bg-primary flex h-12 w-full items-center justify-center gap-2 rounded-[10px] text-[15px] font-semibold aria-disabled:cursor-default aria-disabled:opacity-50 ${CHROME_EASE} ${FOCUS_RING}`}
							data-wc-phone-publish=""
						>
							{cell.review ? (
								<SendIcon aria-hidden="true" className="size-4" />
							) : (
								<UploadIcon aria-hidden="true" className="size-4" />
							)}
							{cell.review ? words.publishing.sendForReview : words.publishing.cell}
						</button>
					</div>
				</>
			)}
		</Sheet>
	);
}
