import { ArrowUpDownIcon, ArrowUpRightIcon, ChevronDownIcon, EllipsisIcon, SearchIcon } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";

import { fill, type Words } from "../../api.ts";
import { ChoiceMenu } from "../../ChoiceMenu.tsx";
import { CHROME_EASE, FOCUS_RING } from "../../controls.tsx";
import type { ContentEntry } from "./data.ts";
import { ActionMenu, Badge, buttonLook, FilterMenu, PlaceIconButton, StatusBadges } from "./ui.tsx";
import { type ContentView, newAddress, SORTS, type Sort, STATUS_FILTERS, viewEntries } from "./view.ts";

/** How many rows show at first, and how many more each "Show more" adds. */
export const PAGE_SIZE = 50;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** When something changed, as people say it ("Just now", "5 min. ago", "2 days ago"), in `language`. */
export function whenText(time: number, now: number, language: string, justNow: string): string {
	const ago = now - time;
	if (ago < MINUTE) return justNow;
	const format = new Intl.RelativeTimeFormat(language, { numeric: "auto", style: "short" });
	if (ago < HOUR) return format.format(-Math.floor(ago / MINUTE), "minute");
	if (ago < DAY) return format.format(-Math.floor(ago / HOUR), "hour");
	if (ago < 7 * DAY) return format.format(-Math.floor(ago / DAY), "day");
	if (ago < 30 * DAY) return format.format(-Math.floor(ago / (7 * DAY)), "week");
	if (ago < 365 * DAY) return format.format(-Math.floor(ago / (30 * DAY)), "month");
	return format.format(-Math.floor(ago / (365 * DAY)), "year");
}

/** A Post Type as the grid needs it. */
export type GridPostType = { id: string; name: string; pages: boolean; urlPattern: string };

/** The Site's languages, the Default language first. */
export type Languages = { default: string; all: readonly { code: string; name: string }[] };

/**
 * A Post Type's Entries as Staff see them in the Content place (`places-content/01`): the title row
 * (its name, how many, in which languages; search, the status and language filters and the sort), the
 * grid (Title, Address, Status, Languages, Author, Updated and the row's actions; header 35, rows 46)
 * and the create row (50): a title, then Enter makes a Draft and opens it on the canvas.
 */
export function EntriesGrid({
	words,
	language,
	postType,
	entries,
	languages,
	view,
	onView,
	onOpen,
	adminOf,
	onCreate,
	announce,
}: {
	words: Words;
	/** The person's Admin language: dates and sorting are said in it. */
	language: string;
	postType: GridPostType;
	entries: readonly ContentEntry[];
	languages: Languages;
	view: ContentView;
	/** A new view: `replace` while typing a search (no history entry for each key). */
	onView(view: ContentView, how: "push" | "replace"): void;
	/** Opens an Entry on the canvas (at its address). */
	onOpen(entry: ContentEntry): void;
	/** The Entry in the admin. */
	adminOf(entry: ContentEntry): string;
	/** Makes a Draft with this title: answers false (and says why) when it couldn't. */
	onCreate(title: string): Promise<boolean>;
	announce(text: string, urgent?: boolean): void;
}) {
	const shown = words.content;
	const [count, setCount] = useState(PAGE_SIZE);
	const rows = viewEntries(entries, view, language);
	const several = languages.all.length > 1;
	const now = Date.now();
	const summary = fill(shown.summary, {
		count: fill(shown.entries[new Intl.PluralRules(language).select(entries.length) === "one" ? "one" : "other"], {
			count: String(entries.length),
		}),
		languages: languages.all.map((each) => each.code.toUpperCase()).join(", "),
	});
	const statusWord = (status: (typeof STATUS_FILTERS)[number] | null) =>
		status === null ? shown.status.all : status === "draft" ? shown.status.drafts : shown.status[status];
	const languageName = (code: string | null) =>
		code === null ? shown.allLanguages : (languages.all.find((each) => each.code === code)?.name ?? code);

	return (
		<div className="flex min-w-0 flex-col gap-3 p-4" data-wc-entries={postType.id}>
			<div className="flex min-h-10 flex-wrap items-center gap-x-2.5 gap-y-2">
				<h2 className="text-chrome-strong m-0 text-[16px] font-semibold">{postType.name}</h2>
				<p className="text-chrome-muted m-0 text-[13px]" data-wc-entries-summary="">
					{several ? summary : summary.split(" · ")[0]}
				</p>
				<div className="ms-auto flex flex-wrap items-center gap-2">
					<label className="relative flex h-[30px] w-[200px] items-center">
						<SearchIcon
							aria-hidden="true"
							className="text-chrome-muted pointer-events-none absolute start-2 size-3.5"
						/>
						<span className="sr-only">{fill(shown.searchIn, { name: postType.name })}</span>
						<input
							type="search"
							value={view.q}
							placeholder={shown.search}
							onChange={(event) => onView({ ...view, q: event.target.value }, "replace")}
							className="bg-chrome-raised text-chrome-strong placeholder:text-chrome-muted focus-visible:ring-chrome-focus h-full w-full min-w-0 rounded-md ps-7 pe-2 text-[12px] font-medium outline-none focus-visible:ring-2"
							data-wc-content-search=""
						/>
					</label>
					<FilterMenu
						label={shown.status.label}
						shown={fill(shown.statusChip, { value: statusWord(view.status) })}
						groups={[
							{
								label: null,
								choices: [null, ...STATUS_FILTERS].map((status) => ({
									key: status ?? "all",
									label: statusWord(status),
									current: view.status === status,
								})),
							},
						]}
						onChoose={(key) =>
							onView({ ...view, status: key === "all" ? null : (key as ContentView["status"]) }, "push")
						}
						data={{ "data-wc-filter": "status" }}
					/>
					{several ? (
						<FilterMenu
							label={shown.language}
							shown={fill(shown.languageChip, { value: languageName(view.language) })}
							groups={[
								{
									label: null,
									choices: [
										{ key: "all", label: shown.allLanguages, current: view.language === null },
										...languages.all.map((each) => ({
											key: each.code,
											label: each.name,
											detail: each.code.toUpperCase(),
											current: view.language === each.code,
										})),
									],
								},
							]}
							onChoose={(key) => onView({ ...view, language: key === "all" ? null : key }, "push")}
							data={{ "data-wc-filter": "language" }}
						/>
					) : null}
					<SortMenu words={words} sort={view.sort} onSort={(sort) => onView({ ...view, sort }, "push")} />
				</div>
			</div>

			<div className="overflow-hidden rounded-lg">
				<table className="w-full table-fixed border-collapse text-[12px]" data-wc-grid="">
					<caption className="sr-only">
						{postType.name}, {shown.sort.sorted.replace("{sort}", shown.sort[view.sort])}
					</caption>
					<colgroup>
						<col className="w-[22%]" />
						<col className="w-[22%]" />
						<col className="w-[150px]" />
						{several ? <col className="w-[110px]" /> : null}
						<col className="w-[100px]" />
						<col className="w-[100px]" />
						<col className="w-[120px]" />
					</colgroup>
					<thead>
						<tr className="bg-chrome-raised h-[35px]">
							<Head sort={view.sort} by="title">
								{shown.columns.title}
							</Head>
							<Head sort={view.sort} by="address">
								{shown.columns.address}
							</Head>
							<Head sort={view.sort} by="status">
								{shown.columns.status}
							</Head>
							{several ? <Head>{shown.columns.languages}</Head> : null}
							<Head sort={view.sort} by="author">
								{shown.columns.author}
							</Head>
							<Head sort={view.sort} by="updated">
								{shown.columns.updated}
							</Head>
							<Head>
								<span className="sr-only">{shown.columns.actions}</span>
							</Head>
						</tr>
					</thead>
					<tbody>
						{rows.length === 0 ? (
							<tr className="border-chrome-line border-b">
								<td colSpan={several ? 7 : 6} className="text-chrome-muted px-2.5 py-6 text-center">
									{entries.length === 0 ? shown.emptyCreate : shown.noMatch}
								</td>
							</tr>
						) : (
							rows
								.slice(0, count)
								.map((entry) => (
									<EntryRow
										key={entry.id}
										words={words}
										entry={entry}
										languages={several ? languages : null}
										when={whenText(entry.updatedAt, now, language, shown.justNow)}
										onOpen={() => onOpen(entry)}
										admin={adminOf(entry)}
										announce={announce}
									/>
								))
						)}
						<CreateRow words={words} postType={postType} columns={several ? 7 : 6} onCreate={onCreate} />
					</tbody>
				</table>
			</div>

			{rows.length > count ? (
				<p className="text-chrome-muted m-0 flex items-center justify-center gap-1 text-[12px]">
					<span role="status">{fill(shown.shown, { shown: String(count), total: String(rows.length) })}</span>
					<span aria-hidden="true">·</span>
					<button
						type="button"
						onClick={() => setCount((was) => was + PAGE_SIZE)}
						className={`text-chrome-accent rounded-sm font-medium hover:underline ${FOCUS_RING}`}
					>
						{shown.showMore}
					</button>
				</p>
			) : null}
		</div>
	);
}

/** A column's header cell, saying when the grid is sorted by it. */
function Head({ children, sort, by }: { children: ReactNode; sort?: Sort; by?: string }) {
	const sorted = sort && by ? (sort === by ? "ascending" : sort === `-${by}` ? "descending" : undefined) : undefined;
	return (
		<th
			scope="col"
			aria-sort={sorted}
			className="text-chrome-muted px-2.5 text-start align-middle text-[11px] font-semibold tracking-[0.3px]"
		>
			{children}
		</th>
	);
}

/** The ⇅ button and its menu of orders. */
function SortMenu({ words, sort, onSort }: { words: Words; sort: Sort; onSort(sort: Sort): void }) {
	const [open, setOpen] = useState(false);
	const button = useRef<HTMLButtonElement>(null);
	const id = useId();
	const shown = words.content.sort;
	return (
		<span className="relative inline-flex">
			<PlaceIconButton
				icon={ArrowUpDownIcon}
				label={`${shown.label}: ${shown[sort]}`}
				size={30}
				onClick={() => setOpen((was) => !was)}
				expanded={open}
				controls={open ? id : undefined}
				buttonRef={button}
				data={{ "data-wc-sort": sort }}
			/>
			{open ? (
				<ChoiceMenu
					id={id}
					label={shown.label}
					groups={[{ label: null, choices: SORTS.map((key) => ({ key, label: shown[key], current: key === sort })) }]}
					button={button}
					side="bottom"
					align="end"
					onChoose={(choice) => onSort(choice.key as Sort)}
					onClose={(focusButton) => {
						setOpen(false);
						if (focusButton) button.current?.focus();
					}}
				/>
			) : null}
		</span>
	);
}

/** One Entry's row: its title (opens it on the canvas), address, status, languages, author, last change. */
function EntryRow({
	words,
	entry,
	languages,
	when,
	onOpen,
	admin,
	announce,
}: {
	words: Words;
	entry: ContentEntry;
	/** The Site's languages, when it has several. */
	languages: Languages | null;
	when: string;
	onOpen(): void;
	admin: string;
	announce(text: string, urgent?: boolean): void;
}) {
	const shown = words.content;
	const title = entry.title || shown.untitled;
	const openable = entry.address !== "";
	return (
		<tr
			className={`group/row border-chrome-line hover:bg-chrome-raised focus-within:bg-chrome-raised h-[46px] border-b ${CHROME_EASE}`}
			data-wc-entry={entry.id}
		>
			<td className="px-2.5">
				<button
					type="button"
					onClick={onOpen}
					disabled={!openable}
					title={openable ? undefined : fill(shown.noAddress, { title })}
					className={`text-chrome-text block max-w-full truncate rounded-sm text-start font-medium hover:underline disabled:hover:no-underline ${FOCUS_RING}`}
					data-wc-entry-title=""
				>
					{title}
				</button>
			</td>
			<td className="text-chrome-muted truncate px-2.5 font-mono" data-wc-entry-address="">
				{entry.address}
			</td>
			<td className="px-2.5">
				<StatusBadges words={words} status={entry.status} inReview={entry.inReview} />
			</td>
			{languages ? (
				<td className="px-2.5">
					<ul className="m-0 flex list-none gap-1 p-0" aria-label={fill(shown.languagesOf, { title })}>
						{languages.all.map((each) => {
							const hidden = entry.hiddenLanguages.includes(each.code);
							return (
								<li
									key={each.code}
									className={`inline-flex h-[18px] items-center rounded px-[5px] text-[10px] font-semibold ${
										hidden
											? "border-chrome-hover text-chrome-muted border border-dashed"
											: "bg-chrome-hover text-chrome-text"
									}`}
								>
									<span aria-hidden="true">{each.code.toUpperCase()}</span>
									<span className="sr-only">
										{fill(hidden ? shown.hiddenIn : shown.shownIn, { language: each.name })}
									</span>
								</li>
							);
						})}
					</ul>
				</td>
			) : null}
			<td className="text-chrome-text truncate px-2.5 font-medium">{entry.author || "—"}</td>
			<td className="text-chrome-text truncate px-2.5 font-medium">
				<time dateTime={new Date(entry.updatedAt).toISOString()}>{when}</time>
			</td>
			<td className="px-2.5">
				<span className="flex items-center justify-end gap-0.5">
					{/* The title opens it too: under the pointer, not a second stop for the keyboard. */}
					{openable ? (
						<button
							type="button"
							tabIndex={-1}
							aria-hidden="true"
							onClick={onOpen}
							className={`text-chrome-muted hover:bg-chrome-hover hover:text-chrome-strong inline-grid size-6 place-items-center rounded-[5px] ${CHROME_EASE}`}
							data-wc-entry-open=""
						>
							<ArrowUpRightIcon className="size-3.5" />
						</button>
					) : null}
					<ActionMenu
						icon={EllipsisIcon}
						label={fill(shown.more, { title })}
						actions={[
							...(openable ? [{ key: "open", label: fill(shown.open, { title }), run: onOpen }] : []),
							{ key: "admin", label: shown.openInAdmin, run: () => window.open(admin, "_blank", "noopener") },
							...(openable
								? [
										{
											key: "copy",
											label: shown.copyAddress,
											run: () => {
												void navigator.clipboard
													?.writeText(new URL(entry.address, window.location.origin).toString())
													.then(() => announce(shown.copied));
											},
										},
									]
								: []),
						]}
						data={{ "data-wc-entry-more": "" }}
					/>
				</span>
			</td>
		</tr>
	);
}

/** The grid's last row: the title of a new Entry; Enter (or Create) makes it as a Draft and opens it. */
function CreateRow({
	words,
	postType,
	columns,
	onCreate,
}: {
	words: Words;
	postType: GridPostType;
	columns: number;
	onCreate(title: string): Promise<boolean>;
}) {
	const shown = words.content;
	const [title, setTitle] = useState("");
	const [busy, setBusy] = useState(false);
	const help = useId();
	const create = async () => {
		const trimmed = title.trim();
		if (!trimmed || busy) return;
		setBusy(true);
		const made = await onCreate(trimmed);
		setBusy(false);
		if (made) setTitle("");
	};
	const address = newAddress(title, postType.urlPattern, postType.pages);
	return (
		<tr className="border-chrome-line h-[50px] border-b" data-wc-create-row="">
			<td className="px-2.5">
				<span className="flex items-center gap-1.5">
					<ChevronDownIcon aria-hidden="true" className="text-chrome-muted size-3 shrink-0" />
					<input
						type="text"
						value={title}
						disabled={busy}
						maxLength={500}
						onChange={(event) => setTitle(event.target.value)}
						onKeyDown={(event) => {
							if (event.key !== "Enter") return;
							event.preventDefault();
							void create();
						}}
						placeholder={postType.pages ? shown.newPage : shown.newEntry}
						aria-label={postType.pages ? shown.newPageTitle : shown.newEntryTitle}
						aria-describedby={help}
						className="text-chrome-strong placeholder:text-chrome-muted focus-visible:ring-chrome-focus min-w-0 grow rounded-sm bg-transparent py-1 text-[12px] font-medium outline-none focus-visible:ring-2"
						data-wc-create-title=""
					/>
				</span>
			</td>
			<td className="text-chrome-muted truncate px-2.5 font-mono" aria-hidden="true">
				{address || (postType.pages ? "/new-page" : "")}
			</td>
			<td className="px-2.5" aria-hidden="true">
				<Badge kind="draft">{shown.status.draft}</Badge>
			</td>
			<td colSpan={columns - 4} />
			<td className="px-2.5 text-end">
				<span id={help} className="sr-only">
					{shown.createHelp}
				</span>
				<button
					type="button"
					onClick={() => void create()}
					disabled={busy || !title.trim()}
					className={`${buttonLook("primary")} w-[100px]`}
					data-wc-create=""
				>
					{busy ? shown.creating : `${shown.create} ↵`}
				</button>
			</td>
		</tr>
	);
}
