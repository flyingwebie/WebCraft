import {
	CheckIcon,
	CircleDotIcon,
	ClockIcon,
	EyeIcon,
	LoaderIcon,
	MonitorIcon,
	PencilIcon,
	Redo2Icon,
	Rows3Icon,
	SlidersHorizontalIcon,
	SmartphoneIcon,
	TabletIcon,
	TriangleAlertIcon,
	Undo2Icon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { editorHistory } from "../../builder/editor-history.ts";
import { ariaKeys, shortcutText } from "../../builder/shortcuts.ts";
import { fill, type Words } from "../api.ts";
import { LanguageMenu, type PageLanguage } from "../bottom-bar/LanguageMenu.tsx";
import { PRESETS, type Preset } from "../canvas/gutters.ts";
import { CHROME_EASE, FOCUS_RING, type Icon, Tip } from "../controls.tsx";
import type { ClientMode } from "./marks.ts";

/** The side panels a Member opens from the bar, one at a time (SPEC 13.1). */
export type ClientPanel = "sections" | "pageDetails";

/**
 * The Draft's state in words (SPEC 13.8, `client-flows/05`): "No changes yet", "Saving…", "Saved",
 * "N changes not published", "Sent for review", "Could not save".
 */
export type ClientDraftState =
	| { kind: "none" }
	| { kind: "saving" }
	| { kind: "saved" }
	| { kind: "changes"; count: number }
	| { kind: "review" }
	| { kind: "failed" };

/**
 * What the Draft state says: a save under way or failed wins; "Saved" for a moment after a save
 * (`justSaved`); then a Review waiting; then the page's changes; else nothing changed yet.
 */
export function clientDraftStateOf(
	saving: "idle" | "saving" | "failed",
	justSaved: boolean,
	page: { changes: number; inReview: boolean } | null,
): ClientDraftState {
	if (saving === "saving") return { kind: "saving" };
	if (saving === "failed") return { kind: "failed" };
	if (justSaved) return { kind: "saved" };
	if (page?.inReview) return { kind: "review" };
	if (page && page.changes > 0) return { kind: "changes", count: page.changes };
	return { kind: "none" };
}

const STATE_LOOK: Record<ClientDraftState["kind"], { icon: Icon; colour: string; text: string }> = {
	none: { icon: CheckIcon, colour: "text-chrome-muted", text: "text-chrome-muted" },
	saved: { icon: CheckIcon, colour: "text-chrome-muted", text: "text-chrome-muted" },
	saving: { icon: LoaderIcon, colour: "text-chrome-muted", text: "text-chrome-muted" },
	changes: { icon: CircleDotIcon, colour: "text-[#f59e0b]", text: "text-[#f59e0b]" },
	review: { icon: ClockIcon, colour: "text-chrome-accent", text: "text-chrome-muted" },
	failed: { icon: TriangleAlertIcon, colour: "text-chrome-danger", text: "text-chrome-danger" },
};

/** One of a set of words in the person's Admin language, by `Intl.PluralRules`. */
export function plural(forms: { one: string; other: string }, count: number, language: string): string {
	const form = new Intl.PluralRules(language).select(count) === "one" ? "one" : "other";
	return fill(forms[form], { count: String(count) });
}

function draftStateText(state: ClientDraftState, words: Words, language: string): string {
	const each = words.client.draftState;
	return state.kind === "changes" ? plural(each.changes, state.count, language) : each[state.kind];
}

/** The keys of one of the editor's shortcuts, as a tooltip shows them and as `aria-keyshortcuts` says them. */
function keysOf(id: string) {
	return { shown: shortcutText(id), aria: ariaKeys(id) };
}

/** What the shell's one Undo history offers now (ADR 0037 › 1.5). */
function useHistory() {
	const history = editorHistory();
	const [state, setState] = useState(() => history.state());
	useEffect(() => history.subscribe(() => setState(history.state())), [history]);
	return state;
}

/** A button of the bar: an icon and a word, 36 high (`CBarBtn`). `on`: its panel is open. */
function BarButton({
	icon: Glyph,
	children,
	on,
	onClick,
	pressed,
	expanded,
	controls,
	data,
	wordless,
}: {
	icon: Icon;
	children: string;
	on?: boolean;
	onClick(): void;
	pressed?: boolean;
	expanded?: boolean;
	controls?: string;
	data?: Record<`data-${string}`, string>;
	/** Its word only in a tooltip (and its name): a tablet's narrower bar (BA-19). */
	wordless?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={pressed}
			aria-expanded={expanded}
			aria-controls={controls}
			className={`group relative flex h-9 shrink-0 items-center justify-center gap-[7px] rounded-lg text-[13px] font-medium ${
				wordless ? "w-9" : "px-3"
			} ${
				on ? "text-chrome-strong bg-[#3f3f46]" : "bg-chrome-raised text-chrome-text hover:bg-chrome-hover"
			} ${CHROME_EASE} ${FOCUS_RING}`}
			{...data}
		>
			<Glyph aria-hidden="true" className="size-4" />
			{wordless ? (
				<>
					<span className="sr-only">{children}</span>
					<Tip label={children} side="top" />
				</>
			) : (
				<span>{children}</span>
			)}
		</button>
	);
}

/** An icon-only button of the bar (Undo, Redo): 36 × 36, no fill at rest, its name in a tooltip. */
function QuietButton({
	icon: Glyph,
	label,
	keys,
	align,
	disabled,
	onClick,
	data,
}: {
	icon: Icon;
	label: string;
	keys: { shown: string; aria: string };
	align?: "start" | "center";
	disabled: boolean;
	onClick(): void;
	data: Record<`data-${string}`, string>;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			aria-keyshortcuts={keys.aria || undefined}
			disabled={disabled}
			onClick={disabled ? undefined : onClick}
			className={`group text-chrome-text hover:bg-chrome-hover relative grid size-9 shrink-0 place-items-center rounded-lg disabled:cursor-default disabled:hover:bg-transparent disabled:[&>svg]:opacity-35 ${CHROME_EASE} ${FOCUS_RING}`}
			{...data}
		>
			<Glyph aria-hidden="true" className="size-4" />
			<Tip label={label} keys={keys.shown} side="top" align={align} />
		</button>
	);
}

/**
 * A segmented control of the bar (`CSeg`): Edit | Preview, and the three widths. A group of
 * switches (`aria-pressed`), the chosen one pressed, each a Tab stop.
 */
function Segmented<Value extends string>({
	label,
	items,
	value,
	onChange,
	data,
}: {
	label: string;
	items: readonly { value: Value; icon: Icon; label: string; word: boolean }[];
	value: Value;
	onChange(value: Value): void;
	data: Record<`data-${string}`, string>;
}) {
	return (
		<fieldset
			className="bg-chrome-raised m-0 flex h-9 min-w-0 shrink-0 items-center gap-0.5 rounded-[9px] border-0 p-[3px]"
			{...data}
		>
			<legend className="sr-only">{label}</legend>
			{items.map((item) => {
				const chosen = item.value === value;
				const Glyph = item.icon;
				return (
					<button
						key={item.value}
						type="button"
						aria-pressed={chosen}
						aria-label={item.word ? undefined : item.label}
						onClick={() => onChange(item.value)}
						className={`group relative flex h-[30px] min-w-[34px] items-center justify-center gap-1.5 rounded-[7px] text-[13px] ${
							item.word ? "px-3" : ""
						} ${
							chosen
								? "text-chrome-strong bg-[#3f3f46] font-semibold"
								: "text-chrome-muted hover:text-chrome-strong font-medium"
						} ${CHROME_EASE} ${FOCUS_RING}`}
						data-wc-segment={item.value}
					>
						<Glyph aria-hidden="true" className="size-[15px]" />
						{item.word ? <span>{item.label}</span> : <Tip label={item.label} side="top" />}
					</button>
				);
			})}
		</fieldset>
	);
}

/**
 * The bottom bar drawn for a client (SPEC 13.1, `client/01`): 56 high, each control 36 high with a
 * word. Left: Undo, Redo, the page's name (the page switcher), the Draft's state in words. Centre:
 * Edit / Preview, then Desktop / Tablet / Phone. Right: the language, Sections (where the Site lets
 * Members arrange its Pages), Page details, and Publish (132 × 40; an Author's "Send for review", 164).
 *
 * `compact` (a tablet's window, 641 to 1023 px; BA-19): the same bar, keeping only the words it needs:
 * Edit and Preview, Sections and Page details show their icons, their words in tooltips and names, and
 * the page's name and the Draft's state take what room is left.
 */
export function ClientBar({
	words,
	language,
	switcher,
	draft,
	mode,
	onMode,
	width,
	onWidth,
	languages,
	onLanguage,
	sections,
	panel,
	panelId,
	onPanel,
	publish,
	onUndo,
	onRedo,
	place,
	detailsLabel,
	compact = false,
}: {
	words: Words;
	/** The person's Admin language, for the plurals. */
	language: string;
	/** The page's name, which opens the list of Pages and Entries (`PageSwitcher`). */
	switcher: ReactNode;
	draft: ClientDraftState;
	mode: ClientMode;
	onMode(mode: ClientMode): void;
	width: Preset;
	onWidth(width: Preset): void;
	languages: readonly PageLanguage[];
	onLanguage(language: PageLanguage): void;
	/** Whether the Sections button is there: the Site lets Members arrange, and the page is a Page. */
	sections: boolean;
	panel: ClientPanel | null;
	panelId: string;
	onPanel(panel: ClientPanel): void;
	/** Publish (`publish/Publish.tsx`, BA-12) in the client's size: 132 × 40, an Author's "Send for review" 164. */
	publish: ReactNode;
	onUndo(): void;
	onRedo(): void;
	/** Whether a place is open over the canvas: the page's own controls wait until it is left. */
	place: boolean;
	/** The details button's word when it isn't "Page details": "Post details" on an Entry (`client-flows/01`, BA-18). */
	detailsLabel?: string;
	/** A tablet's narrower window: words only where they are needed. */
	compact?: boolean;
}) {
	const said = words.client;
	const history = useHistory();
	const undoLabel = history.undo ? fill(words.undoStep, { step: history.undo }) : words.undo;
	const redoLabel = history.redo ? fill(words.redoStep, { step: history.redo }) : words.redo;
	const look = STATE_LOOK[draft.kind];
	const StateIcon = look.icon;
	return (
		<section
			aria-label={words.bar}
			data-building-region="bar"
			className="border-chrome-line bg-chrome focus-visible:ring-chrome-focus col-span-full col-start-1 row-start-2 flex h-14 min-w-0 items-center border-t px-3 outline-none focus-visible:ring-2 focus-visible:ring-inset"
			data-wc-client-bar=""
		>
			<div
				className={`flex h-full min-w-0 items-center gap-2 ${compact ? "grow basis-0" : "w-[520px] shrink"}`}
				data-wc-bar-cluster="start"
			>
				<QuietButton
					icon={Undo2Icon}
					label={undoLabel}
					keys={keysOf("editor.undo")}
					align="start"
					disabled={!history.undo || history.busy}
					onClick={onUndo}
					data={{ "data-wc-bar": "undo" }}
				/>
				<QuietButton
					icon={Redo2Icon}
					label={redoLabel}
					keys={keysOf("editor.redo")}
					disabled={!history.redo || history.busy}
					onClick={onRedo}
					data={{ "data-wc-bar": "redo" }}
				/>
				<span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-[#3f3f46]" />
				{switcher}
				<p
					className="m-0 flex h-9 min-w-0 shrink items-center gap-[7px] px-2.5 text-[13px] font-medium whitespace-nowrap"
					data-wc-draft-state={draft.kind}
				>
					<span className="sr-only">{`${words.draftState.label}: `}</span>
					<StateIcon aria-hidden="true" className={`size-[15px] shrink-0 ${look.colour}`} />
					<span className={`truncate ${look.text}`}>{draftStateText(draft, words, language)}</span>
				</p>
			</div>
			<div
				className={`flex h-full items-center justify-center gap-2.5 ${compact ? "shrink-0 px-2" : "min-w-0 grow"}`}
				data-wc-bar-cluster="centre"
			>
				{place ? null : (
					<>
						<Segmented
							label={said.modes}
							value={mode}
							onChange={onMode}
							items={[
								{ value: "edit", icon: PencilIcon, label: said.edit, word: !compact },
								{ value: "preview", icon: EyeIcon, label: said.preview, word: !compact },
							]}
							data={{ "data-wc-modes": "" }}
						/>
						<Segmented
							label={said.widths}
							value={width}
							onChange={onWidth}
							items={[
								{ value: "desktop", icon: MonitorIcon, label: words.size.desktop, word: false },
								{
									value: "tablet",
									icon: TabletIcon,
									label: `${words.size.tablet} · ${fill(words.size.widthNow, { width: String(PRESETS.tablet) })}`,
									word: false,
								},
								{
									value: "phone",
									icon: SmartphoneIcon,
									label: `${words.size.phone} · ${fill(words.size.widthNow, { width: String(PRESETS.phone) })}`,
									word: false,
								},
							]}
							data={{ "data-wc-widths": "" }}
						/>
					</>
				)}
			</div>
			<div
				className={`flex h-full items-center justify-end gap-2 ${compact ? "shrink-0" : "w-[520px] min-w-0 shrink"}`}
				data-wc-bar-cluster="end"
			>
				{!place && languages.length > 1 ? (
					<LanguageMenu languages={languages} words={words} onChoose={onLanguage} look="client" />
				) : null}
				{!place && sections ? (
					<BarButton
						icon={Rows3Icon}
						on={panel === "sections"}
						expanded={panel === "sections"}
						controls={panel === "sections" ? panelId : undefined}
						onClick={() => onPanel("sections")}
						data={{ "data-wc-bar": "sections" }}
						wordless={compact}
					>
						{said.sections}
					</BarButton>
				) : null}
				{place ? null : (
					<BarButton
						icon={SlidersHorizontalIcon}
						on={panel === "pageDetails"}
						expanded={panel === "pageDetails"}
						controls={panel === "pageDetails" ? panelId : undefined}
						onClick={() => onPanel("pageDetails")}
						data={{ "data-wc-bar": "page-details" }}
						wordless={compact}
					>
						{detailsLabel ?? said.pageDetails}
					</BarButton>
				)}
				{/* Publish (BA-12): one cell that never changes width, its sheet above it. */}
				{publish}
			</div>
		</section>
	);
}
