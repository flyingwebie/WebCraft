import {
	CheckIcon,
	ChevronDownIcon,
	CircleDashedIcon,
	ClockIcon,
	EyeOffIcon,
	ListCollapseIcon,
	SearchIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { fill, type Words } from "../api.ts";
import { AddressField, DetailsStatus, SearchAndSharing, TitleField } from "../client/PageDetails.tsx";
import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";
import { PanelButton } from "../docks/PanelFrame.tsx";
import { Badge } from "../places/content/ui.tsx";
import {
	type EntryDetails,
	type EntryDetailsOptions,
	listedFields,
	type TranslationState,
	useEntryDetails,
} from "./entry-details.ts";
import { FieldControl } from "./field-controls.tsx";

/**
 * The Entry panel (Staff; SPEC 5, `builder/08`): on a Page or an Entry, its own values filled in
 * without leaving the page: Title, Address, the status badges and each language's translation, then
 * the Entry's Fields that don't show on the page, each with its typed control (text, a file with its
 * alt text, a Relationship, a choice, …), then Search and sharing. Collapsed under Layers at first.
 * Its header's actions find a Field by name and collapse or expand the sections.
 */

/** What the panel's header actions change: the search, and which sections are open. */
export type EntryPanelView = {
	finding: boolean;
	query: string;
	setQuery(query: string): void;
	toggleFinding(): void;
	open: { fields: boolean; seo: boolean };
	toggle(section: "fields" | "seo"): void;
	/** Collapses both sections, or opens both when both are collapsed. */
	toggleAll(): void;
};

/** The panel's view, kept by the shell while the page changes beneath it. */
export function useEntryPanelView(): EntryPanelView {
	const [finding, setFinding] = useState(false);
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState({ fields: true, seo: false });
	return useMemo(
		() => ({
			finding,
			query,
			setQuery,
			toggleFinding: () => {
				setFinding((was) => !was);
				setQuery("");
			},
			open,
			toggle: (section) => setOpen((was) => ({ ...was, [section]: !was[section] })),
			toggleAll: () =>
				setOpen((was) => (was.fields || was.seo ? { fields: false, seo: false } : { fields: true, seo: true })),
		}),
		[finding, query, open],
	);
}

/** The panel header's actions (`builder/08`): find a Field; collapse or expand the sections. */
export function EntryPanelActions({ words, view }: { words: Words; view: EntryPanelView }) {
	const said = words.details;
	const collapsed = !view.open.fields && !view.open.seo;
	return (
		<>
			<PanelButton
				icon={SearchIcon}
				label={view.finding ? said.stopFinding : said.find}
				onClick={view.toggleFinding}
				data={{ "data-wc-entry-action": "find" }}
			/>
			<PanelButton
				icon={ListCollapseIcon}
				label={collapsed ? said.expandSections : said.collapseSections}
				onClick={view.toggleAll}
				data={{ "data-wc-entry-action": "collapse" }}
			/>
		</>
	);
}

/** Whether a label matches what is being looked for. */
function matches(label: string, query: string): boolean {
	const wanted = query.trim().toLocaleLowerCase();
	return wanted === "" || label.toLocaleLowerCase().includes(wanted);
}

/** The Entry panel's body as the shell mounts it: the page's Entry read while the panel is open. */
export function EntryPanel({
	view,
	admin,
	onLanguage,
	...options
}: EntryDetailsOptions & {
	view: EntryPanelView;
	admin: string;
	onLanguage(path: string): void;
}) {
	const details = useEntryDetails(options);
	return <EntryFields words={options.words} details={details} view={view} admin={admin} onLanguage={onLanguage} />;
}

/** The Entry panel's body. */
export function EntryFields({
	words,
	details,
	view,
	admin,
	onLanguage,
}: {
	words: Words;
	details: EntryDetails;
	view: EntryPanelView;
	/** The Site in the admin (`…/sites/<id>`), for what is changed there. */
	admin: string;
	/** Shows the page in another language (its page's path). */
	onLanguage(path: string): void;
}) {
	const said = words.details;
	const findId = useId();
	const findBox = useRef<HTMLInputElement>(null);
	// Find puts focus in its box as it opens.
	useEffect(() => {
		if (view.finding) findBox.current?.focus();
	}, [view.finding]);

	if (details.status !== "ready" || !details.details || !details.entry || !details.postType)
		return (
			<div className="px-0.5 py-1">
				<DetailsStatus words={words} details={details} look="dock" />
			</div>
		);

	const entryAdmin = `${admin}/entries/${details.postType.id}/${details.entry.id}`;
	const query = view.finding ? view.query : "";
	const finding = query.trim() !== "";
	const fields = listedFields(details).filter(({ label }) => matches(label, query));
	const basics = {
		title: matches(said.title, query),
		address: matches(said.address, query),
		status: matches(words.content.status.label, query),
		languages: details.several && matches(said.languages, query),
	};
	const seoShown = matches(said.searchAndSharing, query) || finding;
	const nothing =
		finding && fields.length === 0 && !Object.values(basics).some(Boolean) && !matches(said.searchAndSharing, query);

	return (
		<div className="-me-1 flex min-h-0 grow flex-col gap-2 overflow-y-auto pe-1" data-wc-entry-panel="">
			{view.finding ? (
				<span className="bg-chrome-raised focus-within:ring-chrome-focus flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 focus-within:ring-1">
					<SearchIcon aria-hidden="true" className="text-chrome-muted size-3.5 shrink-0" />
					<input
						ref={findBox}
						id={findId}
						type="search"
						value={view.query}
						placeholder={said.find}
						aria-label={said.find}
						onChange={(event) => view.setQuery(event.target.value)}
						onKeyDown={(event) => {
							if (event.key !== "Escape") return;
							event.preventDefault();
							event.stopPropagation();
							view.toggleFinding();
						}}
						className="text-chrome-strong placeholder:text-chrome-faint min-w-0 grow bg-transparent text-[12px] outline-none"
						data-wc-entry-find=""
					/>
				</span>
			) : null}
			{nothing ? (
				<p className="text-chrome-muted m-0 px-0.5 text-[12px]" role="status">
					{fill(said.noMatch, { query: query.trim() })}
				</p>
			) : null}
			{basics.title ? <TitleField look="dock" words={words} details={details} /> : null}
			{basics.address ? <AddressField look="dock" words={words} details={details} /> : null}
			{basics.status ? <StatusCard words={words} details={details} /> : null}
			{basics.languages ? <LanguagesCard words={words} details={details} onLanguage={onLanguage} /> : null}
			<hr className="border-chrome-line m-0 border-t" />
			<Section
				label={said.fields}
				open={view.open.fields || finding}
				onToggle={() => view.toggle("fields")}
				data={{ "data-wc-entry-section": "fields" }}
			>
				{fields.length === 0 && !finding ? (
					<p className="text-chrome-muted m-0 px-0.5 text-[12px]" data-wc-entry-none="">
						{said.allOnPage}
					</p>
				) : (
					fields.map(({ field, path, label }) => (
						<FieldControl
							key={path}
							look="dock"
							words={words}
							details={details}
							field={field}
							path={path}
							label={label}
							admin={entryAdmin}
						/>
					))
				)}
			</Section>
			{seoShown ? (
				<Section
					label={said.searchAndSharing}
					open={view.open.seo || (finding && matches(said.searchAndSharing, query))}
					onToggle={() => view.toggle("seo")}
					data={{ "data-wc-entry-section": "seo" }}
				>
					<SearchAndSharing look="dock" words={words} details={details} canonical />
				</Section>
			) : null}
		</div>
	);
}

/** A section of the panel: its small heading opens or closes it. */
function Section({
	label,
	open,
	onToggle,
	children,
	data,
}: {
	label: string;
	open: boolean;
	onToggle(): void;
	children: ReactNode;
	data?: Record<`data-${string}`, string>;
}) {
	const id = useId();
	return (
		<section className="flex flex-col gap-2" aria-labelledby={`${id}-heading`} {...data}>
			<h3 id={`${id}-heading`} className="m-0">
				<button
					type="button"
					aria-expanded={open}
					aria-controls={id}
					onClick={onToggle}
					className={`text-chrome-muted hover:text-chrome-text flex h-5 w-full items-center gap-1 rounded-sm text-start text-[11px] font-semibold tracking-[0.05em] uppercase ${CHROME_EASE} ${FOCUS_RING}`}
				>
					<span className="grow">{label}</span>
					<ChevronDownIcon
						aria-hidden="true"
						className={`size-3 transition-transform duration-150 motion-reduce:transition-none ${open ? "" : "-rotate-90 rtl:rotate-90"}`}
					/>
				</button>
			</h3>
			<div id={id} hidden={!open} className="flex flex-col gap-2">
				{open ? children : null}
			</div>
		</section>
	);
}

/** The Entry's status: Published, Unpublished changes, Draft; In review beside them while it waits. */
function StatusCard({ words, details }: { words: Words; details: EntryDetails }) {
	const status = words.content.status;
	const entry = details.entry;
	if (!entry) return null;
	const inReview = entry.review?.status === "inReview";
	return (
		<div className="bg-chrome-raised flex min-w-0 flex-col gap-1 rounded-md px-2 py-1.5" data-wc-details-field="status">
			<span className="text-chrome-muted text-[11px]">{status.label}</span>
			<span className="flex flex-wrap items-center gap-1.5" data-wc-entry-status={entry.status}>
				{entry.status === "draft" ? (
					<Badge kind="draft">{status.draft}</Badge>
				) : (
					<Badge kind="live">{status.published}</Badge>
				)}
				{entry.status === "changed" ? <Badge kind="draft">{status.changed}</Badge> : null}
				{inReview ? <Badge kind="info">{status.review}</Badge> : null}
			</span>
		</div>
	);
}

const LANGUAGE_LOOK: Record<TranslationState, { chip: string; icon: typeof CheckIcon }> = {
	done: { chip: "bg-[#0f2e1c] text-chrome-ok", icon: CheckIcon },
	review: { chip: "bg-[#422006] text-chrome-warn", icon: ClockIcon },
	missing: { chip: "bg-chrome-hover text-chrome-text", icon: CircleDashedIcon },
	hidden: { chip: "border border-dashed border-chrome-hover text-chrome-muted", icon: EyeOffIcon },
};

/** Each language of the Entry with where its translation stands; a chip shows the page in that language. */
function LanguagesCard({
	words,
	details,
	onLanguage,
}: {
	words: Words;
	details: EntryDetails;
	onLanguage(path: string): void;
}) {
	const said = words.details;
	const id = useId();
	const languages = details.page?.languages ?? [];
	const choose = useCallback((path: string) => onLanguage(path), [onLanguage]);
	return (
		<div
			className="bg-chrome-raised flex min-w-0 flex-col gap-1 rounded-md px-2 py-1.5"
			data-wc-details-field="languages"
		>
			<span id={id} className="text-chrome-muted text-[11px]">
				{said.languages}
			</span>
			<ul aria-labelledby={id} className="m-0 flex list-none flex-wrap gap-1.5 p-0">
				{languages.map((language) => {
					// Until each language's translation is read, its chip says nothing of it.
					const state: TranslationState | undefined = details.translations[language.code];
					const look = state ? LANGUAGE_LOOK[state] : { chip: "bg-chrome-hover text-chrome-text", icon: null };
					const Glyph = look.icon;
					return (
						<li key={language.code}>
							<button
								type="button"
								aria-current={language.current ? "page" : undefined}
								onClick={() => {
									if (!language.current) choose(language.path);
								}}
								className={`inline-flex h-[22px] items-center gap-1 rounded-[11px] px-[7px] text-[11px] font-semibold ${look.chip} ${
									language.current ? "ring-chrome-text/60 ring-1" : "hover:brightness-125"
								} ${FOCUS_RING}`}
								data-wc-language-chip={language.code}
								data-state={state ?? "reading"}
							>
								{Glyph ? <Glyph aria-hidden="true" className="size-[11px]" /> : null}
								<span aria-hidden="true">{language.code.toUpperCase()}</span>
								<span className="sr-only">
									{state
										? fill(said.languageChip, { language: language.name, state: said.translation[state] })
										: language.name}
								</span>
							</button>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
