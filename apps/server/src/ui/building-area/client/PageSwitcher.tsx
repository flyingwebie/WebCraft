import { ChevronUpIcon, FileTextIcon, PlusIcon } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";

import { fill, type ShellConfig } from "../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";
import type { Switchable } from "../DocumentSwitcher.tsx";
import { type GoToData, managementApi } from "../management.ts";
import { reasonOf } from "../places/content/data.ts";

/** What a new Draft is made in: Pages, or one Post Type's Entries. */
type Making = { postTypeId: string; label: string };

/**
 * The page's name on the client bar (SPEC 13.1): it opens, upwards, the Site's Pages and each Post
 * Type's Entries (Go to's, newest first), with "New Page" and "New Entry in …" at the foot. Choosing one
 * opens it on the canvas; a new one asks for its title, is made as a Draft (`entries.create`) and opens.
 * A dialog (it holds a field), with the keys a list has: arrows, Home and End move; Escape closes.
 */
export function PageSwitcher({
	config,
	name,
	current,
	data,
	onOpen,
	announce,
}: {
	config: ShellConfig;
	/** The open page's title. */
	name: string;
	/** The open page's path on the Site, which the list marks. */
	current: string | null;
	/** Go to's Pages and Entries, and the Post Types (null until read). */
	data: Switchable | null;
	onOpen(path: string): void;
	announce(text: string, urgent?: boolean): void;
}) {
	const { words } = config;
	const said = words.client.switcher;
	const api = useMemo(() => managementApi(config.token), [config.token]);
	const [open, setOpen] = useState(false);
	const [making, setMaking] = useState<Making | null>(null);
	const [title, setTitle] = useState("");
	const [busy, setBusy] = useState(false);
	// Read again each time the list opens, so a Page made since is in it.
	const [fresh, setFresh] = useState<GoToData | null>(null);
	const button = useRef<HTMLButtonElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	const field = useRef<HTMLInputElement>(null);
	const id = useId();

	const close = (focusButton: boolean) => {
		setOpen(false);
		setMaking(null);
		setTitle("");
		if (focusButton) button.current?.focus();
	};

	// Focus goes to the open page (else the first choice) as the list opens; a press outside closes it.
	useEffect(() => {
		if (!open) return;
		const choices = [...(panel.current?.querySelectorAll<HTMLElement>("[data-wc-switch]") ?? [])];
		(choices.find((each) => each.getAttribute("aria-current") === "page") ?? choices[0])?.focus();
		const outside = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (target && (panel.current?.contains(target) || button.current?.contains(target))) return;
			setOpen(false);
			setMaking(null);
		};
		document.addEventListener("pointerdown", outside, true);
		return () => document.removeEventListener("pointerdown", outside, true);
	}, [open]);

	useEffect(() => {
		if (making) field.current?.focus();
	}, [making]);

	useEffect(() => {
		if (!open) return;
		let current = true;
		void api.builder
			.commandMenu({ siteId: config.site.id })
			.then((goTo) => {
				if (current) setFresh(goTo);
			})
			.catch(() => {});
		return () => {
			current = false;
		};
	}, [open, api, config.site.id]);

	const pageType = data?.postTypes.find((each) => each.builtIn === "page") ?? null;
	const otherTypes = data?.postTypes.filter((each) => each.builtIn !== "page") ?? [];
	const goTo = fresh ?? data?.goTo ?? null;
	const groups = goTo
		? [
				{ key: "pages", label: said.pages, rows: goTo.pages },
				...goTo.postTypes.map((postType) => ({ key: postType.id, label: postType.name, rows: postType.entries })),
			]
		: [];

	const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			if (making) {
				setMaking(null);
				return;
			}
			close(true);
			return;
		}
		if (making) return;
		const all = [...(panel.current?.querySelectorAll<HTMLElement>("[data-wc-switch], [data-wc-switch-new]") ?? [])];
		const at = all.indexOf(document.activeElement as HTMLElement);
		const to =
			event.key === "ArrowDown"
				? at + 1
				: event.key === "ArrowUp"
					? at - 1
					: event.key === "Home"
						? 0
						: event.key === "End"
							? all.length - 1
							: null;
		if (to === null) return;
		event.preventDefault();
		all[(to + all.length) % all.length]?.focus();
	};

	const create = async (event: FormEvent) => {
		event.preventDefault();
		const chosen = making;
		const wanted = title.trim();
		if (!chosen || !wanted || busy) return;
		setBusy(true);
		try {
			const { entry } = await api.entries.create({
				siteId: config.site.id,
				postTypeId: chosen.postTypeId,
				title: wanted,
			});
			// A Draft has no published address: Go to names the one it would have.
			let path = entry.path;
			if (!path) {
				const goTo = await api.builder.commandMenu({ siteId: config.site.id });
				path =
					[...goTo.pages, ...goTo.postTypes.flatMap((postType) => postType.entries)].find(
						(each) => each.id === entry.id,
					)?.path ?? null;
			}
			announce(fill(words.content.created, { title: entry.draft.title }));
			close(false);
			if (path) onOpen(path);
			else announce(fill(words.content.noAddress, { title: entry.draft.title }), true);
		} catch (error) {
			announce(fill(words.content.createFailed, { reason: reasonOf(error) }), true);
		} finally {
			setBusy(false);
		}
	};

	const row = `text-chrome-text hover:bg-chrome-hover focus:bg-chrome-hover flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 text-start text-[13px] ${FOCUS_RING}`;

	return (
		<div className="relative min-w-0 shrink">
			<button
				ref={button}
				type="button"
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				aria-label={fill(said.button, { page: name })}
				onClick={() => (open ? close(false) : setOpen(true))}
				className={`bg-chrome-raised text-chrome-text hover:bg-chrome-hover flex h-9 max-w-[220px] min-w-0 items-center gap-[7px] rounded-lg px-3 text-[13px] font-medium ${CHROME_EASE} ${FOCUS_RING}`}
				data-wc-page-switcher=""
			>
				<FileTextIcon aria-hidden="true" className="size-4 shrink-0" />
				<span className="truncate">{name}</span>
				<ChevronUpIcon aria-hidden="true" className="text-chrome-muted size-3.5 shrink-0" />
			</button>
			{open ? (
				<div
					ref={panel}
					id={id}
					role="dialog"
					aria-label={said.label}
					onKeyDown={onKey}
					className="border-chrome-hover bg-chrome-menu absolute start-0 bottom-[calc(100%+8px)] z-50 flex max-h-[min(560px,70vh)] w-[320px] flex-col rounded-xl border shadow-[0_12px_32px_rgba(0,0,0,0.55)]"
					data-wc-page-list=""
				>
					<div className="flex min-h-0 flex-col gap-2 overflow-y-auto p-1.5">
						{goTo === null ? (
							<p className="text-chrome-muted m-0 px-2.5 py-2 text-[13px]">{words.content.loading}</p>
						) : null}
						{groups.map((group) => (
							<section key={group.key} aria-label={group.label} className="flex flex-col gap-0.5">
								<h3 className="text-chrome-muted m-0 px-2.5 pt-1 pb-0.5 text-[11px] font-semibold tracking-wide uppercase">
									{group.label}
								</h3>
								{group.rows.length === 0 ? (
									<p className="text-chrome-faint m-0 px-2.5 py-1 text-[12px]">{said.none}</p>
								) : null}
								{group.rows.map((each) => (
									<button
										key={each.id}
										type="button"
										aria-current={each.path === current ? "page" : undefined}
										onClick={() => {
											close(false);
											if (each.path !== current) onOpen(each.path);
										}}
										className={`${row} ${each.path === current ? "text-chrome-strong font-semibold" : ""}`}
										data-wc-switch={each.path}
									>
										<span className="min-w-0 grow truncate">{each.title || words.documents.untitled}</span>
										<span className="text-chrome-muted shrink-0 font-mono text-[11px]">{each.path}</span>
									</button>
								))}
							</section>
						))}
					</div>
					<div className="border-chrome-hover flex shrink-0 flex-col gap-0.5 border-t p-1.5">
						{making ? (
							<form onSubmit={(event) => void create(event)} className="flex flex-col gap-2 p-1" data-wc-switch-form="">
								<label className="text-chrome-text text-[12px] font-medium" htmlFor={`${id}-title`}>
									{making.label}
								</label>
								<input
									ref={field}
									id={`${id}-title`}
									value={title}
									onChange={(event) => setTitle(event.target.value)}
									maxLength={200}
									className={`border-chrome-hover bg-chrome-raised text-chrome-strong h-10 rounded-lg border px-3 text-[14px] ${FOCUS_RING}`}
									data-wc-switch-title=""
								/>
								<div className="flex justify-end gap-2">
									<button
										type="button"
										onClick={() => setMaking(null)}
										className={`text-chrome-text hover:bg-chrome-hover h-9 rounded-lg px-3 text-[13px] font-medium ${FOCUS_RING}`}
									>
										{said.cancel}
									</button>
									<button
										type="submit"
										disabled={busy || !title.trim()}
										className={`h-9 rounded-lg bg-white px-3.5 text-[13px] font-semibold text-[#18181b] disabled:opacity-50 ${FOCUS_RING}`}
										data-wc-switch-create=""
									>
										{busy ? said.creating : said.create}
									</button>
								</div>
							</form>
						) : (
							<>
								{pageType ? (
									<button
										type="button"
										onClick={() => setMaking({ postTypeId: pageType.id, label: said.newPageTitle })}
										className={row}
										data-wc-switch-new="page"
									>
										<PlusIcon aria-hidden="true" className="size-4" />
										{said.newPage}
									</button>
								) : null}
								{otherTypes.map((postType) => (
									<button
										key={postType.id}
										type="button"
										onClick={() =>
											setMaking({ postTypeId: postType.id, label: fill(said.newEntryTitle, { name: postType.name }) })
										}
										className={row}
										data-wc-switch-new={postType.id}
									>
										<PlusIcon aria-hidden="true" className="size-4" />
										{fill(said.newEntry, { name: postType.name })}
									</button>
								))}
							</>
						)}
					</div>
				</div>
			) : null}
		</div>
	);
}
