import type { BuildingAreaApiClient } from "@webcraft/api";
import { LockIcon, PlusIcon, Repeat2Icon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import type { Query } from "../../../content/loop-query.ts";
import { fill, type Words } from "../../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../../controls.tsx";
import { managementApi } from "../../management.ts";
import { useOnPublished, usePublishSources } from "../../publish/sources.ts";
import { Card, Locked } from "../content/post-types/controls.tsx";
import { buttonLook, PlaceIconButton, SidebarLabel } from "../content/ui.tsx";
import { rememberPlace } from "../memory.ts";
import { Place } from "../Place.tsx";
import type { PlaceProps } from "../registry.ts";
import {
	codeOf,
	type DraftChange,
	type LoopRow,
	type Problem,
	problemsOf,
	reasonText,
	useDraftSaver,
	useLoopResult,
	useLoopsData,
} from "./data.ts";
import { ItemsGrid } from "./ItemsGrid.tsx";
import { CheckMenu, ColumnLabel, copyText, Segmented, Select } from "./parts.tsx";
import { QueryForm } from "./QueryForm.tsx";
import { Result } from "./Result.tsx";
import { loopIdOf, placeOf, placingMarkup, printView, readView, resultRows } from "./view.ts";

/**
 * The Loops place (SPEC 8, plan BA-25, `places-assets/08`): three columns. Left, 300 wide: the Saved
 * Loops with "+" (and Site search's built-in Loop, locked), then the open Loop's settings (its name,
 * where its items come from, the Post Types it lists, and Publish). Middle: its definition, as a form
 * (a query's rules, order, limit and offset; a Loop of its own items as a grid) or as the markup that
 * places it. Right, 320 wide: the result, what its Draft lists, where a click on a key copies its
 * binding. Changes save to the Loop's Draft as they are made; pages show a Loop as it was last
 * published. Loops are Structure: a Member is told they are Staff's.
 */
export function LoopsPlace({ config, words, place, view: viewText, documents, leave, announce, onSaving }: PlaceProps) {
	const shown = words.loops;
	const siteId = config.site.id;
	const api = useMemo(() => managementApi(config.token), [config.token]);
	const { data, failed, reload } = useLoopsData(api, siteId);
	const [loops, setLoops] = useState<LoopRow[]>([]);
	useEffect(() => setLoops(data?.loops ?? []), [data]);
	const view = readView(viewText);
	// `loops` alone shows the first Loop, without a history entry of its own.
	const loopId = loopIdOf(place) ?? loops[0]?.id ?? null;
	const loop = loops.find((each) => each.id === loopId) ?? null;
	// The bar's Publish covers the open Loop (BA-12); once something is published, the statuses are read again.
	usePublishSources(loop ? [{ kind: "loop", id: loop.id }] : []);
	useOnPublished(() => {
		void reload();
		setVersion((was) => was + 1);
	});
	const [version, setVersion] = useState(0);
	const { result, failed: resultFailed, read } = useLoopResult(api, siteId, loop?.id ?? null, version);
	const [problems, setProblems] = useState<Problem[]>([]);
	const [failure, setFailure] = useState<string | null>(null);

	useEffect(() => rememberPlace(place, viewText), [place, viewText]);
	// Another Loop: its own problems only.
	// oxlint-disable-next-line react-hooks/exhaustive-deps -- cleared when the Loop shown changes.
	useEffect(() => {
		setProblems([]);
		setFailure(null);
	}, [loopId]);

	const replaced = useCallback((saved: LoopRow) => {
		setLoops((was) => was.map((each) => (each.id === saved.id ? saved : each)));
		setVersion((was) => was + 1);
	}, []);

	const save = useDraftSaver(async (change: DraftChange) => {
		onSaving("saving");
		try {
			const { loop: saved } = await api.loops.saveDraft(change);
			replaced(saved as LoopRow);
			setProblems([]);
			setFailure(null);
			onSaving("saved");
		} catch (error) {
			onSaving("failed");
			setProblems(problemsOf(error));
			setFailure(fill(shown.saveFailed, { reason: reasonText(words, error) }));
			announce(fill(shown.saveFailed, { reason: reasonText(words, error) }), true);
		}
	});

	const open = (id: string) => documents.openPlace(placeOf(id), viewText);

	if (failed && codeOf(failed) === "FORBIDDEN") {
		return (
			<Place words={words} title={words.places.loops} backTo={null} onBack={leave} place={place}>
				<div className="grid grow place-items-center p-8" data-wc-loops-staff-only="">
					<p className="text-chrome-muted m-0 max-w-sm text-center text-[12px]">{shown.staffOnly}</p>
				</div>
			</Place>
		);
	}

	return (
		<Place
			words={words}
			title={words.places.loops}
			backTo={null}
			onBack={leave}
			place={place}
			shape="columns"
			sidebarLabel={shown.listLabel}
			sidebar={
				<LoopList
					words={words}
					api={api}
					siteId={siteId}
					loops={loops}
					current={loop?.id ?? null}
					ready={data !== null}
					failed={failed}
					onOpen={open}
					onCreated={async (made) => {
						announce(fill(shown.created, { name: made.name }));
						await reload();
						open(made.id);
					}}
				/>
			}
			sidebarFoot={
				loop ? (
					<LoopSettings
						key={loop.id}
						words={words}
						loop={loop}
						postTypes={data?.postTypes ?? []}
						onSave={(change) => save({ siteId, loopId: loop.id, ...change })}
					/>
				) : null
			}
		>
			<div className="flex min-h-0 grow gap-2" data-wc-loops-columns="">
				<div aria-hidden="true" className="bg-chrome-line w-px shrink-0" />
				{loop ? (
					<section
						aria-labelledby="wc-loop-definition"
						className="flex min-h-0 min-w-0 grow flex-col gap-2.5 overflow-hidden p-2"
						data-wc-loop-definition={loop.draft.source}
					>
						<div className="flex items-center gap-2">
							<ColumnLabel id="wc-loop-definition">{shown.definition}</ColumnLabel>
							<Segmented
								label={shown.showAs}
								value={view.mode}
								choices={[
									{ key: "form", label: shown.form },
									{ key: "markup", label: shown.markup },
								]}
								onChange={(mode) => documents.setView(printView({ mode }))}
							/>
						</div>
						<div className="bg-chrome-raised flex min-h-0 grow flex-col gap-3 overflow-y-auto rounded-[10px] p-3">
							{failure ? (
								<p role="alert" className="text-chrome-danger m-0 text-[12px]" data-wc-loop-failure="">
									{failure}
								</p>
							) : null}
							{view.mode === "markup" ? (
								<MarkupView
									words={words}
									loop={loop}
									bindings={
										result?.value.items[0]
											? resultRows(result.value.items[0].values)
													.filter((row) => !row.binding.startsWith("{{@"))
													.slice(0, 3)
													.map((row) => row.binding)
											: []
									}
									announce={announce}
								/>
							) : loop.draft.source === "query" ? (
								<QueryForm
									// One form per Loop: a change still waiting is saved to its own Loop as another opens.
									key={loop.id}
									words={words}
									admin={config.adminMessages}
									api={api}
									siteId={siteId}
									loopName={loop.name}
									query={loop.draft.query as Query}
									postTypes={data?.postTypes ?? []}
									problems={problems}
									onSave={(query) => save({ siteId, loopId: loop.id, query })}
								/>
							) : (
								<ItemsGrid
									key={loop.id}
									words={words}
									api={api}
									siteId={siteId}
									loop={loop}
									admin={`${config.admin}/loops/${loop.id}`}
									onSaved={replaced}
									onSaving={onSaving}
									announce={announce}
								/>
							)}
						</div>
					</section>
				) : (
					<div className="flex min-w-0 grow">
						{data && loops.length === 0 ? (
							<p className="text-chrome-muted m-auto text-[12px]">{shown.none}</p>
						) : failed ? (
							<p role="alert" className="text-chrome-danger m-auto text-[12px]">
								{fill(shown.loadFailed, { reason: reasonText(words, failed) })}
							</p>
						) : null}
					</div>
				)}
				<div aria-hidden="true" className="bg-chrome-line w-px shrink-0" />
				{loop ? (
					<Result
						words={words}
						loopId={loop.id}
						result={result}
						failed={resultFailed}
						limit={loop.draft.source === "query" ? loop.draft.query.limit : null}
						onRead={() => void read()}
						announce={announce}
					/>
				) : (
					<div className="w-[320px] shrink-0" />
				)}
			</div>
		</Place>
	);
}

/** The Saved Loops: one row each (the open one raised, in the Loop's colour), "+" for a new one, and Site search's built-in Loop. */
function LoopList({
	words,
	api,
	siteId,
	loops,
	current,
	ready,
	failed,
	onOpen,
	onCreated,
}: {
	words: Words;
	api: BuildingAreaApiClient;
	siteId: string;
	loops: readonly LoopRow[];
	current: string | null;
	ready: boolean;
	failed: unknown;
	onOpen(id: string): void;
	onCreated(loop: LoopRow): Promise<void>;
}) {
	const shown = words.loops;
	const [creating, setCreating] = useState(false);
	const [name, setName] = useState("");
	const [problem, setProblem] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	const plus = useRef<HTMLButtonElement>(null);
	const id = useId();

	useEffect(() => {
		if (creating) input.current?.focus();
	}, [creating]);

	const create = async () => {
		const wanted = name.trim();
		if (!wanted || busy) return;
		setBusy(true);
		try {
			const { loop } = await api.loops.create({ siteId, name: wanted, source: "query" });
			setCreating(false);
			setName("");
			setProblem(null);
			await onCreated(loop as LoopRow);
		} catch (error) {
			const atName = problemsOf(error).some((each) => each.at === "name");
			setProblem(atName ? shown.reasons.name : reasonText(words, error));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-col pb-1">
			<SidebarLabel
				add={
					<PlaceIconButton
						icon={PlusIcon}
						label={shown.newLoop}
						onClick={() => (creating ? input.current?.focus() : setCreating(true))}
						buttonRef={plus}
						data={{ "data-wc-loop-new": "" }}
					/>
				}
			>
				{shown.savedLoops}
			</SidebarLabel>
			{creating ? (
				<div className="flex flex-col gap-1 px-2 pb-1.5" data-wc-loop-create="">
					<span className="flex items-center gap-1.5">
						<input
							ref={input}
							type="text"
							value={name}
							placeholder="latest-posts"
							aria-label={shown.newName}
							aria-describedby={`${id}-help${problem ? ` ${id}-problem` : ""}`}
							aria-invalid={problem ? true : undefined}
							onChange={(event) => setName(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									void create();
								} else if (event.key === "Escape") {
									// The create row closes; the place stays open.
									event.preventDefault();
									event.stopPropagation();
									setCreating(false);
									setProblem(null);
									plus.current?.focus();
								}
							}}
							className={`border-chrome-hover bg-chrome-raised text-chrome-strong placeholder:text-chrome-muted h-[30px] min-w-0 grow rounded-md border px-2 font-mono text-[12px] ${FOCUS_RING}`}
						/>
						<button
							type="button"
							disabled={busy || !name.trim()}
							onClick={() => void create()}
							className={buttonLook("primary")}
						>
							{shown.create}
						</button>
					</span>
					<p id={`${id}-help`} className="text-chrome-muted m-0 text-[11px]">
						{shown.newNameHelp}
					</p>
					{problem ? (
						<p id={`${id}-problem`} role="alert" className="text-chrome-danger m-0 text-[11px]">
							{problem}
						</p>
					) : null}
				</div>
			) : null}
			<ul className="m-0 flex list-none flex-col gap-0.5 p-0" data-wc-loop-list="">
				{loops.map((each) => {
					const here = each.id === current;
					return (
						<li key={each.id}>
							<button
								type="button"
								onClick={() => onOpen(each.id)}
								aria-current={here ? "page" : undefined}
								className={`flex h-[31px] w-full items-center gap-2 rounded-md px-2 text-start text-[12px] font-medium ${
									here
										? "bg-chrome-raised text-chrome-strong"
										: "text-chrome-muted hover:bg-chrome-raised hover:text-chrome-text"
								} ${CHROME_EASE} ${FOCUS_RING}`}
								data-wc-loop-row={each.name}
							>
								<Repeat2Icon aria-hidden="true" className={`size-3.5 shrink-0 ${here ? "text-loop" : ""}`} />
								<span className="min-w-0 grow truncate">{each.name}</span>
								{each.status !== "published" ? (
									<span
										aria-hidden="true"
										className={`size-1.5 shrink-0 rounded-full ${each.status === "draft" ? "bg-chrome-warn" : "bg-[#93c5fd]"}`}
									/>
								) : null}
								<span className="sr-only">
									{` · ${each.status === "published" ? words.content.status.published : each.status === "draft" ? words.content.status.draft : words.content.status.changed}`}
								</span>
							</button>
						</li>
					);
				})}
				{ready ? (
					<li
						className="text-chrome-muted flex h-[31px] items-center gap-2 px-2 text-[12px] font-medium"
						title={shown.builtInHelp}
						data-wc-loop-built-in="search"
					>
						<LockIcon aria-hidden="true" className="size-3.5 shrink-0" />
						<span className="min-w-0 grow truncate">{shown.builtIn}</span>
						<code className="text-chrome-muted font-mono text-[11px]">search</code>
						<span className="sr-only">{` · ${shown.builtInHelp}`}</span>
					</li>
				) : null}
			</ul>
			{ready && loops.length === 0 && !creating ? (
				<p className="text-chrome-muted m-0 px-2 py-1 text-[12px]">{shown.none}</p>
			) : null}
			{failed && !ready ? (
				<p role="alert" className="text-chrome-danger m-0 px-2 py-1 text-[12px]">
					{fill(shown.loadFailed, { reason: reasonText(words, failed) })}
				</p>
			) : null}
		</div>
	);
}

/**
 * The open Loop's settings: its name (locked), where its items come from, the Post Types a query lists,
 * and its status. The bar's Publish publishes it (BA-12).
 */
function LoopSettings({
	words,
	loop,
	postTypes,
	onSave,
}: {
	words: Words;
	loop: LoopRow;
	postTypes: readonly { key: string; name: string }[];
	onSave(change: Omit<DraftChange, "siteId" | "loopId">): void;
}) {
	const shown = words.loops;
	const id = useId();
	const query = loop.draft.query;
	const listed = postTypes.filter((postType) => query.postTypes.includes(postType.key));

	const status =
		loop.status === "published"
			? words.content.status.published
			: loop.status === "draft"
				? words.content.status.draft
				: words.content.status.changed;

	return (
		<div className="flex min-h-0 grow flex-col overflow-y-auto" data-wc-loop-settings="">
			<div className="py-2">
				<div aria-hidden="true" className="bg-chrome-line h-px" />
			</div>
			<SidebarLabel>{shown.settings}</SidebarLabel>
			<div className="flex flex-col gap-2.5 px-2 pt-1 pb-2">
				<Card label={shown.name}>
					<Locked value={loop.name} why={shown.nameLocked} mono />
				</Card>
				<Card label={shown.itemsFrom} htmlFor={`${id}-source`}>
					<Select
						id={`${id}-source`}
						bare
						value={loop.draft.source}
						onChange={(event) => onSave({ source: event.target.value === "items" ? "items" : "query" })}
						className="w-full"
						data-wc-loop-source=""
					>
						<option value="query">{shown.fromQuery}</option>
						<option value="items">{shown.fromItems}</option>
					</Select>
				</Card>
				{loop.draft.source === "query" ? (
					<Card label={shown.postTypes}>
						<CheckMenu
							bare
							label={shown.postTypesMenu}
							shown={listed.map((postType) => postType.name).join(", ") || shown.postTypesNone}
							checks={postTypes.map((postType) => ({
								key: postType.key,
								label: postType.name,
								checked: query.postTypes.includes(postType.key),
							}))}
							onToggle={(key, checked) =>
								onSave({
									query: {
										...query,
										postTypes: checked ? [...query.postTypes, key] : query.postTypes.filter((each) => each !== key),
									},
								})
							}
							data={{ "data-wc-loop-post-types": "" }}
						/>
					</Card>
				) : null}
				<Card label={shown.status}>
					<SettingsRow>
						<span
							className="text-chrome-strong min-w-0 grow truncate text-[12px] font-medium"
							data-wc-loop-status={loop.status}
						>
							{status}
						</span>
					</SettingsRow>
					{loop.status !== "published" ? (
						<p className="text-chrome-muted m-0 text-[11px]" data-wc-loop-publish-help="">
							{shown.publishHelp}
						</p>
					) : null}
				</Card>
			</div>
		</div>
	);
}

function SettingsRow({ children }: { children: ReactNode }) {
	return <span className="flex min-w-0 items-center gap-2">{children}</span>;
}

/** The definition as markup: what places the Loop in a Template or Component, with Copy. */
function MarkupView({
	words,
	loop,
	bindings,
	announce,
}: {
	words: Words;
	loop: LoopRow;
	bindings: readonly string[];
	announce(text: string, urgent?: boolean): void;
}) {
	const shown = words.loops;
	const markup = placingMarkup(loop.name, {
		bindings,
		emptyText: shown.noItems,
		paginate: loop.draft.source === "query" && loop.draft.query.paginate,
	});
	return (
		<div className="flex flex-col gap-3" data-wc-loop-markup="">
			<div className="flex items-center gap-2">
				<p className="text-chrome-muted m-0 grow text-[12px]">{shown.markupIntro}</p>
				<button
					type="button"
					onClick={async () =>
						(await copyText(markup)) ? announce(shown.copiedMarkup) : announce(shown.copyFailed, true)
					}
					className={buttonLook("outline")}
				>
					{shown.copyMarkup}
				</button>
			</div>
			<pre
				className="bg-chrome-well text-chrome-text m-0 overflow-x-auto rounded-md p-3 font-mono text-[12px] leading-5"
				// oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the markup scrolls sideways; the keyboard reaches it.
				tabIndex={0}
			>
				{markup}
			</pre>
			<p className="text-chrome-muted m-0 text-[11px]">
				<code className="font-mono">{`{{ ${loop.name}.count }}`}</code>
				{" · "}
				<code className="font-mono">{`{{@if ${loop.name}.empty}}`}</code>
				{" · "}
				<code className="font-mono">{"{{ loop.index }}"}</code>
			</p>
		</div>
	);
}
