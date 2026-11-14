import { FileIcon, FileTextIcon, GlobeIcon, ListIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef } from "react";

import { fill } from "../../api.ts";
import type { PostTypeRow } from "../../management.ts";
import { rememberPlace, rememberScroll, scrollOf } from "../memory.ts";
import { Place, PlaceLater } from "../Place.tsx";
import type { PlaceProps } from "../registry.ts";
import { type ContentEntry, reasonOf, useContentData } from "./data.ts";
import { EntriesGrid, type GridPostType } from "./EntriesGrid.tsx";
import { GlobalsForm } from "./GlobalsForm.tsx";
import { MemberList } from "./MemberList.tsx";
import { AddIcon, Badge, PlaceIconButton, SidebarLabel, SidebarRow } from "./ui.tsx";
import { type ContentView, printView, readView } from "./view.ts";

/** What the Content place's address (`content/…`) opens. */
type Part =
	| { kind: "entries"; postTypeId: string | "pages" }
	| { kind: "postTypes" }
	| { kind: "globals"; group: string | null };

function partOf(place: string): Part {
	const rest = place.slice("content/".length);
	if (rest === "post-types") return { kind: "postTypes" };
	if (rest === "globals") return { kind: "globals", group: null };
	if (rest.startsWith("globals/")) return { kind: "globals", group: rest.slice("globals/".length) };
	return { kind: "entries", postTypeId: rest };
}

/** A Post Type as the lists need it. */
function gridType(postType: PostTypeRow): GridPostType {
	return { id: postType.id, name: postType.name, pages: postType.builtIn === "page", urlPattern: postType.urlPattern };
}

/**
 * The Content place (SPEC 8 and 13.6; `places-content/01`, `client-flows/02`): an inner sidebar of
 * 256 with Pages and each Post Type (with how many Entries each has), the Globals ("Site details" for
 * a Member, by their Groups) and, for Staff, Post Types (BA-21 fills it); beside it the open list
 * (Staff: the grid; Members: their list with tabs) or the Globals as a form. Its list's search,
 * filters and sorting are in the address (`wc-view`), so Back restores them; reopening the place
 * returns to the same list and scroll (`memory.ts`).
 */
export function ContentPlace(props: PlaceProps) {
	const { config, words, place, view, documents, documentName, leave, open, announce, onSaving } = props;
	const { data, failed, reload, setGlobals, api } = useContentData(config.token, config.site.id);
	const shown = words.content;
	const part = partOf(place);
	const scroller = useRef<HTMLDivElement>(null);
	const restored = useRef<string | null>(null);

	useEffect(() => rememberPlace(place, view), [place, view]);

	// The list's scroll: where it was left, once there is something to scroll; remembered as it moves.
	const scrollKey = `${place}?${view ?? ""}`;
	useLayoutEffect(() => {
		if (!data || restored.current === scrollKey || !scroller.current) return;
		restored.current = scrollKey;
		scroller.current.scrollTop = scrollOf(place, view);
	}, [data, scrollKey, place, view]);

	const pagesType = data?.postTypes.find((postType) => postType.builtIn === "page") ?? null;
	const staff = data?.staff ?? false;

	const goTo = useCallback((next: string) => documents.openPlace(next), [documents]);

	const onCreate = useCallback(
		async (postType: GridPostType, title: string): Promise<boolean> => {
			try {
				const { entry } = await api.entries.create({ siteId: config.site.id, postTypeId: postType.id, title });
				const addresses = await reload();
				const path = entry.path ?? addresses.get(entry.id) ?? null;
				announce(fill(shown.created, { title: entry.draft.title }));
				if (path) open({ kind: "page", page: path });
				else announce(fill(shown.noAddress, { title: entry.draft.title }), true);
				return true;
			} catch (error) {
				announce(fill(shown.createFailed, { reason: reasonOf(error) }), true);
				return false;
			}
		},
		[api, config.site.id, reload, announce, open, shown],
	);

	const openEntry = useCallback(
		(entry: ContentEntry) => {
			if (entry.address) open({ kind: "page", page: entry.address });
		},
		[open],
	);

	const sidebar = data ? (
		<div className="flex flex-col">
			<div className="flex flex-col gap-0.5 p-2" data-wc-content-lists="">
				{staff ? <SidebarLabel>{shown.sections}</SidebarLabel> : null}
				{data.postTypes.map((postType) => {
					const key = postType.builtIn === "page" ? "pages" : postType.id;
					return (
						<SidebarRow
							key={postType.id}
							icon={postType.builtIn === "page" ? FileIcon : FileTextIcon}
							label={postType.builtIn === "page" ? shown.pages : postType.name}
							count={data.entries.get(postType.id)?.length ?? null}
							current={part.kind === "entries" && part.postTypeId === key}
							onOpen={() => goTo(`content/${key}`)}
							data={{ "data-wc-content-row": key }}
						/>
					);
				})}
			</div>
			<hr className="border-chrome-line m-0 border-t" />
			{staff ? (
				<>
					<div className="p-2">
						<SidebarRow
							icon={GlobeIcon}
							label={shown.globals}
							current={part.kind === "globals"}
							onOpen={() => goTo("content/globals")}
							data={{ "data-wc-content-row": "globals" }}
						/>
					</div>
					<hr className="border-chrome-line m-0 border-t" />
					<div className="p-2">
						<SidebarLabel
							badge={<Badge kind="neutral">{shown.staffOnly}</Badge>}
							add={
								<PlaceIconButton
									icon={AddIcon}
									label={shown.newPostType}
									unavailable={words.unavailable}
									data={{ "data-wc-new-post-type": "" }}
								/>
							}
						>
							{shown.postTypes}
						</SidebarLabel>
					</div>
				</>
			) : (
				<MemberDetails
					globals={data.globals}
					current={part.kind === "globals" ? (part.group ?? "") : null}
					label={shown.siteDetails}
					allDetails={shown.allDetails}
					onOpen={(group) => goTo(group ? `content/globals/${group}` : "content/globals")}
				/>
			)}
		</div>
	) : null;

	let pane: ReactNode;
	if (failed) {
		pane = (
			<p role="alert" className="text-chrome-danger m-0 p-5 text-[12px]">
				{fill(shown.loadFailed, { reason: failed })}
			</p>
		);
	} else if (!data) {
		pane = (
			<p role="status" className="text-chrome-muted m-0 p-5 text-[12px]">
				{shown.loading}
			</p>
		);
	} else if (part.kind === "postTypes") {
		pane = staff ? <PlaceLater words={words} admin={`${config.admin}/post-types`} /> : null;
	} else if (part.kind === "globals") {
		const group =
			part.group && data.globals?.fields.some((field) => field.key === part.group && field.type === "group")
				? part.group
				: null;
		const title = group
			? (data.globals?.fields.find((field) => field.key === group)?.label ?? shown.globals)
			: staff
				? shown.globals
				: shown.siteDetails;
		pane = data.globals ? (
			<GlobalsForm
				key={group ?? ""}
				words={words}
				api={api}
				siteId={config.site.id}
				globals={data.globals}
				group={group}
				title={title}
				admin={`${config.admin}/globals`}
				onSaved={setGlobals}
				onSaving={onSaving}
				announce={announce}
			/>
		) : null;
	} else {
		const postType =
			part.postTypeId === "pages" ? pagesType : (data.postTypes.find((each) => each.id === part.postTypeId) ?? null);
		if (!postType) {
			pane = <p className="text-chrome-muted m-0 p-5 text-[12px]">{shown.noMatch}</p>;
		} else {
			const type = gridType(postType);
			const entries = data.entries.get(postType.id) ?? [];
			const contentView = readView(view, type.pages);
			const onView = (next: ContentView, how: "push" | "replace") =>
				documents.setView(printView(next, type.pages), how);
			pane = staff ? (
				<EntriesGrid
					key={postType.id}
					words={words}
					language={config.language}
					postType={type}
					entries={entries}
					languages={config.languages}
					view={contentView}
					onView={onView}
					onOpen={openEntry}
					adminOf={(entry) => `${config.admin}/entries/${postType.id}/${entry.id}`}
					onCreate={(title) => onCreate(type, title)}
					announce={announce}
				/>
			) : (
				<MemberList
					key={postType.id}
					words={words}
					language={config.language}
					postType={type}
					entries={entries}
					view={contentView}
					onView={onView}
					onOpen={openEntry}
					onCreate={(title) => onCreate(type, title)}
				/>
			);
		}
	}

	return (
		<Place
			words={words}
			title={words.places.content}
			backTo={data && !staff ? documentName || words.documents.page : null}
			onBack={leave}
			sidebar={sidebar ?? <span />}
			sidebarLabel={shown.lists}
			place={place}
		>
			<div
				ref={scroller}
				className="min-h-0 grow overflow-y-auto"
				onScroll={(event) => rememberScroll(place, view, event.currentTarget.scrollTop)}
				data-wc-place-scroll=""
			>
				{pane}
			</div>
		</Place>
	);
}

/** A Member's "Site details": a row for each Group of the Globals, and one for all of them when some aren't in a Group. */
function MemberDetails({
	globals,
	current,
	label,
	allDetails,
	onOpen,
}: {
	globals: { fields: readonly { key: string; label: string; type: string }[] } | null;
	/** The Group open ("" for all the details), or null when the Globals aren't. */
	current: string | null;
	label: string;
	allDetails: string;
	onOpen(group: string | null): void;
}) {
	const fields = globals?.fields ?? [];
	if (fields.length === 0) return null;
	const groups = fields.filter((field) => field.type === "group");
	const loose = groups.length < fields.length;
	return (
		<div className="flex flex-col gap-0.5 p-2" data-wc-site-details="">
			<SidebarLabel>{label}</SidebarLabel>
			{loose || groups.length === 0 ? (
				<SidebarRow
					icon={ListIcon}
					label={allDetails}
					current={current === ""}
					onOpen={() => onOpen(null)}
					data={{ "data-wc-content-row": "globals" }}
				/>
			) : null}
			{groups.map((group) => (
				<SidebarRow
					key={group.key}
					icon={ListIcon}
					label={group.label}
					current={current === group.key}
					onOpen={() => onOpen(group.key)}
					data={{ "data-wc-content-row": `globals/${group.key}` }}
				/>
			))}
		</div>
	);
}
