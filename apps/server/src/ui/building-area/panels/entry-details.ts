import type { BuildingAreaApiClient } from "@webcraft/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type EditRequests, fill, type PageState, type Words } from "../api.ts";
import { managementApi } from "../management.ts";

/**
 * What the Entry panel (Staff, BA-13) and Page details / Post details (Members) show of the page in the
 * frame: its Entry's own values (title, address, Search and sharing, through the `details` edit
 * request), its status and Fields (`entries.get`, `postTypes.get`), each language's translation, and
 * which of its Fields show on the page as editable regions (those are changed where they are, so the
 * panels leave them out). Every change saves to the Draft through `details/save`, as Content typed in
 * place does: 0.8 s after typing stops, at once for a choice, and when a box is left.
 */

export type EntryData = Awaited<ReturnType<BuildingAreaApiClient["entries"]["get"]>>["entry"];
export type PostTypeData = Awaited<ReturnType<BuildingAreaApiClient["postTypes"]["get"]>>["postType"];
export type FieldDef = PostTypeData["fields"][number];
export type Json = EntryData["draft"]["fields"][string];
type MediaData = Awaited<ReturnType<BuildingAreaApiClient["media"]["get"]>>["media"];

/** The page's Entry's own values, as the `details` edit request answers them. */
export type DetailsAnswer = {
	item: string;
	language: string;
	title: string;
	address: { prefix: string; slug: string; path: string | null; home: boolean };
	seo: {
		title: string | null;
		description: string | null;
		canonical: string | null;
		image: string | null;
		noindex: boolean;
	};
	fallbacks: {
		title: string;
		description: string | null;
		image: { mediaId?: string; from: "entry" | "field" | "site" | "socialCard" } | null;
	};
	summary: { field: string; label: string; type: string; value: Json } | null;
	translatable: { title: boolean; slug: boolean; seo: boolean; summary: boolean };
	image: { id: string; fileName: string; alt: string | null; thumbnail: string | null; url: string | null } | null;
	published: boolean;
};

/** A change `details/save` takes: only what is given changes; null or "" clears a value. */
export type DetailsChange = {
	title?: string;
	slug?: string;
	seo?: Partial<{
		title: string | null;
		description: string | null;
		canonical: string | null;
		image: string | null;
		noindex: boolean;
	}>;
	summary?: string | null;
	fields?: Record<string, unknown>;
};

/** Where a language's translation of the Entry stands, for its chip. */
export type TranslationState = "done" | "review" | "missing" | "hidden";

/** An Entry a Relationship can point at. */
export type LinkTarget = { id: string; title: string };

/** A file a media Field holds, as the panels show it. */
export type ShownFile = { id: string; name: string; alt: string | null; thumbnail: string | null };

/** A problem of a value, as the server says it. */
type Problem = { at: string; rule?: string };

/** How long after the last key a value is saved (as text typed in place is). */
export const SAVE_AFTER_MS = 800;

/** What search engines show of a title and a description, at most (the counters count against them). */
export const SEO_TITLE_MAX = 60;
export const SEO_DESCRIPTION_MAX = 160;

/** The panels' state of the page's Entry. */
export type EntryDetails = {
	/** `none`: the page shows no Entry of its own (an archive, search results, the 404 page). */
	status: "loading" | "ready" | "failed" | "none";
	/** Why reading failed (the refusal's code). */
	reason: string | null;
	details: DetailsAnswer | null;
	entry: EntryData | null;
	postType: PostTypeData | null;
	/** The page as Edit mode describes it (its language, the Site's languages with their pages). */
	page: PageState | null;
	/** Whether the Site has more than one language: translatable values then say which one they are in. */
	several: boolean;
	/** The Fields (by path, `credits.photographer` inside a Group) that show on the page as editable regions. */
	onPage: ReadonlySet<string>;
	/** Each language's translation of the Entry, by code. */
	translations: Readonly<Record<string, TranslationState>>;
	/** The Entries each Relationship can point at, by Post Type key: their name and Entries. */
	targets: Readonly<Record<string, { name: string; entries: readonly LinkTarget[] }>>;
	/** The files media Fields hold, by id. */
	files: Readonly<Record<string, ShownFile>>;
	/** Each value's problem, worded, by its key (`title`, `slug`, `seo.title`, `summary`, `fields.<path>`). */
	problems: ReadonlyMap<string, string>;
	/**
	 * Saves a change to the Draft under a key: 0.8 s after the last change under that key, or after
	 * `wait` (0: at once, for a choice or a switch). A newer change under the same key replaces it.
	 */
	change(key: string, change: DetailsChange, wait?: number): void;
	/** Saves now whatever waits under a key (a box was left). */
	flush(key: string): void;
	/** Whether a change under a key waits to be saved or is being saved. */
	pending(key: string): boolean;
	/** Reads the Entry's file back after a media Field took it. */
	remember(file: ShownFile): void;
};

/** The Fields of the page's Entry that the panels list: not a Body, and not shown on the page as a region. */
export function listedFields(details: EntryDetails): { field: FieldDef; path: string; label: string }[] {
	const postType = details.postType;
	if (!postType) return [];
	const listed: { field: FieldDef; path: string; label: string }[] = [];
	for (const field of postType.fields) {
		if (field.type === "body") continue;
		if (field.type === "group") {
			for (const inner of field.fields) {
				const path = `${field.key}.${inner.key}`;
				if (inner.type === "body" || details.onPage.has(path)) continue;
				listed.push({ field: inner, path, label: `${field.label} › ${inner.label}` });
			}
			continue;
		}
		if (details.onPage.has(field.key)) continue;
		listed.push({ field, path: field.key, label: field.label });
	}
	return listed;
}

/** The value at a path among an Entry's Fields' values. */
export function valueAtPath(values: Readonly<Record<string, Json>> | undefined, path: string): Json {
	let current: Json = (values ?? {}) as Json;
	for (const name of path.split(".")) {
		current = current && typeof current === "object" && !Array.isArray(current) ? (current[name] ?? null) : null;
	}
	return current;
}

/** A value given at a path, as `fields` takes it: `credits.photographer` is `{ credits: { photographer } }`. */
export function fieldsAt(path: string, value: unknown): Record<string, unknown> {
	return path.split(".").reduceRight<unknown>((inner, name) => ({ [name]: inner }), value) as Record<string, unknown>;
}

/** The key a problem's place is kept under. */
function keyOf(at: string, details: DetailsAnswer | null): string {
	if (at === "title" || at === "slug") return at;
	if (at.startsWith("seo.")) return at;
	if (details?.summary && at === `fields.${details.summary.field}`) return "summary";
	// `fields.credits.photographer`, `fields.team[1].name`: kept under the Field (a Group's inner Field).
	const path = at.slice("fields.".length).split("[")[0] ?? "";
	return `fields.${path}`;
}

/** A problem, worded as the page's regions word theirs. */
export function problemWords(words: Words, problem: Problem): string {
	const said = words.editing.problems as Record<string, string>;
	return said[problem.rule ?? "other"] ?? said.other ?? "";
}

/** The Fields of the page that show as editable regions of the Entry, read from the frame's page. */
function regionsOn(item: string): Set<string> {
	const frame = document.querySelector<HTMLIFrameElement>("iframe[data-wc-frame]");
	const page = frame?.contentDocument;
	const found = new Set<string>();
	if (!page) return found;
	for (const region of page.querySelectorAll(`[data-wc-item="${CSS.escape(item)}"][data-wc-field]`)) {
		const field = region.getAttribute("data-wc-field");
		if (field) found.add(field);
	}
	return found;
}

/** What reading and saving the page's Entry needs from the shell. */
export type EntryDetailsOptions = {
	token: string;
	siteId: string;
	words: Words;
	request: EditRequests;
	page: PageState | null;
	/** A change is being saved, was saved, or couldn't be: the Draft state beside Publish follows. */
	onSaving(status: "saving" | "saved" | "failed"): void;
	/** A page never published moved with its new slug: the shell's address follows it there. */
	onMoved(path: string): void;
	announce(text: string, urgent?: boolean): void;
};

/**
 * Reads the page's Entry for the panels and saves their changes. `page` is what Edit mode says of the
 * page in the frame now: read again each time it changes (a save, someone else's change, another page).
 */
export function useEntryDetails({
	token,
	siteId,
	words,
	request,
	page,
	onSaving,
	onMoved,
	announce,
}: EntryDetailsOptions): EntryDetails {
	const api = useMemo(() => managementApi(token), [token]);
	const item = page?.page.item ?? null;
	const entryId = item?.startsWith("entry:") ? item.slice("entry:".length) : null;
	const language = page?.language.code ?? null;
	const defaultLanguage = page?.defaultLanguage ?? null;

	const [details, setDetails] = useState<DetailsAnswer | null>(null);
	const [entry, setEntry] = useState<EntryData | null>(null);
	const [postType, setPostType] = useState<PostTypeData | null>(null);
	const [status, setStatus] = useState<EntryDetails["status"]>("loading");
	const [reason, setReason] = useState<string | null>(null);
	const [onPage, setOnPage] = useState<ReadonlySet<string>>(new Set());
	const [translations, setTranslations] = useState<Record<string, TranslationState>>({});
	const [targets, setTargets] = useState<EntryDetails["targets"]>({});
	const [files, setFiles] = useState<Record<string, ShownFile>>({});
	const [problems, setProblems] = useState<ReadonlyMap<string, string>>(new Map());

	const latest = useRef({ item, language, details, onSaving, onMoved, announce, words });
	latest.current = { item, language, details, onSaving, onMoved, announce, words };

	// Which Fields show on the page as regions: read from the frame's page now and each time it loads.
	// biome-ignore lint/correctness/useExhaustiveDependencies: read again with each state of the page (it may have changed).
	useEffect(() => {
		if (!item) {
			setOnPage(new Set());
			return;
		}
		const read = () => setOnPage(regionsOn(item));
		read();
		// The page may still be arriving: its regions are read again once it has loaded.
		const frame = document.querySelector<HTMLIFrameElement>("iframe[data-wc-frame]");
		frame?.addEventListener("load", read);
		return () => frame?.removeEventListener("load", read);
	}, [item, page]);

	// The Entry read again whenever the page's state changes; the newest reading wins.
	const reading = useRef(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the Post Type is kept across readings of one Entry on purpose.
	useEffect(() => {
		if (!page) {
			setStatus("loading");
			return;
		}
		if (!entryId || !item) {
			setStatus("none");
			setDetails(null);
			setEntry(null);
			return;
		}
		const run = ++reading.current;
		void (async () => {
			const answer = await request<DetailsAnswer>("details", { item, language: language ?? undefined });
			if (run !== reading.current) return;
			if (!answer.ok) {
				setStatus("failed");
				setReason(answer.code);
				return;
			}
			try {
				const { entry: read } = await api.entries.get({ siteId, entryId, ...(language ? { language } : {}) });
				const type =
					postType?.id === read.postTypeId
						? postType
						: (await api.postTypes.get({ siteId, postTypeId: read.postTypeId })).postType;
				if (run !== reading.current) return;
				setDetails(answer.data);
				setEntry(read);
				setPostType(type);
				setStatus("ready");
				setReason(null);
			} catch (error) {
				if (run !== reading.current) return;
				setStatus("failed");
				setReason(codeOf(error));
			}
		})();
	}, [page, item, entryId, language, api, siteId, request]);

	// Each language's translation, read once per Entry and state (a translation only changes with a save).
	useEffect(() => {
		if (!entry || !page || !entryId) return;
		let current = true;
		const others = page.languages.filter((each) => each.code !== defaultLanguage);
		void Promise.all(
			others.map(async (each): Promise<[string, TranslationState]> => {
				if (entry.draft.hiddenLanguages.includes(each.code)) return [each.code, "hidden"];
				try {
					const { entry: there } = await api.entries.get({ siteId, entryId, language: each.code });
					const translation = there.translation;
					if (!translation) return [each.code, "done"];
					if (translation.missing.length > 0) return [each.code, "missing"];
					if (translation.toReview.length > 0 || translation.outdated.length > 0) return [each.code, "review"];
					return [each.code, "done"];
				} catch {
					return [each.code, "missing"];
				}
			}),
		).then((states) => {
			if (!current) return;
			const next: Record<string, TranslationState> = {};
			if (defaultLanguage)
				next[defaultLanguage] = entry.draft.hiddenLanguages.includes(defaultLanguage) ? "hidden" : "done";
			for (const [code, state] of states) next[code] = state;
			setTranslations(next);
		});
		return () => {
			current = false;
		};
	}, [entry, page, entryId, defaultLanguage, api, siteId]);

	// The Entries each Relationship the panels list can point at, and the files media Fields hold.
	const relationshipKeys = useMemo(() => {
		const keys = new Set<string>();
		const walk = (fields: readonly FieldDef[]) => {
			for (const field of fields) {
				if (field.type === "relationship") for (const key of field.postTypes) keys.add(key);
				if (field.type === "group") walk(field.fields);
			}
		};
		if (postType) walk(postType.fields);
		return [...keys].sort().join(",");
	}, [postType]);
	useEffect(() => {
		if (!relationshipKeys) return;
		let current = true;
		void (async () => {
			try {
				const { postTypes } = await api.postTypes.list({ siteId });
				const wanted = new Set(relationshipKeys.split(","));
				const found: Record<string, { name: string; entries: LinkTarget[] }> = {};
				for (const type of postTypes) {
					if (!wanted.has(type.key)) continue;
					const { entries } = await api.entries.list({ siteId, postTypeId: type.id });
					found[type.key] = {
						name: type.name,
						entries: entries.map((each) => ({ id: each.id, title: each.draft.title })),
					};
				}
				if (current) setTargets(found);
			} catch {
				// The control still shows what is chosen, by its id; choosing waits for another reading.
			}
		})();
		return () => {
			current = false;
		};
	}, [relationshipKeys, api, siteId]);

	const fileIds = useMemo(() => {
		if (!postType || !entry) return "";
		const ids = new Set<string>();
		const walk = (fields: readonly FieldDef[], values: Readonly<Record<string, Json>>) => {
			for (const field of fields) {
				const value = values[field.key];
				if (field.type === "media" && typeof value === "string") ids.add(value);
				if (field.type === "group" && value && typeof value === "object" && !Array.isArray(value))
					walk(field.fields, value as Record<string, Json>);
			}
		};
		walk(postType.fields, entry.draft.fields);
		return [...ids].sort().join(",");
	}, [postType, entry]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: files already read are not read again.
	useEffect(() => {
		if (!fileIds) return;
		let current = true;
		void Promise.all(
			fileIds
				.split(",")
				.filter((id) => !files[id])
				.map(async (id) => {
					try {
						const { media } = await api.media.get({ siteId, mediaId: id, ...(language ? { language } : {}) });
						return shownFile(media);
					} catch {
						return null;
					}
				}),
		).then((read) => {
			if (!current) return;
			const known = read.filter((each): each is ShownFile => each !== null);
			if (known.length) setFiles((was) => ({ ...was, ...Object.fromEntries(known.map((each) => [each.id, each])) }));
		});
		return () => {
			current = false;
		};
	}, [fileIds, api, siteId, language]);

	// Saving: one change waits per key; each key saves on its own.
	const queued = useRef(new Map<string, DetailsChange>());
	const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
	const inFlight = useRef(new Set<string>());
	const [, setBusy] = useState(0);

	const run = useCallback(
		async (key: string) => {
			const change = queued.current.get(key);
			const at = latest.current;
			timers.current.delete(key);
			if (!change || !at.item) return;
			queued.current.delete(key);
			inFlight.current.add(key);
			setBusy((count) => count + 1);
			at.onSaving("saving");
			const answer = await request<{ details: DetailsAnswer; problems: Problem[] }>("details/save", {
				item: at.item,
				...(at.language ? { language: at.language } : {}),
				...change,
			});
			inFlight.current.delete(key);
			setBusy((count) => count + 1);
			const said = at.words.details;
			if (!answer.ok) {
				// A refused value: what refused it, beside its box (a slug another page has, a value its Field doesn't take).
				const refused = (answer.data as { problems?: Problem[] } | undefined)?.problems ?? [];
				const text =
					answer.code === "ENTRY_SLUG_TAKEN"
						? said.slugTaken
						: refused[0]
							? key === "slug"
								? said.slugInvalid
								: problemWords(at.words, refused[0])
							: fill(at.words.saveFailed, { reason: answer.code });
				setProblems((was) => new Map(was).set(key, text));
				at.onSaving("failed");
				at.announce(text, true);
				return;
			}
			const saved = answer.data;
			setDetails(saved.details);
			if (change.fields) {
				setEntry((was) =>
					was ? { ...was, draft: { ...was.draft, fields: merged(was.draft.fields, change.fields ?? {}) } } : was,
				);
			}
			setProblems((was) => {
				const next = new Map(was);
				next.delete(key);
				for (const problem of saved.problems)
					next.set(keyOf(problem.at, saved.details), problemWords(at.words, problem));
				return next;
			});
			at.onSaving("saved");
			for (const problem of saved.problems) at.announce(problemWords(at.words, problem), true);
			// A page never published is found at its Draft's address, which its slug moves.
			if (change.slug !== undefined && !saved.details.published && saved.details.address.path) {
				at.onMoved(saved.details.address.path);
				at.announce(fill(said.moved, { path: saved.details.address.path }));
			}
		},
		[request],
	);

	const change = useCallback(
		(key: string, next: DetailsChange, wait = SAVE_AFTER_MS) => {
			queued.current.set(key, next);
			const timer = timers.current.get(key);
			if (timer) clearTimeout(timer);
			if (wait <= 0) void run(key);
			else
				timers.current.set(
					key,
					setTimeout(() => void run(key), wait),
				);
			setBusy((count) => count + 1);
		},
		[run],
	);

	const flush = useCallback(
		(key: string) => {
			const timer = timers.current.get(key);
			if (!timer) return;
			clearTimeout(timer);
			void run(key);
		},
		[run],
	);

	// Whatever waits is saved when the panel goes (another page, the panel collapsed).
	useEffect(() => {
		const waiting = timers.current;
		return () => {
			for (const [key, timer] of waiting) {
				clearTimeout(timer);
				void run(key);
			}
		};
	}, [run]);

	// Another page: its problems are its own.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only another item clears them.
	useEffect(() => setProblems(new Map()), [item, language]);

	return {
		status,
		reason,
		details,
		entry,
		postType,
		page,
		several: (page?.languages.length ?? 0) > 1,
		onPage,
		translations,
		targets,
		files,
		problems,
		change,
		flush,
		pending: (key) => queued.current.has(key) || inFlight.current.has(key),
		remember: (file) => setFiles((was) => ({ ...was, [file.id]: file })),
	};
}

/** A file of the Media library as the panels show it: its name, its alt text, a small picture. */
export function shownFile(media: MediaData): ShownFile {
	const webp = media.variants.filter((variant) => variant.format === "webp");
	const small = webp.find((variant) => variant.width >= 64) ?? webp.at(-1);
	return {
		id: media.id,
		name: media.fileName,
		alt: media.alt ?? null,
		thumbnail: media.kind === "image" ? (small?.url ?? media.url ?? null) : null,
	};
}

/** Values with a change's values put in (a Group's given Fields only). */
function merged(values: Readonly<Record<string, Json>>, change: Record<string, unknown>): Record<string, Json> {
	const next: Record<string, Json> = { ...values };
	for (const [key, value] of Object.entries(change)) {
		const was = next[key];
		next[key] =
			value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			was &&
			typeof was === "object" &&
			!Array.isArray(was)
				? (merged(was as Record<string, Json>, value as Record<string, unknown>) as Json)
				: (value as Json);
	}
	return next;
}

/** A refusal's code, as the Management API's client gives it. */
function codeOf(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : "network";
}
