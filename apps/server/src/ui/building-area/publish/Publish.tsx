import { CircleCheckIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { type EditRequests, fill, type ShellConfig } from "../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";
import type { BuildingDocument } from "../documents.ts";
import { managementApi } from "../management.ts";
import { PAGE_CHANGED_EVENT } from "../open-document.ts";
import { type ChangeRow, changeText, countOf, type PublishItem, refusalText, usePublishData } from "./data.ts";
import { type CellSize, type CellState, PublishCell } from "./PublishCell.tsx";
import { PublishSheet, type SheetActions } from "./PublishSheet.tsx";
import { documentSource, PUBLISH_OPEN_EVENT, PUBLISHED_EVENT, usePlaceSources } from "./sources.ts";

/** How long the cell reads "Published" (SPEC 13.8). */
const PUBLISHED_MS = 2000;

/** How long the "Published" toast stays, unless the pointer or focus is on it (`client-flows/05`). */
const TOAST_MS = 5000;

/**
 * Publish on the bottom bar (plan BA-12, SPEC 10 and 13.8): the cell, the sheet above it and the toast
 * after it. It covers what the open document and the place in view have changed (`publish/items`):
 * the page's Content, and for Staff the Structure it shows; it publishes them together through
 * Publish all's two calls (`publishing.publishAll`), or schedules them (`publishing.scheduleAll`).
 * ⌘↵ opens it, from the shell or the page.
 */
export function Publish({
	config,
	request,
	path,
	document,
	changed,
	size = "bar",
	announce,
	onPublished,
}: {
	config: ShellConfig;
	request: EditRequests;
	/** The page the frame shows (its path, no query); null when it shows none (a stand-in, a place's own canvas). */
	path: string | null;
	/** The open document: a Template or Component open without a page is published with it. */
	document: BuildingDocument | null;
	/** Changes when what Publish covers may have changed: it reads it again. */
	changed: unknown;
	size?: CellSize;
	announce(text: string, urgent?: boolean): void;
	/** Something was published, reverted or discarded: the shell reads the page's state again. */
	onPublished(): void;
}) {
	const { words, language } = config;
	const shown = words.publishing;
	const api = useMemo(() => managementApi(config.token), [config.token]);
	const placeSources = usePlaceSources();
	const sources = useMemo(() => {
		const own = documentSource(document);
		return own ? [own, ...placeSources] : [...placeSources];
	}, [document, placeSources]);
	const { data, failed, read } = usePublishData(request, path, sources, changed);
	const [open, setOpen] = useState(false);
	const [cell, setCell] = useState<"ready" | "publishing" | "published" | "failed">("ready");
	const [busy, setBusy] = useState(false);
	const [toast, setToast] = useState<{ live: string | null; at: number } | null>(null);
	const retry = useRef<PublishItem[] | null>(null);
	const button = useRef<HTMLButtonElement>(null);
	const sheetId = useId();

	const author = data ? !data.canPublish : false;
	const count = countOf(data);
	const withdrawable = data?.reviews.some((review) => review.status === "inReview" && review.canWithdraw) ?? false;
	// Nothing to publish, revert or withdraw: the cell is drawn quiet and does nothing.
	const nothing = !data || (data.changes.length === 0 && data.drafts.length === 0 && !withdrawable);
	const disabled = cell === "publishing" || cell === "published" || (cell === "ready" && nothing);

	const state: CellState = cell === "ready" ? (author ? { kind: "review" } : { kind: "ready", count }) : { kind: cell };

	const close = useCallback((focusCell: boolean) => {
		setOpen(false);
		if (focusCell) button.current?.focus();
	}, []);

	const changedEverywhere = useCallback(
		(items: readonly PublishItem[]) => {
			onPublished();
			globalThis.document.dispatchEvent(new CustomEvent(PUBLISHED_EVENT, { detail: { items } }));
			// The frame renders the published Structure: once some is published, it reads the page again.
			if (items.some((item) => item.kind !== "entry" && item.kind !== "globals")) {
				globalThis.document.dispatchEvent(new CustomEvent(PAGE_CHANGED_EVENT));
			}
		},
		[onPublished],
	);

	const publish = useCallback(
		async (given?: readonly PublishItem[]) => {
			const items = given ?? data?.items ?? [];
			if (items.length === 0) return;
			setOpen(false);
			setCell("publishing");
			setBusy(true);
			button.current?.focus();
			announce(shown.publishing);
			try {
				const siteId = config.site.id;
				const first = await api.publishing.publishAll({ siteId, items: [...items] });
				if (!first.published) {
					await api.publishing.publishAll({ siteId, items: [...items], confirmation: first.confirmation.id });
				}
				retry.current = null;
				setCell("published");
				announce(shown.publishedSaid);
				setToast({ live: data?.live ?? null, at: Date.now() });
				changedEverywhere(items);
				void read();
			} catch (error) {
				retry.current = [...items];
				setCell("failed");
				announce(fill(shown.failed, { reason: refusalText(error, words) }), true);
				void read();
			} finally {
				setBusy(false);
			}
		},
		[api, config.site.id, data, announce, shown, words, changedEverywhere, read],
	);

	// "Published" for 2 s, then the label again.
	useEffect(() => {
		if (cell !== "published") return;
		const timer = setTimeout(() => setCell("ready"), PUBLISHED_MS);
		return () => clearTimeout(timer);
	}, [cell]);

	const press = () => {
		if (cell === "failed" && retry.current) {
			void publish(retry.current);
			return;
		}
		if (open) close(false);
		else {
			setOpen(true);
			void read();
		}
	};

	// ⌘↵ opens Publish (SPEC 13.9): from the shell, and from the page through its agent (`PUBLISH_OPEN_EVENT`).
	const latest = useRef({ disabled, open });
	latest.current = { disabled, open };
	useEffect(() => {
		const openIt = () => {
			if (latest.current.disabled || latest.current.open) return;
			setOpen(true);
			void read();
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
			if (globalThis.document.querySelector("[data-wc-narrow]")) return;
			// Inside the sheet ⌘↵ is the sheet's own (a note being written).
			if ((event.target as Element | null)?.closest?.("[data-wc-publish-sheet]")) return;
			event.preventDefault();
			openIt();
		};
		globalThis.document.addEventListener("keydown", onKey, true);
		globalThis.document.addEventListener(PUBLISH_OPEN_EVENT, openIt);
		return () => {
			globalThis.document.removeEventListener("keydown", onKey, true);
			globalThis.document.removeEventListener(PUBLISH_OPEN_EVENT, openIt);
		};
	}, [read]);

	const pagePath = data?.page?.path ?? path;
	const actions: SheetActions = {
		publish: () => void publish(),
		close,
		async schedule(at) {
			const items = data?.items ?? [];
			if (items.length === 0) return;
			setBusy(true);
			try {
				const siteId = config.site.id;
				const first = await api.publishing.scheduleAll({ siteId, items, at });
				if (!first.scheduled) {
					await api.publishing.scheduleAll({ siteId, items, at, confirmation: first.confirmation.id });
				}
				close(true);
				const when = new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(at);
				announce(fill(shown.scheduled, { when }));
				void read();
			} catch (error) {
				announce(fill(shown.failed, { reason: refusalText(error, words) }), true);
			} finally {
				setBusy(false);
			}
		},
		async revert(change: ChangeRow) {
			if (!pagePath) return;
			const name = changeText(change, words);
			const answer = await request("undo", { path: pagePath, item: change.item, key: change.key });
			if (answer.ok) {
				announce(fill(shown.reverted, { name }));
				onPublished();
			} else announce(fill(shown.revertFailed, { name, reason: answer.code }), true);
			await read();
			keepFocusInSheet();
		},
		async discard() {
			if (!pagePath) return;
			setBusy(true);
			const answer = await request("discard", { path: pagePath });
			setBusy(false);
			if (answer.ok) {
				announce(shown.discarded);
				onPublished();
			} else announce(fill(shown.failed, { reason: answer.code }), true);
			await read();
			keepFocusInSheet();
		},
		async submit(note) {
			if (!pagePath) return;
			setBusy(true);
			const answer = await request("review/submit", { path: pagePath, note });
			setBusy(false);
			if (answer.ok) {
				close(true);
				announce(shown.review.sent);
				onPublished();
			} else announce(fill(shown.review.failed, { reason: answer.code }), true);
			void read();
		},
		async withdraw() {
			if (!pagePath) return;
			setBusy(true);
			const answer = await request("review/withdraw", { path: pagePath });
			setBusy(false);
			if (answer.ok) {
				announce(shown.review.withdrawn);
				onPublished();
			} else announce(fill(shown.failed, { reason: answer.code }), true);
			await read();
			keepFocusInSheet();
		},
	};

	return (
		<span className="relative inline-flex shrink-0" data-wc-publish-cell="">
			<PublishCell
				ref={button}
				state={state}
				words={words}
				language={language}
				size={size}
				open={open}
				sheetId={sheetId}
				disabled={disabled}
				onPress={press}
			/>
			{open ? (
				<PublishSheet
					id={sheetId}
					words={words}
					language={language}
					data={data}
					failed={failed}
					busy={busy}
					actions={actions}
				/>
			) : null}
			{toast ? (
				<PublishedToast
					key={toast.at}
					live={toast.live}
					words={words}
					onDone={() => setToast((was) => (was?.at === toast.at ? null : was))}
				/>
			) : null}
		</span>
	);
}

/**
 * After a row or a button of the sheet went away (or was off while it acted), focus goes back to the
 * sheet rather than being lost; focus elsewhere in the sheet stays where it is.
 */
function keepFocusInSheet(): void {
	const sheet = document.querySelector<HTMLElement>("[data-wc-publish-sheet]");
	if (sheet && !sheet.contains(document.activeElement)) sheet.focus();
}

/** "Published · View live page" at the top centre (SPEC 10): 5 s, paused while the pointer or focus is on it. */
function PublishedToast({ live, words, onDone }: { live: string | null; words: ShellConfig["words"]; onDone(): void }) {
	const shown = words.publishing;
	const [held, setHeld] = useState(false);
	const latest = useRef(onDone);
	latest.current = onDone;
	useEffect(() => {
		if (held) return;
		const timer = setTimeout(() => latest.current(), TOAST_MS);
		return () => clearTimeout(timer);
	}, [held]);
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: hovering only pauses the toast's timer.
		<div
			className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex justify-center"
			onPointerEnter={() => setHeld(true)}
			onPointerLeave={() => setHeld(false)}
			onFocus={() => setHeld(true)}
			onBlur={() => setHeld(false)}
			data-wc-publish-toast=""
		>
			<div className="border-chrome-hover bg-chrome-menu text-chrome-strong pointer-events-auto flex items-center gap-3 rounded-[10px] border py-2 ps-3 pe-2 text-[14px] font-medium shadow-[0_12px_32px_rgba(0,0,0,0.55)]">
				<CircleCheckIcon aria-hidden="true" className="text-chrome-ok size-[18px] shrink-0" />
				<span>{shown.published}</span>
				{live ? (
					<a
						href={live}
						target="_blank"
						rel="noopener noreferrer"
						className={`bg-chrome-hover text-chrome-strong rounded-[7px] px-3 py-1.5 text-[13px] font-semibold hover:bg-[#34343b] ${CHROME_EASE} ${FOCUS_RING}`}
						data-wc-publish-live=""
					>
						{shown.viewLive}
					</a>
				) : null}
				<button
					type="button"
					aria-label={shown.dismiss}
					onClick={onDone}
					className={`text-chrome-muted hover:text-chrome-strong inline-grid size-6 place-items-center rounded-md ${CHROME_EASE} ${FOCUS_RING}`}
				>
					<XIcon aria-hidden="true" className="size-3.5" />
				</button>
			</div>
		</div>
	);
}
