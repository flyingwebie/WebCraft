import type { BuildingAreaApiClient } from "@webcraft/api";
import { LockIcon, Trash2Icon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";

import { fill, type Words } from "../../../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../../../controls.tsx";
import type { PostTypeRow } from "../../../management.ts";
import { Badge, buttonLook, PlaceIconButton } from "../ui.tsx";
import { codeOf, problemsOf, problemText, reasonText } from "./controls.tsx";
import { DeleteDialog, type Deleting } from "./DeleteDialog.tsx";

/** Which Templates a Post Type has (`templates.list`): made, not made, or none to make. */
type Made = { entry: boolean | null; archive: boolean | "unavailable" | null };

/** A Post Type key made from its name, as the server makes one: `Blog posts` gives `blog-posts`. */
export function keyFromName(name: string): string {
	return name
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^[^a-z]+/, "")
		.replace(/-+$/, "")
		.slice(0, 64)
		.replace(/-+$/, "");
}

/**
 * The Post Types list of the Content place (SPEC 8, `places-content/02`): each Post Type with its
 * key, URL pattern, whether its Entry and Archive templates are made, and how many Entries it has;
 * the Page Post Type locked. Its name opens its Fields. The create row makes one on Enter (its key and
 * URL pattern follow the name unless given) and opens its Fields; the bin opens the dialog that
 * deletes it with its Entries and Templates.
 */
export function PostTypesList({
	words,
	language,
	api,
	siteId,
	postTypes,
	counts,
	focusCreate,
	onOpen,
	onCreated,
	onDeleted,
	announce,
}: {
	words: Words;
	language: string;
	api: BuildingAreaApiClient;
	siteId: string;
	/** The Site's Post Types, Pages first. */
	postTypes: readonly PostTypeRow[];
	/** How many Entries each Post Type has, by its id. */
	counts: ReadonlyMap<string, number>;
	/** Changes when the sidebar's "+" asks for the create row. */
	focusCreate: number;
	onOpen(postType: PostTypeRow): void;
	onCreated(postType: PostTypeRow): Promise<void>;
	onDeleted(postType: Deleting): Promise<void>;
	announce(text: string, urgent?: boolean): void;
}) {
	const shown = words.postTypes;
	const [made, setMade] = useState<ReadonlyMap<string, Made>>(new Map());
	const [deleting, setDeleting] = useState<Deleting | null>(null);
	const opener = useRef<HTMLElement | null>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const ids = postTypes.map((postType) => postType.id).join(",");

	// Which Templates each Post Type has: read when the list opens and whenever its Post Types change.
	// oxlint-disable-next-line react-hooks/exhaustive-deps -- `ids` names the Post Types the list shows.
	useEffect(() => {
		let alive = true;
		api.templates
			.list({ siteId })
			.then(({ templates }) => {
				if (!alive) return;
				const next = new Map<string, Made>();
				for (const listing of templates) {
					if (!listing.postType) continue;
					const was = next.get(listing.postType.id) ?? { entry: null, archive: null };
					if (listing.kind === "entry") was.entry = listing.template !== null;
					if (listing.kind === "archive")
						was.archive = listing.template !== null ? true : listing.unavailable ? "unavailable" : false;
					next.set(listing.postType.id, was);
				}
				setMade(next);
			})
			.catch(() => {
				// Without it the template columns stay empty; the rest of the list still works.
			});
		return () => {
			alive = false;
		};
	}, [api, siteId, ids]);

	const count = fill(shown.count[new Intl.PluralRules(language).select(postTypes.length) === "one" ? "one" : "other"], {
		count: String(postTypes.length),
	});

	return (
		<div className="flex min-w-0 flex-col gap-3 p-4" data-wc-post-types="">
			<div className="flex h-10 items-center gap-2.5">
				<h2 ref={heading} tabIndex={-1} className="text-chrome-strong m-0 text-[16px] font-semibold outline-none">
					{shown.title}
				</h2>
				<span className="text-chrome-muted text-[13px]" data-wc-post-types-count="">
					{count}
				</span>
			</div>

			<div className="overflow-hidden rounded-lg">
				<table className="w-full table-fixed border-collapse text-[12px]" data-wc-post-types-grid="">
					<caption className="sr-only">{shown.title}</caption>
					<colgroup>
						<col className="w-[22%]" />
						<col className="w-[13%]" />
						<col className="w-[19%]" />
						<col className="w-[120px]" />
						<col className="w-[130px]" />
						<col className="w-[80px]" />
						<col className="w-[120px]" />
					</colgroup>
					<thead>
						<tr className="bg-chrome-raised h-[35px]">
							<Head>{shown.columns.name}</Head>
							<Head>{shown.columns.key}</Head>
							<Head>{shown.columns.urlPattern}</Head>
							<Head>{shown.columns.entryTemplate}</Head>
							<Head>{shown.columns.archiveTemplate}</Head>
							<Head end>{shown.columns.entries}</Head>
							<Head>
								<span className="sr-only">{shown.columns.actions}</span>
							</Head>
						</tr>
					</thead>
					<tbody>
						{postTypes.map((postType) => {
							const pages = postType.builtIn === "page";
							const templates = made.get(postType.id) ?? { entry: null, archive: null };
							const name = pages ? words.content.pages : postType.name;
							return (
								<tr
									key={postType.id}
									className={`border-chrome-line hover:bg-chrome-raised focus-within:bg-chrome-raised h-[46px] border-b ${CHROME_EASE}`}
									data-wc-post-type={postType.key}
								>
									<td className="px-2.5">
										<span className="flex min-w-0 items-center gap-1.5">
											{pages ? (
												<>
													<LockIcon aria-hidden="true" className="text-chrome-faint size-3 shrink-0" />
													<span className="sr-only">{shown.builtIn}</span>
												</>
											) : null}
											<button
												type="button"
												onClick={() => onOpen(postType)}
												className={`text-chrome-text block max-w-full truncate rounded-sm text-start font-medium hover:underline ${FOCUS_RING}`}
												data-wc-post-type-name=""
											>
												{name}
											</button>
										</span>
									</td>
									<td className="text-chrome-muted truncate px-2.5 font-mono">{postType.key}</td>
									<td className="text-chrome-muted truncate px-2.5 font-mono">{postType.urlPattern}</td>
									<td className="px-2.5">
										{pages ? <None words={words} /> : <MadeCell words={words} made={templates.entry} />}
									</td>
									<td className="px-2.5">
										{pages ? (
											<None words={words} />
										) : templates.archive === "unavailable" ? (
											<span className="text-chrome-muted">{shown.noArchive}</span>
										) : (
											<MadeCell words={words} made={templates.archive} />
										)}
									</td>
									<td className="text-chrome-text px-2.5 text-end font-medium tabular-nums">
										{counts.get(postType.id) ?? 0}
									</td>
									<td className="px-2.5">
										<span className="flex items-center justify-end">
											{pages ? null : (
												<PlaceIconButton
													icon={Trash2Icon}
													label={fill(shown.delete, { name })}
													tone="danger"
													onClick={() => {
														opener.current = document.activeElement as HTMLElement | null;
														setDeleting({ id: postType.id, name });
													}}
													data={{ "data-wc-post-type-delete": postType.key }}
												/>
											)}
										</span>
									</td>
								</tr>
							);
						})}
						<CreateRow
							words={words}
							api={api}
							siteId={siteId}
							focus={focusCreate}
							onCreated={onCreated}
							announce={announce}
						/>
					</tbody>
				</table>
			</div>

			{deleting ? (
				<DeleteDialog
					words={words}
					language={language}
					api={api}
					siteId={siteId}
					postType={deleting}
					onClose={() => {
						setDeleting(null);
						opener.current?.focus();
					}}
					onDeleted={() => {
						const gone = deleting;
						setDeleting(null);
						announce(fill(shown.deleted, { name: gone.name }));
						void onDeleted(gone).then(() => heading.current?.focus());
					}}
				/>
			) : null}
		</div>
	);
}

/** A column's header cell. */
function Head({ children, end }: { children: ReactNode; end?: boolean }) {
	return (
		<th
			scope="col"
			className={`text-chrome-muted px-2.5 align-middle text-[11px] font-semibold tracking-[0.3px] ${end ? "text-end" : "text-start"}`}
		>
			{children}
		</th>
	);
}

/** A Template's cell: Made (a badge) or Not made yet; nothing while unknown. */
function MadeCell({ words, made }: { words: Words; made: boolean | null }) {
	if (made === null) return null;
	return made ? (
		<Badge kind="live">{words.postTypes.made}</Badge>
	) : (
		<span className="text-chrome-muted">{words.postTypes.notMade}</span>
	);
}

/** The Page Post Type's Template cells: Pages are arranged with Page layouts. */
function None({ words }: { words: Words }) {
	return (
		<span className="text-chrome-muted">
			<span aria-hidden="true">—</span>
			<span className="sr-only">{words.postTypes.pagesNone}</span>
		</span>
	);
}

/** The list's last row: a new Post Type's name, key and URL pattern; Enter (or Create) makes it. */
function CreateRow({
	words,
	api,
	siteId,
	focus,
	onCreated,
	announce,
}: {
	words: Words;
	api: BuildingAreaApiClient;
	siteId: string;
	focus: number;
	onCreated(postType: PostTypeRow): Promise<void>;
	announce(text: string, urgent?: boolean): void;
}) {
	const shown = words.postTypes;
	const [name, setName] = useState("");
	const [key, setKey] = useState("");
	const [pattern, setPattern] = useState("");
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const nameBox = useRef<HTMLInputElement>(null);
	const help = useId();
	const problemId = useId();

	useEffect(() => {
		if (focus > 0) nameBox.current?.focus();
	}, [focus]);

	const madeKey = key.trim() || keyFromName(name);
	const madePattern = pattern.trim() || (madeKey ? `/${madeKey}/{slug}` : "");

	const create = async () => {
		if (!name.trim() || busy) return;
		setBusy(true);
		setProblem(null);
		try {
			const { postType } = await api.postTypes.create({
				siteId,
				name: name.trim(),
				...(madeKey ? { key: madeKey } : {}),
				urlPattern: madePattern,
			});
			announce(fill(shown.created, { name: postType.name }));
			setName("");
			setKey("");
			setPattern("");
			await onCreated(postType);
		} catch (error) {
			const problems = problemsOf(error);
			const text =
				problems.length > 0
					? problems.map((each) => problemText(words, each)).join(" ")
					: codeOf(error) === "POST_TYPE_TAKEN" || codeOf(error) === "PATH_TAKEN"
						? reasonText(words, error)
						: fill(shown.notCreated, { reason: reasonText(words, error) });
			setProblem(text);
			announce(text, true);
		} finally {
			setBusy(false);
		}
	};

	const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		void create();
	};
	const describedBy = problem ? `${help} ${problemId}` : help;
	const box =
		"placeholder:text-chrome-muted focus-visible:ring-chrome-focus min-w-0 w-full rounded-sm bg-transparent py-1 text-[12px] outline-none focus-visible:ring-2";

	return (
		<>
			<tr className="border-chrome-line h-[50px] border-b" data-wc-post-type-create="">
				<td className="px-2.5">
					<input
						ref={nameBox}
						type="text"
						value={name}
						disabled={busy}
						maxLength={200}
						onChange={(event) => setName(event.target.value)}
						onKeyDown={onKey}
						placeholder={shown.newName}
						aria-label={shown.newNameLabel}
						aria-describedby={describedBy}
						aria-invalid={problem ? true : undefined}
						className={`text-chrome-strong font-medium ${box}`}
						data-wc-new-post-type-name=""
					/>
				</td>
				<td className="px-2.5">
					<input
						type="text"
						value={key}
						disabled={busy}
						maxLength={64}
						onChange={(event) => setKey(event.target.value)}
						onKeyDown={onKey}
						placeholder={keyFromName(name) || "key"}
						aria-label={shown.newKeyLabel}
						aria-describedby={describedBy}
						className={`text-chrome-strong font-mono ${box}`}
						data-wc-new-post-type-key=""
					/>
				</td>
				<td className="px-2.5">
					<input
						type="text"
						value={pattern}
						disabled={busy}
						maxLength={500}
						onChange={(event) => setPattern(event.target.value)}
						onKeyDown={onKey}
						placeholder={madeKey ? `/${madeKey}/{slug}` : "/{slug}"}
						aria-label={shown.newPatternLabel}
						aria-describedby={describedBy}
						className={`text-chrome-strong font-mono ${box}`}
						data-wc-new-post-type-pattern=""
					/>
				</td>
				<td colSpan={3} />
				<td className="px-2.5 text-end">
					<span id={help} className="sr-only">
						{shown.createHelp}
					</span>
					<button
						type="button"
						onClick={() => void create()}
						disabled={busy || !name.trim()}
						className={`${buttonLook("primary")} w-[100px]`}
						data-wc-new-post-type-create=""
					>
						{busy ? shown.creating : `${shown.create} ↵`}
					</button>
				</td>
			</tr>
			{problem ? (
				<tr>
					<td colSpan={7} className="px-2.5 py-2">
						<p id={problemId} className="text-chrome-danger m-0 text-[12px]" data-wc-post-type-problem="">
							{problem}
						</p>
					</td>
				</tr>
			) : null}
		</>
	);
}
