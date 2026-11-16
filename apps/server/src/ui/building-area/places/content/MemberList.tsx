import { PlusIcon, SearchIcon } from "lucide-react";
import { type RefObject, useId, useRef, useState } from "react";

import { fill, type Words } from "../../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../../controls.tsx";
import type { ContentEntry } from "./data.ts";
import { type GridPostType, PAGE_SIZE, whenText } from "./EntriesGrid.tsx";
import { buttonLook, StatusBadges } from "./ui.tsx";
import { type ContentView, matchesStatus, viewEntries } from "./view.ts";

/** The tabs a Member's list has (SPEC 13.6, `client-flows/02`): filters, so words only. */
const TABS = [null, "published", "draft", "review"] as const;

type Tab = (typeof TABS)[number];

/** Whether an Entry is under a Member's tab: Published counts those with unpublished changes too. */
function inTab(entry: ContentEntry, tab: Tab): boolean {
	if (tab === "published") return entry.status === "published" || entry.status === "changed";
	return matchesStatus(entry, tab);
}

/**
 * A Post Type's Entries as a Member sees them in the Content place (SPEC 13.6, `client-flows/02`): the
 * name with search and "New …", the tabs All · Published · Drafts · In review with their counts, the
 * create row at the top ("Write a new …"), then each Entry's title, status, author and last change,
 * with Edit (it opens on the canvas) under the pointer.
 */
export function MemberList({
	words,
	language,
	postType,
	entries,
	view,
	onView,
	onOpen,
	onCreate,
}: {
	words: Words;
	language: string;
	postType: GridPostType;
	entries: readonly ContentEntry[];
	view: ContentView;
	onView(view: ContentView, how: "push" | "replace"): void;
	onOpen(entry: ContentEntry): void;
	onCreate(title: string): Promise<boolean>;
}) {
	const shown = words.content;
	const [count, setCount] = useState(PAGE_SIZE);
	const create = useRef<HTMLInputElement>(null);
	const tab: Tab = view.status === "changed" ? "published" : view.status;
	// The tab is a filter of its own (Published takes in the changed ones); the search and order are the view's.
	const rows = viewEntries(entries, { ...view, status: null }, language).filter((entry) => inTab(entry, tab));
	const now = Date.now();
	const tabWord = (each: Tab) =>
		each === null
			? shown.status.all
			: each === "draft"
				? shown.status.drafts
				: each === "published"
					? shown.status.published
					: shown.status.review;

	return (
		<div className="flex min-w-0 flex-col gap-4 px-5 py-5" data-wc-entries={postType.id}>
			<div className="flex min-h-[34px] flex-wrap items-center gap-2.5">
				<h2 className="text-chrome-strong m-0 text-[18px] font-semibold">{postType.name}</h2>
				<div className="ms-auto flex items-center gap-2.5">
					<label className="relative flex h-[34px] w-[280px] items-center">
						<SearchIcon
							aria-hidden="true"
							className="text-chrome-muted pointer-events-none absolute start-2.5 size-3.5"
						/>
						<span className="sr-only">{fill(shown.searchIn, { name: postType.name })}</span>
						<input
							type="search"
							value={view.q}
							placeholder={shown.search}
							onChange={(event) => onView({ ...view, q: event.target.value }, "replace")}
							className="bg-chrome-raised text-chrome-strong placeholder:text-chrome-muted focus-visible:ring-chrome-focus h-full w-full min-w-0 rounded-md ps-8 pe-2.5 text-[13px] outline-none focus-visible:ring-2"
							data-wc-content-search=""
						/>
					</label>
					<button
						type="button"
						onClick={() => create.current?.focus()}
						className={buttonLook("primary")}
						data-wc-new-entry=""
					>
						<PlusIcon aria-hidden="true" className="size-3.5" />
						{postType.pages ? shown.newPage : shown.newEntry}
					</button>
				</div>
			</div>

			<fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0">
				<legend className="sr-only">{shown.status.label}</legend>
				{TABS.map((each) => {
					const current = each === tab;
					return (
						<button
							key={each ?? "all"}
							type="button"
							aria-pressed={current}
							onClick={() => onView({ ...view, status: each }, "push")}
							className={`border-chrome-hover inline-flex h-[33px] items-center gap-2 rounded-md border px-3.5 text-[12px] font-medium ${
								current
									? "bg-chrome-raised text-chrome-strong"
									: "text-chrome-muted hover:bg-chrome-raised hover:text-chrome-text"
							} ${CHROME_EASE} ${FOCUS_RING}`}
							data-wc-tab={each ?? "all"}
						>
							{tabWord(each)}
							<span className="text-chrome-muted text-[11px]">
								{entries.filter((entry) => inTab(entry, each)).length}
							</span>
						</button>
					);
				})}
			</fieldset>

			<div className="overflow-hidden rounded-lg">
				<table className="w-full table-fixed border-collapse text-[12px]" data-wc-grid="">
					<caption className="sr-only">{postType.name}</caption>
					<colgroup>
						<col />
						<col className="w-[120px]" />
						<col className="w-[150px]" />
						<col className="w-[110px]" />
						<col className="w-[90px]" />
					</colgroup>
					<thead>
						<tr className="bg-chrome-raised h-[35px]">
							{[shown.columns.title, shown.columns.status, shown.columns.author, shown.columns.updated].map((word) => (
								<th
									key={word}
									scope="col"
									className="text-chrome-muted px-2.5 text-start text-[11px] font-semibold tracking-[0.3px]"
								>
									{word}
								</th>
							))}
							<th scope="col" className="px-2.5">
								<span className="sr-only">{shown.columns.actions}</span>
							</th>
						</tr>
					</thead>
					<tbody>
						<WriteRow words={words} pages={postType.pages} input={create} onCreate={onCreate} />
						{rows.length === 0 ? (
							<tr className="border-chrome-line border-b">
								<td colSpan={5} className="text-chrome-muted px-2.5 py-6 text-center">
									{entries.length === 0 ? shown.empty : shown.noMatch}
								</td>
							</tr>
						) : (
							rows.slice(0, count).map((entry) => {
								const title = entry.title || shown.untitled;
								const openable = entry.address !== "";
								return (
									<tr
										key={entry.id}
										className={`group/row border-chrome-line hover:bg-chrome-raised focus-within:bg-chrome-raised h-14 border-b ${CHROME_EASE}`}
										data-wc-entry={entry.id}
									>
										<td className="px-2.5">
											<button
												type="button"
												onClick={() => onOpen(entry)}
												disabled={!openable}
												title={openable ? undefined : fill(shown.noAddress, { title })}
												className={`text-chrome-strong block max-w-full truncate rounded-sm text-start text-[14px] font-medium hover:underline disabled:hover:no-underline ${FOCUS_RING}`}
												data-wc-entry-title=""
											>
												{title}
											</button>
										</td>
										<td className="px-2.5">
											<StatusBadges words={words} status={entry.status} inReview={entry.inReview} memberWords />
										</td>
										<td className="text-chrome-text truncate px-2.5 font-medium">{entry.author || "—"}</td>
										<td className="text-chrome-text truncate px-2.5 font-medium">
											<time dateTime={new Date(entry.updatedAt).toISOString()}>
												{whenText(entry.updatedAt, now, language, shown.justNow)}
											</time>
										</td>
										<td className="px-2.5 text-end">
											{/* The title opens it too: Edit says so under the pointer, and is no second stop for the keyboard. */}
											{openable ? (
												<button
													type="button"
													tabIndex={-1}
													aria-hidden="true"
													onClick={() => onOpen(entry)}
													className={`${buttonLook("outline")} opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100`}
													data-wc-entry-edit=""
												>
													{shown.edit}
												</button>
											) : null}
										</td>
									</tr>
								);
							})
						)}
					</tbody>
				</table>
			</div>

			{rows.length > count ? (
				<p className="text-chrome-muted m-0 flex items-center justify-center gap-1 text-[13px]">
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

/** A Member's create row, at the top: "Write a new …"; Enter makes it as a Draft and opens it. */
function WriteRow({
	words,
	pages,
	input,
	onCreate,
}: {
	words: Words;
	pages: boolean;
	input: RefObject<HTMLInputElement | null>;
	onCreate(title: string): Promise<boolean>;
}) {
	const shown = words.content;
	const [title, setTitle] = useState("");
	const [busy, setBusy] = useState(false);
	const help = useId();
	return (
		<tr className="border-chrome-hover h-14 border-b border-dashed" data-wc-create-row="">
			<td colSpan={5} className="px-2.5">
				<span className="flex items-center gap-2.5">
					<PlusIcon aria-hidden="true" className="text-chrome-muted size-4 shrink-0" />
					<input
						ref={input}
						type="text"
						value={title}
						disabled={busy}
						maxLength={500}
						onChange={(event) => setTitle(event.target.value)}
						onKeyDown={async (event) => {
							if (event.key !== "Enter" || !title.trim() || busy) return;
							event.preventDefault();
							setBusy(true);
							const made = await onCreate(title.trim());
							setBusy(false);
							if (made) setTitle("");
						}}
						placeholder={pages ? shown.writeNewPage : shown.writeNewEntry}
						aria-label={pages ? shown.newPageTitle : shown.newEntryTitle}
						aria-describedby={help}
						className="text-chrome-strong placeholder:text-chrome-muted focus-visible:ring-chrome-focus min-w-0 grow rounded-sm bg-transparent py-1 text-[14px] outline-none focus-visible:ring-2"
						data-wc-create-title=""
					/>
					<span id={help} className="sr-only">
						{shown.createHelp}
					</span>
				</span>
			</td>
		</tr>
	);
}
