import {
	BoldIcon,
	CheckIcon,
	ItalicIcon,
	Link2OffIcon,
	LinkIcon,
	ListIcon,
	ListOrderedIcon,
	TriangleAlertIcon,
	TypeIcon,
	Undo2Icon,
} from "lucide-react";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";

import { editorHistory } from "../../builder/editor-history.ts";
import { ariaKeys, chordText, onApple, shortcutText } from "../../builder/shortcuts.ts";
import { fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING, type Icon, Tip } from "../controls.tsx";
import type { EditingSnapshot, PageEditing } from "./editing.ts";

/** The toolbar's height (SPEC 13.3, `client/02`): 44, with 32 high tools. */
const TOOLBAR_HEIGHT = 44;
/** The space between the toolbar or the problem note and the region they belong to. */
const GAP = 8;

/** One of the toolbar's tools, as it shows and acts. */
type Tool = {
	id: "bold" | "italic" | "link" | "bulletList" | "numberedList" | "undo";
	icon: Icon;
	label: string;
	keys?: { shown: string; aria: string };
	pressed?: boolean;
	disabled?: boolean;
	act(): void;
};

/** A key chord with the platform's modifier: `⌘B` on Apple devices, `Ctrl+B` elsewhere. */
function modKeys(key: string) {
	const apple = onApple();
	return { shown: chordText({ key, mod: true }, apple), aria: `${apple ? "Meta" : "Control"}+${key.toUpperCase()}` };
}

/** Whether the shell's Undo history has a step to take back. */
function useCanUndo(): boolean {
	const history = editorHistory();
	return useSyncExternalStore(
		(listener) => history.subscribe(listener),
		() => {
			const now = history.state();
			return now.undo !== null && !now.busy;
		},
	);
}

/**
 * The text being edited, from the shell (ADR 0037, SPEC 13.3, `client/02`): over a region that takes
 * formatting, the floating toolbar with the Field's name at its start, then Bold, Italic, Link, the two
 * lists, Undo and Done. A region's problem shows under it. Both are drawn in the shell's own document
 * over the frame, and follow the region as the page scrolls, resizes or zooms.
 *
 * The keyboard way in is Alt+F10 from the text; the arrow keys, Home and End move between the tools,
 * Escape goes back to the text where the caret was. A pointer on a tool keeps the caret in the text.
 */
export function TextToolbar({ editing, words }: { editing: PageEditing; words: Words }) {
	const snapshot = useSyncExternalStore(editing.subscribe, editing.snapshot);
	const { region } = snapshot;
	// The toolbar and the note follow the region: drawn again whenever the overlay draws.
	const [, setMoved] = useState(0);
	useEffect(() => editing.onMove(() => setMoved((count) => count + 1)), [editing]);
	if (!region) return null;
	const box = editing.boxOf(region.element);
	if (!box) return null;
	return (
		<>
			{snapshot.toolbar ? <Toolbar editing={editing} words={words} snapshot={snapshot} box={box} /> : null}
			{snapshot.problem ? <ProblemNote text={snapshot.problem} box={box} /> : null}
		</>
	);
}

/** The canvas's box on the shell's window: what the toolbar stays inside. */
function canvasBox(): DOMRect {
	return (
		document.querySelector("[data-wc-canvas]")?.getBoundingClientRect() ??
		new DOMRect(0, 0, window.innerWidth, window.innerHeight)
	);
}

function Toolbar({
	editing,
	words,
	snapshot,
	box,
}: {
	editing: PageEditing;
	words: Words;
	snapshot: EditingSnapshot;
	box: DOMRect;
}) {
	const said = words.editing;
	const { tools } = editing;
	const wrapper = useRef<HTMLDivElement>(null);
	const linkField = useRef<HTMLInputElement>(null);
	const canUndo = useCanUndo();
	const [at, setAt] = useState(0);
	const [link, setLink] = useState<{ value: string; existing: boolean } | null>(null);
	const [width, setWidth] = useState(0);

	const all: Tool[] = [
		{
			id: "bold",
			icon: BoldIcon,
			label: said.bold,
			keys: modKeys("b"),
			pressed: snapshot.pressed.bold,
			act: () => tools.exec("bold"),
		},
		{
			id: "italic",
			icon: ItalicIcon,
			label: said.italic,
			keys: modKeys("i"),
			pressed: snapshot.pressed.italic,
			act: () => tools.exec("italic"),
		},
		{
			id: "link",
			icon: LinkIcon,
			label: said.link,
			pressed: link !== null,
			act: () => {
				if (link) {
					setLink(null);
					tools.backToText();
					return;
				}
				const existing = tools.linkHere();
				setLink({ value: existing, existing: existing !== "" });
			},
		},
		{ id: "bulletList", icon: ListIcon, label: said.bulletList, act: () => tools.exec("insertUnorderedList") },
		{ id: "numberedList", icon: ListOrderedIcon, label: said.numberedList, act: () => tools.exec("insertOrderedList") },
		{
			id: "undo",
			icon: Undo2Icon,
			label: said.undo,
			keys: { shown: shortcutText("editor.undo"), aria: ariaKeys("editor.undo") },
			disabled: !canUndo,
			act: () => tools.undo(),
		},
	];
	/** The tools the arrow keys go through: every one that is on, then Done. */
	const stops = all.filter((tool) => !tool.disabled).length + 1;

	const buttons = useRef<(HTMLButtonElement | null)[]>([]);
	const focusStop = useCallback((index: number) => {
		setAt(index);
		const enabled = buttons.current.filter((button) => button && !button.disabled);
		enabled[index]?.focus();
	}, []);

	// Alt+F10 from the text: focus on the first tool.
	const reached = useRef(snapshot.reach);
	useEffect(() => {
		if (snapshot.reach === reached.current) return;
		reached.current = snapshot.reach;
		focusStop(0);
	}, [snapshot.reach, focusStop]);

	useLayoutEffect(() => {
		if (link) linkField.current?.focus();
	}, [link]);

	useLayoutEffect(() => {
		const measured = wrapper.current?.offsetWidth ?? 0;
		if (measured !== width) setWidth(measured);
	});

	const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (event.target instanceof HTMLInputElement) return;
		const enabled = buttons.current.filter((button): button is HTMLButtonElement => !!button && !button.disabled);
		const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
		let next = -1;
		const forward = getComputedStyle(event.currentTarget).direction === "rtl" ? "ArrowLeft" : "ArrowRight";
		const back = forward === "ArrowRight" ? "ArrowLeft" : "ArrowRight";
		if (event.key === forward) next = (index + 1) % enabled.length;
		else if (event.key === back) next = (index - 1 + enabled.length) % enabled.length;
		else if (event.key === "Home") next = 0;
		else if (event.key === "End") next = enabled.length - 1;
		else if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			setLink(null);
			tools.backToText();
			return;
		} else return;
		event.preventDefault();
		focusStop(next);
	};

	const applyLink = () => {
		const address = link?.value.trim() ?? "";
		setLink(null);
		if (address) tools.exec("createLink", address);
		else tools.backToText();
	};

	// Above the region, inside the canvas; below it when there is no room above.
	const room = canvasBox();
	const height = TOOLBAR_HEIGHT + (link ? 48 : 0);
	const above = box.top - TOOLBAR_HEIGHT - GAP;
	const top = above >= room.top + 4 ? above : Math.min(box.bottom + GAP, room.bottom - height - 4);
	const left = Math.max(room.left + 4, Math.min(box.left, room.right - width - 4));

	let stop = 0;
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only keeps a pressed tool from taking the caret out of the text, and notices focus leaving; its toolbar and link field are the controls.
		<div
			ref={wrapper}
			className="fixed z-30 flex flex-col gap-2"
			style={{ left: `${left}px`, top: `${top}px` }}
			data-wc-text-toolbar=""
			onMouseDown={(event) => {
				// A tool pressed keeps the caret and the selection in the text.
				if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
			}}
			onBlur={(event) => {
				const next = event.relatedTarget;
				if (next instanceof Node && event.currentTarget.contains(next)) return;
				setLink(null);
				tools.left(next instanceof Element ? next : null);
			}}
		>
			<div
				role="toolbar"
				aria-label={fill(said.toolbar, { name: snapshot.region?.name ?? "" })}
				aria-orientation="horizontal"
				onKeyDown={onKeyDown}
				className="border-chrome-hover bg-chrome-menu flex h-11 items-center gap-0.5 rounded-xl border ps-2.5 pe-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.35)]"
			>
				<TypeIcon aria-hidden="true" className="text-chrome-text size-3.5 shrink-0" />
				<span className="text-chrome-strong ps-1.5 pe-2.5 text-[13px] font-semibold whitespace-nowrap">
					{snapshot.region?.name}
				</span>
				<Divider />
				{all.map((tool, index) => {
					const mine = tool.disabled ? -1 : stop++;
					return (
						<span key={tool.id} className="contents">
							{tool.id === "bulletList" || tool.id === "undo" ? <Divider /> : null}
							<button
								ref={(button) => {
									buttons.current[index] = button;
								}}
								type="button"
								aria-label={tool.label}
								aria-keyshortcuts={tool.keys?.aria}
								aria-pressed={
									tool.id === "bold" || tool.id === "italic" || tool.id === "link" ? tool.pressed : undefined
								}
								disabled={tool.disabled}
								tabIndex={mine === at ? 0 : -1}
								onClick={tool.act}
								data-wc-tool={tool.id}
								className={`group relative grid h-8 w-[34px] shrink-0 place-items-center rounded-[7px] ${
									tool.pressed ? "text-chrome-strong bg-[#3f3f46]" : "text-chrome-text hover:bg-chrome-hover"
								} disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent ${CHROME_EASE} ${FOCUS_RING}`}
							>
								<tool.icon aria-hidden="true" className="size-4" />
								<Tip label={tool.label} keys={tool.keys?.shown} side="top" />
							</button>
						</span>
					);
				})}
				<button
					ref={(button) => {
						buttons.current[all.length] = button;
					}}
					type="button"
					tabIndex={stops - 1 === at ? 0 : -1}
					onClick={(event) => tools.done(event.detail === 0)}
					data-wc-tool="done"
					className={`ms-1 h-8 shrink-0 rounded-[7px] bg-white px-3.5 text-[13px] font-semibold text-[#121214] ${FOCUS_RING}`}
				>
					{said.done}
				</button>
			</div>
			{link ? (
				<div className="bg-chrome-menu flex h-10 items-center gap-2 rounded-[10px] border border-[#3f3f46] ps-2.5 pe-1.5">
					<LinkIcon aria-hidden="true" className="text-chrome-muted size-[15px] shrink-0" />
					<label htmlFor="wc-link-address" className="sr-only">
						{said.linkAddress}
					</label>
					<input
						ref={linkField}
						id="wc-link-address"
						type="url"
						autoComplete="off"
						value={link.value}
						placeholder={said.linkPlaceholder}
						onChange={(event) => setLink({ ...link, value: event.target.value })}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								applyLink();
							} else if (event.key === "Escape") {
								event.preventDefault();
								event.stopPropagation();
								setLink(null);
								tools.backToText();
							}
						}}
						className="text-chrome-strong placeholder:text-chrome-faint min-w-[220px] grow bg-transparent text-[13px] outline-none"
					/>
					{link.existing ? (
						<button
							type="button"
							aria-label={said.linkRemove}
							onClick={() => {
								setLink(null);
								tools.exec("unlink");
							}}
							className={`group text-chrome-text hover:bg-chrome-hover relative grid size-[26px] shrink-0 place-items-center rounded-[7px] ${CHROME_EASE} ${FOCUS_RING}`}
						>
							<Link2OffIcon aria-hidden="true" className="size-3.5" />
							<Tip label={said.linkRemove} side="bottom" />
						</button>
					) : null}
					<button
						type="button"
						aria-label={said.linkApply}
						onClick={applyLink}
						className={`group bg-primary text-primary-foreground relative grid size-[26px] shrink-0 place-items-center rounded-[7px] ${FOCUS_RING}`}
					>
						<CheckIcon aria-hidden="true" className="size-3.5" />
						<Tip label={said.linkApply} side="bottom" align="end" />
					</button>
				</div>
			) : null}
		</div>
	);
}

/** A rule between the toolbar's groups. */
function Divider() {
	return (
		<span aria-hidden="true" className="flex h-8 w-[9px] shrink-0 items-center justify-center">
			<span className="h-5 w-px bg-[#3f3f46]" />
		</span>
	);
}

/** A region's problem (what keeps its value from being published), under the region. */
function ProblemNote({ text, box }: { text: string; box: DOMRect }) {
	const room = canvasBox();
	const top = Math.min(box.bottom + GAP, room.bottom - 32);
	const left = Math.max(room.left + 4, box.left);
	return (
		<p
			className="border-chrome-hover bg-chrome-menu text-chrome-danger pointer-events-none fixed z-30 m-0 flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium shadow-[0_6px_16px_rgba(0,0,0,0.35)]"
			style={{ left: `${left}px`, top: `${top}px` }}
			data-wc-region-problem=""
		>
			<TriangleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
			{text}
		</p>
	);
}
