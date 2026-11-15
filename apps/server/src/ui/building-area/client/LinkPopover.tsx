import {
	CheckIcon,
	ChevronDownIcon,
	FileIcon,
	FileTextIcon,
	GlobeIcon,
	MailIcon,
	MousePointerClickIcon,
	PhoneIcon,
	RssIcon,
	SearchIcon,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";

import { fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING, type Icon } from "../controls.tsx";
import type { GoToData } from "../management.ts";
import { pickMedia } from "../places/media/pick.ts";
import { INPUT, Popover, PopoverButton, PopoverField } from "./Popover.tsx";
import type { LinkValue, RegionPopovers } from "./popovers.ts";

/** Where a link goes (SPEC 13.3): a Page or Entry of the Site, a web address, an email, a phone number, a file. */
type Kind = "page" | "url" | "email" | "phone" | "file";

const KINDS: readonly Kind[] = ["page", "url", "email", "phone", "file"];
const KIND_ICONS: Record<Kind, Icon> = {
	page: FileTextIcon,
	url: GlobeIcon,
	email: MailIcon,
	phone: PhoneIcon,
	file: FileIcon,
};

/** How long after typing stops the link saves (and when the field is left). */
const SAVE_AFTER_MS = 800;
/** How long "Click again to remove" waits for the second click. */
const CONFIRM_MS = 4000;
/** The most results the list shows at once before it scrolls. */
const SHOWN_ROWS = 6;

/** One Page or Entry a link can go to. */
type Target = { id: string; title: string; path: string; badge: string | null };

/** What the popover holds while it is changed: one address per kind, the words and the new tab. */
type Draft = {
	text: string;
	kind: Kind;
	page: string;
	web: string;
	email: string;
	phone: string;
	file: { path: string; name: string } | null;
	newTab: boolean;
};

/** Where an address goes, read back as the popover's kinds. */
function draftOf(link: LinkValue | null): Draft {
	const url = link?.url ?? "";
	const base: Draft = {
		text: link?.text ?? "",
		kind: "page",
		page: "",
		web: "",
		email: "",
		phone: "",
		file: null,
		newTab: link?.newTab ?? false,
	};
	if (/^mailto:/i.test(url))
		return { ...base, kind: "email", email: decodeURIComponent(url.slice(7).split("?")[0] ?? "") };
	if (/^tel:/i.test(url)) return { ...base, kind: "phone", phone: url.slice(4) };
	if (url.startsWith("/_media/"))
		return { ...base, kind: "file", file: { path: url, name: url.split("/").pop() ?? url } };
	if (url.startsWith("/")) return { ...base, kind: "page", page: url };
	if (url === "") return base;
	return { ...base, kind: "url", web: url };
}

/** The address a draft gives, or why it gives none ("" when there is nothing to go to yet). */
function addressOf(draft: Draft): { url: string } | { problem: "unsafe" | "badEmail" | "badPhone" } {
	switch (draft.kind) {
		case "page":
			return { url: draft.page };
		case "file":
			return { url: draft.file?.path ?? "" };
		case "email": {
			const email = draft.email.trim();
			if (!email) return { url: "" };
			return /^[^\s@]+@[^\s@]+$/.test(email) ? { url: `mailto:${email}` } : { problem: "badEmail" };
		}
		case "phone": {
			const phone = draft.phone.trim();
			if (!phone) return { url: "" };
			const digits = phone.replace(/[\s().-]/g, "");
			return /^\+?\d{3,}$/.test(digits) ? { url: `tel:${digits}` } : { problem: "badPhone" };
		}
		default: {
			const web = draft.web.trim();
			if (!web) return { url: "" };
			if (/^(https?:\/\/|\/|#)/i.test(web)) return /\s/.test(web) ? { problem: "unsafe" } : { url: web };
			// A scheme of any other kind (javascript:, data:, …) is no web address.
			if (/^[a-z][a-z0-9+.-]*:/i.test(web) && !/^[^:/]+:\d/.test(web)) return { problem: "unsafe" };
			return /\s/.test(web) ? { problem: "unsafe" } : { url: `https://${web}` };
		}
	}
}

/** How the foot shows where the link goes: the Site's address and the path, the address without its scheme. */
function shownAddress(url: string): string {
	if (!url) return "";
	if (url.startsWith("/")) return `${window.location.host}${url}`;
	return url.replace(/^(https?:\/\/|mailto:|tel:)/i, "");
}

/** Whether the `<a>` looks like a button on the page: a button's Class or role, or a filled box. */
function looksLikeButton(element: HTMLElement): boolean {
	if (/\b(btn|button|cta)\b/i.test(element.className) || element.getAttribute("role") === "button") return true;
	const style = element.ownerDocument.defaultView?.getComputedStyle(element);
	const fill = style?.backgroundColor ?? "";
	return fill !== "" && fill !== "transparent" && !/rgba\(.*,\s*0\)$/.test(fill);
}

/**
 * The button/link popover (SPEC 13.3, `client/04`): under a link or a button on the page, named by its
 * Field. Its words; where it goes: a Page or Entry from a searchable list, a web address, an email, a
 * phone number, or a file of the Media library (the Media picker); "Open in a new tab"; and the address
 * it goes to with "Remove link" (a second click). Each change saves to the Draft as it is made (words
 * and addresses a moment after typing stops), through the link Field's own rules: an address a link
 * may not go to is said under its field and not saved.
 */
export function LinkPopover({
	popovers,
	words,
	element,
	name,
	focus,
	seq,
	hidden,
	box,
	goTo,
}: {
	popovers: RegionPopovers;
	words: Words;
	element: HTMLElement;
	name: string;
	focus: string | null;
	seq: number;
	hidden: boolean;
	box: DOMRect;
	/** Go to's Pages and Entries of the Site (`builder.commandMenu`), read as the popover opens. */
	goTo(): Promise<GoToData>;
}) {
	const said = words.client.link;
	const [draft, setDraft] = useState<Draft>(() => draftOf(popovers.link.read(element)));
	const latest = useRef(draft);
	latest.current = draft;
	const saved = useRef<string>(JSON.stringify(popovers.link.read(element)));
	const timer = useRef<number | undefined>(undefined);
	const [problem, setProblem] = useState<string | null>(null);
	const [confirming, setConfirming] = useState(false);
	const confirmTimer = useRef<number | undefined>(undefined);
	const [targets, setTargets] = useState<Target[] | null>(null);
	const [query, setQuery] = useState("");
	/** The result the keys are on (-1: none yet; typing a search puts them on the first). */
	const [active, setActive] = useState(-1);
	const wordsId = useId();
	const addressId = useId();
	const problemId = useId();
	const listId = useId();
	const newTabId = useId();
	const button = useMemo(() => looksLikeButton(element), [element]);
	const wordsField = useRef<HTMLInputElement>(null);

	useEffect(
		() => () => {
			window.clearTimeout(timer.current);
			window.clearTimeout(confirmTimer.current);
		},
		[],
	);

	// The Site's Pages and Entries, read again each time it opens.
	useEffect(() => {
		let current = true;
		void goTo()
			.then((data) => {
				if (!current) return;
				setTargets([
					...data.pages.map((page) => ({ ...page, badge: null })),
					...data.postTypes.flatMap((postType) =>
						postType.entries.map((entry) => ({ ...entry, badge: postType.name })),
					),
				]);
			})
			.catch(() => {
				if (current) setTargets([]);
			});
		return () => {
			current = false;
		};
	}, [goTo]);

	/** Saves the link as the popover holds it now, unless it is the same as stored or has nowhere to go yet. */
	const commit = async () => {
		window.clearTimeout(timer.current);
		const now = latest.current;
		const address = addressOf(now);
		if ("problem" in address) {
			setProblem(said[address.problem]);
			return;
		}
		setProblem(null);
		// Nowhere to go yet: nothing to save until it has an address.
		if (!address.url) return;
		const value: LinkValue = { url: address.url, text: now.text.trim(), newTab: now.newTab };
		const key = JSON.stringify(value);
		if (key === saved.current) return;
		const answer = await popovers.link.save(element, value);
		if (answer.ok) {
			saved.current = key;
			return;
		}
		setProblem(answer.reason === "BAD_REQUEST" ? said.unsafe : fill(said.failed, { reason: answer.reason }));
	};
	const change = (next: Partial<Draft>, at: "now" | "later") => {
		const merged = { ...latest.current, ...next };
		latest.current = merged;
		setDraft(merged);
		setConfirming(false);
		window.clearTimeout(timer.current);
		if (at === "now") void commit();
		else timer.current = window.setTimeout(() => void commit(), SAVE_AFTER_MS);
	};

	const remove = async () => {
		if (!confirming) {
			setConfirming(true);
			window.clearTimeout(confirmTimer.current);
			confirmTimer.current = window.setTimeout(() => setConfirming(false), CONFIRM_MS);
			return;
		}
		window.clearTimeout(confirmTimer.current);
		window.clearTimeout(timer.current);
		setConfirming(false);
		const answer = await popovers.link.save(element, null);
		if (!answer.ok) {
			setProblem(fill(said.failed, { reason: answer.reason }));
			return;
		}
		saved.current = JSON.stringify(null);
		const empty = draftOf(null);
		latest.current = empty;
		setDraft(empty);
		// Remove link goes with the link: focus stays in the popover, on its words.
		wordsField.current?.focus();
	};

	const shown = useMemo(() => {
		const wanted = query.trim().toLowerCase();
		const all = targets ?? [];
		return wanted ? all.filter((target) => `${target.title} ${target.path}`.toLowerCase().includes(wanted)) : all;
	}, [targets, query]);

	const choosePage = (target: Target) => change({ page: target.path }, "now");
	const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			if (shown.length === 0) return;
			const down = event.key === "ArrowDown";
			setActive((at) =>
				at < 0 ? (down ? 0 : shown.length - 1) : (at + (down ? 1 : -1) + shown.length) % shown.length,
			);
		} else if (event.key === "Enter") {
			const target = shown[active];
			if (!target) return;
			event.preventDefault();
			choosePage(target);
		}
	};
	useEffect(() => {
		document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
	}, [active, listId]);

	const address = addressOf(draft);
	const url = "url" in address ? address.url : "";
	const KindIcon = KIND_ICONS[draft.kind];
	// The field of a typed address: a web address, an email or a phone number.
	const typed =
		draft.kind === "email"
			? { key: "email" as const, label: said.email, placeholder: said.emailPlaceholder }
			: draft.kind === "phone"
				? { key: "phone" as const, label: said.phone, placeholder: said.phonePlaceholder }
				: { key: "web" as const, label: said.url, placeholder: said.urlPlaceholder };

	return (
		<Popover
			kind="link"
			icon={MousePointerClickIcon}
			title={name}
			closeLabel={fill(said.close, { name })}
			box={box}
			where="below"
			focus={focus}
			seq={seq}
			hidden={hidden}
			onClose={(back) => {
				// What was typed and not saved yet is saved as it closes.
				void commit();
				popovers.close(back);
			}}
		>
			<PopoverField label={button ? said.wordsButton : said.words} htmlFor={wordsId}>
				<input
					ref={wordsField}
					id={wordsId}
					type="text"
					maxLength={300}
					autoComplete="off"
					value={draft.text}
					className={`${INPUT} h-10`}
					data-wc-autofocus=""
					data-wc-link-words=""
					onChange={(event) => change({ text: event.currentTarget.value }, "later")}
					onBlur={() => void commit()}
				/>
			</PopoverField>
			<fieldset className="m-0 flex w-full min-w-0 flex-col gap-1.5 border-0 p-0">
				<legend className="text-chrome-strong mb-1.5 p-0 text-[13px] font-medium">{said.where}</legend>
				<div className="flex w-full gap-2">
					<span className="relative w-[128px] shrink-0">
						<KindIcon
							className="text-chrome-muted pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
							aria-hidden="true"
						/>
						<select
							aria-label={said.kind}
							value={draft.kind}
							className={`${INPUT} h-10 cursor-pointer appearance-none ps-9 pe-8`}
							data-wc-link-kind=""
							onChange={(event) => change({ kind: event.currentTarget.value as Kind }, "now")}
						>
							{KINDS.map((kind) => (
								<option key={kind} value={kind}>
									{said.kinds[kind]}
								</option>
							))}
						</select>
						<ChevronDownIcon
							className="text-chrome-muted pointer-events-none absolute end-3 top-1/2 size-3.5 -translate-y-1/2"
							aria-hidden="true"
						/>
					</span>
					{draft.kind === "page" ? (
						<span className="relative min-w-0 flex-1">
							<SearchIcon
								className="text-chrome-muted pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
								aria-hidden="true"
							/>
							<input
								type="search"
								role="combobox"
								aria-label={said.search}
								aria-controls={listId}
								aria-expanded="true"
								aria-autocomplete="list"
								aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
								placeholder={said.searchPlaceholder}
								autoComplete="off"
								value={query}
								className={`${INPUT} h-10 ps-9`}
								data-wc-focus-key="search"
								data-wc-link-search=""
								onChange={(event) => {
									setQuery(event.currentTarget.value);
									setActive(0);
								}}
								onKeyDown={onSearchKey}
							/>
						</span>
					) : draft.kind === "file" ? (
						<PopoverButton
							className="min-w-0 flex-1"
							data-wc-link-file=""
							onClick={async () => {
								popovers.picking(true);
								const picked = await pickMedia({ current: null });
								popovers.picking(false);
								if (picked?.url) change({ file: { path: picked.url, name: picked.fileName } }, "now");
							}}
						>
							<span className="truncate">{draft.file ? said.changeFile : said.chooseFile}</span>
						</PopoverButton>
					) : (
						<input
							id={addressId}
							type={draft.kind === "email" ? "email" : draft.kind === "phone" ? "tel" : "text"}
							inputMode={draft.kind === "url" ? "url" : undefined}
							aria-label={typed.label}
							aria-invalid={problem ? true : undefined}
							aria-describedby={problem ? problemId : undefined}
							placeholder={typed.placeholder}
							autoComplete="off"
							spellCheck={false}
							value={draft[typed.key]}
							className={`${INPUT} h-10 min-w-0 flex-1`}
							data-wc-link-address=""
							onChange={(event) => change({ [typed.key]: event.currentTarget.value }, "later")}
							onBlur={() => void commit()}
						/>
					)}
				</div>
				{draft.kind === "page" ? (
					<div
						id={listId}
						role="listbox"
						aria-label={said.results}
						className="flex w-full flex-col overflow-y-auto"
						style={{ maxHeight: SHOWN_ROWS * 34 }}
						data-wc-link-results=""
					>
						{targets === null ? (
							<p className="text-chrome-muted m-0 px-2.5 py-2 text-[13px]">{said.loadingPages}</p>
						) : shown.length === 0 ? (
							<p className="text-chrome-muted m-0 px-2.5 py-2 text-[13px]">{said.noResults}</p>
						) : (
							shown.map((target, index) => {
								const chosen = target.path === draft.page;
								const RowIcon = target.badge ? RssIcon : FileTextIcon;
								return (
									// biome-ignore lint/a11y/useKeyWithClickEvents: the combobox's keys choose an option.
									<div
										key={target.id}
										id={`${listId}-${index}`}
										role="option"
										aria-selected={chosen}
										tabIndex={-1}
										className={`flex h-[34px] w-full shrink-0 cursor-pointer items-center gap-2.5 rounded-[7px] px-2.5 ${
											chosen ? "bg-chrome-hover" : index === active ? "bg-chrome-raised" : "hover:bg-chrome-raised"
										} ${CHROME_EASE}`}
										data-wc-link-target={target.path}
										onPointerDown={(event) => event.preventDefault()}
										onClick={() => {
											setActive(index);
											choosePage(target);
										}}
									>
										<RowIcon
											className={`size-[15px] shrink-0 ${chosen ? "text-chrome-strong" : "text-chrome-muted"}`}
											aria-hidden="true"
										/>
										<span
											className={`min-w-0 flex-1 truncate text-[14px] font-medium ${chosen ? "text-chrome-strong" : "text-chrome-text"}`}
										>
											{target.title}
										</span>
										{target.badge ? (
											<span className="shrink-0 rounded-full bg-[#11264d] px-2 py-0.5 text-[11px] font-semibold text-[#bfdbfe]">
												{target.badge}
											</span>
										) : null}
										{chosen ? <CheckIcon className="text-chrome-ok size-[15px] shrink-0" aria-hidden="true" /> : null}
									</div>
								);
							})
						)}
					</div>
				) : null}
				{problem ? (
					<p id={problemId} className="text-chrome-danger m-0 text-[12px]" role="alert" data-wc-link-problem="">
						{problem}
					</p>
				) : null}
			</fieldset>
			<div className="flex w-full items-center gap-3">
				<span id={newTabId} className="text-chrome-strong flex-1 text-[13px] font-medium">
					{said.newTab}
				</span>
				<button
					type="button"
					role="switch"
					aria-checked={draft.newTab}
					aria-labelledby={newTabId}
					className={`flex h-6 w-10 shrink-0 items-center rounded-full px-[3px] ${
						draft.newTab ? "bg-chrome-ok justify-end" : "justify-start bg-[#3f3f46]"
					} ${CHROME_EASE} ${FOCUS_RING}`}
					data-wc-link-new-tab=""
					onClick={() => change({ newTab: !draft.newTab }, "now")}
				>
					<span className={`size-[18px] rounded-full ${draft.newTab ? "bg-[#052e16]" : "bg-[#e4e4e7]"}`} />
				</button>
			</div>
			<div className="flex w-full items-center gap-3">
				<span className="text-chrome-muted min-w-0 flex-1 truncate text-[12px]" data-wc-link-address-shown="">
					{url ? shownAddress(url) : said.nowhere}
				</span>
				{saved.current !== "null" ? (
					<button
						type="button"
						className={`shrink-0 rounded-md px-1 text-[12px] font-semibold text-[#fca5a5] hover:underline ${FOCUS_RING}`}
						data-wc-link-remove=""
						onClick={() => void remove()}
					>
						{confirming ? said.removeAgain : said.remove}
					</button>
				) : null}
			</div>
		</Popover>
	);
}
