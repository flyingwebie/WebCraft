import type { BuilderCatalogue, CommandMenuData, Permission } from "@webcraft/core";
import { readExpression, type TreeNode } from "@webcraft/renderer/builder";
import {
	ArrowLeftIcon,
	CodeXmlIcon,
	CommandIcon,
	ComponentIcon,
	FileTextIcon,
	LayoutTemplateIcon,
	type LucideIcon,
	MapPinIcon,
	SearchIcon,
	SquarePlusIcon,
	VariableIcon,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";

import type { Command } from "../../builder/commands.ts";
import { recentCommands, rememberCommand, visibleCommands } from "../../builder/commands.ts";
import { ariaKeys, chordText, type SpokenKey, shortcutSpoken, shortcutText } from "../../builder/shortcuts.ts";
import { childLists, newElement, withNewIds } from "../../builder/tree.ts";
import { formatTarget } from "../../code-format/targets.ts";
import { fill } from "../api.ts";
import { KIND_ICONS } from "../bottom-bar/InsertRow.tsx";
import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";
import { anchorName, type InsertKind, KIND_TAGS, type Landing } from "../editing/insert.ts";
import { managementApi } from "../management.ts";
import type { MenuHost } from "./host.ts";
import type { InsertQuestion, MenuRequest, MenuTab } from "./state.ts";

/** A row of the menu: a command, with what the frame draws beside its name. */
type Row = Command & { icon: LucideIcon | typeof KIND_ICONS.section; detail?: string; tag?: string };

/** What Insert is asking now: which Loop or Form, or the Condition's test; to insert or to wrap the selection. */
type Asking = { question: InsertQuestion; mode: "insert" | "wrap" };

const ALL_CANVASES = ["building"] as const;

/** The insert row's kinds, grouped as Insert lists them (`builder/09`). */
const INSERT_GROUPS: readonly { group: "sections" | "text" | "media" | "commands"; kinds: readonly InsertKind[] }[] = [
	{ group: "sections", kinds: ["section", "container", "div", "header", "footer"] },
	{ group: "text", kinds: ["heading", "text", "link", "button", "list"] },
	{ group: "media", kinds: ["image", "video", "icon"] },
	{ group: "commands", kinds: ["loop", "condition", "form", "outlet"] },
];

/** Tags Insert's search reaches beyond the row's kinds: every element the tree may hold, by its tag. */
const NAMED_TAGS = new Set(["section", "div", "header", "footer", "h2", "p", "a", "ul", "img", "video"]);

/**
 * The building area's Command menu (BA-10; SPEC 2 and 6, `builder/09`): one dialog over the dimmed
 * shell with three tabs, Actions (⌘K), Go to (⌘P) and Insert (⌘I), an ARIA tab list whose selected
 * tab is its one stop; Tab and ⇧Tab in the search box switch tabs. The search box drives a list box:
 * the highlighted row is read as its name, group and keys, and the number of rows once typing pauses.
 * Insert says where things land ("Where: Inside · After"); ⌥↵ inserts the other way. With an empty
 * search the last five commands used show under "Recent" (per browser). A Member gets the shorter
 * menu (SPEC 13.9): their Actions and Go to, no Insert. Focus goes back where the menu was opened.
 */
export function CommandMenu({
	host,
	request,
	onRequest,
}: {
	host: MenuHost;
	request: MenuRequest | null;
	onRequest(next: MenuRequest | null): void;
}) {
	const { words, staff } = host;
	const said = words.commandMenu;
	const id = useId();
	const dialog = useRef<HTMLDialogElement>(null);
	const search = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const tabButtons = useRef(new Map<MenuTab, HTMLButtonElement>());
	const origin = useRef<HTMLElement | null>(null);
	const open = request !== null;
	const tab = request?.tab ?? "actions";
	const tabs: readonly MenuTab[] = staff ? ["actions", "goTo", "insert"] : ["actions", "goTo"];
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const [recent, setRecent] = useState<string[]>(() => recentCommands());
	const [data, setData] = useState<CommandMenuData | null>(null);
	const [asking, setAsking] = useState<Asking | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const [count, setCount] = useState("");
	/** Insert's switch: Inside or After (After when the selection can't hold anything). */
	const [after, setAfter] = useState(false);
	/** The Undo history's state as the menu opened (its rows name the steps). */
	const historyNow = host.history.state();

	// Opening: remembers where focus was, shows the dialog modal, and starts afresh.
	useEffect(() => {
		const element = dialog.current;
		if (!element) return;
		if (open && !element.open) {
			origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			element.showModal();
		}
		if (!open && element.open) {
			element.close();
			const back = origin.current;
			origin.current = null;
			if (back?.isConnected) back.focus();
		}
	}, [open]);

	// A tab, or a question asked from outside (the row's Loop and Condition), starts the list afresh.
	useEffect(() => {
		if (!open) return;
		setQuery("");
		setActive(0);
		setProblem(null);
		setAsking(request?.step ? { question: request.step, mode: "insert" } : null);
		setAfter(Boolean(request?.forceAfter));
		requestAnimationFrame(() => search.current?.focus());
	}, [open, request]);

	// Go to's lists and the Permissions held are read each time the menu opens (`builder.commandMenu`).
	useEffect(() => {
		if (!open) return;
		let current = true;
		managementApi(host.config.token)
			.builder.commandMenu({ siteId: host.config.site.id })
			.then((read) => {
				if (current) setData(read as CommandMenuData);
			})
			.catch(() => {});
		return () => {
			current = false;
		};
	}, [open, host.config.token, host.config.site.id]);

	const can = (permission: Permission) =>
		data
			? (data.permissions as readonly string[]).includes(permission)
			: host.config.permissions.includes(permission as never) || permission === "site.view";

	// ── Insert: where things land ──
	const inserter = staff?.inserter;
	const landingOf = (kind: InsertKind, inverse = false): Landing | null =>
		inserter ? inserter.landing(kind, inverse ? !after : after) : null;
	const inside = inserter?.landing("div", false);
	const canInside = inside?.kind === "tree" && inside.position === "inside";
	const sample = inserter ? inserter.landing("div", after || !canInside) : null;
	const snapshotNow = staff?.structure.snapshot();
	const catalogue: BuilderCatalogue | null = snapshotNow
		? (snapshotNow.sources.get(sample?.kind === "tree" ? sample.source : "site")?.catalogue ??
			snapshotNow.sources.get("site")?.catalogue ??
			null)
		: null;

	const whereText = (() => {
		if (!sample || !staff) return "";
		if (sample.kind === "refused") return sample.reason;
		const snapshot = staff.structure.snapshot();
		if (sample.kind === "page")
			return sample.anchor
				? fill(words.insert.whereAfter, { name: anchorName(snapshot, sample.anchor) })
				: words.insert.wherePage;
		const name = sample.anchor ? anchorName(snapshot, sample.anchor) : "";
		const text =
			sample.position === "inside"
				? fill(words.insert.whereInside, { name })
				: sample.position === "after"
					? fill(words.insert.whereAfter, { name })
					: fill(words.insert.whereEnd, {
							name: snapshot.sources.get(sample.source)?.name ?? words.structure.siteTemplate,
						});
		return `${said.tabs.insert} ${text}`;
	})();

	const close = () => onRequest(null);

	/**
	 * Runs an insert that may ask more (a Media file) or wait (a new section): the menu closes first, so
	 * the picker and the canvas get focus; a refusal is said by the inserter.
	 */
	const later = (insert: () => Promise<unknown>) => {
		close();
		setTimeout(() => void insert(), 0);
	};

	const insertNodes = (nodes: TreeNode[], name: string, kind: InsertKind, inverse: boolean) => {
		const at = landingOf(kind, inverse);
		if (!inserter || !at) return;
		const refused = inserter.insertNodes(nodes, name, at);
		if (refused) setProblem(refused);
		else close();
	};

	// ── The rows of each tab ──
	const keyWords = (name: SpokenKey) => said.keyNames[name];
	const actions = ((): Row[] => {
		const rows: Row[] = [];
		const add = (row: Omit<Row, "tab" | "canvases" | "keywords" | "permission"> & Partial<Row>) =>
			rows.push({ tab: "actions", canvases: ALL_CANVASES as never, keywords: [], permission: "site.view", ...row });
		const editor = said.groups.editor;
		const action = said.actions;
		add({
			id: "undo",
			group: editor,
			icon: CommandIcon,
			label: historyNow.undo ? fill(action.undoStep, { step: historyNow.undo }) : action.undo,
			shortcut: "editor.undo",
			disabled: !historyNow.undo || historyNow.busy,
			reason: action.nothingToUndo,
			run: () => host.history.undo(),
		});
		add({
			id: "redo",
			group: editor,
			icon: CommandIcon,
			label: historyNow.redo ? fill(action.redoStep, { step: historyNow.redo }) : action.redo,
			shortcut: "editor.redo",
			disabled: !historyNow.redo || historyNow.busy,
			reason: action.nothingToRedo,
			run: () => host.history.redo(),
		});
		add({
			id: "publish",
			group: editor,
			icon: CommandIcon,
			label: action.publish,
			permission: "entry.publish",
			run: host.publish,
		});
		add({
			id: "sendForReview",
			group: editor,
			icon: CommandIcon,
			label: action.sendForReview,
			permission: "entry.edit",
			without: "entry.publish",
			run: host.publish,
		});
		if (host.member) {
			const member = host.member;
			add({
				id: "preview",
				group: editor,
				icon: CommandIcon,
				label: member.preview.on ? action.edit : action.preview,
				run: () => member.preview.set(!member.preview.on),
			});
			add({ id: "pageDetails", group: editor, icon: CommandIcon, label: action.pageDetails, run: member.pageDetails });
			const sections = member.sections;
			if (sections) add({ id: "sections", group: editor, icon: CommandIcon, label: action.sections, run: sections });
			add({ id: "help", group: editor, icon: CommandIcon, label: action.help, run: member.help });
		}
		if (host.hidden) {
			const hidden = host.hidden;
			add({
				id: "hideInterface",
				group: editor,
				icon: CommandIcon,
				label: hidden.on ? action.showInterface : action.hideInterface,
				permission: "structure.edit",
				run: () => hidden.set(!hidden.on),
			});
		}
		for (const [language, name] of [
			["html", action.formatHtml],
			["css", action.formatCss],
			["js", action.formatJs],
		] as const) {
			const run = formatTarget(language);
			if (run)
				add({
					id: `format-${language}`,
					group: said.groups.format,
					icon: CodeXmlIcon,
					label: name,
					permission: "structure.edit",
					run,
				});
		}
		const formats = (["html", "css", "js"] as const).map((language) => formatTarget(language));
		if (formats.every(Boolean))
			add({
				id: "format-all",
				group: said.groups.format,
				icon: CodeXmlIcon,
				label: action.formatAll,
				permission: "structure.edit",
				run: async () => {
					for (const format of formats) await format?.();
				},
			});
		if (staff) {
			add({
				id: "newComponent",
				group: editor,
				icon: ComponentIcon,
				label: action.newComponent,
				permission: "structure.edit",
				run: staff.newComponent,
			});
			const ops = staff.ops;
			const element = said.groups.element;
			const on = { group: element, icon: CodeXmlIcon, permission: "structure.edit" as const };
			if (ops.inTree()) {
				add({ ...on, id: "copy", label: action.copy, shortcut: "tree.copy", run: () => void ops.copy() });
				if (ops.copied())
					add({ ...on, id: "paste", label: action.paste, shortcut: "tree.paste", run: () => void ops.paste() });
				add({
					...on,
					id: "duplicate",
					label: action.duplicate,
					shortcut: "element.duplicate",
					run: () => void ops.duplicate(),
				});
				add({ ...on, id: "delete", label: action.delete, shortcut: "element.delete", run: () => void ops.remove() });
				add({ ...on, id: "parent", label: action.parent, run: () => void ops.parent() });
				for (const kind of ["div", "section", "a"] as const)
					add({
						...on,
						id: `wrap-${kind}`,
						label: fill(action.wrap, { what: said.wrap[kind] }),
						run: () => void ops.wrap(kind, said.wrap[kind]),
					});
				for (const kind of ["loop", "condition"] as const)
					add({
						...on,
						id: `wrap-${kind}`,
						label: fill(action.wrap, { what: said.wrap[kind] }),
						run: () => onRequest({ tab: "insert", step: kind }),
					});
				if (ops.canUnwrap()) add({ ...on, id: "unwrap", label: action.unwrap, run: () => void ops.unwrap() });
				add({ ...on, id: "makeComponent", label: action.makeComponent, run: staff.makeComponent });
			}
			const placement = { group: said.groups.placement, icon: ComponentIcon, permission: "structure.edit" as const };
			if (staff.editComponent)
				add({ ...placement, id: "editComponent", label: action.editComponent, run: staff.editComponent });
			if (ops.onPage()) {
				add({
					...placement,
					id: "duplicate",
					label: action.duplicate,
					shortcut: "element.duplicate",
					run: () => void ops.duplicate(),
				});
				add({
					...placement,
					id: "delete",
					label: action.delete,
					shortcut: "element.delete",
					run: () => void ops.remove(),
				});
			}
			const toggle = staff.toggleHidden;
			if (toggle)
				add({
					...placement,
					id: "toggleHidden",
					label: toggle.hidden ? action.showPlacement : action.hidePlacement,
					run: toggle.run,
				});
		}
		const places = said.groups.places;
		if (host.place)
			add({ id: "backToCanvas", group: places, icon: MapPinIcon, label: action.backToCanvas, run: host.leavePlace });
		for (const place of host.places)
			if (place.key !== host.place)
				add({
					id: `place-${place.key}`,
					group: places,
					icon: MapPinIcon,
					label: fill(action.openPlace, { place: place.name }),
					run: () => host.openPlace(place.key),
				});
		add({ id: "exit", group: editor, icon: CommandIcon, label: action.exit, run: host.exit });
		return rows;
	})();

	const goTo = ((): Row[] | null => {
		if (!data) return null;
		const rows: Row[] = [];
		const add = (row: Omit<Row, "tab" | "canvases" | "keywords" | "permission"> & Partial<Row>) =>
			rows.push({ tab: "goTo", canvases: ALL_CANVASES as never, keywords: [], permission: "entry.edit", ...row });
		const pages = said.groups.pages;
		for (const page of data.pages)
			add({
				id: `page:${page.id}`,
				group: pages,
				icon: FileTextIcon,
				label: page.title || page.path,
				hint: page.path,
				detail: page.path,
				keywords: [page.path],
				run: () => host.open({ kind: "page", page: page.path }),
			});
		for (const postType of data.postTypes)
			for (const entry of postType.entries)
				add({
					id: `page:${entry.id}`,
					group: postType.name,
					icon: FileTextIcon,
					label: entry.title || entry.path,
					hint: entry.path,
					detail: entry.path,
					keywords: [entry.path],
					run: () => host.open({ kind: "page", page: entry.path }),
				});
		if (staff) {
			const templates = {
				group: said.groups.templates,
				icon: LayoutTemplateIcon,
				permission: "structure.edit" as const,
			};
			const named = said.templates;
			add({
				...templates,
				id: "template:site",
				label: named.siteTemplate,
				run: () => host.open({ kind: "siteTemplate" }),
			});
			add({
				...templates,
				id: "template:search",
				label: named.searchTemplate,
				run: () => host.open({ kind: "searchTemplate" }),
			});
			for (const postType of data.postTypes) {
				add({
					...templates,
					id: `template:entry:${postType.id}`,
					label: fill(named.entryTemplate, { postType: postType.name }),
					run: () => host.open({ kind: "entryTemplate", postTypeId: postType.id, entryId: null }),
				});
				if (postType.archive)
					add({
						...templates,
						id: `template:archive:${postType.id}`,
						label: fill(named.archiveTemplate, { postType: postType.name }),
						run: () => host.open({ kind: "archiveTemplate", postTypeId: postType.id }),
					});
			}
			for (const component of data.components)
				add({
					id: `component:${component.id}`,
					group: said.groups.components,
					icon: ComponentIcon,
					permission: "structure.edit",
					label: component.name,
					run: () => host.open({ kind: "component", componentId: component.id }),
				});
			// The elements on this page with a name of their own (a layer label), and the Page's Placements.
			const snapshot = staff.structure.snapshot();
			const layers = { group: said.groups.layers, icon: CodeXmlIcon, permission: "structure.edit" as const };
			for (const placement of snapshot.layout ?? [])
				add({
					...layers,
					id: `layer:content/${placement.id}`,
					label: placement.name,
					run: () => staff.structure.select(`content/${placement.id}`),
				});
			for (const [ref, source] of snapshot.sources) {
				const visit = (nodes: readonly TreeNode[]) => {
					for (const node of nodes) {
						if (node.type === "element" && node.label)
							add({
								...layers,
								id: `layer:${ref}#${node.id}`,
								label: node.label,
								detail: node.tag,
								run: () => staff.structure.select(`${ref}#${node.id}`),
							});
						for (const children of childLists(node)) visit(children);
					}
				};
				visit(source.tree.nodes);
			}
		}
		return rows;
	})();

	const insertRows = ((): Row[] => {
		if (!staff) return [];
		const rows: Row[] = [];
		const groupName = (group: keyof typeof said.groups) => said.groups[group];
		const items = words.insert.items;
		const commands = new Set(catalogue?.commands ?? []);
		for (const { group, kinds } of INSERT_GROUPS)
			for (const kind of kinds) {
				if (kind === "outlet" && !commands.has("outlet")) continue;
				if (kind === "form" && !commands.has("form")) continue;
				const label = kind === "text" ? items.text.menu : items[kind].name;
				const onPage = sample?.kind === "page";
				rows.push({
					id: `insert:${kind}`,
					tab: "insert",
					group: groupName(group),
					label,
					detail: kind === "section" && onPage ? items.section.page : items[kind].hint,
					tag: KIND_TAGS[kind],
					icon: KIND_ICONS[kind],
					keywords: [kind, KIND_TAGS[kind]],
					permission: "structure.edit",
					canvases: ALL_CANVASES as never,
					run: ({ inverse }) => {
						if (kind === "loop" || kind === "condition" || kind === "form") {
							setAsking({ question: kind, mode: "insert" });
							setQuery("");
							setActive(0);
							return;
						}
						const forceAfter = inverse ? !after : after;
						later(() => staff.inserter.insert(kind, { forceAfter }));
					},
				});
			}
		const components = said.groups.components;
		rows.push({
			id: "insert:new-component",
			tab: "insert",
			group: components,
			label: said.actions.newComponent,
			detail: words.componentDialog.newTitle,
			icon: SquarePlusIcon,
			keywords: ["component"],
			permission: "structure.edit",
			canvases: ALL_CANVASES as never,
			run: () => {
				close();
				staff.newComponent();
			},
		});
		for (const component of catalogue?.components ?? [])
			rows.push({
				id: `insert:component:${component.id}`,
				tab: "insert",
				group: components,
				label: component.name,
				detail: fill(items.component.hint, { name: component.name }),
				tag: `<${component.name}/>`,
				icon: ComponentIcon,
				keywords: ["component"],
				permission: "structure.edit",
				canvases: ALL_CANVASES as never,
				run: ({ inverse }) => {
					const at = landingOf("component", inverse);
					if (!at) return;
					if (at.kind === "page") later(() => staff.inserter.placeComponent(component.id, at));
					else {
						const source = at.kind === "tree" ? staff.structure.snapshot().sources.get(at.source) : undefined;
						if (!source) {
							setProblem(at.kind === "refused" ? at.reason : words.insert.refusals.connecting);
							return;
						}
						const nodes = withNewIds(source.tree, [
							{ type: "component", id: "new", component: component.id, props: [] } as TreeNode,
						]);
						insertNodes(nodes, component.name, "component", inverse);
					}
				},
			});
		// Searching reaches every other element the tree may hold, and its values.
		if (query.trim()) {
			for (const tag of catalogue?.elements ?? []) {
				if (NAMED_TAGS.has(tag)) continue;
				rows.push({
					id: `insert:tag:${tag}`,
					tab: "insert",
					group: said.groups.other,
					label: `<${tag}>`,
					detail: fill(items.element.hint, { tag }),
					tag: `<${tag}>`,
					icon: CodeXmlIcon,
					keywords: [tag],
					permission: "structure.edit",
					canvases: ALL_CANVASES as never,
					run: ({ inverse }) => {
						const at = landingOf("div", inverse);
						const source = at?.kind === "tree" ? staff.structure.snapshot().sources.get(at.source) : undefined;
						if (!source) {
							setProblem(at?.kind === "refused" ? at.reason : words.insert.refusals.page);
							return;
						}
						insertNodes([newElement(source.tree, tag)], `<${tag}>`, "div", inverse);
					},
				});
			}
			for (const value of catalogue?.values ?? [])
				rows.push({
					id: `insert:value:${value.path}`,
					tab: "insert",
					group: said.groups.values,
					label: value.label ?? value.path,
					detail: fill(items.value.hint, { path: value.path }),
					tag: `{{ ${value.path} }}`,
					icon: VariableIcon,
					keywords: [value.path],
					permission: "structure.edit",
					canvases: ALL_CANVASES as never,
					run: ({ inverse }) => insertNodes([{ type: "value", path: value.path }], value.path, "link", inverse),
				});
		}
		return rows;
	})();

	/** The answers to Insert's question: which Loop or Form. (The Condition's test is typed in the search box.) */
	const answers = ((): Row[] => {
		if (!asking || !staff || asking.question === "condition") return [];
		const group = asking.question === "loop" ? said.steps.loop : said.steps.form;
		const choices =
			asking.question === "loop"
				? (catalogue?.loops ?? []).map((loop) => ({ key: loop.name, label: loop.name }))
				: (catalogue?.forms ?? []).map((form) => ({ key: form.id, label: form.name }));
		return choices.map(
			(choice): Row => ({
				id: `answer:${asking.question}:${choice.key}`,
				tab: "insert",
				group,
				label: choice.label,
				icon: KIND_ICONS[asking.question],
				tag: asking.question === "loop" ? `{{@loop ${choice.label}}}` : "{{@form}}",
				keywords: [],
				permission: "structure.edit",
				canvases: ALL_CANVASES as never,
				run: ({ inverse }) => {
					const node =
						asking.question === "loop"
							? ({ type: "loop", source: choice.key, alias: "item", children: [], empty: null } as TreeNode)
							: ({ type: "form", form: choice.key } as TreeNode);
					if (asking.mode === "wrap") {
						const refused = staff.ops.wrap(node, said.wrap.loop);
						if (refused) setProblem(refused);
						else close();
						return;
					}
					insertNodes([node], choice.label, asking.question, inverse);
				},
			}),
		);
	})();

	// The row's Component button and the empty Page's Add a Component list the Components only, until typing.
	const insertList =
		request?.only === "components" && !query.trim()
			? insertRows.filter((row) => row.group === said.groups.components)
			: insertRows;
	const all = asking ? answers : tab === "actions" ? actions : tab === "goTo" ? (goTo ?? []) : insertList;
	const listed = (() => {
		const found = visibleCommands(all, {
			tab: asking ? "insert" : tab,
			canvas: "building",
			can,
			query: asking?.question === "condition" ? "" : query,
			recent: asking ? [] : recent,
		});
		return { recent: found.recent as Row[], results: found.results as Row[] };
	})();
	const rows = [...listed.recent, ...listed.results];
	const current = rows[Math.min(active, rows.length - 1)];

	// The number of rows is read once typing pauses.
	useEffect(() => {
		if (!open || !query) return;
		const timer = setTimeout(
			() => setCount(rows.length === 1 ? said.countOne : fill(said.countOther, { count: String(rows.length) })),
			600,
		);
		return () => clearTimeout(timer);
	}, [open, query, rows.length, said]);

	// Insert shows where the next insert lands, on the canvas and in the tree, while it is open.
	useEffect(() => {
		if (!open || tab !== "insert" || !inserter) return;
		inserter.preview("div", after);
		return () => inserter.preview(null);
	}, [open, tab, inserter, after]);

	const run = (row: Row, inverse = false) => {
		if (row.disabled) return;
		setProblem(null);
		if (!asking) setRecent(rememberCommand(row.id));
		if (row.tab === "insert") {
			void row.run({ inverse });
			return;
		}
		close();
		// The command runs once the menu has closed and focus has gone back.
		setTimeout(() => void row.run({ inverse }), 0);
	};

	const conditionTest = () => {
		const read = readExpression(query);
		if ("problem" in read) {
			setProblem(read.problem.message);
			return;
		}
		const node = {
			type: "condition",
			branches: [{ test: read.expression, children: [] }],
			otherwise: null,
		} as TreeNode;
		if (asking?.mode === "wrap" && staff) {
			const refused = staff.ops.wrap(node, said.wrap.condition);
			if (refused) setProblem(refused);
			else close();
			return;
		}
		insertNodes([node], words.insert.items.condition.name, "condition", false);
	};

	const switchTab = (next: MenuTab) => onRequest({ tab: next });

	const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Tab") {
			event.preventDefault();
			const at = tabs.indexOf(tab) + (event.shiftKey ? -1 : 1);
			switchTab(tabs[(at + tabs.length) % tabs.length] as MenuTab);
		} else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const move = event.key === "ArrowDown" ? 1 : -1;
			setActive((was) => (rows.length ? (Math.min(was, rows.length - 1) + move + rows.length) % rows.length : 0));
		} else if (event.key === "Home" || event.key === "End") {
			event.preventDefault();
			setActive(event.key === "Home" ? 0 : Math.max(0, rows.length - 1));
		} else if (event.key === "Enter") {
			event.preventDefault();
			if (asking?.question === "condition") conditionTest();
			else if (current) run(current, event.altKey && tab === "insert");
		} else if (event.key === "Backspace" && !query && asking) {
			event.preventDefault();
			setAsking(null);
		}
	};

	// Keeps the highlighted row in view.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the highlighted row moves with these.
	useEffect(() => {
		list.current?.querySelector(`[aria-selected="true"]`)?.scrollIntoView({ block: "nearest" });
	}, [active, rows.length]);

	const spoken = (row: Row) => {
		const keys = row.shortcut ? shortcutSpoken(row.shortcut, keyWords) : "";
		const text = keys
			? fill(said.optionKeys, { label: row.label, group: row.group, keys })
			: fill(said.option, { label: row.label, group: row.group });
		const after = text.startsWith(row.label) ? text.slice(row.label.length) : `, ${text}`;
		return row.disabled && row.reason ? `${after}, ${row.reason}` : after;
	};

	const groups: { name: string; rows: { row: Row; index: number }[] }[] = [];
	rows.forEach((row, index) => {
		const name = index < listed.recent.length ? said.recent : row.group;
		const last = groups.at(-1);
		if (
			last &&
			last.name === name &&
			index < listed.recent.length === (last.rows[0]?.index ?? 0) < listed.recent.length
		)
			last.rows.push({ row, index });
		else groups.push({ name, rows: [{ row, index }] });
	});

	const placeholder =
		asking?.question === "condition"
			? fill(said.steps.condition, { example: "{{ site.tagline }}" })
			: tab === "goTo"
				? staff
					? said.placeholder.goTo
					: said.placeholder.goToMember
				: said.placeholder[tab];
	const inverseKeys = chordText({ key: "Enter", alt: true });

	return (
		<dialog
			ref={dialog}
			aria-labelledby={`${id}-title`}
			onCancel={(event) => {
				event.preventDefault();
				if (asking) setAsking(null);
				else close();
			}}
			className="bg-chrome-menu text-chrome-text border-chrome-hover fixed inset-x-0 top-4 mx-auto mt-0 flex max-h-[calc(100dvh-32px)] w-[864px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border p-0 font-sans shadow-[0_24px_64px_rgba(0,0,0,0.6)] backdrop:bg-black/60 [&:not([open])]:hidden"
			data-wc-command-menu=""
		>
			<h2 id={`${id}-title`} className="sr-only">
				{said.title}
			</h2>
			<div className="border-chrome-line flex h-12 shrink-0 items-center gap-1 border-b px-3">
				<div role="tablist" aria-label={said.tabsLabel} className="flex items-center gap-1">
					{tabs.map((each) => {
						const keys = shortcutText(`menu.${each}`);
						return (
							<button
								key={each}
								ref={(button) => {
									if (button) tabButtons.current.set(each, button);
									else tabButtons.current.delete(each);
								}}
								type="button"
								role="tab"
								id={`${id}-tab-${each}`}
								aria-selected={each === tab}
								aria-controls={`${id}-panel`}
								aria-keyshortcuts={ariaKeys(`menu.${each}`) || undefined}
								tabIndex={each === tab ? 0 : -1}
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => switchTab(each)}
								onKeyDown={(event) => {
									const at = tabs.indexOf(each);
									const next =
										event.key === "ArrowRight" || event.key === "ArrowLeft"
											? tabs[(at + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length]
											: event.key === "Home"
												? tabs[0]
												: event.key === "End"
													? tabs.at(-1)
													: undefined;
									if (!next) return;
									event.preventDefault();
									switchTab(next);
									requestAnimationFrame(() => tabButtons.current.get(next)?.focus());
								}}
								className={`aria-selected:bg-chrome-hover aria-selected:text-chrome-strong text-chrome-muted flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-semibold ${CHROME_EASE} ${FOCUS_RING}`}
								data-wc-menu-tab={each}
							>
								{said.tabs[each]}
								<span aria-hidden="true" className="text-chrome-muted font-mono text-[11px]">
									{keys}
								</span>
							</button>
						);
					})}
				</div>
				<span className="text-chrome-muted ms-auto text-[11px]">{said.switchHint}</span>
			</div>
			<div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`} className="flex min-h-0 flex-col">
				<div className="border-chrome-line flex h-[42px] shrink-0 items-center gap-2 border-b px-3.5">
					{asking ? (
						<button
							type="button"
							aria-label={said.steps.back}
							onClick={() => setAsking(null)}
							className={`text-chrome-muted hover:text-chrome-strong grid size-6 place-items-center rounded-md ${FOCUS_RING}`}
						>
							<ArrowLeftIcon aria-hidden="true" className="size-4 rtl:rotate-180" />
						</button>
					) : (
						<SearchIcon aria-hidden="true" className="text-chrome-muted size-4 shrink-0" />
					)}
					<input
						ref={search}
						role="combobox"
						aria-label={asking?.question === "condition" ? said.steps.conditionLabel : placeholder}
						aria-expanded="true"
						aria-controls={`${id}-list`}
						aria-autocomplete="list"
						aria-activedescendant={
							current && asking?.question !== "condition" ? `${id}-option-${rows.indexOf(current)}` : undefined
						}
						aria-describedby={tab === "insert" ? `${id}-where` : undefined}
						placeholder={placeholder}
						value={query}
						autoComplete="off"
						spellCheck={false}
						onChange={(event) => {
							setQuery(event.target.value);
							setActive(0);
							setProblem(null);
						}}
						onKeyDown={keyDown}
						className="text-chrome-strong placeholder:text-chrome-muted min-w-0 grow bg-transparent text-[14px] outline-none"
						data-wc-menu-search=""
					/>
				</div>
				{tab === "insert" && staff ? (
					<div className="border-chrome-line flex h-[30px] shrink-0 items-center gap-2.5 border-b px-3.5 text-[11px]">
						<span className="text-chrome-muted font-semibold">{said.where}</span>
						{/* biome-ignore lint/a11y/useSemanticElements: two switches drawn as one segmented control. */}
						<div role="group" aria-label={said.where} className="bg-chrome flex rounded-md p-0.5">
							{(["inside", "after"] as const).map((way) => (
								<button
									key={way}
									type="button"
									aria-pressed={way === "after" ? after || !canInside : !after && canInside}
									disabled={way === "inside" && !canInside}
									onClick={() => setAfter(way === "after")}
									className={`aria-pressed:bg-chrome-hover aria-pressed:text-chrome-strong text-chrome-muted h-5 rounded-[5px] px-2 text-[11px] font-semibold disabled:opacity-40 ${FOCUS_RING}`}
									data-wc-menu-where={way}
								>
									{way === "inside" ? said.inside : said.after}
								</button>
							))}
						</div>
						<span id={`${id}-where`} className="text-chrome-muted min-w-0 truncate" data-wc-menu-where-text="">
							{whereText}
							{canInside ? (
								<span className="sr-only">
									{`. ${fill(said.inverse, { keys: inverseKeys, way: after ? said.inverseInside : said.inverseAfter })}`}
								</span>
							) : null}
						</span>
					</div>
				) : null}
				<div
					ref={list}
					id={`${id}-list`}
					role="listbox"
					aria-label={asking ? (asking.question === "loop" ? said.steps.loop : said.steps.form) : said.tabs[tab]}
					className="relative min-h-0 grow overflow-y-auto p-2"
				>
					{tab === "goTo" && goTo === null ? (
						<p className="text-chrome-muted m-0 p-2 text-[12px]">{said.loading}</p>
					) : null}
					{groups.map((group) => (
						// biome-ignore lint/a11y/useSemanticElements: a list box groups its options with role="group".
						<div
							key={`${group.name}-${group.rows[0]?.index}`}
							role="group"
							aria-label={group.name}
							className="flex flex-col gap-0.5"
						>
							<p
								aria-hidden="true"
								className="text-chrome-muted m-0 flex h-[18px] items-center px-2 text-[10px] font-semibold tracking-[0.06em] uppercase"
							>
								{group.name}
							</p>
							{group.rows.map(({ row, index }) => {
								const Glyph = row.icon;
								const keys = row.shortcut ? shortcutText(row.shortcut) : "";
								return (
									<div
										key={`${row.id}-${index}`}
										id={`${id}-option-${index}`}
										role="option"
										tabIndex={-1}
										aria-selected={row === current}
										aria-disabled={row.disabled || undefined}
										onMouseDown={(event) => event.preventDefault()}
										onMouseMove={() => setActive(index)}
										onClick={(event) => run(row, event.altKey && tab === "insert")}
										onKeyDown={() => {}}
										className={`aria-selected:bg-chrome-hover flex h-7 cursor-default items-center gap-2 rounded-md px-2 ${row.disabled ? "opacity-50" : ""}`}
										data-wc-menu-row={row.id}
									>
										<span
											aria-hidden="true"
											className="bg-chrome-raised grid size-5 shrink-0 place-items-center rounded-[5px]"
										>
											<Glyph aria-hidden="true" className="size-[11px]" />
										</span>
										<span className="text-chrome-strong w-28 shrink-0 truncate text-[12px] font-medium">
											{row.label}
											<span className="sr-only">{spoken(row)}</span>
										</span>
										<span aria-hidden="true" className="text-chrome-muted min-w-0 grow truncate text-[11px]">
											{row.disabled && row.reason ? row.reason : (row.detail ?? row.hint ?? "")}
										</span>
										{row.tag || keys ? (
											<span
												aria-hidden="true"
												className="bg-chrome-well text-chrome-muted flex h-[17px] shrink-0 items-center rounded-[4px] px-[5px] font-mono text-[10px]"
											>
												{row.tag ?? keys}
											</span>
										) : null}
									</div>
								);
							})}
						</div>
					))}
					{rows.length === 0 && (tab !== "goTo" || goTo !== null) && asking?.question !== "condition" ? (
						<p className="text-chrome-muted m-0 p-2 text-[12px]">
							{asking ? (asking.question === "loop" ? said.steps.noLoops : said.steps.noForms) : said.none}
						</p>
					) : null}
				</div>
				<p role="alert" className="text-chrome-danger m-0 shrink-0 px-3.5 pb-2 text-[12px] empty:hidden">
					{problem ?? ""}
				</p>
				<p role="status" className="sr-only">
					{count}
				</p>
			</div>
		</dialog>
	);
}
