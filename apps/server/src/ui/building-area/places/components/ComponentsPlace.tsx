import { PlusIcon, SearchIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { fill, type Words } from "../../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../../controls.tsx";
import { Badge, buttonLook } from "../content/ui.tsx";
import { rememberPlace, rememberScroll, scrollOf } from "../memory.ts";
import { Place } from "../Place.tsx";
import type { PlaceProps } from "../registry.ts";
import { ComponentDetails } from "./ComponentDetails.tsx";
import { DeleteComponentDialog, type DeletingComponent } from "./DeleteComponentDialog.tsx";
import { type ComponentRow, counted, reasonText, useComponentsData } from "./data.ts";
import {
	type ComponentsFilter,
	type ComponentsView,
	copyName,
	printComponentsView,
	readComponentsView,
	tagOf,
	viewComponents,
} from "./view.ts";

const FILTERS: readonly ComponentsFilter[] = ["all", "allowed", "unused"];

/**
 * The Components place (SPEC 8, `places-content/05`): a card grid with search and New Component in the
 * header, the filters All · Allowed for Members · Unused (words: they only filter), and the chosen
 * Component's details at the place's end (Props, the Allowed for Members switch, where it is used,
 * Edit, Duplicate, Delete). Each card has a picture, the name, "on N pages", Draft and Allowed. The
 * filter, the search and the chosen Component are in the address (`wc-view`), so Back and a reload
 * keep them. Edit opens the Component as the document: in place on a page that shows it, else on
 * its own canvas. Delete asks in a dialog that names where it is used, and removes every Placement.
 */
export function ComponentsPlace(props: PlaceProps) {
	const { config, words, place, view, documents, leave, open, announce, onSaving } = props;
	const shown = words.components;
	const { data, failed, reload, setAllowed, api } = useComponentsData(config.token, config.site.id);
	const scroller = useRef<HTMLDivElement>(null);
	const restored = useRef(false);
	const current = readComponentsView(view);
	const [creating, setCreating] = useState(false);
	const [busy, setBusy] = useState<"duplicate" | null>(null);
	const [deleting, setDeleting] = useState<DeletingComponent | null>(null);
	const deleteButton = useRef<HTMLButtonElement>(null);

	useEffect(() => rememberPlace(place, view), [place, view]);
	useEffect(() => {
		if (!data || restored.current || !scroller.current) return;
		restored.current = true;
		scroller.current.scrollTop = scrollOf(place, view);
	}, [data, place, view]);

	const setView = useCallback(
		(next: ComponentsView, how: "push" | "replace") => documents.setView(printComponentsView(next), how),
		[documents],
	);

	const ready = data && !("forbidden" in data) ? data : null;
	const items = useMemo(
		() => (ready ? ready.components.map((each) => ({ ...each, placed: each.usage.usedIn.length > 0 })) : []),
		[ready],
	);
	const visible = ready ? viewComponents(items, current, ready.allowed) : [];
	const chosen =
		(current.component ? items.find((each) => each.id === current.component) : undefined) ?? visible[0] ?? null;

	const create = useCallback(
		async (name: string): Promise<string | null> => {
			try {
				const { component } = await api.components.create({ siteId: config.site.id, name });
				announce(fill(shown.created, { name: component.name }));
				setCreating(false);
				open({ kind: "component", componentId: component.id });
				return null;
			} catch (error) {
				return reasonText(words, error);
			}
		},
		[api, config.site.id, announce, open, shown, words],
	);

	const changeAllowed = useCallback(
		async (component: ComponentRow, allowed: boolean) => {
			if (!ready) return;
			const next = allowed
				? [...new Set([...ready.allowed, component.id])]
				: [...ready.allowed].filter((id) => id !== component.id);
			onSaving("saving");
			setAllowed(next);
			try {
				const settings = await api.pageLayouts.configure({ siteId: config.site.id, allowedComponents: next });
				setAllowed(settings.allowedComponents);
				onSaving("saved");
				announce(fill(allowed ? shown.allowedOn : shown.allowedOff, { name: component.name }));
			} catch (error) {
				setAllowed([...ready.allowed]);
				onSaving("failed");
				announce(fill(shown.allowedFailed, { name: component.name, reason: reasonText(words, error) }), true);
			}
		},
		[ready, api, config.site.id, setAllowed, onSaving, announce, shown, words],
	);

	const duplicate = useCallback(
		async (component: ComponentRow) => {
			if (!ready || busy) return;
			setBusy("duplicate");
			onSaving("saving");
			try {
				const siteId = config.site.id;
				const { component: full } = await api.components.get({ siteId, componentId: component.id });
				const name = copyName(full.name, new Set(ready.components.map((each) => each.name)));
				const { component: copy } = await api.components.create({ siteId, name, props: full.draft.props });
				await api.components.saveDraft({ siteId, componentId: copy.id, tree: full.draft.tree });
				const { script } = await api.components.getScript({ siteId, componentId: component.id });
				if (script)
					await api.components.saveScriptDraft({
						siteId,
						componentId: copy.id,
						code: script.draft.code,
						consentCategory: script.draft.consentCategory,
						libraryIds: script.draft.libraryIds,
					});
				await reload();
				setView({ ...current, filter: "all", q: "", component: copy.id }, "replace");
				onSaving("saved");
				announce(fill(shown.duplicated, { name }));
			} catch (error) {
				onSaving("failed");
				announce(fill(shown.duplicateFailed, { name: component.name, reason: reasonText(words, error) }), true);
			} finally {
				setBusy(null);
			}
		},
		[ready, busy, api, config.site.id, reload, setView, current, onSaving, announce, shown, words],
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
			<>
				<fieldset className="m-0 flex h-11 min-w-0 shrink-0 items-center gap-1.5 border-0 px-4 py-0">
					<legend className="sr-only">{shown.filters}</legend>
					{FILTERS.map((filter) => {
						const on = current.filter === filter;
						return (
							<button
								key={filter}
								type="button"
								aria-pressed={on}
								onClick={() => setView({ ...current, filter }, "push")}
								className={`border-chrome-hover inline-flex h-[33px] items-center rounded-md border px-3.5 text-[12px] font-medium ${
									on
										? "bg-chrome-raised text-chrome-strong"
										: "text-chrome-muted hover:bg-chrome-raised hover:text-chrome-text"
								} ${CHROME_EASE} ${FOCUS_RING}`}
								data-wc-component-filter={filter}
							>
								{shown[filter]}
							</button>
						);
					})}
				</fieldset>
				<div
					ref={scroller}
					className="min-h-0 grow overflow-y-auto px-4 py-2"
					onScroll={(event) => rememberScroll(place, view, event.currentTarget.scrollTop)}
					data-wc-place-scroll=""
				>
					{creating ? <NewComponent words={words} onCreate={create} onCancel={() => setCreating(false)} /> : null}
					{visible.length === 0 ? (
						<p className="text-chrome-muted m-0 py-2 text-[12px]">{items.length === 0 ? shown.none : shown.noMatch}</p>
					) : (
						<ul
							aria-label={shown.list}
							className="m-0 flex list-none flex-wrap items-start gap-4 p-0"
							data-wc-component-grid=""
						>
							{visible.map((component) => (
								<li key={component.id}>
									<ComponentCard
										words={words}
										language={config.language}
										component={component}
										allowed={ready?.allowed.has(component.id) ?? false}
										chosen={chosen?.id === component.id}
										onChoose={() => setView({ ...current, component: component.id }, "replace")}
										onEdit={() => {
											if (!component.module) open({ kind: "component", componentId: component.id });
										}}
									/>
								</li>
							))}
						</ul>
					)}
				</div>
			</>
		);
	}

	const actions =
		ready !== null ? (
			<>
				<label className="relative flex h-[30px] w-[220px] items-center">
					<SearchIcon aria-hidden="true" className="text-chrome-muted pointer-events-none absolute start-2 size-3.5" />
					<span className="sr-only">{shown.searchLabel}</span>
					<input
						type="search"
						value={current.q}
						placeholder={shown.search}
						onChange={(event) => setView({ ...current, q: event.target.value }, "replace")}
						className="bg-chrome-raised text-chrome-strong placeholder:text-chrome-muted focus-visible:ring-chrome-focus h-full w-full min-w-0 rounded-md ps-7 pe-2 text-[12px] font-medium outline-none focus-visible:ring-2"
						data-wc-component-search=""
					/>
				</label>
				<button
					type="button"
					onClick={() => setCreating(true)}
					className={`${buttonLook("primary")} h-[30px] w-[150px]`}
					data-wc-component-new=""
				>
					<PlusIcon aria-hidden="true" className="size-3.5" />
					{shown.new}
				</button>
			</>
		) : undefined;

	const aside =
		ready && chosen ? (
			<aside
				aria-label={fill(shown.details, { name: chosen.name })}
				className="border-chrome-line flex w-[300px] shrink-0 flex-col gap-3 overflow-y-auto border-s p-4"
				data-wc-component-details={chosen.id}
			>
				<ComponentDetails
					words={words}
					component={chosen}
					allowed={ready.allowed.has(chosen.id)}
					goTo={ready.goTo}
					busy={busy}
					onAllowed={(allowed) => void changeAllowed(chosen, allowed)}
					onEdit={() => open({ kind: "component", componentId: chosen.id })}
					onDuplicate={() => void duplicate(chosen)}
					onDelete={() => setDeleting({ id: chosen.id, name: chosen.name })}
					deleteRef={deleteButton}
				/>
			</aside>
		) : undefined;

	return (
		<Place
			words={words}
			title={words.places.components}
			backTo={null}
			onBack={leave}
			actions={actions}
			aside={aside}
			place={place}
		>
			{body}
			{deleting && ready ? (
				<DeleteComponentDialog
					words={words}
					language={config.language}
					api={api}
					siteId={config.site.id}
					component={deleting}
					goTo={ready.goTo}
					onClose={() => {
						setDeleting(null);
						deleteButton.current?.focus();
					}}
					onDeleted={() => {
						const name = deleting.name;
						setDeleting(null);
						setView({ ...current, component: null }, "replace");
						void reload().then(() => {
							announce(fill(shown.deleted, { name }));
							// Its card is gone: focus goes to the first card left, else to the search.
							(
								document.querySelector<HTMLElement>("[data-wc-component-card]") ??
								document.querySelector<HTMLElement>("[data-wc-component-search]")
							)?.focus();
						});
					}}
				/>
			) : null}
		</Place>
	);
}

/** A Component's card (200 wide): its picture, its name, on how many pages it shows, Draft and Allowed. */
function ComponentCard({
	words,
	language,
	component,
	allowed,
	chosen,
	onChoose,
	onEdit,
}: {
	words: Words;
	language: string;
	component: ComponentRow;
	allowed: boolean;
	chosen: boolean;
	onChoose(): void;
	onEdit(): void;
}) {
	const shown = words.components;
	const bar = "bg-chrome-hover rounded-[2px]";
	return (
		<button
			type="button"
			aria-pressed={chosen}
			onClick={onChoose}
			onDoubleClick={onEdit}
			className={`flex w-[200px] flex-col gap-2 rounded-[10px] border p-2.5 text-start ${
				chosen ? "bg-chrome-raised border-selection" : "hover:bg-chrome-raised border-transparent"
			} ${CHROME_EASE} ${FOCUS_RING}`}
			data-wc-component-card={component.id}
		>
			<span
				aria-hidden="true"
				className="bg-chrome-raised border-chrome-hover flex h-[120px] w-full flex-col gap-1.5 overflow-hidden rounded-md border p-3"
			>
				<span className={`${bar} h-1.5 w-9`} />
				<span className="bg-chrome-hover h-11 w-full rounded" />
				<span className={`${bar} h-2 w-[70px]`} />
			</span>
			<span className="text-chrome-strong text-[13px] font-semibold" data-wc-component-name="">
				{component.name}
			</span>
			<span className="flex flex-wrap items-center gap-1.5">
				<span className="text-chrome-muted text-[11px]">{counted(shown.onPages, component.usage.pages, language)}</span>
				{component.status === "draft" && !component.module ? <Badge kind="draft">{shown.draftBadge}</Badge> : null}
				{allowed ? <Badge kind="info">{shown.allowedBadge}</Badge> : null}
				{component.module ? <Badge kind="neutral">{shown.moduleBadge}</Badge> : null}
			</span>
		</button>
	);
}

/** The card that makes a Component: its name (words, or a tag), Enter makes it and opens it. */
function NewComponent({
	words,
	onCreate,
	onCancel,
}: {
	words: Words;
	onCreate(name: string): Promise<string | null>;
	onCancel(): void;
}) {
	const shown = words.components;
	const [typed, setTyped] = useState("");
	const [problem, setProblem] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	const id = useId();
	const tag = tagOf(typed);

	useEffect(() => {
		input.current?.focus();
	}, []);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!tag || busy) return;
		setBusy(true);
		const refused = await onCreate(tag);
		setBusy(false);
		setProblem(refused);
		if (refused) input.current?.focus();
	};

	return (
		<form
			onSubmit={(event) => void submit(event)}
			className="bg-chrome-raised mb-4 flex w-full max-w-[640px] flex-wrap items-center gap-2 rounded-[10px] p-2.5"
			data-wc-component-create=""
		>
			<label htmlFor={id} className="sr-only">
				{shown.newName}
			</label>
			<input
				ref={input}
				id={id}
				value={typed}
				onChange={(event) => {
					setTyped(event.target.value);
					setProblem(null);
				}}
				onKeyDown={(event) => {
					if (event.key !== "Escape") return;
					event.preventDefault();
					event.stopPropagation();
					onCancel();
				}}
				placeholder={shown.newPlaceholder}
				autoComplete="off"
				spellCheck={false}
				aria-invalid={problem ? true : undefined}
				aria-describedby={`${id}-help${problem ? ` ${id}-problem` : ""}`}
				className="bg-chrome text-chrome-strong placeholder:text-chrome-muted focus-visible:ring-chrome-focus h-8 min-w-0 grow rounded-md px-2 text-[12px] font-medium outline-none focus-visible:ring-2"
			/>
			<span className="text-chrome-muted font-mono text-[11px]" data-wc-component-tag="">
				{tag ? fill(shown.tag, { tag: `<${tag} />` }) : null}
			</span>
			<button type="submit" disabled={!tag || busy} className={buttonLook("primary")}>
				{busy ? shown.creating : `${shown.create} ↵`}
			</button>
			<button type="button" onClick={onCancel} className={buttonLook("quiet")}>
				{shown.cancelNew}
			</button>
			<p id={`${id}-help`} className="text-chrome-muted m-0 w-full text-[11px]">
				{shown.newHelp}
			</p>
			{problem ? (
				<p id={`${id}-problem`} role="alert" className="text-chrome-danger m-0 w-full text-[11px]">
					{fill(shown.createFailed, { reason: problem })}
				</p>
			) : null}
		</form>
	);
}
