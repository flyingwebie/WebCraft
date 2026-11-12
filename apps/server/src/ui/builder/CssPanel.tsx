import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import {
	AlignHorizontalJustifyCenterIcon,
	AlignHorizontalJustifyEndIcon,
	AlignHorizontalJustifyStartIcon,
	AlignHorizontalSpaceBetweenIcon,
	AlignVerticalJustifyCenterIcon,
	AlignVerticalJustifyEndIcon,
	AlignVerticalJustifyStartIcon,
	ArrowDownIcon,
	ArrowRightIcon,
	ArrowRightToLineIcon,
	Columns3Icon,
	EyeOffIcon,
	LayoutGridIcon,
	type LucideIcon,
	PlusIcon,
	SquareIcon,
	StretchVerticalIcon,
	WrapTextIcon,
	XIcon,
} from "lucide-react";
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { useAnnouncement } from "../content/reorder.tsx";
import { CSS_PROPERTIES, declarationOf, withDeclarationOf } from "../design-system/declarations.ts";
import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
import { CodeArea } from "./CodeArea.tsx";
import type { Catalogue } from "./model.ts";

/** Which CSS a save or preview changes: one piece of a Class, or the Site CSS. */
export type CssTarget =
	| { kind: "class"; classId: string; part: "styles" }
	| { kind: "class"; classId: string; part: "css" }
	| { kind: "class"; classId: string; part: "breakpoint"; breakpointId: string }
	| { kind: "site" };

/** A Class as the panel edits it: its CSS as text, the version a save names and how widely it is used. */
export type CssClass = {
	id: string;
	name: string;
	generated: boolean;
	styles: string;
	breakpoints: Record<string, string>;
	css: string;
	version: string;
	usage: { elements: number; pages: number };
};

/** What the panel reads for an element's Classes. */
export type CssData = {
	classes: CssClass[];
	breakpoints: { id: string; name: string; width: number }[];
	siteCss: { css: string; version: string };
	tokens: { property: string; value: string; kind: string }[];
};

/**
 * What a canvas gives the CSS panel to reach the Design system's Draft: Code mode through its Edit
 * mode endpoint, the Builder through the Management API. A refusal throws an error with the API's
 * `code` and `data` (`CHANGED_MEANWHILE` with `version`, `DESIGN_SYSTEM_INVALID` with `problems`).
 */
export type CssPanelPort = {
	/** The Classes by id, in that order (token utilities left out), with the breakpoints, the Site CSS and the tokens. */
	read(classIds: readonly string[]): Promise<CssData>;
	/** Saves one piece, based on the version it was read at. */
	save(target: CssTarget, text: string, version: string | null): Promise<{ text: string; version: string }>;
	/** Makes an empty Class in the Design system's Draft. */
	createClass(name: string): Promise<{ id: string; name: string }>;
	/** Renames a Class (a Generated Class that became a normal one). */
	renameClass(classId: string, name: string): Promise<void>;
	/** Shows unsaved CSS on the canvas, or (null) the Draft again. Optional: a canvas may only show saved CSS. */
	preview?(change: { target: CssTarget; text: string } | null): void;
};

/**
 * How a canvas mounts the CSS panel (ADR 0035: one panel for both canvases). The element and its
 * class list come from the canvas's current shared document, never from a CSS answer, so a late
 * answer can't change the tabs, the tree or the selection.
 */
export type CssPanelProps = {
	/** Await every pending CSS tab before leaving either canvas. False keeps the editor open. */
	departure?: { current: (() => Promise<boolean>) | null };
	/** Authored CSS changes, including layout buttons, invalidate a pending departure. */
	onEdit?(): void;
	port: CssPanelPort;
	/** The selected element, with its Classes and token utilities in its order; null when no element is selected. */
	element: { id: string; classes: readonly string[] } | null;
	/** The Site's Classes and token utilities, for names and suggestions. */
	catalogue: Pick<Catalogue, "classes" | "utilities">;
	/** Whether the element's class list can change (its source is writable and connected). */
	editable: boolean;
	/** The element comes from a Module's Component: the panel says why its Classes can't change. */
	fromModule?: boolean;
	/** Changes the element's class list through its current shared document; answers why not, if it can't. */
	onClasses(classIds: string[], announcement: string): string | undefined;
	/**
	 * Reads the canvas's Class catalogue again, through its source's owner, after the panel made,
	 * renamed or restyled a Class: the panel never hands the canvas a Class copy of its own.
	 */
	refreshCatalogue(): Promise<void>;
	/** Changes whenever the Design system's Draft changed elsewhere: the panel reads it again. */
	designVersion?: number;
};

type View = "all" | "own" | string;
type Problem = { at?: string; message: string; line?: number };

const UTILITY = "u:";
const SITE = "site";

/** Where unsaved text is kept: one place per piece of CSS, so switching tabs or widths keeps it. */
function keyOf(target: CssTarget): string {
	if (target.kind === "site") return SITE;
	return target.part === "breakpoint" ? `${target.classId}:${target.breakpointId}` : `${target.classId}:${target.part}`;
}

function savedText(target: CssTarget, data: CssData | null, known: ReadonlyMap<string, CssClass>): string | null {
	if (target.kind === "site") return data?.siteCss.css ?? null;
	const each = known.get(target.classId);
	if (!each) return null;
	if (target.part === "styles") return each.styles;
	if (target.part === "css") return each.css;
	return each.breakpoints[target.breakpointId] ?? "";
}

/** The layout row's buttons: the property, its word, and each value with its icon. */
const LAYOUT: {
	property: string;
	word: "display" | "direction" | "justify" | "align" | "wrap";
	values: [string, LucideIcon][];
}[] = [
	{
		property: "display",
		word: "display",
		values: [
			["block", SquareIcon],
			["flex", Columns3Icon],
			["grid", LayoutGridIcon],
			["none", EyeOffIcon],
		],
	},
	{
		property: "flex-direction",
		word: "direction",
		values: [
			["row", ArrowRightIcon],
			["column", ArrowDownIcon],
		],
	},
	{
		property: "justify-content",
		word: "justify",
		values: [
			["flex-start", AlignHorizontalJustifyStartIcon],
			["center", AlignHorizontalJustifyCenterIcon],
			["flex-end", AlignHorizontalJustifyEndIcon],
			["space-between", AlignHorizontalSpaceBetweenIcon],
		],
	},
	{
		property: "align-items",
		word: "align",
		values: [
			["flex-start", AlignVerticalJustifyStartIcon],
			["center", AlignVerticalJustifyCenterIcon],
			["flex-end", AlignVerticalJustifyEndIcon],
			["stretch", StretchVerticalIcon],
		],
	},
	{
		property: "flex-wrap",
		word: "wrap",
		values: [
			["wrap", WrapTextIcon],
			["nowrap", ArrowRightToLineIcon],
		],
	},
];

/** One suggestion: what it shows, and the text that replaces what was typed (`$0` marks the caret). */
type Suggestion = { label: string; detail?: string; insert: string };

/** Equal columns as the layout row writes them, `repeat(3, minmax(0, 1fr))`, or plainly, `repeat(3, 1fr)`. */
const COLUMNS = /^repeat\(\s*(\d+)\s*,\s*(?:minmax\(\s*0\s*,\s*1fr\s*\)|1fr)\s*\)$/i;

/**
 * The CSS panel (ADR 0009, ADR 0035; decided in #120): one tab per Class of the selected element, in
 * the order of its `class` attribute, then the Site CSS. A Class tab edits the Class's styles for all
 * widths or from one breakpoint up, or its own CSS (selectors such as `&:hover`), warns how widely the
 * Class is used, and offers a layout row of plain declarations. Classes are added (an unknown name
 * makes an empty Class first) and removed through the element's class list in its shared document,
 * never deleted. Token utilities show as removable chips. A Generated Class becomes a normal one when
 * edited, with an optional rename. The panel never shows or accepts `@layer`: it says which cascade
 * layer each tab's CSS lands in.
 */
export function CssPanel({
	port,
	element,
	catalogue,
	editable,
	fromModule = false,
	onClasses,
	refreshCatalogue,
	designVersion = 0,
	departure,
	onEdit,
}: CssPanelProps) {
	const t = useT();
	const id = useId();
	const [announcement, announce] = useAnnouncement();
	const [data, setData] = useState<CssData | null>(null);
	const [known, setKnown] = useState<ReadonlyMap<string, CssClass>>(new Map());
	const [picked, setPicked] = useState<{ element: string | null; tab: string } | null>(null);
	const [view, setView] = useState<View>("all");
	/** Each pending piece keeps the version it was started from, until that text has been saved. */
	const [drafts, setDrafts] = useState<Readonly<Record<string, { text: string; version: string | null }>>>({});
	const [problems, setProblems] = useState<Problem[]>([]);
	const [conflict, setConflict] = useState<{ key: string; version: string } | null>(null);
	const [renaming, setRenaming] = useState<{ classId: string; name: string } | null>(null);
	const [adding, setAdding] = useState(false);
	const [addName, setAddName] = useState("");
	const [addProblem, setAddProblem] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const editRevision = useRef(0);
	const saveActive = useRef(false);
	const [suggest, setSuggest] = useState<{ from: number; to: number; items: Suggestion[]; active: number } | null>(
		null,
	);
	const lastClass = useRef<string | null>(null);
	const latest = useRef({ element, onClasses });
	latest.current = { element, onClasses };
	const readRun = useRef(0);
	const dataRun = useRef(0);
	const classRuns = useRef(new Map<string, number>());
	const area = useRef<HTMLTextAreaElement>(null);
	const tabRefs = useRef(new Map<string, HTMLButtonElement>());
	const addInput = useRef<HTMLInputElement>(null);
	const addButton = useRef<HTMLButtonElement>(null);
	const renameInput = useRef<HTMLInputElement>(null);

	const classIds = element?.classes ?? [];
	const nameOf = (classId: string) =>
		known.get(classId)?.name ??
		catalogue.classes.find((each) => each.id === classId)?.name ??
		catalogue.utilities.find((each) => each.id === classId)?.name ??
		classId;
	const isClass = (classId: string) =>
		!classId.startsWith(UTILITY) && (known.has(classId) || catalogue.classes.some((each) => each.id === classId));
	const classTabs = classIds.filter(isClass);
	const utilities = classIds.filter((classId) => classId.startsWith(UTILITY));
	const classKey = classIds.join(" ");

	// The tab: the one picked for this element, else the last Class edited when it has it, else its first Class.
	const elementId = element?.id ?? null;
	const moduleNotice = !!element && !editable && fromModule;
	let tab: string;
	if (picked && picked.element === elementId && (picked.tab === SITE || classTabs.includes(picked.tab)))
		tab = picked.tab;
	else tab = lastClass.current && classTabs.includes(lastClass.current) ? lastClass.current : (classTabs[0] ?? SITE);
	const chosen = tab === SITE ? undefined : known.get(tab);
	const breakpoints = data?.breakpoints ?? [];
	const shownView: View =
		view === "all" || view === "own" || breakpoints.some((each) => each.id === view) ? view : "all";
	const target: CssTarget =
		tab === SITE
			? { kind: "site" }
			: shownView === "all"
				? { kind: "class", classId: tab, part: "styles" }
				: shownView === "own"
					? { kind: "class", classId: tab, part: "css" }
					: { kind: "class", classId: tab, part: "breakpoint", breakpointId: shownView };
	const key = keyOf(target);
	const saved = savedText(target, data, known);
	const text = drafts[key]?.text ?? saved ?? "";
	const dirty = drafts[key] !== undefined && drafts[key]?.text !== saved;
	const hasLayer = /@layer\b/i.test(text);

	const read = useCallback(async () => {
		const run = ++readRun.current;
		const fresh = await port.read(classKey ? classKey.split(" ") : []);
		// An answer arriving late never replaces what a later read supplied: each Class, and the rest
		// (breakpoints, Site CSS, tokens), keeps the newest read that answered it. The tabs never come
		// from an answer, only from the element's current shared document.
		if (run > dataRun.current) {
			dataRun.current = run;
			setData(fresh);
		}
		const newer = fresh.classes.filter((each) => run > (classRuns.current.get(each.id) ?? 0));
		for (const each of newer) classRuns.current.set(each.id, run);
		if (newer.length)
			setKnown((before) => {
				const next = new Map(before);
				for (const each of newer) next.set(each.id, each);
				return next;
			});
	}, [port, classKey]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a change to the Design system's Draft elsewhere is read again.
	useEffect(() => {
		read().catch((failure) => announce(t(errorMessage(failure))));
	}, [read, designVersion]);

	// The canvas previews what is typed (nothing that would be refused), and the Draft again once saved.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the target is named by its key.
	useEffect(() => {
		if (!port.preview) return;
		const timer = setTimeout(() => port.preview?.(dirty && !hasLayer ? { target, text } : null), 250);
		return () => clearTimeout(timer);
	}, [port, key, text, dirty, hasLayer]);

	// An unfinished + form or rename prompt belongs to the element it was opened on: another element closes it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only a change of element resets them.
	useEffect(() => {
		setRenaming(null);
		setAdding(false);
		setAddName("");
		setAddProblem(null);
		setSuggest(null);
	}, [elementId]);

	useEffect(() => {
		if (renaming) renameInput.current?.focus();
	}, [renaming]);
	useEffect(() => {
		if (adding) addInput.current?.focus();
	}, [adding]);

	const label =
		tab === SITE
			? t("builder.css.siteCss")
			: shownView === "all"
				? `.${nameOf(tab)}`
				: shownView === "own"
					? t("builder.css.ownOf", { name: `.${nameOf(tab)}` })
					: t("builder.css.atWidth", {
							name: `.${nameOf(tab)}`,
							width: breakpoints.find((each) => each.id === shownView)?.name ?? "",
						});

	const pick = (next: string, focus = false) => {
		setPicked({ element: elementId, tab: next });
		if (next !== SITE) lastClass.current = next;
		setSuggest(null);
		setProblems([]);
		if (focus) tabRefs.current.get(next)?.focus();
	};

	const change = (value: string) => {
		editRevision.current++;
		onEdit?.();
		setDrafts((before) => ({
			...before,
			[key]: {
				text: value,
				version: before[key]
					? before[key].version
					: target.kind === "site"
						? (data?.siteCss.version ?? null)
						: (chosen?.version ?? null),
			},
		}));
		if (tab !== SITE) lastClass.current = tab;
		setProblems(/@layer\b/i.test(value) ? [{ message: t("builder.css.noLayer") }] : []);
	};

	const removeClass = (classId: string) => {
		if (!editable) return;
		const problem = onClasses(
			classIds.filter((each) => each !== classId),
			t("builder.css.removed", { name: `.${nameOf(classId)}` }),
		);
		announce(problem ?? t("builder.css.removed", { name: `.${nameOf(classId)}` }));
		if (!problem && tab === classId) {
			const at = classTabs.indexOf(classId);
			const next = classTabs.filter((each) => each !== classId)[Math.max(0, at - 1)] ?? SITE;
			setPicked({ element: elementId, tab: next });
			requestAnimationFrame(() => tabRefs.current.get(next)?.focus());
		}
	};

	const removeUtility = (classId: string) => {
		if (!editable) return;
		const message = t("builder.css.tokenRemoved", { name: nameOf(classId) });
		announce(
			onClasses(
				classIds.filter((each) => each !== classId),
				message,
			) ?? message,
		);
	};

	const add = async (event: FormEvent) => {
		event.preventDefault();
		setAddProblem(null);
		const name = addName.trim().replace(/^\./, "");
		if (!name || !element) return;
		const found = catalogue.classes.find((each) => each.name === name);
		if (found) {
			if (classIds.includes(found.id)) return setAddProblem(t("builder.css.already", { name }));
			const problem = onClasses([...classIds, found.id], t("builder.css.added", { name }));
			if (problem) return setAddProblem(problem);
			lastClass.current = found.id;
			setPicked({ element: elementId, tab: found.id });
			announce(t("builder.css.added", { name }));
		} else {
			try {
				const created = await port.createClass(name);
				await refreshCatalogue();
				// Added to the element's class list as it is now, never to the one read before the request.
				const now = latest.current;
				if (now.element?.id !== elementId) return announce(t("builder.css.created", { name }));
				if (!now.element.classes.includes(created.id)) {
					const problem = now.onClasses([...now.element.classes, created.id], t("builder.css.created", { name }));
					if (problem) return setAddProblem(problem);
				}
				lastClass.current = created.id;
				setPicked({ element: elementId, tab: created.id });
				announce(t("builder.css.created", { name }));
			} catch (failure) {
				const listed = (failure as { data?: { problems?: Problem[] } }).data?.problems;
				return setAddProblem(listed?.length ? listed.map((each) => each.message).join(" ") : t(errorMessage(failure)));
			}
		}
		setAddName("");
		setAdding(false);
		requestAnimationFrame(() => addButton.current?.focus());
	};

	const departureNow = useRef<() => Promise<boolean>>(async () => false);
	departureNow.current = async () => {
		if (saveActive.current) return false;
		if (!Object.keys(drafts).length) return true;
		saveActive.current = true;
		const revision = editRevision.current;
		const snapshot = drafts;
		const versions = new Map<string, { before: string | null; after: string }>();
		setSaving(true);
		try {
			for (const [draftKey, pending] of Object.entries(snapshot)) {
				const [classId = "", part = ""] = draftKey.split(":");
				const which: CssTarget =
					draftKey === SITE
						? { kind: "site" }
						: part === "styles" || part === "css"
							? { kind: "class", classId, part }
							: { kind: "class", classId, part: "breakpoint", breakpointId: part };
				if (pending.text === savedText(which, data, known)) continue;
				const base = pending.version;
				const own = versions.get(classId);
				const saved = await port.save(which, pending.text, own?.before === base ? own.after : base);
				versions.set(classId, { before: base, after: saved.version });
				setDrafts((before) =>
					before[draftKey] ? { ...before, [draftKey]: { ...before[draftKey], version: saved.version } } : before,
				);
			}
			await read();
			setDrafts((before) =>
				Object.fromEntries(
					Object.entries(before).filter(([draftKey, pending]) => pending.text !== snapshot[draftKey]?.text),
				),
			);
			await refreshCatalogue();
			setProblems([]);
			return editRevision.current === revision;
		} catch (failure) {
			setProblems([{ message: t(errorMessage(failure)) }]);
			return false;
		} finally {
			saveActive.current = false;
			setSaving(false);
		}
	};
	useEffect(() => {
		if (!departure) return;
		departure.current = () => departureNow.current();
		return () => {
			departure.current = null;
		};
	}, [departure]);

	const save = async (over?: string) => {
		if (saveActive.current || saved === null) return;
		if (!dirty && over === undefined) return;
		if (hasLayer) {
			setProblems([{ message: t("builder.css.noLayer") }]);
			return;
		}
		const version =
			over ??
			(drafts[key]
				? drafts[key].version
				: target.kind === "site"
					? (data?.siteCss.version ?? null)
					: (chosen?.version ?? null));
		saveActive.current = true;
		const wasGenerated = target.kind === "class" && !!chosen?.generated && text !== saved;
		setSaving(true);
		try {
			const stored = await port.save(target, text, version);
			setDrafts((before) => (before[key] ? { ...before, [key]: { ...before[key], version: stored.version } } : before));
			await read();
			setDrafts((before) => {
				if (before[key]?.text !== text) return before;
				const { [key]: _, ...rest } = before;
				return rest;
			});
			setProblems([]);
			setConflict(null);
			announce(t("builder.css.saved", { name: label }));
			await refreshCatalogue();
			if (wasGenerated && chosen) setRenaming({ classId: chosen.id, name: chosen.name });
		} catch (failure) {
			const refused = failure as { code?: string; data?: { version?: string; problems?: Problem[] } };
			if (refused.code === "CHANGED_MEANWHILE" && refused.data?.version) {
				setConflict({ key, version: refused.data.version });
			} else if (refused.code === "DESIGN_SYSTEM_INVALID" && refused.data?.problems?.length) {
				setProblems(refused.data.problems);
			} else setProblems([{ message: t(errorMessage(failure)) }]);
		} finally {
			saveActive.current = false;
			setSaving(false);
		}
	};

	const reloadTheirs = async () => {
		setDrafts((before) => {
			const { [key]: _, ...rest } = before;
			return rest;
		});
		setConflict(null);
		await read().catch((failure) => announce(t(errorMessage(failure))));
		area.current?.focus();
	};

	const rename = async (event: FormEvent) => {
		event.preventDefault();
		if (!renaming) return;
		const name = renaming.name.trim().replace(/^\./, "");
		try {
			if (name && name !== known.get(renaming.classId)?.name) {
				await port.renameClass(renaming.classId, name);
				await refreshCatalogue();
				await read();
				announce(t("builder.css.renamed", { name: `.${name}` }));
			}
			setRenaming(null);
			area.current?.focus();
		} catch (failure) {
			const listed = (failure as { data?: { problems?: Problem[] } }).data?.problems;
			setProblems(listed?.length ? listed : [{ message: t(errorMessage(failure)) }]);
		}
	};

	const layout = (property: string, value: string) => {
		change(withDeclarationOf(text, property, value));
		announce(t("builder.css.layoutValue", { property, value }));
	};

	// Suggestions: the design tokens' variables after `var(` or `--` in a value, CSS properties at the
	// start of a declaration; Ctrl+Space asks for them anywhere.
	const tokens = data?.tokens ?? [];
	const suggestAt = (value: string, caret: number, asked = false) => {
		const line = value.slice(value.lastIndexOf("\n", caret - 1) + 1, caret);
		const variable = /(--[\w-]*)$/.exec(line);
		if (variable && /var\(\s*--[\w-]*$|:\s*[^;]*--[\w-]*$/.test(line)) {
			const typed = variable[1] ?? "";
			const items = tokens
				.filter((each) => each.property.startsWith(typed))
				.slice(0, 40)
				.map((each) => ({
					label: each.property,
					detail: each.value,
					insert: /var\(\s*--[\w-]*$/.test(line) ? each.property : `var(${each.property})`,
				}));
			return setSuggest(items.length ? { from: caret - typed.length, to: caret, items, active: 0 } : null);
		}
		const property = /^\s*([a-z-]*)$/.exec(line);
		if (property && (asked || (property[1] ?? "").length > 0)) {
			const typed = property[1] ?? "";
			const items = CSS_PROPERTIES.filter((each) => each.startsWith(typed)).map((each) => ({
				label: each,
				insert: `${each}: $0;`,
			}));
			return setSuggest(items.length ? { from: caret - typed.length, to: caret, items, active: 0 } : null);
		}
		setSuggest(null);
	};
	const accept = (item: Suggestion) => {
		if (!suggest) return;
		const before = text.slice(0, suggest.from);
		const at = item.insert.indexOf("$0");
		const insert = item.insert.replace("$0", "");
		change(`${before}${insert}${text.slice(suggest.to)}`);
		setSuggest(null);
		const caret = before.length + (at < 0 ? insert.length : at);
		requestAnimationFrame(() => area.current?.setSelectionRange(caret, caret));
	};
	const editorKeys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
			event.preventDefault();
			void save();
			return;
		}
		if (event.ctrlKey && event.key === " ") {
			event.preventDefault();
			suggestAt(text, event.currentTarget.selectionStart, true);
			return;
		}
		if (!suggest) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const step = event.key === "ArrowDown" ? 1 : -1;
			setSuggest({ ...suggest, active: (suggest.active + step + suggest.items.length) % suggest.items.length });
		} else if (event.key === "Enter" || event.key === "Tab") {
			const item = suggest.items[suggest.active];
			if (item) {
				event.preventDefault();
				accept(item);
			}
		} else if (event.key === "Escape") {
			event.preventDefault();
			setSuggest(null);
		}
	};

	const tabKeys = (event: KeyboardEvent<HTMLButtonElement>, current: string) => {
		const all = [...classTabs, SITE];
		const at = all.indexOf(current);
		const go = (next: string | undefined) => {
			if (next === undefined) return;
			event.preventDefault();
			pick(next, true);
		};
		if (event.key === "ArrowRight") go(all[(at + 1) % all.length]);
		else if (event.key === "ArrowLeft") go(all[(at - 1 + all.length) % all.length]);
		else if (event.key === "Home") go(all[0]);
		else if (event.key === "End") go(all.at(-1));
		else if ((event.key === "Delete" || event.key === "Backspace") && current !== SITE && editable) {
			event.preventDefault();
			removeClass(current);
		}
	};

	const usage = chosen?.usage;
	const suggestions = useMemo(
		() =>
			catalogue.classes
				.filter((each) => !each.generated && !classIds.includes(each.id))
				.map((each) => each.name)
				.sort((a, b) => a.localeCompare(b)),
		[catalogue.classes, classIds],
	);
	const columns = COLUMNS.exec(declarationOf(text, "grid-template-columns") ?? "")?.[1] ?? "";
	const showLayout = tab !== SITE && shownView !== "own";
	const problemLines = new Set(problems.flatMap((problem) => (problem.line ? [problem.line] : [])));
	const panelId = `${id}-panel`;
	const listboxId = `${id}-suggest`;

	return (
		<div className="css-panel flex min-h-0 flex-1 flex-col gap-2 text-sm" data-css-panel="">
			{utilities.length > 0 ? (
				<ul aria-label={t("builder.css.tokens")} className="flex flex-wrap gap-1">
					{utilities.map((classId) => (
						<li key={classId}>
							<span className="bg-muted text-foreground inline-flex items-center gap-1 rounded-full border py-0.5 ps-2 pe-0.5 font-mono text-xs">
								{nameOf(classId)}
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									className="rounded-full"
									disabled={!editable}
									aria-label={t("builder.css.removeToken", { name: nameOf(classId) })}
									onClick={() => removeUtility(classId)}
								>
									<XIcon aria-hidden="true" />
								</Button>
							</span>
						</li>
					))}
				</ul>
			) : null}
			<div className="flex flex-wrap items-center gap-1">
				<div role="tablist" aria-label={t("builder.css.tabs")} className="flex flex-wrap items-center gap-1">
					{classTabs.map((classId) => {
						const generated =
							known.get(classId)?.generated ?? catalogue.classes.find((each) => each.id === classId)?.generated;
						const name = nameOf(classId);
						return (
							<button
								key={classId}
								ref={(node) => {
									if (node) tabRefs.current.set(classId, node);
									else tabRefs.current.delete(classId);
								}}
								type="button"
								role="tab"
								id={`${id}-tab-${classId}`}
								aria-selected={tab === classId}
								aria-controls={panelId}
								aria-keyshortcuts={editable ? "Delete" : undefined}
								aria-describedby={editable ? `${id}-remove-hint` : undefined}
								tabIndex={tab === classId ? 0 : -1}
								onClick={() => pick(classId)}
								onKeyDown={(event) => tabKeys(event, classId)}
								className="hover:bg-muted aria-selected:bg-secondary aria-selected:text-secondary-foreground focus-visible:ring-ring/50 inline-flex items-center gap-1.5 rounded-md border px-2 py-1 outline-none focus-visible:ring-3"
							>
								<span className="font-mono">.{name}</span>
								{generated ? (
									<Badge variant="outline" className="px-1 py-0 text-[10px]">
										{t("builder.css.generated")}
									</Badge>
								) : null}
								<span aria-hidden="true" className="text-muted-foreground text-[10px] uppercase">
									{t("builder.css.layerClasses")}
								</span>
								{editable ? (
									// The pointer's way to remove; the keyboard's is Delete on the focused tab.
									<span
										aria-hidden="true"
										title={t("builder.css.removeClass", { name: `.${name}` })}
										data-remove-class={classId}
										className="hover:bg-muted-foreground/20 -me-1 rounded p-0.5"
										onClick={(event) => {
											event.stopPropagation();
											removeClass(classId);
										}}
									>
										<XIcon className="size-3" />
									</span>
								) : null}
							</button>
						);
					})}
					<button
						ref={(node) => {
							if (node) tabRefs.current.set(SITE, node);
							else tabRefs.current.delete(SITE);
						}}
						type="button"
						role="tab"
						id={`${id}-tab-site`}
						aria-selected={tab === SITE}
						aria-controls={panelId}
						tabIndex={tab === SITE ? 0 : -1}
						onClick={() => pick(SITE)}
						onKeyDown={(event) => tabKeys(event, SITE)}
						className="hover:bg-muted aria-selected:bg-secondary aria-selected:text-secondary-foreground focus-visible:ring-ring/50 inline-flex items-center gap-1.5 rounded-md border px-2 py-1 outline-none focus-visible:ring-3"
					>
						<span>{t("builder.css.siteCss")}</span>
						<span aria-hidden="true" className="text-muted-foreground text-[10px] uppercase">
							{t("builder.css.layerCustom")}
						</span>
					</button>
				</div>
				{element ? (
					<Button
						ref={addButton}
						type="button"
						variant="ghost"
						size="icon-sm"
						disabled={!editable}
						aria-label={t("builder.css.add")}
						aria-describedby={moduleNotice ? `${id}-read-only` : undefined}
						aria-expanded={adding}
						aria-controls={`${id}-add`}
						onClick={() => setAdding(!adding)}
					>
						<PlusIcon aria-hidden="true" />
					</Button>
				) : null}
			</div>
			{moduleNotice ? (
				<p id={`${id}-read-only`} className="text-muted-foreground text-xs">
					{t("builder.css.readOnly")}
				</p>
			) : null}
			<p id={`${id}-remove-hint`} hidden>
				{t("builder.css.removeHint")}
			</p>
			{adding && element ? (
				<form id={`${id}-add`} onSubmit={add} className="flex flex-wrap items-end gap-2">
					<div className="grid gap-1">
						<label htmlFor={`${id}-add-name`} className="text-xs font-medium">
							{t("builder.css.addName")}
						</label>
						<Input
							ref={addInput}
							id={`${id}-add-name`}
							list={`${id}-add-list`}
							value={addName}
							autoComplete="off"
							spellCheck={false}
							aria-describedby={`${id}-add-help${addProblem ? ` ${id}-add-problem` : ""}`}
							aria-invalid={addProblem ? true : undefined}
							className="h-8 w-48 font-mono text-xs"
							onChange={(event) => setAddName(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Escape") {
									event.preventDefault();
									setAdding(false);
									addButton.current?.focus();
								}
							}}
						/>
						<datalist id={`${id}-add-list`}>
							{suggestions.map((name) => (
								<option key={name} value={name} />
							))}
						</datalist>
					</div>
					<Button type="submit" size="sm">
						{t("builder.css.addSubmit")}
					</Button>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						onClick={() => {
							setAdding(false);
							addButton.current?.focus();
						}}
					>
						{t("builder.css.cancel")}
					</Button>
					<p id={`${id}-add-help`} className="text-muted-foreground w-full text-xs">
						{t("builder.css.addHelp")}
					</p>
					{addProblem ? (
						<p id={`${id}-add-problem`} role="alert" className="text-destructive w-full text-xs">
							{addProblem}
						</p>
					) : null}
				</form>
			) : null}
			<div
				id={panelId}
				role="tabpanel"
				aria-labelledby={tab === SITE ? `${id}-tab-site` : `${id}-tab-${tab}`}
				className="flex min-h-0 flex-1 flex-col gap-2"
			>
				<p className="text-muted-foreground text-xs">
					{t("builder.css.layer", {
						layer: tab === SITE ? t("builder.css.layerCustom") : t("builder.css.layerClasses"),
					})}
					{tab === SITE
						? ` · ${element ? (classTabs.length ? "" : t("builder.css.noClass")) : t("builder.css.noElement")}`
						: ""}
				</p>
				{tab !== SITE ? (
					<>
						{usage ? (
							<p className="text-xs">
								<strong>{t("builder.css.usage", usage)}</strong>{" "}
								<span className="text-muted-foreground">{t("builder.css.usageHelp")}</span>
							</p>
						) : null}
						<fieldset className="flex flex-wrap gap-1">
							<legend className="sr-only">{t("builder.css.width")}</legend>
							{[
								{ value: "all", name: t("builder.css.allWidths") },
								...breakpoints.map((each) => ({
									value: each.id,
									name: t("builder.css.fromBreakpoint", { name: each.name, width: each.width }),
								})),
							].map((each) => (
								<Button
									key={each.value}
									type="button"
									size="xs"
									variant={shownView === each.value ? "secondary" : "ghost"}
									aria-pressed={shownView === each.value}
									onClick={() => setView(each.value)}
								>
									{each.name}
								</Button>
							))}
							<Button
								type="button"
								size="xs"
								variant={shownView === "own" ? "secondary" : "ghost"}
								aria-pressed={shownView === "own"}
								title={t("builder.css.ownCssHelp")}
								onClick={() => setView(shownView === "own" ? "all" : "own")}
							>
								{t("builder.css.ownCss")}
							</Button>
						</fieldset>
					</>
				) : null}
				{showLayout ? (
					<fieldset className="flex flex-wrap items-center gap-2">
						<legend className="sr-only">{t("builder.css.layout")}</legend>
						{LAYOUT.map((group) => (
							<fieldset key={group.property} className="flex">
								<legend className="sr-only">{t(`builder.css.${group.word}`)}</legend>
								{group.values.map(([value, Icon]) => {
									const name = t("builder.css.layoutValue", { property: t(`builder.css.${group.word}`), value });
									return (
										<Button
											key={value}
											type="button"
											size="icon-xs"
											variant={declarationOf(text, group.property) === value ? "secondary" : "ghost"}
											aria-pressed={declarationOf(text, group.property) === value}
											aria-label={name}
											title={name}
											disabled={saved === null}
											onClick={() => layout(group.property, value)}
										>
											<Icon aria-hidden="true" />
										</Button>
									);
								})}
							</fieldset>
						))}
						<LayoutField
							key={`gap-${key}`}
							label={t("builder.css.gap")}
							value={declarationOf(text, "gap") ?? ""}
							disabled={saved === null}
							onCommit={(value) => value && layout("gap", value)}
						/>
						<LayoutField
							key={`columns-${key}`}
							label={t("builder.css.columns")}
							value={columns}
							numeric
							disabled={saved === null}
							onCommit={(value) => {
								const count = Number.parseInt(value, 10);
								if (!Number.isInteger(count) || count < 1 || count > 24) return;
								let next = withDeclarationOf(text, "display", "grid");
								next = withDeclarationOf(next, "grid-template-columns", `repeat(${count}, minmax(0, 1fr))`);
								change(next);
								announce(t("builder.css.layoutValue", { property: t("builder.css.columns"), value: count }));
							}}
						/>
					</fieldset>
				) : null}
				{renaming ? (
					<form
						onSubmit={rename}
						aria-labelledby={`${id}-rename-title`}
						aria-describedby={`${id}-rename-help`}
						className="grid gap-2 rounded-md border p-2"
					>
						<p id={`${id}-rename-title`} className="font-medium">
							{t("builder.css.renameTitle", { name: `.${known.get(renaming.classId)?.name ?? renaming.name}` })}
						</p>
						<p id={`${id}-rename-help`} className="text-muted-foreground text-xs">
							{t("builder.css.renameHelp")}
						</p>
						<div className="flex flex-wrap items-end gap-2">
							<div className="grid gap-1">
								<label htmlFor={`${id}-rename`} className="text-xs font-medium">
									{t("builder.css.renameLabel")}
								</label>
								<Input
									ref={renameInput}
									id={`${id}-rename`}
									value={renaming.name}
									spellCheck={false}
									className="h-8 w-48 font-mono text-xs"
									onChange={(event) => setRenaming({ ...renaming, name: event.target.value })}
								/>
							</div>
							<Button type="submit" size="sm">
								{t("builder.css.rename")}
							</Button>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								onClick={() => {
									setRenaming(null);
									area.current?.focus();
								}}
							>
								{t("builder.css.keepName")}
							</Button>
						</div>
					</form>
				) : null}
				{conflict && conflict.key === key ? (
					<div role="alert" className="border-destructive/40 grid gap-2 rounded-md border p-2">
						<p>{t("builder.css.conflict")}</p>
						<div className="flex gap-2">
							<Button type="button" size="sm" variant="outline" onClick={() => void reloadTheirs()}>
								{t("builder.css.reload")}
							</Button>
							<Button type="button" size="sm" variant="destructive" onClick={() => void save(conflict.version)}>
								{t("builder.css.overwrite")}
							</Button>
						</div>
					</div>
				) : null}
				<div className="relative flex min-h-32 flex-1 flex-col">
					<CodeArea
						ref={area}
						id={`${id}-text`}
						aria-label={t("builder.css.cssOf", { name: label })}
						value={text}
						readOnly={saved === null}
						aria-busy={saved === null}
						aria-invalid={problems.length > 0 ? true : undefined}
						aria-describedby={problems.length > 0 ? `${id}-problems` : undefined}
						aria-autocomplete="list"
						aria-controls={suggest ? listboxId : undefined}
						aria-activedescendant={suggest ? `${listboxId}-${suggest.active}` : undefined}
						placeholder={saved === null ? t("builder.css.loading") : undefined}
						problemLines={problemLines}
						onChange={(event) => {
							change(event.target.value);
							suggestAt(event.target.value, event.target.selectionStart);
						}}
						onKeyDown={editorKeys}
						onBlur={() => setSuggest(null)}
					/>
					{suggest ? (
						<div
							id={listboxId}
							role="listbox"
							aria-label={t("builder.css.suggestions")}
							className="bg-popover text-popover-foreground absolute inset-x-2 bottom-2 z-10 max-h-48 overflow-auto rounded-md border p-1 shadow-md"
							onMouseDown={(event) => event.preventDefault()}
						>
							{suggest.items.map((item, index) => (
								// biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/useFocusableInteractive: the textarea keeps focus; its arrow keys and Enter choose options (aria-activedescendant).
								<div
									key={item.label}
									id={`${listboxId}-${index}`}
									role="option"
									aria-selected={index === suggest.active}
									className="aria-selected:bg-muted flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1 font-mono text-xs"
									onClick={() => accept(item)}
								>
									<span>{item.label}</span>
									{item.detail ? <span className="text-muted-foreground truncate">{item.detail}</span> : null}
								</div>
							))}
						</div>
					) : null}
				</div>
				{problems.length > 0 ? (
					<ul
						id={`${id}-problems`}
						aria-label={t("builder.css.problems")}
						className="text-destructive grid gap-1 text-xs"
					>
						{problems.map((problem, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: problems come in the order they are found.
							<li key={index}>
								{problem.line
									? t("builder.css.problemAt", { line: problem.line, message: problem.message })
									: problem.message}
							</li>
						))}
					</ul>
				) : null}
				{dirty ? (
					// Shown while there is something to save, so the canvas's own Save stays the only one otherwise.
					<div className="flex items-center gap-2">
						<Button
							type="button"
							size="sm"
							disabled={saving || saved === null}
							onClick={() => void save()}
							aria-describedby={`${id}-unsaved`}
						>
							{saving ? t("builder.css.saving") : t("builder.css.save")}
						</Button>
						<span id={`${id}-unsaved`} className="text-muted-foreground text-xs">
							{t("builder.css.unsaved")}
						</span>
					</div>
				) : null}
			</div>
			<p role="status" className="sr-only">
				{announcement}
			</p>
		</div>
	);
}

/** A small field of the layout row, applied on Enter or when it loses focus. */
function LayoutField({
	label,
	value,
	numeric = false,
	disabled,
	onCommit,
}: {
	label: string;
	value: string;
	numeric?: boolean;
	disabled: boolean;
	onCommit(value: string): void;
}) {
	const id = useId();
	const [typed, setTyped] = useState(value);
	const shown = useRef(value);
	if (shown.current !== value) {
		shown.current = value;
		setTyped(value);
	}
	const commit = () => {
		if (typed.trim() !== value) onCommit(typed.trim());
	};
	return (
		<span className="inline-flex items-center gap-1">
			<label htmlFor={id} className="text-xs">
				{label}
			</label>
			<Input
				id={id}
				value={typed}
				disabled={disabled}
				inputMode={numeric ? "numeric" : undefined}
				spellCheck={false}
				className="h-7 w-20 font-mono text-xs"
				onChange={(event) => setTyped(event.target.value)}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						commit();
					}
				}}
			/>
		</span>
	);
}
