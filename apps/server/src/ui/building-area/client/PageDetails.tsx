import { ArrowLeftIcon, ChevronRightIcon, ImageIcon, SearchIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";
import {
	type EntryDetails,
	type EntryDetailsOptions,
	listedFields,
	SEO_DESCRIPTION_MAX,
	SEO_TITLE_MAX,
	useEntryDetails,
} from "../panels/entry-details.ts";
import {
	boxClass,
	describedBy,
	FieldControl,
	Labelled,
	type Look,
	Switch,
	useTyped,
} from "../panels/field-controls.tsx";
import { pickMedia } from "../places/media/pick.ts";

/**
 * Page details and Post details (SPEC 13.5 and 13.7; `client-flows/03`, `client-flows/01`): what a
 * Member changes of the page's Entry that doesn't show on the page, in the side panel. A Page gets Page
 * details: its title and address, then Search and sharing (the title and description in search
 * results with their counters against 60 and 160, a preview of the result, the picture when shared,
 * "Hide from search engines"). An Entry of another Post Type gets Post details: its Fields that don't
 * show on the page (a category, an author, a date, its Summary), then "Search and sharing" as a
 * screen of its own, with its address. Every value saves to the Draft as it is typed.
 *
 * The side panel itself (its heading, close button and Escape) is client editing's (BA-14): it holds
 * `<PageDetails>` and names itself with `detailsHeading`.
 */

/** What the side panel holding the details is called, and what is under its name. */
export function detailsHeading(words: Words, details: EntryDetails): { title: string; sub: string; post: boolean } {
	const post = details.postType !== null && details.postType.builtIn !== "page";
	return {
		title: post ? words.details.postDetails : words.details.pageDetails,
		sub: post ? (details.postType?.name ?? "") : (details.details?.title ?? details.page?.page.title ?? ""),
		post,
	};
}

/**
 * Page details or Post details as a side panel holds them: the page's Entry read while it is open,
 * and the panel's name told to the panel (`onHeading`), which is Page details or Post details.
 */
export function MemberDetails({
	admin,
	onHeading,
	...options
}: EntryDetailsOptions & {
	admin: string;
	onHeading?(heading: { title: string; sub: string }): void;
}) {
	const details = useEntryDetails(options);
	const { title, sub } = detailsHeading(options.words, details);
	const told = useRef(onHeading);
	told.current = onHeading;
	useEffect(() => told.current?.({ title, sub }), [title, sub]);
	return <PageDetails words={options.words} details={details} admin={admin} />;
}

/** Page details or Post details, for a Member (the side panel's body). */
export function PageDetails({
	words,
	details,
	admin,
}: {
	words: Words;
	details: EntryDetails;
	/** The Site in the admin (`…/sites/<id>`), for what is changed there. */
	admin: string;
}) {
	const said = words.details;
	const [screen, setScreen] = useState<"main" | "search">("main");
	const searchRow = useRef<HTMLButtonElement>(null);
	const backButton = useRef<HTMLButtonElement>(null);
	const moved = useRef(false);
	// Another page starts on the main screen.
	const item = details.page?.page.item ?? null;
	// oxlint-disable-next-line react-hooks/exhaustive-deps -- another page is what resets it.
	useEffect(() => setScreen("main"), [item]);
	// Focus follows the screen: into Search and sharing on its Back button, out of it on its row.
	useEffect(() => {
		if (!moved.current) return;
		moved.current = false;
		(screen === "search" ? backButton : searchRow).current?.focus();
	}, [screen]);

	if (details.status !== "ready" || !details.details || !details.entry || !details.postType)
		return <DetailsStatus words={words} details={details} look="client" />;

	const { post } = detailsHeading(words, details);
	const entryAdmin = `${admin}/entries/${details.postType.id}/${details.entry.id}`;
	const summaryPath = details.postType.summaryField;
	const fields = listedFields(details);

	if (post && screen === "search") {
		return (
			<div className="flex flex-col gap-4" data-wc-details="search">
				<button
					ref={backButton}
					type="button"
					onClick={() => {
						moved.current = true;
						setScreen("main");
					}}
					className={`text-chrome-text hover:bg-chrome-hover -ms-1 inline-flex h-8 items-center gap-2 self-start rounded-lg px-1.5 text-[13px] font-medium ${CHROME_EASE} ${FOCUS_RING}`}
					data-wc-details-back=""
				>
					<ArrowLeftIcon aria-hidden="true" className="size-4" />
					{fill(said.back, { panel: said.postDetails })}
				</button>
				<h3 className="text-chrome-strong m-0 text-[14px] font-semibold">{said.searchAndSharing}</h3>
				<AddressField look="client" words={words} details={details} />
				<SearchAndSharing look="client" words={words} details={details} canonical={false} />
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4" data-wc-details={post ? "post" : "page"}>
			{post ? null : (
				<>
					<TitleField look="client" words={words} details={details} />
					<AddressField look="client" words={words} details={details} />
				</>
			)}
			{fields.map(({ field, path, label }) => (
				<FieldControl
					key={path}
					look="client"
					words={words}
					details={details}
					field={field}
					path={path}
					label={label}
					admin={entryAdmin}
					count={path === summaryPath ? SEO_DESCRIPTION_MAX : undefined}
				/>
			))}
			{post ? (
				<button
					ref={searchRow}
					type="button"
					onClick={() => {
						moved.current = true;
						setScreen("search");
					}}
					className={`bg-chrome-raised text-chrome-strong hover:bg-chrome-hover flex h-11 w-full items-center gap-2.5 rounded-lg px-2.5 text-start text-[14px] font-medium ${CHROME_EASE} ${FOCUS_RING}`}
					data-wc-details-search=""
				>
					<SearchIcon aria-hidden="true" className="text-chrome-muted size-4" />
					<span className="grow">{said.searchAndSharing}</span>
					<ChevronRightIcon aria-hidden="true" className="text-chrome-muted size-4 rtl:rotate-180" />
				</button>
			) : (
				<>
					<SectionLabel look="client">{said.searchAndSharing}</SectionLabel>
					<SearchAndSharing look="client" words={words} details={details} canonical={false} />
				</>
			)}
		</div>
	);
}

/** While the Entry is read, when it couldn't be, or when the page shows none of its own. */
export function DetailsStatus({ words, details, look }: { words: Words; details: EntryDetails; look: Look }) {
	const said = words.details;
	const text =
		details.status === "none"
			? said.noEntry
			: details.status === "failed"
				? fill(said.failed, { reason: details.reason ?? "network" })
				: said.loading;
	return (
		<p
			role={details.status === "failed" ? "alert" : undefined}
			className={`text-chrome-muted m-0 ${look === "dock" ? "text-[12px]" : "text-[13px]"}`}
			data-wc-details-status={details.status}
		>
			{text}
		</p>
	);
}

/** A section's small heading (`SEARCH AND SHARING`, `FIELDS`). */
export function SectionLabel({ look, children }: { look: Look; children: string }) {
	return (
		<h3
			className={`text-chrome-muted m-0 font-semibold tracking-[0.05em] uppercase ${look === "dock" ? "text-[11px]" : "text-[11px]"}`}
		>
			{children}
		</h3>
	);
}

/** "{label} · {language}" for a value kept per language, on a Site with several. */
function inLanguage(words: Words, details: EntryDetails, label: string): string {
	return details.several ? fill(words.details.fieldIn, { label, language: details.page?.language.name ?? "" }) : label;
}

/** The page's title. */
export function TitleField({ look, words, details }: { look: Look; words: Words; details: EntryDetails }) {
	const id = useId();
	const problem = details.problems.get("title") ?? null;
	const [typed, setTyped, focus] = useTyped(details.details?.title ?? "", () => details.pending("title"));
	return (
		<Labelled
			look={look}
			id={id}
			label={inLanguage(words, details, words.details.title)}
			problem={problem}
			data={{ "data-wc-details-field": "title" }}
		>
			<input
				id={id}
				type="text"
				value={typed}
				autoComplete="off"
				aria-invalid={problem ? true : undefined}
				aria-describedby={describedBy(id, null, problem)}
				onChange={(event) => {
					setTyped(event.target.value);
					details.change("title", { title: event.target.value });
				}}
				onFocus={focus.onFocus}
				onBlur={() => {
					focus.onBlur();
					details.flush("title");
				}}
				className={boxClass(look, look === "dock" ? "h-[18px]" : "h-10")}
			/>
		</Labelled>
	);
}

/** The page's address: the part before its slug, then its slug; the home page's is the Site's root. */
export function AddressField({ look, words, details }: { look: Look; words: Words; details: EntryDetails }) {
	const said = words.details;
	const id = useId();
	const address = details.details?.address;
	const problem = details.problems.get("slug") ?? null;
	const [typed, setTyped, focus] = useTyped(address?.slug ?? "", () => details.pending("slug"));
	const home = address?.home ?? false;
	const hint = home ? said.homeAddress : null;
	const prefix = `${look === "client" ? window.location.host : ""}${home ? "/" : (address?.prefix ?? "/")}`;
	return (
		<Labelled
			look={look}
			id={id}
			label={inLanguage(words, details, said.address)}
			hint={hint}
			problem={problem}
			data={{ "data-wc-details-field": "address" }}
			as={home ? "span" : "label"}
		>
			<span
				className={
					look === "dock"
						? "flex min-w-0 items-center font-mono text-[12px]"
						: `bg-chrome-raised focus-within:border-chrome-focus flex h-10 min-w-0 items-center rounded-lg border border-[#3f3f46] px-3 font-mono text-[14px] ${CHROME_EASE}`
				}
			>
				<span className="text-chrome-muted shrink-0" data-wc-details-prefix="">
					{prefix}
				</span>
				{home ? null : (
					<input
						id={id}
						type="text"
						value={typed}
						autoComplete="off"
						spellCheck={false}
						aria-invalid={problem ? true : undefined}
						aria-describedby={describedBy(id, hint, problem)}
						onChange={(event) => {
							setTyped(event.target.value);
							details.change("slug", { slug: event.target.value });
						}}
						onFocus={focus.onFocus}
						onBlur={() => {
							focus.onBlur();
							details.flush("slug");
						}}
						className="text-chrome-strong focus-visible:outline-chrome-focus min-w-0 grow rounded-[3px] bg-transparent font-medium outline-none focus-visible:outline-1 focus-visible:outline-offset-[3px] focus-visible:outline-solid"
					/>
				)}
			</span>
		</Labelled>
	);
}

/** "44 of 60": how long the text a search engine shows is, against what it shows. */
function Counter({ words, length, max, id }: { words: Words; length: number; max: number; id: string }) {
	const over = length > max;
	return (
		<span id={id} className={over ? "text-chrome-warn" : undefined} data-wc-details-counter="">
			{fill(words.details.counter, { count: String(length), max: String(max) })}
			{over ? <span className="sr-only">{`, ${words.details.tooLong}`}</span> : null}
		</span>
	);
}

/**
 * Search and sharing: the title and description in search results (what the page falls back to shown
 * in each while it is empty, with counters against 60 and 160), how the result reads, the picture when
 * the page is shared, its canonical address (Staff), and "Hide from search engines".
 */
export function SearchAndSharing({
	look,
	words,
	details,
	canonical,
}: {
	look: Look;
	words: Words;
	details: EntryDetails;
	/** Whether the canonical address is offered (Staff). */
	canonical: boolean;
}) {
	const said = words.details;
	const seo = details.details?.seo;
	const fallbacks = details.details?.fallbacks;
	const titleId = useId();
	const descriptionId = useId();
	const canonicalId = useId();
	const noindexId = useId();
	const [title, setTitle, titleFocus] = useTyped(seo?.title ?? "", () => details.pending("seo.title"));
	const [description, setDescription, descriptionFocus] = useTyped(seo?.description ?? "", () =>
		details.pending("seo.description"),
	);
	const [address, setAddress, addressFocus] = useTyped(seo?.canonical ?? "", () => details.pending("seo.canonical"));
	const [noindex, setNoindex] = useState(seo?.noindex ?? false);
	useEffect(() => setNoindex(seo?.noindex ?? false), [seo?.noindex]);
	if (!seo || !fallbacks) return null;

	const shownTitle = title || fallbacks.title;
	const shownDescription = description || fallbacks.description || "";
	const titleLength = [...shownTitle].length;
	const descriptionLength = [...shownDescription].length;
	const problem = (key: string) => details.problems.get(key) ?? null;
	const path = details.details?.address.path ?? "/";
	const small = look === "dock" ? "h-[18px]" : "h-10";

	const box = (
		key: "title" | "description" | "canonical",
		value: string,
		set: (next: string) => void,
		focus: { onFocus(): void; onBlur(): void },
	) => ({
		value,
		onChange: (event: { target: { value: string } }) => {
			set(event.target.value);
			details.change(`seo.${key}`, { seo: { [key]: event.target.value } });
		},
		onFocus: focus.onFocus,
		onBlur: () => {
			focus.onBlur();
			details.flush(`seo.${key}`);
		},
	});

	return (
		<div className={`flex flex-col ${look === "dock" ? "gap-2" : "gap-4"}`} data-wc-details-seo="">
			<Labelled
				look={look}
				id={titleId}
				label={inLanguage(words, details, said.seoTitle)}
				count={<Counter words={words} length={titleLength} max={SEO_TITLE_MAX} id={`${titleId}-count`} />}
				problem={problem("seo.title")}
			>
				<input
					id={titleId}
					type="text"
					autoComplete="off"
					placeholder={fallbacks.title}
					aria-describedby={[`${titleId}-count`, describedBy(titleId, null, problem("seo.title"))]
						.filter(Boolean)
						.join(" ")}
					aria-invalid={problem("seo.title") ? true : undefined}
					{...box("title", title, setTitle, titleFocus)}
					className={boxClass(look, small)}
				/>
			</Labelled>
			<Labelled
				look={look}
				id={descriptionId}
				label={inLanguage(words, details, said.seoDescription)}
				count={
					<Counter words={words} length={descriptionLength} max={SEO_DESCRIPTION_MAX} id={`${descriptionId}-count`} />
				}
				problem={problem("seo.description")}
			>
				<textarea
					id={descriptionId}
					rows={3}
					placeholder={fallbacks.description ?? ""}
					aria-describedby={[`${descriptionId}-count`, describedBy(descriptionId, null, problem("seo.description"))]
						.filter(Boolean)
						.join(" ")}
					aria-invalid={problem("seo.description") ? true : undefined}
					{...box("description", description, setDescription, descriptionFocus)}
					className={boxClass(look, look === "dock" ? "resize-none leading-[18px]" : "resize-none py-2.5 leading-5")}
				/>
			</Labelled>
			<figure className="m-0 flex flex-col gap-1 rounded-[10px] bg-white p-3.5" data-wc-details-preview="">
				<figcaption className="sr-only">{said.preview}</figcaption>
				<span className="truncate text-[12px] text-[#188038]">{`${window.location.host}${path === "/" ? "" : path}`}</span>
				<span className="text-[15px] leading-5 font-semibold text-[#1a0dab]">{shownTitle}</span>
				{shownDescription ? (
					<span className="line-clamp-3 text-[12px] leading-[17px] text-[#4d5156]">{shownDescription}</span>
				) : null}
			</figure>
			<SharedPicture look={look} words={words} details={details} />
			{canonical ? (
				<Labelled
					look={look}
					id={canonicalId}
					label={inLanguage(words, details, said.canonical)}
					hint={said.canonicalHelp}
					problem={problem("seo.canonical")}
				>
					<input
						id={canonicalId}
						type="url"
						autoComplete="off"
						placeholder={`${window.location.origin}${path}`}
						aria-describedby={describedBy(canonicalId, said.canonicalHelp, problem("seo.canonical"))}
						aria-invalid={problem("seo.canonical") ? true : undefined}
						{...box("canonical", address, setAddress, addressFocus)}
						className={boxClass(look, small)}
					/>
				</Labelled>
			) : null}
			<div
				className={
					look === "dock"
						? "bg-chrome-raised flex items-center gap-2 rounded-md px-2 py-1.5"
						: "flex items-center gap-3"
				}
				data-wc-details-field="noindex"
			>
				<span className="flex min-w-0 grow flex-col gap-0.5">
					<span
						id={`${noindexId}-label`}
						className={look === "dock" ? "text-chrome-muted text-[11px]" : "text-chrome-strong text-[13px] font-medium"}
					>
						{said.noindex}
					</span>
					<span
						id={`${noindexId}-hint`}
						className={`text-chrome-muted ${look === "dock" ? "text-[11px]" : "text-[12px]"}`}
					>
						{said.noindexHelp}
					</span>
				</span>
				<Switch
					look={look}
					id={noindexId}
					on={noindex}
					onChange={(on) => {
						setNoindex(on);
						details.change("seo.noindex", { seo: { noindex: on } }, 0);
					}}
					labelledBy={`${noindexId}-label`}
					describedBy={`${noindexId}-hint`}
				/>
			</div>
		</div>
	);
}

/** The picture other sites show when the page is shared: its own, or what it falls back to; Change picks one. */
function SharedPicture({ look, words, details }: { look: Look; words: Words; details: EntryDetails }) {
	const said = words.details;
	const id = useId();
	const own = details.details?.seo.image ?? null;
	const from = own ? "entry" : (details.details?.fallbacks.image?.from ?? null);
	const imageField = details.postType?.seo.imageField ?? null;
	const fieldLabel = imageField
		? (details.postType?.fields.find((field) => field.key === imageField.split(".")[0])?.label ?? null)
		: null;
	const text =
		from === "entry"
			? said.pictureOwn
			: from === "field"
				? fieldLabel
					? fill(said.pictureField, { field: fieldLabel })
					: said.pictureFieldAny
				: from === "site"
					? said.pictureSite
					: from === "socialCard"
						? said.pictureCard
						: said.pictureNone;
	const thumbnail = details.details?.image?.thumbnail ?? null;
	const problem = details.problems.get("seo.image") ?? null;
	const button = `text-chrome-text hover:bg-chrome-hover inline-flex shrink-0 items-center justify-center rounded-lg border border-[#3f3f46] font-semibold ${
		look === "dock" ? "h-6 px-2 text-[11px]" : "h-[34px] w-[88px] text-[13px]"
	} ${CHROME_EASE} ${FOCUS_RING}`;
	return (
		<Labelled
			look={look}
			id={id}
			label={said.picture}
			problem={problem}
			as="span"
			data={{ "data-wc-details-field": "picture" }}
		>
			<fieldset className="m-0 flex min-w-0 items-center gap-2.5 border-0 p-0" aria-labelledby={`${id}-label`}>
				{thumbnail ? (
					<img
						src={thumbnail}
						alt=""
						className={`shrink-0 object-cover ${look === "dock" ? "size-7 rounded-md" : "h-11 w-16 rounded-lg"}`}
					/>
				) : (
					<span
						aria-hidden="true"
						className={`bg-chrome-hover text-chrome-muted grid shrink-0 place-items-center ${look === "dock" ? "size-7 rounded-md" : "h-11 w-16 rounded-lg"}`}
					>
						<ImageIcon className="size-4" />
					</span>
				)}
				<span className="flex min-w-0 grow flex-col gap-1">
					<span
						className={`text-chrome-muted ${look === "dock" ? "text-[11px]" : "text-[12px]"}`}
						data-wc-details-picture=""
					>
						{text}
					</span>
					{own ? (
						<button
							type="button"
							onClick={() => details.change("seo.image", { seo: { image: null } }, 0)}
							className={`text-chrome-accent self-start rounded-sm text-[12px] hover:underline ${FOCUS_RING}`}
						>
							{said.useDefault}
						</button>
					) : null}
				</span>
				<button
					type="button"
					aria-label={said.changePicture}
					onClick={async () => {
						const chosen = await pickMedia({ kind: "image", current: own });
						if (chosen) details.change("seo.image", { seo: { image: chosen.id } }, 0);
					}}
					className={button}
				>
					{said.change}
				</button>
			</fieldset>
		</Labelled>
	);
}
