import {
	type Block,
	type BlockType,
	type BodyCheck,
	bodyChecks,
	CALLOUT_TONES,
	type CalloutTone,
	type InlineText,
	isSafeLink,
	newBlockId,
	storedBlocks,
	videoAt,
} from "@webcraft/renderer/body";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@webcraft/ui/components/dropdown-menu.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { Label } from "@webcraft/ui/components/label.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import {
	ArrowDownIcon,
	ArrowUpIcon,
	BoldIcon,
	CircleAlertIcon,
	CodeIcon,
	EllipsisIcon,
	Heading2Icon,
	ImageIcon,
	ItalicIcon,
	LinkIcon,
	type LucideIcon,
	PlusIcon,
	StrikethroughIcon,
	Trash2Icon,
	TriangleAlertIcon,
} from "lucide-react";
import { type ClipboardEvent, type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
	caretOffset,
	caretOnEdgeLine,
	joinRuns,
	placeCaret,
	runsLength,
	runsToHtml,
	splitRuns,
} from "../../../body-editor/inline-dom.ts";
import { type BodyComponentChoice, newComponentBlock } from "../../../body-editor/model.ts";
import { getApi } from "../../api.ts";
import { errorMessage } from "../../errors.ts";
import { type MessageKey, useT } from "../../i18n.tsx";
import { MediaPicker } from "../../media/MediaPicker.tsx";
import type { MediaItem } from "../../media/preview.ts";
import type { Json, Problem } from "../model.ts";
import { problemsWithin } from "../model.ts";
import { LinkDialog } from "../RichTextEditor.tsx";
import { Announcer, DragHandle, moveItem, useDragOrder } from "../reorder.tsx";
import { BlockMenu } from "./BlockMenu.tsx";
import { ComponentProps } from "./ComponentProps.tsx";
import {
	BLOCK_CHOICES,
	type BlockChoice,
	choiceOf,
	isTextBlock,
	itemsOf,
	type Line,
	linesOf,
	newBlock,
	SHORTCUTS,
	turnInto,
	WHOLE_SHORTCUTS,
} from "./choices.ts";
import { InlineEditor } from "./InlineEditor.tsx";

/** A button of the toolbar. */
type ToolbarButton = { id: string; label: MessageKey; icon: LucideIcon; run(): void };

/** Where the caret goes once the editor has drawn a change: an editable part of a Block, at a position. */
type FocusRequest = { key: string; offset: number | "start" | "end" };

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * A Body field's block editor: the Blocks of one language, in order, each edited in place. `/` in an
 * empty paragraph (or Add block) offers the Blocks the Field allows; Markdown shortcuts work while
 * typing (`## `, `- `, `1. `, `> `, ` ``` `, `---`); Blocks move by dragging their handle or with Move
 * up and Move down in their menu (Alt+Shift with the arrow keys from the text). Every change goes to
 * the Draft through the Entry editor's autosave. Problems the server found and the body's Checks show
 * under the Block they are about.
 */
export function BodyEditor({
	siteId,
	postTypeId,
	id,
	labelledBy,
	describedBy,
	invalid,
	lang,
	path,
	value,
	blocksOff,
	problems,
	media,
	onMediaChosen,
	onChange,
}: {
	siteId: string;
	postTypeId?: string;
	id: string;
	labelledBy: string;
	describedBy?: string;
	invalid?: boolean;
	lang?: string;
	/** The value's path among the Entry's values (`fields.body`), where its problems are. */
	path: string;
	value: Json;
	blocksOff: readonly BlockType[];
	problems: readonly Problem[];
	media: Readonly<Record<string, MediaItem>>;
	onMediaChosen(item: MediaItem): void;
	onChange(blocks: Block[]): void;
}) {
	const t = useT();
	const [blocks, setBlocks] = useState<Block[]>(() => {
		const stored = storedBlocks(value);
		return stored.length > 0 ? stored : [newBlock(BLOCK_CHOICES[0] as BlockChoice)];
	});
	const latestBlocks = useRef(blocks);
	latestBlocks.current = blocks;
	// A Block whose text the editor changed itself starts its editable parts again.
	const [versions, setVersions] = useState<Record<string, number>>({});
	const [menu, setMenu] = useState<{ after: string | null; slash: boolean } | null>(null);
	const [linking, setLinking] = useState(false);
	const [announcement, setAnnouncement] = useState("");
	const editables = useRef(new Map<string, HTMLElement>());
	const pending = useRef<FocusRequest | null>(null);
	const current = useRef<{ blockId: string; key: string; range: Range | null } | null>(null);
	const toolbar = useRef<HTMLDivElement>(null);
	const linkButton = useRef<HTMLButtonElement>(null);
	const allowed = BLOCK_CHOICES.filter((choice) => !blocksOff.includes(choice.type));
	const language = lang ?? "en";
	const [components, setComponents] = useState<BodyComponentChoice[]>([]);
	const [componentForm, setComponentForm] = useState<{
		component: BodyComponentChoice;
		block?: Extract<Block, { type: "component" }>;
		after: string | null;
		slash: boolean;
	} | null>(null);
	useEffect(() => {
		if (!postTypeId) return;
		let active = true;
		void getApi()
			.then((api) => api.entries.bodyComponents({ siteId, postTypeId }))
			.then((result) => {
				if (active) setComponents(result.components);
			})
			.catch((error) => {
				if (active) setAnnouncement(t(errorMessage(error)));
			});
		return () => {
			active = false;
		};
	}, [siteId, postTypeId, t]);
	const chooseComponent = (component: BodyComponentChoice) => {
		setComponentForm({ component, after: menu?.after ?? null, slash: menu?.slash ?? false });
		setMenu(null);
	};

	// Shared Draft updates are also visible in the admin. Only changed Blocks remount: a server echo
	// adding translation metadata must not reset an editor's selection while they type.
	useEffect(() => {
		const incoming = storedBlocks(value);
		const next = incoming.length > 0 ? incoming : [newBlock(BLOCK_CHOICES[0] as BlockChoice)];
		const currentBlocks = latestBlocks.current;
		const content = (block: Block) => {
			const { source: _, ...rest } = block;
			return JSON.stringify(rest);
		};
		if (
			incoming.length === 0 &&
			currentBlocks.length === 1 &&
			currentBlocks[0]?.type === "paragraph" &&
			runsLength(currentBlocks[0].text) === 0
		)
			return;
		if (
			next.length === currentBlocks.length &&
			next.every((block, index) => content(block) === content(currentBlocks[index] as Block))
		)
			return;
		const changed = next.filter((block) => {
			const before = currentBlocks.find((each) => each.id === block.id);
			return before && content(before) !== content(block);
		});
		const focused = [...editables.current].find(([, element]) => element === document.activeElement);
		if (focused && changed.some((block) => focused[0].startsWith(`${block.id}:`)))
			pending.current = { key: focused[0], offset: caretOffset(focused[1]) ?? "end" };
		latestBlocks.current = next;
		setBlocks(next);
		setVersions((before) => {
			const after = { ...before };
			for (const block of changed) after[block.id] = (after[block.id] ?? 0) + 1;
			return after;
		});
	}, [value]);

	const checks = useMemo(
		() =>
			bodyChecks(blocks, {
				language,
				altOf: (mediaId) => (media[mediaId] ? (media[mediaId]?.alt ?? null) : undefined),
			}),
		[blocks, media, language],
	);

	// The toolbar formats the text last selected in the editor, so it keeps track of the selection.
	useEffect(() => {
		const track = () => {
			const selection = window.getSelection();
			if (!selection || selection.rangeCount === 0) return;
			for (const [key, element] of editables.current) {
				if (element.isContentEditable && element.contains(selection.anchorNode)) {
					current.current = { blockId: key.split(":")[0] ?? "", key, range: selection.getRangeAt(0).cloneRange() };
					return;
				}
			}
		};
		document.addEventListener("selectionchange", track);
		return () => document.removeEventListener("selectionchange", track);
	}, []);

	useEffect(() => {
		const request = pending.current;
		if (!request) return;
		const element = editables.current.get(request.key);
		if (!element) return;
		pending.current = null;
		if (element.isContentEditable) placeCaret(element, request.offset);
		else element.focus();
	});

	const commit = (next: Block[], remount: readonly string[] = [], focus?: FocusRequest) => {
		latestBlocks.current = next;
		setBlocks(next);
		if (remount.length > 0) {
			setVersions((before) => {
				const after = { ...before };
				for (const blockId of remount) after[blockId] = (after[blockId] ?? 0) + 1;
				return after;
			});
		}
		if (focus) pending.current = focus;
		onChange(next);
	};

	/** The first part of a Block the caret or focus can go to. */
	const firstKey = (block: Block): string => {
		switch (block.type) {
			case "list":
				return `${block.id}:item:0`;
			case "toggle":
				return `${block.id}:summary`;
			case "table":
				return `${block.id}:cell:0:0`;
			case "paragraph":
			case "heading":
			case "quote":
			case "callout":
				return `${block.id}:text`;
			default:
				return `${block.id}:control`;
		}
	};
	const lastKey = (block: Block): string => {
		if (block.type === "list") return `${block.id}:item:${linesOf(block.items).length - 1}`;
		if (block.type === "toggle") return `${block.id}:text`;
		return firstKey(block);
	};

	const change = (blockId: string, update: (block: Block) => Block) =>
		commit(blocks.map((block) => (block.id === blockId ? update(block) : block)));

	const insertAfter = (afterId: string | null, inserted: Block[], focus?: FocusRequest) => {
		const index = afterId === null ? blocks.length : blocks.findIndex((block) => block.id === afterId) + 1;
		commit([...blocks.slice(0, index), ...inserted, ...blocks.slice(index)], [], focus);
	};

	const paste = async (event: ClipboardEvent<HTMLDivElement>) => {
		if (!postTypeId || !(event.target instanceof HTMLElement)) return;
		const element = event.target.closest<HTMLElement>('[contenteditable="true"]');
		const key = [...editables.current].find(([, each]) => each === element)?.[0];
		if (!element || !key) return;
		const blockId = key.split(":")[0];
		if (!blockId) return;
		event.preventDefault();
		event.stopPropagation();
		const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
		const html = event.clipboardData.getData("text/html");
		const text = event.clipboardData.getData("text/plain");
		const selection = window.getSelection();
		const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
		try {
			const api = await getApi();
			let added: Block[];
			if (files.length > 0) {
				if (blocksOff.includes("image")) return;
				setAnnouncement(t("body.paste.uploading"));
				added = [];
				for (const file of files) {
					const { media: item } = await api.media.upload({ siteId, file });
					onMediaChosen(item);
					added.push({ id: newBlockId(), type: "image", media: item.id });
				}
			} else added = (await api.entries.pasteBody({ siteId, postTypeId, html, text })).blocks;
			if (!element.isConnected || added.length === 0) return;
			const [only] = added;
			if (added.length === 1 && only?.type === "paragraph" && range && element.contains(range.startContainer)) {
				element.focus();
				selection?.removeAllRanges();
				selection?.addRange(range);
				document.execCommand("insertHTML", false, runsToHtml(only.text));
				return;
			}
			const current = latestBlocks.current;
			const index = current.findIndex((block) => block.id === blockId);
			const anchor = current[index];
			if (!anchor) return;
			const empty = anchor.type === "paragraph" && runsLength(anchor.text) === 0;
			if (empty && added[0]) added[0] = { ...added[0], id: blockId };
			const offset = empty ? index : index + 1;
			commit([...current.slice(0, offset), ...added, ...current.slice(index + 1)], empty ? [blockId] : [], {
				key: firstKey(added.at(-1) as Block),
				offset: "end",
			});
			setAnnouncement(t("body.paste.added", { count: added.length }));
		} catch (error) {
			setAnnouncement(t(errorMessage(error)));
		}
	};

	const remove = (blockId: string) => {
		const index = blocks.findIndex((block) => block.id === blockId);
		const rest = blocks.filter((block) => block.id !== blockId);
		const next = rest.length > 0 ? rest : [newBlock(BLOCK_CHOICES[0] as BlockChoice)];
		const neighbour = next[Math.max(0, index - 1)] as Block;
		commit(next, [], {
			key: index > 0 ? lastKey(neighbour) : firstKey(neighbour),
			offset: index > 0 ? "end" : "start",
		});
		setAnnouncement(t("body.removed", { type: t(choiceOf(blocks[index] as Block).label) }));
	};

	const move = (from: number, to: number) => {
		if (to < 0 || to >= blocks.length) return;
		commit(moveItem(blocks, from, to));
		setAnnouncement(t("body.moved", { to: to + 1, count: blocks.length }));
	};
	const drag = useDragOrder(move);

	const choose = (choice: BlockChoice) => {
		const state = menu;
		setMenu(null);
		const anchor = state?.after ? blocks.find((block) => block.id === state.after) : undefined;
		const emptyParagraph = anchor?.type === "paragraph" && runsLength(anchor.text) === 0;
		if (anchor && (state?.slash || emptyParagraph)) {
			replaceWith(anchor, choice, []);
		} else {
			const block = newBlock(choice);
			// A divider holds nothing to type: writing goes on in a paragraph after it.
			const after = choice.type === "divider" ? [block, newBlock(BLOCK_CHOICES[0] as BlockChoice)] : [block];
			insertAfter(state?.after ?? null, after, { key: firstKey(after.at(-1) as Block), offset: "start" });
		}
		setAnnouncement(t("body.added", { type: t(choice.label) }));
	};

	/** Turns a Block into a choice holding `text`; a divider gets a paragraph after it to write on in. */
	const replaceWith = (block: Block, choice: BlockChoice, text: InlineText) => {
		const turned = turnInto({ ...block, ...("text" in block ? { text } : {}) } as Block, choice);
		const parts = choice.type === "divider" ? [turned, newBlock(BLOCK_CHOICES[0] as BlockChoice)] : [turned];
		const index = blocks.findIndex((each) => each.id === block.id);
		commit([...blocks.slice(0, index), ...parts, ...blocks.slice(index + 1)], [block.id], {
			key: firstKey(parts.at(-1) as Block),
			offset: "start",
		});
	};

	/** A text Block's text changed by typing; a paragraph that becomes ``` or --- turns into code or a divider. */
	const typed = (block: Block, text: InlineText) => {
		const whole = text.map((run) => run.text).join("");
		const target =
			block.type === "paragraph" ? allowed.find((choice) => choice.id === WHOLE_SHORTCUTS[whole]) : undefined;
		if (target) {
			replaceWith(block, target, []);
			setAnnouncement(t("body.added", { type: t(target.label) }));
			return;
		}
		change(block.id, () => ({ ...block, text }) as Block);
	};

	const closeMenu = () => {
		const state = menu;
		setMenu(null);
		const anchor = state?.after ? blocks.find((block) => block.id === state.after) : undefined;
		if (anchor && state?.slash && anchor.type === "paragraph") {
			// Escape keeps the `/` that opened the menu.
			change(anchor.id, () => ({ ...anchor, text: [{ text: "/" }] }));
			setVersions((before) => ({ ...before, [anchor.id]: (before[anchor.id] ?? 0) + 1 }));
			pending.current = { key: `${anchor.id}:text`, offset: "end" };
		} else if (anchor) {
			pending.current = { key: firstKey(anchor), offset: "end" };
			setVersions((before) => ({ ...before }));
		}
	};

	/** Runs a formatting command on the text the caret was last in. */
	const format = (command: "bold" | "italic" | "strikeThrough" | "code") => {
		const at = current.current;
		const element = at ? editables.current.get(at.key) : undefined;
		if (!at || !element) return;
		element.focus();
		const selection = window.getSelection();
		if (at.range && selection) {
			selection.removeAllRanges();
			selection.addRange(at.range);
		}
		if (command === "code") toggleCode(element);
		else document.execCommand(command);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	};

	const addLink = (url: string) => {
		const at = current.current;
		const element = at ? editables.current.get(at.key) : undefined;
		if (!at || !element || !isSafeLink(url)) return;
		element.focus();
		const selection = window.getSelection();
		if (at.range && selection) {
			selection.removeAllRanges();
			selection.addRange(at.range);
		}
		if (selection && !selection.isCollapsed) document.execCommand("createLink", false, url);
		else document.execCommand("insertHTML", false, `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	};

	/** Turns the Block the caret is in into a choice (the toolbar's heading, lists and quote). */
	const turnCurrent = (choice: BlockChoice) => {
		const block = blocks.find((each) => each.id === current.current?.blockId);
		if (!block || !isTextBlock(block)) {
			const added = newBlock(choice);
			insertAfter(block?.id ?? null, [added], { key: firstKey(added), offset: "start" });
			return;
		}
		const same = choiceOf(block).id === choice.id;
		const turned = turnInto(block, same ? (BLOCK_CHOICES[0] as BlockChoice) : choice);
		commit(
			blocks.map((each) => (each.id === block.id ? turned : each)),
			[block.id],
			{ key: firstKey(turned), offset: "end" },
		);
	};

	const remember = (blockId: string, key: string) => {
		const selection = window.getSelection();
		const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
		current.current = { blockId, key, range };
	};

	/** Keys every piece of text shares: moving between Blocks, moving Blocks, formatting. */
	const sharedKeys = (event: KeyboardEvent<HTMLElement>, element: HTMLElement, index: number, key: string): boolean => {
		const mod = isMac() ? event.metaKey : event.ctrlKey;
		if (event.altKey && event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
			event.preventDefault();
			const to = index + (event.key === "ArrowUp" ? -1 : 1);
			move(index, to);
			pending.current = { key, offset: caretOffset(element) ?? "end" };
			return true;
		}
		if (
			mod &&
			!event.shiftKey &&
			!event.altKey &&
			(event.key.toLowerCase() === "b" || event.key.toLowerCase() === "i")
		) {
			event.preventDefault();
			format(event.key.toLowerCase() === "b" ? "bold" : "italic");
			return true;
		}
		if (mod && event.shiftKey && event.key.toLowerCase() === "x") {
			event.preventDefault();
			format("strikeThrough");
			return true;
		}
		if (mod && !event.shiftKey && event.key.toLowerCase() === "e") {
			event.preventDefault();
			format("code");
			return true;
		}
		if (mod && !event.shiftKey && event.key.toLowerCase() === "k") {
			event.preventDefault();
			setLinking(true);
			return true;
		}
		const offset = caretOffset(element);
		const length = element.textContent?.length ?? 0;
		const previous = blocks[index - 1];
		const next = blocks[index + 1];
		if (!event.shiftKey && !mod && !event.altKey) {
			if (
				((event.key === "ArrowUp" && caretOnEdgeLine(element, "first")) ||
					(event.key === "ArrowLeft" && offset === 0)) &&
				previous
			) {
				if (key !== firstKey(blocks[index] as Block)) return false;
				event.preventDefault();
				pending.current = { key: lastKey(previous), offset: "end" };
				setVersions((before) => ({ ...before }));
				return true;
			}
			if (
				((event.key === "ArrowDown" && caretOnEdgeLine(element, "last")) ||
					(event.key === "ArrowRight" && offset === length)) &&
				next
			) {
				if (key !== lastKey(blocks[index] as Block)) return false;
				event.preventDefault();
				pending.current = { key: firstKey(next), offset: "start" };
				setVersions((before) => ({ ...before }));
				return true;
			}
		}
		return false;
	};

	/** Keys in a Block of one piece of text: a paragraph, a heading, a quote, a callout. */
	const textKeys =
		(block: Extract<Block, { text: InlineText }>, index: number) =>
		(event: KeyboardEvent<HTMLElement>, element: HTMLElement) => {
			const key = `${block.id}:text`;
			if (event.nativeEvent.isComposing) return;
			const text = block.text;
			const plain = text.map((run) => run.text).join("");
			if (event.key === "/" && block.type === "paragraph" && plain === "" && allowed.length > 0) {
				event.preventDefault();
				setMenu({ after: block.id, slash: true });
				return;
			}
			if (event.key === " " && block.type === "paragraph") {
				const offset = caretOffset(element) ?? 0;
				const marker = plain.slice(0, offset);
				const target = allowed.find((choice) => choice.id === SHORTCUTS[marker]);
				if (target) {
					event.preventDefault();
					replaceWith(block, target, splitRuns(text, offset)[1]);
					setAnnouncement(t("body.added", { type: t(target.label) }));
					return;
				}
			}
			if (sharedKeys(event, element, index, key)) return;
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				const offset = caretOffset(element) ?? runsLength(text);
				const [before, after] = splitRuns(text, offset);
				const added = newBlock(BLOCK_CHOICES[0] as BlockChoice, after);
				const index = blocks.findIndex((each) => each.id === block.id);
				commit([...blocks.slice(0, index), { ...block, text: before }, added, ...blocks.slice(index + 1)], [block.id], {
					key: `${added.id}:text`,
					offset: "start",
				});
				return;
			}
			if (event.key === "Enter" && event.shiftKey && block.type === "heading") {
				event.preventDefault();
				return;
			}
			if (event.key === "Backspace" && caretOffset(element) === 0 && window.getSelection()?.isCollapsed) {
				if (block.type !== "paragraph") {
					event.preventDefault();
					const turned = turnInto(block, BLOCK_CHOICES[0] as BlockChoice);
					commit(
						blocks.map((each) => (each.id === block.id ? turned : each)),
						[block.id],
						{ key: `${block.id}:text`, offset: "start" },
					);
					return;
				}
				const previous = blocks[index - 1];
				if (previous && "text" in previous && previous.type !== "toggle") {
					event.preventDefault();
					const joinAt = runsLength(previous.text);
					const merged = { ...previous, text: joinRuns(previous.text, text) } as Block;
					commit(
						blocks.filter((each) => each.id !== block.id).map((each) => (each.id === previous.id ? merged : each)),
						[previous.id],
						{ key: `${previous.id}:text`, offset: joinAt },
					);
					return;
				}
				if (previous && plain === "") {
					event.preventDefault();
					remove(block.id);
				}
			}
		};

	/** Keys in a list's line: Enter adds an item (or leaves the list), Ctrl+] and Ctrl+[ nest. */
	const lineKeys =
		(block: Extract<Block, { type: "list" }>, index: number, lines: Line[], line: number) =>
		(event: KeyboardEvent<HTMLElement>, element: HTMLElement) => {
			const key = `${block.id}:item:${line}`;
			if (event.nativeEvent.isComposing) return;
			const mod = isMac() ? event.metaKey : event.ctrlKey;
			const here = lines[line] as Line;
			const setLines = (next: Line[], focus: FocusRequest, extra?: (list: Block) => Block[]) => {
				const list: Block = { ...block, items: itemsOf(next) };
				const replaced = extra ? extra(list) : [list];
				commit([...blocks.slice(0, index), ...replaced, ...blocks.slice(index + 1)], [block.id], focus);
			};
			if (mod && (event.key === "]" || event.key === "[")) {
				event.preventDefault();
				const deeper = event.key === "]";
				const limit = line === 0 ? 0 : Math.min(2, (lines[line - 1] as Line).depth + 1);
				const depth = deeper ? Math.min(limit, here.depth + 1) : Math.max(0, here.depth - 1);
				setLines(
					lines.map((each, each_index) => (each_index === line ? { ...each, depth } : each)),
					{ key, offset: caretOffset(element) ?? "end" },
				);
				return;
			}
			if (sharedKeys(event, element, index, key)) return;
			if (!event.shiftKey && !mod && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
				const to = line + (event.key === "ArrowUp" ? -1 : 1);
				if (to >= 0 && to < lines.length && caretOnEdgeLine(element, event.key === "ArrowUp" ? "first" : "last")) {
					event.preventDefault();
					pending.current = { key: `${block.id}:item:${to}`, offset: event.key === "ArrowUp" ? "end" : "start" };
					setVersions((before) => ({ ...before }));
				}
				return;
			}
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				if (runsLength(here.text) === 0) {
					if (here.depth > 0) {
						setLines(
							lines.map((each, each_index) => (each_index === line ? { ...each, depth: each.depth - 1 } : each)),
							{ key, offset: "start" },
						);
						return;
					}
					// An empty item at the top leaves the list: a paragraph takes its place, and the items after it start a new list.
					const paragraph = newBlock(BLOCK_CHOICES[0] as BlockChoice);
					const before = lines.slice(0, line);
					const after = lines.slice(line + 1);
					const parts: Block[] = [];
					if (before.length > 0) parts.push({ ...block, items: itemsOf(before) });
					parts.push(paragraph);
					if (after.length > 0) {
						parts.push({
							...newBlock(choiceOf(block)),
							items: itemsOf(
								after.map((each) => ({ ...each, depth: Math.max(0, each.depth - (after[0]?.depth ?? 0)) })),
							),
						} as Block);
					}
					commit([...blocks.slice(0, index), ...parts, ...blocks.slice(index + 1)], [block.id], {
						key: `${paragraph.id}:text`,
						offset: "start",
					});
					return;
				}
				const offset = caretOffset(element) ?? runsLength(here.text);
				const [before, after] = splitRuns(here.text, offset);
				setLines(
					[
						...lines.slice(0, line),
						{ ...here, text: before },
						{ depth: here.depth, text: after },
						...lines.slice(line + 1),
					],
					{ key: `${block.id}:item:${line + 1}`, offset: "start" },
				);
				return;
			}
			if (event.key === "Backspace" && caretOffset(element) === 0 && window.getSelection()?.isCollapsed) {
				event.preventDefault();
				if (here.depth > 0) {
					setLines(
						lines.map((each, each_index) => (each_index === line ? { ...each, depth: each.depth - 1 } : each)),
						{ key, offset: "start" },
					);
				} else if (line > 0) {
					const previous = lines[line - 1] as Line;
					const joinAt = runsLength(previous.text);
					setLines(
						[
							...lines.slice(0, line - 1),
							{ ...previous, text: joinRuns(previous.text, here.text) },
							...lines.slice(line + 1),
						],
						{ key: `${block.id}:item:${line - 1}`, offset: joinAt },
					);
				} else {
					// The first item leaves the list as a paragraph before it.
					const paragraph = newBlock(BLOCK_CHOICES[0] as BlockChoice, here.text);
					const rest = lines.slice(1);
					commit(
						[
							...blocks.slice(0, index),
							paragraph,
							...(rest.length > 0
								? [
										{
											...block,
											items: itemsOf(
												rest.map((each) => ({ ...each, depth: Math.max(0, each.depth - (rest[0]?.depth ?? 0)) })),
											),
										},
									]
								: []),
							...blocks.slice(index + 1),
						],
						[block.id],
						{ key: `${paragraph.id}:text`, offset: "start" },
					);
				}
			}
		};

	const register = (key: string) => (element: HTMLElement | null) => {
		if (element) editables.current.set(key, element);
		else editables.current.delete(key);
	};

	const blockLabel = (block: Block, index: number) =>
		t("body.block", {
			type:
				block.type === "component"
					? (components.find((each) => each.id === block.component)?.name ?? t("body.components.unknown"))
					: t(choiceOf(block).label),
			number: index + 1,
		});

	const offers = (id: string) => allowed.some((choice) => choice.id === id);
	const choice = (id: string) => BLOCK_CHOICES.find((each) => each.id === id) as BlockChoice;
	const toolbarButtons: ToolbarButton[] = [
		...(offers("heading2")
			? [
					{
						id: "heading",
						label: "body.toolbar.heading",
						icon: Heading2Icon,
						run: () => turnCurrent(choice("heading2")),
					} as const,
				]
			: []),
		{ id: "bold", label: "body.toolbar.bold", icon: BoldIcon, run: () => format("bold") },
		{ id: "italic", label: "body.toolbar.italic", icon: ItalicIcon, run: () => format("italic") },
		{ id: "strike", label: "body.toolbar.strike", icon: StrikethroughIcon, run: () => format("strikeThrough") },
		{ id: "code", label: "body.toolbar.code", icon: CodeIcon, run: () => format("code") },
		{ id: "link", label: "body.toolbar.link", icon: LinkIcon, run: () => setLinking(true) },
		...(["bulleted", "numbered", "quote"] as const)
			.filter(offers)
			.map((id) => ({ id, label: choice(id).label, icon: choice(id).icon, run: () => turnCurrent(choice(id)) })),
		...(offers("image")
			? [
					{
						id: "image",
						label: "body.toolbar.image",
						icon: ImageIcon,
						run: () => {
							const added = newBlock(choice("image"));
							insertAfter(current.current?.blockId ?? null, [added], { key: firstKey(added), offset: "start" });
						},
					} as const,
				]
			: []),
	];
	const [toolbarFocus, setToolbarFocus] = useState(0);

	return (
		<div
			className="data-[invalid=true]:border-destructive dark:bg-input/30 grid rounded-md border"
			data-invalid={invalid ? true : undefined}
			onPasteCapture={(event) => void paste(event)}
		>
			<div
				ref={toolbar}
				role="toolbar"
				aria-label={t("body.toolbar.label")}
				aria-controls={id}
				className="bg-muted/50 flex flex-wrap items-center gap-1 rounded-t-md border-b p-1"
				onKeyDown={(event) => {
					if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End")
						return;
					event.preventDefault();
					const count = toolbarButtons.length + 1;
					const next =
						event.key === "Home"
							? 0
							: event.key === "End"
								? count - 1
								: (toolbarFocus + (event.key === "ArrowRight" ? 1 : -1) + count) % count;
					setToolbarFocus(next);
					toolbar.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
				}}
			>
				{toolbarButtons.map((button, index) => (
					<Button
						key={button.id}
						ref={button.id === "link" ? linkButton : undefined}
						type="button"
						variant="ghost"
						size="icon-sm"
						tabIndex={toolbarFocus === index ? 0 : -1}
						aria-label={t(button.label)}
						onMouseDown={(event) => event.preventDefault()}
						onFocus={() => setToolbarFocus(index)}
						onClick={button.run}
					>
						<button.icon aria-hidden="true" />
					</Button>
				))}
				<div className="relative">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						tabIndex={toolbarFocus === toolbarButtons.length ? 0 : -1}
						aria-expanded={menu !== null && !menu.slash}
						onMouseDown={(event) => event.preventDefault()}
						onFocus={() => setToolbarFocus(toolbarButtons.length)}
						onClick={() => setMenu({ after: current.current?.blockId ?? null, slash: false })}
					>
						<PlusIcon aria-hidden="true" />
						{t("body.toolbar.add")}
					</Button>
					{menu !== null && !menu.slash ? (
						<BlockMenu
							components={components}
							onComponent={chooseComponent}
							choices={allowed}
							onChoose={choose}
							onClose={closeMenu}
						/>
					) : null}
				</div>
			</div>
			<ol
				id={id}
				aria-labelledby={labelledBy}
				aria-describedby={[describedBy, `${id}-tips`].filter(Boolean).join(" ")}
				lang={lang}
				className="grid gap-1 p-2"
			>
				{blocks.map((block, index) => {
					const within = problemsWithin(problems, `${path}[${index}]`);
					const blockChecks = checks.filter((check) => check.blockId === block.id);
					const notesId = `${id}-block-${index}-notes`;
					const hasNotes = within.length > 0 || blockChecks.length > 0;
					return (
						<BlockRow
							key={block.id}
							index={index}
							count={blocks.length}
							label={blockLabel(block, index)}
							drag={drag}
							turnChoices={isTextBlock(block) ? allowed.filter((choice) => isTextBlock(newBlock(choice))) : []}
							onTurn={(choice) => {
								const turned = turnInto(block, choice);
								commit(
									blocks.map((each) => (each.id === block.id ? turned : each)),
									[block.id],
									{ key: firstKey(turned), offset: "end" },
								);
							}}
							onMove={(to) => move(index, to)}
							onRemove={() => remove(block.id)}
							onFocusWithin={() => {
								if (current.current?.blockId !== block.id)
									current.current = { blockId: block.id, key: firstKey(block), range: null };
							}}
							notes={hasNotes ? <BlockNotes id={notesId} problems={within} checks={blockChecks} /> : null}
							menu={
								menu?.slash && menu.after === block.id ? (
									<BlockMenu
										components={components}
										onComponent={chooseComponent}
										choices={allowed}
										onChoose={choose}
										onClose={closeMenu}
									/>
								) : null
							}
						>
							{block.type === "component" ? (
								<div className="grid gap-2 p-2">
									<p className="font-medium">
										{components.find((each) => each.id === block.component)?.name ?? t("body.components.unknown")}
									</p>
									<Button
										type="button"
										variant="outline"
										ref={register(`${block.id}:control`)}
										disabled={!components.some((each) => each.id === block.component)}
										onClick={() => {
											const component = components.find((each) => each.id === block.component);
											if (component) setComponentForm({ component, block, after: null, slash: false });
										}}
									>
										{t("body.components.edit", {
											name:
												components.find((each) => each.id === block.component)?.name ?? t("body.components.unknown"),
										})}
									</Button>
								</div>
							) : (
								<BlockContent
									key={`${block.id}-${versions[block.id] ?? 0}`}
									siteId={siteId}
									block={block}
									label={blockLabel(block, index)}
									describedBy={hasNotes ? notesId : undefined}
									invalid={within.length > 0}
									media={media}
									onMediaChosen={onMediaChosen}
									register={(part) => register(`${block.id}:${part}`)}
									onFocusText={(part) => remember(block.id, `${block.id}:${part}`)}
									onChange={(next) => change(block.id, () => next)}
									onTyped={(text) => typed(block, text)}
									textKeys={"text" in block && block.type !== "toggle" ? textKeys(block, index) : undefined}
									lineKeys={block.type === "list" ? (lines, line) => lineKeys(block, index, lines, line) : undefined}
									sharedKeys={(part) => (event, element) => {
										sharedKeys(event, element, index, `${block.id}:${part}`);
									}}
								/>
							)}
						</BlockRow>
					);
				})}
			</ol>
			<p id={`${id}-tips`} className="text-muted-foreground border-t px-3 py-2 text-xs">
				{t("body.help")}
			</p>
			{componentForm ? (
				<ComponentProps
					siteId={siteId}
					component={componentForm.component}
					block={componentForm.block}
					media={media}
					onMediaChosen={onMediaChosen}
					onClose={() => {
						const target = componentForm.block?.id ?? componentForm.after;
						setComponentForm(null);
						if (target) {
							const block = blocks.find((each) => each.id === target);
							if (block) editables.current.get(firstKey(block))?.focus();
						}
					}}
					onSave={(props) => {
						const { component, block, after, slash } = componentForm;
						setComponentForm(null);
						if (block) {
							change(block.id, () => ({ ...block, props }));
							return;
						}
						const added = newComponentBlock(component.id, props);
						const anchor = blocks.find((each) => each.id === after);
						if (anchor?.type === "paragraph" && (slash || runsLength(anchor.text) === 0)) {
							commit(
								blocks.map((each) => (each.id === anchor.id ? { ...added, id: anchor.id } : each)),
								[],
								{ key: `${anchor.id}:control`, offset: "start" },
							);
						} else insertAfter(after, [added], { key: firstKey(added), offset: "start" });
					}}
				/>
			) : null}
			<LinkDialog open={linking} onOpenChange={setLinking} finalFocus={linkButton} onAdd={addLink} />
			<Announcer message={announcement} />
		</div>
	);
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Inline code on the selection: wraps it in `<code>`, or takes the code off when it is all code already. */
function toggleCode(element: HTMLElement): void {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
	const range = selection.getRangeAt(0);
	const code = (
		range.commonAncestorContainer instanceof Element
			? range.commonAncestorContainer
			: range.commonAncestorContainer.parentElement
	)?.closest("code");
	const text = range.toString();
	if (code && element.contains(code)) document.execCommand("insertText", false, text);
	else document.execCommand("insertHTML", false, `<code>${escapeHtml(text)}</code>`);
}

/** A Block's problems (what keeps the Draft from being published) and Checks (warnings), under it. */
function BlockNotes({
	id,
	problems,
	checks,
}: {
	id: string;
	problems: readonly Problem[];
	checks: readonly BodyCheck[];
}) {
	const t = useT();
	return (
		<ul id={id} className="grid gap-1 ps-7 text-sm">
			{problems.map((problem) => (
				<li
					key={`${problem.at}:${problem.rule ?? problem.message}`}
					className="text-destructive flex items-start gap-1.5"
				>
					<CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
					<span>
						{problem.rule === "blockType" || problem.rule === "video" || problem.rule === "media"
							? t(`content.problems.${problem.rule}`)
							: t("content.problems.invalid")}
					</span>
				</li>
			))}
			{checks.map((check) => (
				<li
					key={`${check.check}:${check.detail ?? ""}`}
					className="flex items-start gap-1.5 text-amber-800 dark:text-amber-300"
				>
					<TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
					<span>
						<span className="sr-only">{t("body.checks.warning")} </span>
						{t(`body.checks.${check.check}`, { detail: check.detail ?? "" })}
					</span>
				</li>
			))}
		</ul>
	);
}

/** One Block in the list: its drag handle, what it holds, its menu, and its notes and `/` menu under it. */
function BlockRow({
	index,
	count,
	label,
	drag,
	turnChoices,
	onTurn,
	onMove,
	onRemove,
	onFocusWithin,
	notes,
	menu,
	children,
}: {
	index: number;
	count: number;
	label: string;
	drag: ReturnType<typeof useDragOrder>;
	turnChoices: readonly BlockChoice[];
	onTurn(choice: BlockChoice): void;
	onMove(to: number): void;
	onRemove(): void;
	onFocusWithin(): void;
	notes: ReactNode;
	menu: ReactNode;
	children: ReactNode;
}) {
	const t = useT();
	const item = useRef<HTMLLIElement>(null);
	return (
		<li
			ref={item}
			{...drag.itemProps(index)}
			onFocus={onFocusWithin}
			className="group data-[drop-target=true]:border-primary relative grid gap-1 rounded-md border border-transparent py-1 data-[drop-target=true]:border-dashed"
		>
			<div className="flex items-start gap-1">
				<span className="mt-1">
					<DragHandle {...drag.handleProps(index, () => item.current)} />
				</span>
				<div className="relative min-w-0 flex-1">
					{children}
					{menu}
				</div>
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								className="text-muted-foreground"
								aria-label={t("body.actions", { block: label })}
							/>
						}
					>
						<EllipsisIcon aria-hidden="true" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-auto min-w-44">
						{turnChoices.length > 0 ? (
							<>
								<DropdownMenuGroup>
									<DropdownMenuLabel>{t("body.turnInto")}</DropdownMenuLabel>
									{turnChoices.map((choice) => (
										<DropdownMenuItem key={choice.id} onClick={() => onTurn(choice)}>
											<choice.icon aria-hidden="true" />
											{t(choice.label)}
										</DropdownMenuItem>
									))}
								</DropdownMenuGroup>
								<DropdownMenuSeparator />
							</>
						) : null}
						<DropdownMenuItem disabled={index === 0} onClick={() => onMove(index - 1)}>
							<ArrowUpIcon aria-hidden="true" />
							{t("content.moveUp")}
						</DropdownMenuItem>
						<DropdownMenuItem disabled={index === count - 1} onClick={() => onMove(index + 1)}>
							<ArrowDownIcon aria-hidden="true" />
							{t("content.moveDown")}
						</DropdownMenuItem>
						<DropdownMenuItem variant="destructive" onClick={onRemove}>
							<Trash2Icon aria-hidden="true" />
							{t("body.remove")}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			{notes}
		</li>
	);
}

type KeyHandler = (event: KeyboardEvent<HTMLElement>, element: HTMLElement) => void;

/** What a Block holds, edited in place by its type. */
function BlockContent({
	siteId,
	block,
	label,
	describedBy,
	invalid,
	media,
	onMediaChosen,
	register,
	onFocusText,
	onChange,
	onTyped,
	textKeys,
	lineKeys,
	sharedKeys,
}: {
	siteId: string;
	block: Block;
	label: string;
	describedBy?: string;
	invalid: boolean;
	media: Readonly<Record<string, MediaItem>>;
	onMediaChosen(item: MediaItem): void;
	register(part: string): (element: HTMLElement | null) => void;
	onFocusText(part: string): void;
	onChange(block: Block): void;
	/** The text of a paragraph, heading, quote or callout, typed. */
	onTyped(text: InlineText): void;
	textKeys?: KeyHandler;
	lineKeys?: (lines: Line[], line: number) => KeyHandler;
	sharedKeys(part: string): KeyHandler;
}) {
	const t = useT();
	const common = { describedBy, invalid };
	switch (block.type) {
		case "paragraph":
		case "heading":
		case "quote": {
			const styles: Record<string, string> = {
				paragraph: "",
				heading: block.type === "heading" ? (["", "", "text-2xl", "text-xl", "text-lg"][block.level] ?? "") : "",
				quote: "border-s-2 ps-3 italic",
			};
			return (
				<InlineEditor
					{...common}
					label={label}
					value={block.text}
					multiline={block.type !== "heading"}
					placeholder={block.type === "paragraph" ? t("body.placeholder") : undefined}
					className={`${styles[block.type]} ${block.type === "heading" ? "font-semibold tracking-tight" : ""} py-0.5`}
					register={register("text")}
					onFocus={() => onFocusText("text")}
					onChange={onTyped}
					onKeyDown={(event, element) => {
						onFocusText("text");
						textKeys?.(event, element);
					}}
				/>
			);
		}
		case "callout":
			return (
				<div className="bg-muted/60 border-primary grid gap-2 rounded-md border-s-4 p-2 sm:grid-cols-[auto_1fr]">
					<NativeSelect
						ref={register("control")}
						aria-label={t("body.callout.tone", { block: label })}
						value={block.tone}
						onChange={(event) => onChange({ ...block, tone: event.target.value as CalloutTone })}
						size="sm"
					>
						{CALLOUT_TONES.map((tone) => (
							<NativeSelectOption key={tone} value={tone}>
								{t(`body.callout.tones.${tone}`)}
							</NativeSelectOption>
						))}
					</NativeSelect>
					<InlineEditor
						{...common}
						label={label}
						value={block.text}
						register={register("text")}
						onFocus={() => onFocusText("text")}
						onChange={(text) => onChange({ ...block, text })}
						onKeyDown={(event, element) => {
							onFocusText("text");
							textKeys?.(event, element);
						}}
					/>
				</div>
			);
		case "list": {
			const lines = linesOf(block.items);
			const Tag = block.style === "numbered" ? "ol" : "ul";
			return (
				<Tag
					className={`${block.style === "numbered" ? "list-decimal" : "list-disc"} grid gap-0.5 ps-6`}
					aria-label={label}
				>
					{lines.map((line, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: lines are edited in place; the list's own key starts them again on bigger changes.
						<li key={index} style={{ marginInlineStart: `${line.depth * 1.5}rem` }}>
							<InlineEditor
								{...common}
								label={t("body.list.item", { number: index + 1 })}
								value={line.text}
								register={register(`item:${index}`)}
								onFocus={() => onFocusText(`item:${index}`)}
								onChange={(text) => {
									const next = lines.map((each, each_index) => (each_index === index ? { ...each, text } : each));
									onChange({ ...block, items: itemsOf(next) });
								}}
								onKeyDown={(event, element) => {
									onFocusText(`item:${index}`);
									lineKeys?.(lines, index)(event, element);
								}}
							/>
						</li>
					))}
				</Tag>
			);
		}
		case "image": {
			const item = block.media ? (media[block.media] ?? null) : null;
			return (
				<div
					className="grid gap-2"
					ref={(node) =>
						register("control")(node?.querySelector<HTMLElement>(`#${CSS.escape(`${block.id}-media`)}`) ?? null)
					}
				>
					<span id={`${block.id}-label`} className="sr-only">
						{label}
					</span>
					<MediaPicker
						siteId={siteId}
						id={`${block.id}-media`}
						labelledBy={`${block.id}-label`}
						describedBy={[describedBy, `${block.id}-texts`].filter(Boolean).join(" ")}
						invalid={invalid}
						value={block.media}
						item={item}
						onChange={(next) => {
							if (next) onMediaChosen(next.item);
							onChange({ ...block, media: next ? next.id : null });
						}}
					/>
					<p id={`${block.id}-texts`} className="text-muted-foreground text-sm">
						{item ? (
							<>
								{item.alt ? t("body.image.alt", { alt: item.alt }) : t("body.image.noAlt")}
								{item.caption ? ` ${t("body.image.caption", { caption: item.caption })}` : ""}{" "}
							</>
						) : null}
						{t("body.image.fromLibrary")}
					</p>
				</div>
			);
		}
		case "video": {
			const found = block.url ? videoAt(block.url) : undefined;
			return (
				<fieldset className="grid gap-2 rounded-md border p-3" aria-describedby={describedBy}>
					<legend className="px-1 text-sm font-medium">{label}</legend>
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="grid gap-1.5">
							<Label htmlFor={`${block.id}-url`} className="text-muted-foreground font-normal">
								{t("body.video.address")}
							</Label>
							<Input
								ref={register("control")}
								id={`${block.id}-url`}
								inputMode="url"
								autoComplete="off"
								placeholder="https://"
								value={block.url}
								aria-invalid={invalid ? true : undefined}
								aria-describedby={`${block.id}-url-help`}
								onChange={(event) => onChange({ ...block, url: event.target.value })}
							/>
							<p id={`${block.id}-url-help`} className="text-muted-foreground text-sm">
								{found ? t(`body.video.${found.provider}`) : t("body.video.addressHelp")}
							</p>
						</div>
						<div className="grid gap-1.5">
							<Label htmlFor={`${block.id}-title`} className="text-muted-foreground font-normal">
								{t("body.video.title")}
							</Label>
							<Input
								id={`${block.id}-title`}
								autoComplete="off"
								maxLength={300}
								value={block.title}
								aria-describedby={`${block.id}-title-help`}
								onChange={(event) => onChange({ ...block, title: event.target.value })}
							/>
							<p id={`${block.id}-title-help`} className="text-muted-foreground text-sm">
								{t("body.video.titleHelp")}
							</p>
						</div>
					</div>
				</fieldset>
			);
		}
		case "table": {
			const columns = Math.max(1, ...block.rows.map((row) => row.length));
			const setCell = (row: number, column: number, text: InlineText) =>
				onChange({
					...block,
					rows: block.rows.map((cells, each) =>
						each === row ? cells.map((cell, which) => (which === column ? text : cell)) : cells,
					),
				});
			return (
				<fieldset className="grid gap-2 rounded-md border p-3" aria-describedby={describedBy}>
					<legend className="px-1 text-sm font-medium">{label}</legend>
					<div className="overflow-x-auto">
						<table className="w-full border-collapse text-sm">
							<tbody>
								{block.rows.map((row, rowIndex) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place.
									<tr key={rowIndex}>
										{row.map((cell, column) => (
											<td
												// biome-ignore lint/suspicious/noArrayIndexKey: cells are edited in place.
												key={column}
												className={`border p-1 ${block.headerRow && rowIndex === 0 ? "bg-muted font-medium" : ""}`}
											>
												<InlineEditor
													label={t("body.table.cell", { row: rowIndex + 1, column: column + 1 })}
													value={cell}
													multiline={false}
													register={register(`cell:${rowIndex}:${column}`)}
													onFocus={() => onFocusText(`cell:${rowIndex}:${column}`)}
													onChange={(text) => setCell(rowIndex, column, text)}
													onKeyDown={(event, element) => {
														onFocusText(`cell:${rowIndex}:${column}`);
														if (event.key === "Enter") event.preventDefault();
														sharedKeys(`cell:${rowIndex}:${column}`)(event, element);
													}}
												/>
											</td>
										))}
									</tr>
								))}
							</tbody>
						</table>
					</div>
					<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
						<div className="flex items-center gap-2">
							<Checkbox
								id={`${block.id}-header`}
								checked={block.headerRow}
								onCheckedChange={(checked) => onChange({ ...block, headerRow: checked === true })}
							/>
							<Label htmlFor={`${block.id}-header`} className="font-normal">
								{t("body.table.headerRow")}
							</Label>
						</div>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => onChange({ ...block, rows: [...block.rows, Array.from({ length: columns }, () => [])] })}
							disabled={block.rows.length >= 500}
						>
							<PlusIcon aria-hidden="true" />
							{t("body.table.addRow")}
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => onChange({ ...block, rows: block.rows.map((row) => [...row, []]) })}
							disabled={columns >= 20}
						>
							<PlusIcon aria-hidden="true" />
							{t("body.table.addColumn")}
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={block.rows.length <= 1}
							onClick={() => onChange({ ...block, rows: block.rows.slice(0, -1) })}
						>
							<Trash2Icon aria-hidden="true" />
							{t("body.table.removeRow")}
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={columns <= 1}
							onClick={() => onChange({ ...block, rows: block.rows.map((row) => row.slice(0, -1)) })}
						>
							<Trash2Icon aria-hidden="true" />
							{t("body.table.removeColumn")}
						</Button>
					</div>
				</fieldset>
			);
		}
		case "code":
			return (
				<fieldset className="grid gap-2 rounded-md border p-3" aria-describedby={describedBy}>
					<legend className="px-1 text-sm font-medium">{label}</legend>
					<Label htmlFor={`${block.id}-code`} className="sr-only">
						{t("body.code.code")}
					</Label>
					<Textarea
						ref={register("control")}
						id={`${block.id}-code`}
						value={block.code}
						rows={Math.min(20, Math.max(3, block.code.split("\n").length))}
						spellCheck={false}
						className="font-mono text-sm"
						onChange={(event) => onChange({ ...block, code: event.target.value })}
						onKeyDown={(event) => sharedKeys("control")(event, event.currentTarget)}
					/>
					<div className="flex items-center gap-2">
						<Label htmlFor={`${block.id}-language`} className="text-muted-foreground font-normal">
							{t("body.code.language")}
						</Label>
						<Input
							id={`${block.id}-language`}
							value={block.language ?? ""}
							maxLength={32}
							autoComplete="off"
							spellCheck={false}
							className="w-32 font-mono"
							onChange={(event) => onChange({ ...block, language: event.target.value.trim().toLowerCase() || null })}
						/>
					</div>
				</fieldset>
			);
		case "divider":
			return (
				<div className="flex items-center py-3">
					<hr className="flex-1" />
					<span className="sr-only">{label}</span>
				</div>
			);
		case "toggle":
			return (
				<div className="grid gap-1 rounded-md border p-2">
					<InlineEditor
						label={t("body.toggle.summary", { block: label })}
						value={block.summary}
						multiline={false}
						className="font-medium"
						register={register("summary")}
						onFocus={() => onFocusText("summary")}
						onChange={(summary) => onChange({ ...block, summary })}
						onKeyDown={(event, element) => {
							onFocusText("summary");
							if (event.key === "Enter") event.preventDefault();
							sharedKeys("summary")(event, element);
						}}
					/>
					<InlineEditor
						{...common}
						label={t("body.toggle.text", { block: label })}
						value={block.text}
						className="text-muted-foreground ps-4"
						register={register("text")}
						onFocus={() => onFocusText("text")}
						onChange={(text) => onChange({ ...block, text })}
						onKeyDown={(event, element) => {
							onFocusText("text");
							sharedKeys("text")(event, element);
						}}
					/>
				</div>
			);
	}
}
