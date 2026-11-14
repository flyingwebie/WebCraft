import {
	ALargeSmallIcon,
	AlignCenterIcon,
	AlignLeftIcon,
	AlignRightIcon,
	AtSignIcon,
	BaselineIcon,
	BlendIcon,
	BoldIcon,
	LayoutGridIcon,
	MoveHorizontalIcon,
	MoveVerticalIcon,
	PaintBucketIcon,
	ScanLineIcon,
	SearchIcon,
	SpaceIcon,
	SquareRoundCornerIcon,
	StarIcon,
	StarOffIcon,
	StretchHorizontalIcon,
	StretchVerticalIcon,
} from "lucide-react";
import { Fragment, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";

import { fill, type Words } from "../../api.ts";
import { CHROME_EASE, FOCUS_RING, type Icon, Tip } from "../../controls.tsx";
import { breakpointQuery, declarationOf, withDeclaration, withQuery } from "./rule.ts";
import {
	defaultChoice,
	type QuickTokens,
	type StepSizes,
	type TokenChoice,
	type TokenKind,
	tokenChoices,
} from "./view.ts";

type Quick = Words["styles"]["quick"];
type ActionWord = keyof Quick["actions"];

/** A quick action (`places-assets/05`): a Design token written in a property, a plain value, or a media query. */
type Action =
	| { key: ActionWord; icon: Icon; kind: "media" }
	| { key: ActionWord; icon: Icon; kind: "token"; property: string; tokens: TokenKind }
	| { key: ActionWord; icon: Icon; kind: "value"; property: string; value: string };

/** The row's groups, in the frame's order. */
const GROUPS: readonly (readonly Action[])[] = [
	[
		{ key: "media", icon: AtSignIcon, kind: "media" },
		{ key: "padding", icon: ScanLineIcon, kind: "token", property: "padding", tokens: "space" },
	],
	[
		{ key: "flex", icon: StretchHorizontalIcon, kind: "value", property: "display", value: "flex" },
		{ key: "column", icon: StretchVerticalIcon, kind: "value", property: "flex-direction", value: "column" },
		{ key: "grid", icon: LayoutGridIcon, kind: "value", property: "display", value: "grid" },
	],
	[
		{ key: "width", icon: MoveHorizontalIcon, kind: "token", property: "max-inline-size", tokens: "widths" },
		{ key: "height", icon: MoveVerticalIcon, kind: "token", property: "min-block-size", tokens: "space" },
		{ key: "gap", icon: SpaceIcon, kind: "token", property: "gap", tokens: "space" },
	],
	[
		{ key: "left", icon: AlignLeftIcon, kind: "value", property: "text-align", value: "start" },
		{ key: "center", icon: AlignCenterIcon, kind: "value", property: "text-align", value: "center" },
		{ key: "right", icon: AlignRightIcon, kind: "value", property: "text-align", value: "end" },
	],
	[
		{ key: "fontSize", icon: ALargeSmallIcon, kind: "token", property: "font-size", tokens: "text" },
		{ key: "bold", icon: BoldIcon, kind: "value", property: "font-weight", value: "700" },
		{ key: "colour", icon: BaselineIcon, kind: "token", property: "color", tokens: "colours" },
	],
	[
		{ key: "background", icon: PaintBucketIcon, kind: "token", property: "background-color", tokens: "colours" },
		{ key: "radius", icon: SquareRoundCornerIcon, kind: "token", property: "border-radius", tokens: "radius" },
		{ key: "shadow", icon: BlendIcon, kind: "token", property: "box-shadow", tokens: "shadows" },
	],
];

const FAVOURITES = "webcraft.building.favourites.";

/** The Design tokens starred in the menus, per Site (kept in this browser). */
export function useFavourites(siteId: string): [readonly string[], (value: string) => void] {
	const key = `${FAVOURITES}${siteId}`;
	const [favourites, setFavourites] = useState<readonly string[]>(() => {
		try {
			const stored = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
			return Array.isArray(stored) ? stored.filter((each): each is string => typeof each === "string") : [];
		} catch {
			return [];
		}
	});
	const toggle = (value: string) =>
		setFavourites((was) => {
			const next = was.includes(value) ? was.filter((each) => each !== value) : [...was, value];
			try {
				localStorage.setItem(key, JSON.stringify(next));
			} catch {
				// Kept for this visit only.
			}
			return next;
		});
	return [favourites, toggle];
}

/** A change the row makes to the rule: its new text, and where the caret goes. */
export type RuleEdit = { text: string; caret: number };

/**
 * The quick actions above a Class's rule (`places-assets/05`): six groups of small buttons, each
 * writing one of the rule's own declarations. A Design token action's first click writes the default
 * token (the first favourite, else the scale's middle step) and opens its menu; a second click removes
 * the declaration; ↓ on a pressed one opens the menu again. The menu lists the tokens of its kind with
 * a search and a favourite star. A plain action sets its value (or removes it when set); the media
 * query action lists the Breakpoints and the canvas's width now.
 */
export function QuickActions({
	words,
	text,
	readable,
	onEdit,
	tokens,
	sizes,
	breakpoints,
	canvasWidth,
	favourites,
	toggleFavourite,
	announce,
}: {
	words: Words;
	text: string;
	/** Whether the rule can be read now: the actions wait until it can. */
	readable: boolean;
	onEdit(edit: RuleEdit): void;
	tokens: QuickTokens;
	sizes: StepSizes;
	breakpoints: readonly { id: string; name: string; width: number }[];
	canvasWidth(): number | null;
	favourites: readonly string[];
	toggleFavourite(value: string): void;
	announce(text: string): void;
}) {
	const shown = words.styles.quick;
	const [open, setOpen] = useState<ActionWord | null>(null);
	const buttons = useRef(new Map<ActionWord, HTMLButtonElement>());

	const close = (focusButton: boolean) => {
		const was = open;
		setOpen(null);
		if (focusButton && was) buttons.current.get(was)?.focus();
	};

	const run = (action: Action) => {
		if (!readable) return;
		const name = shown.actions[action.key];
		if (action.kind === "media") {
			setOpen(open === action.key ? null : action.key);
			return;
		}
		const present = declarationOf(text, action.property);
		if (action.kind === "value") {
			const edit = withDeclaration(text, action.property, present?.value === action.value ? null : action.value);
			if (!edit) return;
			onEdit(edit);
			announce(fill(present?.value === action.value ? shown.removed : shown.added, { action: name }));
			return;
		}
		if (present) {
			const edit = withDeclaration(text, action.property, null);
			if (!edit) return;
			onEdit(edit);
			setOpen(null);
			announce(fill(shown.removed, { action: name }));
			return;
		}
		const choice = defaultChoice(action.tokens, tokens, favourites);
		if (!choice) return;
		const edit = withDeclaration(text, action.property, choice.value);
		if (!edit) return;
		onEdit(edit);
		setOpen(action.key);
		announce(fill(shown.added, { action: `${name} ${choice.label}` }));
	};

	return (
		<fieldset className="m-0 flex h-[26px] min-w-0 items-center gap-1 border-0 p-0" data-wc-quick-actions="">
			<legend className="sr-only">{shown.label}</legend>
			{GROUPS.map((group, index) => (
				<Fragment key={group[0]?.key}>
					{index > 0 ? <span aria-hidden="true" className="bg-chrome-hover mx-0.5 h-3.5 w-px" /> : null}
					{group.map((action) => {
						const name = shown.actions[action.key];
						const present = action.kind === "media" ? null : declarationOf(text, action.property);
						const pressed =
							action.kind === "media"
								? open === action.key
								: action.kind === "value"
									? present?.value === action.value
									: !!present;
						const choices = action.kind === "token" ? tokenChoices(action.tokens, tokens, sizes) : null;
						const noTokens = choices !== null && choices.length === 0 && !present;
						const unavailable = !readable ? shown.noRule : noTokens ? shown.noTokens : null;
						const label =
							action.kind === "token"
								? `${name} · ${present ? shown.remove : shown.add}`
								: action.kind === "media"
									? `${name} · ${shown.more}`
									: name;
						const menuOpen = open === action.key;
						return (
							<span key={action.key} className="group relative inline-flex">
								<button
									ref={(element) => {
										if (element) buttons.current.set(action.key, element);
									}}
									type="button"
									aria-label={unavailable ? `${name} · ${unavailable}` : label}
									aria-pressed={action.kind === "media" ? undefined : pressed}
									aria-haspopup={action.kind === "value" ? undefined : "dialog"}
									aria-expanded={action.kind === "value" ? undefined : menuOpen}
									aria-disabled={unavailable ? true : undefined}
									onClick={() => (unavailable ? undefined : run(action))}
									onKeyDown={(event) => {
										if (event.key === "ArrowDown" && action.kind === "token" && present && !unavailable) {
											event.preventDefault();
											setOpen(action.key);
										}
									}}
									onContextMenu={(event) => {
										if (action.kind === "token" && present && !unavailable) {
											event.preventDefault();
											setOpen(action.key);
										}
									}}
									className={`inline-grid size-[22px] place-items-center rounded ${
										pressed ? "bg-chrome-hover text-chrome-strong" : "text-chrome-muted"
									} ${unavailable ? "cursor-default opacity-50" : "hover:bg-chrome-hover hover:text-chrome-strong"} ${CHROME_EASE} ${FOCUS_RING}`}
									data-wc-quick={action.key}
								>
									<action.icon aria-hidden="true" className="size-[13px]" />
								</button>
								{menuOpen ? null : <Tip label={unavailable ? `${name} · ${unavailable}` : label} side="bottom" />}
								{menuOpen && action.kind === "token" && choices ? (
									<TokenMenu
										words={words}
										title={shown.kinds[action.tokens]}
										label={fill(shown.menu, { action: name })}
										choices={choices}
										current={present?.value ?? null}
										favourites={favourites}
										toggleFavourite={toggleFavourite}
										onChoose={(choice) => {
											const edit = withDeclaration(text, action.property, choice.value);
											if (edit) onEdit(edit);
											announce(fill(shown.chosen, { action: name, token: choice.label }));
											close(true);
										}}
										onClose={close}
									/>
								) : null}
								{menuOpen && action.kind === "media" ? (
									<TokenMenu
										words={words}
										title={shown.kinds.breakpoints}
										label={fill(shown.menu, { action: name })}
										choices={[
											...[...breakpoints]
												.sort((a, b) => a.width - b.width)
												.map((each) => ({
													label: each.name,
													value: breakpointQuery(each.width),
													detail: `≥ ${each.width}px`,
												})),
											...(() => {
												const width = canvasWidth();
												return width
													? [
															{
																label: fill(shown.atWidth, { width: String(width) }),
																value: breakpointQuery(width),
																detail: "",
															},
														]
													: [];
											})(),
										]}
										current={null}
										onChoose={(choice) => {
											const edit = withQuery(text, choice.value);
											if (edit) onEdit(edit);
											announce(fill(shown.chosen, { action: name, token: choice.label }));
											close(true);
										}}
										onClose={close}
									/>
								) : null}
							</span>
						);
					})}
				</Fragment>
			))}
		</fieldset>
	);
}

/**
 * A quick action's menu (`places-assets/05`): a search, the group's name, and its choices, the one in
 * the rule marked; a Design token has a favourite star beside it. ↓ and ↑ move between choices,
 * Escape closes it and goes back to the action.
 */
function TokenMenu({
	words,
	title,
	label,
	choices,
	current,
	favourites,
	toggleFavourite,
	onChoose,
	onClose,
}: {
	words: Words;
	title: string;
	label: string;
	choices: readonly TokenChoice[];
	current: string | null;
	/** Given for Design tokens: each choice gets a star. */
	favourites?: readonly string[];
	toggleFavourite?(value: string): void;
	onChoose(choice: TokenChoice): void;
	onClose(focusButton: boolean): void;
}) {
	const shown = words.styles.quick;
	const id = useId();
	const box = useRef<HTMLDivElement>(null);
	const search = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	const latest = useRef(onClose);
	latest.current = onClose;

	useEffect(() => {
		search.current?.focus();
		const outside = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (target && box.current?.parentElement?.contains(target)) return;
			latest.current(false);
		};
		document.addEventListener("pointerdown", outside, true);
		return () => document.removeEventListener("pointerdown", outside, true);
	}, []);

	const needle = query.trim().toLowerCase();
	const listed = choices
		.filter((choice) => !needle || choice.label.toLowerCase().includes(needle) || choice.value.includes(needle))
		.sort((a, b) => Number(favourites?.includes(b.value) ?? 0) - Number(favourites?.includes(a.value) ?? 0));

	const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
		const all = [...(box.current?.querySelectorAll<HTMLElement>("[data-wc-token-choice]") ?? [])];
		const at = all.indexOf(document.activeElement as HTMLElement);
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			onClose(true);
		} else if (event.key === "ArrowDown") {
			event.preventDefault();
			all[at === -1 ? 0 : Math.min(all.length - 1, at + 1)]?.focus();
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			if (at <= 0) search.current?.focus();
			else all[at - 1]?.focus();
		}
	};

	return (
		<div
			ref={box}
			role="dialog"
			aria-label={label}
			onKeyDown={onKey}
			className="border-chrome-hover bg-chrome-menu absolute start-0 top-[calc(100%+6px)] z-50 flex w-[210px] flex-col gap-0.5 rounded-lg border p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.55)]"
			data-wc-token-menu=""
		>
			<label className="relative flex h-7 items-center">
				<SearchIcon aria-hidden="true" className="text-chrome-muted pointer-events-none absolute start-2 size-[13px]" />
				<span className="sr-only">{shown.search}</span>
				<input
					ref={search}
					type="search"
					value={query}
					placeholder={shown.search}
					onChange={(event) => setQuery(event.target.value)}
					aria-controls={id}
					className="border-chrome-hover bg-chrome text-chrome-strong placeholder:text-chrome-muted focus:border-chrome-focus focus:ring-chrome-focus h-full w-full min-w-0 rounded-md border ps-7 pe-2 text-[12px] outline-none focus:ring-1"
				/>
			</label>
			<p className="text-chrome-muted m-0 flex h-[22px] items-center px-1.5 text-[10px] font-semibold tracking-[0.6px] uppercase">
				{title}
			</p>
			<ul id={id} aria-label={title} className="m-0 flex max-h-64 list-none flex-col gap-0.5 overflow-y-auto p-0">
				{listed.length === 0 ? <li className="text-chrome-muted px-1.5 py-1 text-[12px]">{shown.none}</li> : null}
				{listed.map((choice) => {
					const starred = favourites?.includes(choice.value) ?? false;
					const on = choice.value === current;
					return (
						<li
							key={choice.value}
							className={`flex h-7 items-center gap-1 rounded-[5px] ${on ? "bg-chrome-hover" : ""}`}
						>
							{toggleFavourite ? (
								<button
									type="button"
									aria-pressed={starred}
									aria-label={fill(starred ? shown.notFavourite : shown.favourite, { token: choice.label })}
									onClick={() => toggleFavourite(choice.value)}
									className={`inline-grid size-6 flex-none place-items-center rounded ${
										starred ? "text-chrome-warn" : "text-chrome-muted"
									} hover:bg-chrome-hover ${FOCUS_RING}`}
									data-wc-token-star={choice.label}
								>
									{starred ? (
										<StarIcon aria-hidden="true" className="size-3.5 fill-current" />
									) : (
										<StarOffIcon aria-hidden="true" className="size-3.5" />
									)}
								</button>
							) : null}
							<button
								type="button"
								aria-current={on ? "true" : undefined}
								onClick={() => onChoose(choice)}
								className={`text-chrome-text hover:bg-chrome-hover focus:bg-chrome-hover flex h-7 min-w-0 grow items-center gap-2 rounded-[5px] px-1.5 text-start text-[12px] font-medium ${FOCUS_RING}`}
								data-wc-token-choice={choice.label}
							>
								<span className="min-w-0 grow truncate">{choice.label}</span>
								{choice.detail ? (
									<span className="text-chrome-muted shrink-0 font-mono text-[11px]">{choice.detail}</span>
								) : null}
							</button>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
