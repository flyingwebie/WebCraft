import {
	CaseSensitiveIcon,
	MoveHorizontalIcon,
	PlusIcon,
	RulerIcon,
	SquareDashedBottomIcon,
	SquareRoundCornerIcon,
	SwatchBookIcon,
	TriangleAlertIcon,
	TypeIcon,
	XIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import type { Editing } from "../../../design-system/editing.ts";
import { type ColourToken, freeName, newTokenId, type Tokens } from "../../../design-system/model.ts";
import { fill, type Words } from "../../api.ts";
import { CHROME_EASE, FOCUS_RING, type Icon, Tip } from "../../controls.tsx";
import { CodeBox } from "./CodeBox.tsx";
import { contrastOf, groupCss, type StylesView, TOKEN_GROUPS, TOKEN_NAME, type TokenGroup } from "./view.ts";

const GROUP_ICONS: Record<TokenGroup, Icon> = {
	colours: SwatchBookIcon,
	space: RulerIcon,
	text: CaseSensitiveIcon,
	fonts: TypeIcon,
	radius: SquareRoundCornerIcon,
	shadows: SquareDashedBottomIcon,
	widths: MoveHorizontalIcon,
};

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `#abc` as `#aabbcc`, for the colour picker. */
function fullHex(value: string): string {
	return /^#[0-9a-f]{3}$/i.test(value) ? `#${[...value.slice(1)].map((each) => each + each).join("")}` : value;
}

/** How many tokens a group holds. */
function countOf(tokens: Tokens, group: TokenGroup): number {
	return group === "space" || group === "text" ? tokens[group].steps.length : tokens[group].length;
}

/** The custom-property prefixes a group gives the stylesheet. */
function prefixesOf(tokens: Tokens, group: TokenGroup): string[] {
	switch (group) {
		case "colours":
			return tokens.colours.map((each) => each.name);
		case "fonts":
			return ["font"];
		case "shadows":
			return ["shadow"];
		case "widths":
			return ["width"];
		default:
			return [group];
	}
}

/**
 * Styles › Design tokens (`places-assets/06`): the groups on the left (Colours, Spacing, Type scale,
 * Fonts, Radius, Shadows, Content widths, each with how many it holds), and the chosen group's typed
 * editor on the right, or its tokens as the CSS custom properties they give ("Editor · CSS"). Colours
 * have a light and a dark value and the contrast they reach in the Check. Every change saves to the
 * Design system's Draft a moment later; removing a token saves at once, so one in use is refused.
 */
export function TokensTab({
	words,
	editing,
	view,
	setView,
	announce,
}: {
	words: Words;
	editing: Editing;
	view: StylesView;
	setView(view: StylesView, replace?: boolean): void;
	announce(text: string): void;
}) {
	const shown = words.styles.tokens;
	const id = useId();
	const { tokens } = editing.draft;
	const group = view.group;
	return (
		<div className="flex min-h-0 min-w-0 grow gap-2.5" data-wc-tokens={group}>
			<nav
				aria-label={shown.groups}
				className="border-chrome-hover flex w-[300px] shrink-0 flex-col gap-0.5 overflow-y-auto rounded-[10px] border p-2"
			>
				{TOKEN_GROUPS.map((each) => {
					const Glyph = GROUP_ICONS[each];
					const on = each === group;
					return (
						<button
							key={each}
							type="button"
							aria-current={on ? "true" : undefined}
							onClick={() => setView({ ...view, group: each })}
							className={`flex h-8 items-center gap-2 rounded-md px-2 text-start text-[12px] font-medium ${
								on ? "bg-chrome-raised text-chrome-strong" : "text-chrome-text hover:bg-chrome-raised"
							} ${CHROME_EASE} ${FOCUS_RING}`}
							data-wc-token-group={each}
						>
							<Glyph aria-hidden="true" className={`size-3.5 ${on ? "" : "text-chrome-muted"}`} />
							<span className="grow">{shown.group[each]}</span>
							<span className="text-chrome-muted text-[11px]">{countOf(tokens, each)}</span>
						</button>
					);
				})}
			</nav>
			<section
				aria-labelledby={`${id}-title`}
				className="border-chrome-hover flex min-w-0 grow flex-col gap-2.5 overflow-hidden rounded-[10px] border p-3"
			>
				<div className="flex items-center">
					<h2 id={`${id}-title`} className="text-chrome-strong m-0 grow text-[14px] font-semibold">
						{shown.group[group]}
					</h2>
					<fieldset className="bg-chrome m-0 flex gap-0.5 rounded-lg border-0 p-0.5">
						<legend className="sr-only">{shown.showAs}</legend>
						{[false, true].map((css) => (
							<button
								key={String(css)}
								type="button"
								aria-pressed={view.css === css}
								onClick={() => setView({ ...view, css })}
								className={`h-[26px] rounded-md px-3 text-[12px] font-medium ${
									view.css === css ? "bg-chrome-hover text-chrome-strong" : "text-chrome-muted hover:text-chrome-text"
								} ${CHROME_EASE} ${FOCUS_RING}`}
								data-wc-tokens-as={css ? "css" : "editor"}
							>
								{css ? shown.css : shown.editor}
							</button>
						))}
					</fieldset>
				</div>
				{view.css ? (
					<CodeBox
						value={groupCss(editing.preview.stylesheet, prefixesOf(tokens, group))}
						label={fill(shown.cssOf, { group: shown.group[group] })}
						readOnly
						data={{ "data-wc-tokens-css": group }}
					/>
				) : (
					<div className="min-h-0 grow overflow-auto">
						{group === "colours" ? (
							<ColoursEditor words={words} editing={editing} announce={announce} />
						) : group === "space" || group === "text" ? (
							<ScaleEditor words={words} editing={editing} kind={group} />
						) : group === "fonts" ? (
							<FontsEditor words={words} editing={editing} announce={announce} />
						) : group === "shadows" ? (
							<ShadowsEditor words={words} editing={editing} announce={announce} />
						) : (
							<DimensionsEditor words={words} editing={editing} kind={group} announce={announce} />
						)}
					</div>
				)}
			</section>
		</div>
	);
}

/** Removes a token through an immediate save, so a token in use is refused at once (and says where). */
async function removeTokens(editing: Editing, tokens: Tokens): Promise<boolean> {
	const answer = await editing.now(async () => {
		const client = await editing.api();
		return client.designSystem.saveDraft({ siteId: editing.siteId, tokens });
	});
	if (!answer) return false;
	editing.replaceDraft(answer.designSystem.draft);
	return true;
}

/**
 * A field of a token that looks like text until it is used: what is typed is kept here and saved only
 * once it is valid (a name the Design system takes, a colour, a number), so a half-typed value never
 * reaches the Draft. A value changed elsewhere shows unless the field is being typed in.
 */
function TokenField({
	label,
	value,
	valid,
	onCommit,
	mono = true,
	placeholder,
	className = "",
	data,
}: {
	label: string;
	value: string;
	valid(text: string): boolean;
	onCommit(text: string): void;
	mono?: boolean;
	placeholder?: string;
	className?: string;
	data?: Record<`data-${string}`, string>;
}) {
	const field = useRef<HTMLInputElement>(null);
	const [typed, setTyped] = useState(value);
	useEffect(() => {
		if (document.activeElement !== field.current) setTyped(value);
	}, [value]);
	const ok = valid(typed);
	return (
		<input
			ref={field}
			aria-label={label}
			value={typed}
			placeholder={placeholder}
			onChange={(event) => {
				setTyped(event.target.value);
				if (valid(event.target.value)) onCommit(event.target.value);
			}}
			onBlur={() => {
				if (!valid(typed)) setTyped(value);
			}}
			aria-invalid={ok ? undefined : true}
			spellCheck={false}
			autoComplete="off"
			className={`text-chrome-text placeholder:text-chrome-muted hover:border-chrome-hover focus:border-chrome-focus focus:ring-chrome-focus aria-invalid:border-chrome-danger h-7 min-w-0 rounded-[5px] border border-transparent bg-transparent px-1.5 text-[12px] outline-none focus:ring-1 ${
				mono ? "font-mono" : ""
			} ${className}`}
			{...data}
		/>
	);
}

/** A colour's swatch: the colour picker under it, named for screen readers. */
function Swatch({ colour, label, onPick }: { colour: string; label: string; onPick(hex: string): void }) {
	return (
		<span
			className="border-chrome-hover focus-within:ring-chrome-focus relative inline-block size-[22px] shrink-0 rounded-md border focus-within:ring-2"
			style={{ background: colour }}
		>
			<input
				type="color"
				aria-label={label}
				value={HEX.test(colour) ? fullHex(colour) : "#000000"}
				onChange={(event) => onPick(event.target.value)}
				className="absolute inset-0 size-full cursor-pointer opacity-0"
			/>
		</span>
	);
}

/** Removes a token on a second click (SPEC 10: small things); the first says what a second does. */
function RemoveButton({ label, again, onRemove }: { label: string; again: string; onRemove(): void }) {
	const [armed, setArmed] = useState(false);
	useEffect(() => {
		if (!armed) return;
		const timer = window.setTimeout(() => setArmed(false), 3000);
		return () => window.clearTimeout(timer);
	}, [armed]);
	const name = armed ? again : label;
	return (
		<span className="group relative inline-flex">
			<button
				type="button"
				aria-label={name}
				onClick={() => {
					if (armed) {
						setArmed(false);
						onRemove();
					} else setArmed(true);
				}}
				onBlur={() => setArmed(false)}
				className={`inline-grid size-6 place-items-center rounded-[5px] ${
					armed
						? "bg-chrome-danger/20 text-chrome-danger"
						: "text-chrome-muted hover:bg-chrome-hover hover:text-chrome-strong"
				} ${CHROME_EASE} ${FOCUS_RING}`}
				data-wc-token-remove={armed ? "armed" : ""}
			>
				<XIcon aria-hidden="true" className="size-3.5" />
			</button>
			<Tip label={name} side="bottom" align="end" />
		</span>
	);
}

/** "Add colour" and its kin: a quiet row under a table. */
function AddRow({ label, onAdd, data }: { label: string; onAdd(): void; data?: Record<`data-${string}`, string> }) {
	return (
		<button
			type="button"
			onClick={onAdd}
			className={`text-chrome-muted hover:text-chrome-strong flex h-9 items-center gap-2 rounded-md px-1 text-[12px] font-medium ${CHROME_EASE} ${FOCUS_RING}`}
			{...data}
		>
			<PlusIcon aria-hidden="true" className="size-3.5" />
			{label}
		</button>
	);
}

/** A table of tokens: its header row (30 high) and its rows (44 high). */
function TokenTable({
	caption,
	columns,
	children,
}: {
	caption: string;
	columns: [string, string][];
	children: ReactNode;
}) {
	return (
		<table className="w-full border-collapse">
			<caption className="sr-only">{caption}</caption>
			<thead>
				<tr className="h-[30px]">
					{columns.map(([label, size]) => (
						<th
							key={label}
							scope="col"
							className={`text-chrome-muted px-1 text-start text-[11px] font-semibold uppercase ${size}`}
						>
							{label}
						</th>
					))}
				</tr>
			</thead>
			<tbody>{children}</tbody>
		</table>
	);
}

function ContrastBadge({ words, level }: { words: Words; level: "AAA" | "AA" | "low" | null }) {
	const shown = words.styles.tokens;
	if (level === null) return <span className="text-chrome-muted text-[11px]">{shown.unchecked}</span>;
	if (level === "low")
		return (
			<span className="inline-flex h-5 items-center gap-1 rounded-full bg-amber-950 px-1.5 text-[10px] font-semibold text-amber-300">
				<TriangleAlertIcon aria-hidden="true" className="size-[11px]" />
				{shown.low}
			</span>
		);
	return (
		<span
			className={`inline-flex h-5 items-center rounded-full px-1.5 text-[10px] font-semibold ${
				level === "AAA" ? "bg-green-950 text-green-400" : "bg-chrome-hover text-chrome-text"
			}`}
		>
			{level}
		</span>
	);
}

/** Colours (`places-assets/06`): name, swatch and light value, the dark value, and the contrast reached. */
function ColoursEditor({ words, editing, announce }: { words: Words; editing: Editing; announce(text: string): void }) {
	const shown = words.styles.tokens;
	const { tokens } = editing.draft;
	const setColours = (colours: ColourToken[]) => editing.setSection("tokens", { ...tokens, colours });
	const change = (colourId: string | undefined, next: (colour: ColourToken) => ColourToken) =>
		setColours(tokens.colours.map((each) => (each.id === colourId ? next(each) : each)));
	const add = () => {
		const made: ColourToken = {
			id: newTokenId(),
			name: freeName("colour", tokens.colours),
			light: { base: "#71717a", steps: {} },
			dark: { base: null, steps: {} },
		};
		setColours([...tokens.colours, made]);
		announce(fill(shown.added, { name: made.name }));
	};
	return (
		<>
			<TokenTable
				caption={shown.group.colours}
				columns={[
					[shown.name, "w-[140px]"],
					[shown.swatch, "w-14"],
					[shown.light, ""],
					[shown.dark, ""],
					[shown.contrast, "w-[90px]"],
					["", "w-8"],
				]}
			>
				{tokens.colours.map((colour) => {
					const generatedDark = (colour.id && editing.preview.ramps[colour.id]?.dark.shown["60"]) || "";
					const dark = colour.dark.base ?? generatedDark;
					return (
						<tr key={colour.id ?? colour.name} className="h-11" data-wc-colour={colour.name}>
							<td className="px-1">
								<TokenField
									label={fill(shown.nameOf, { name: colour.name })}
									value={colour.name}
									valid={(text) => TOKEN_NAME.test(text)}
									onCommit={(name) => change(colour.id, (each) => ({ ...each, name }))}
									className="w-[130px]"
								/>
							</td>
							<td className="px-1">
								<Swatch
									colour={colour.light.base}
									label={fill(shown.lightOf, { name: colour.name })}
									onPick={(base) => change(colour.id, (each) => ({ ...each, light: { ...each.light, base } }))}
								/>
							</td>
							<td className="px-1">
								<TokenField
									label={fill(shown.lightOf, { name: colour.name })}
									value={colour.light.base}
									valid={(text) => HEX.test(text)}
									onCommit={(base) => change(colour.id, (each) => ({ ...each, light: { ...each.light, base } }))}
									className="text-chrome-muted w-24"
									data={{ "data-wc-colour-light": colour.name }}
								/>
							</td>
							<td className="px-1">
								<span className="flex items-center gap-2">
									<Swatch
										colour={dark || "transparent"}
										label={fill(shown.darkOf, { name: colour.name })}
										onPick={(base) => change(colour.id, (each) => ({ ...each, dark: { ...each.dark, base } }))}
									/>
									<TokenField
										label={fill(shown.darkOf, { name: colour.name })}
										value={colour.dark.base ?? ""}
										placeholder={generatedDark ? fill(shown.auto, { value: generatedDark }) : shown.autoPlain}
										valid={(text) => text === "" || HEX.test(text)}
										onCommit={(base) =>
											change(colour.id, (each) => ({
												...each,
												dark: { ...each.dark, base: base === "" ? null : base },
											}))
										}
										className="text-chrome-muted w-32"
										data={{ "data-wc-colour-dark": colour.name }}
									/>
								</span>
							</td>
							<td className="px-1">
								<ContrastBadge
									words={words}
									level={colour.id ? contrastOf(colour.id, editing.preview.contrast) : null}
								/>
							</td>
							<td className="px-1">
								<RemoveButton
									label={fill(shown.remove, { name: colour.name })}
									again={fill(shown.removeAgain, { name: colour.name })}
									onRemove={() =>
										void removeTokens(editing, {
											...tokens,
											colours: tokens.colours.filter((each) => each.id !== colour.id),
										}).then((done) => done && announce(fill(shown.removed, { name: colour.name })))
									}
								/>
							</td>
						</tr>
					);
				})}
			</TokenTable>
			<AddRow label={shown.addColour} onAdd={add} data={{ "data-wc-token-add": "colours" }} />
			{editing.draft.darkMode ? null : <p className="text-chrome-muted m-0 px-1 text-[11px]">{shown.noDarkMode}</p>}
		</>
	);
}

/** A number field of a token (a scale's base or ratio, a dimension, a shadow's offset). */
function NumberField({
	label,
	value,
	onCommit,
	step = "1",
	min,
	className = "w-16",
}: {
	label: string;
	value: number;
	onCommit(value: number): void;
	step?: string;
	min?: number;
	className?: string;
}) {
	return (
		<TokenField
			label={label}
			value={String(value)}
			valid={(text) =>
				text.trim() !== "" && Number.isFinite(Number(text)) && (min === undefined || Number(text) >= min)
			}
			onCommit={(text) => onCommit(Number(text))}
			className={`text-end ${className}`}
			data={{ "data-wc-number": step }}
		/>
	);
}

/** Spacing and the type scale: the base size and ratio at both ends of the viewports, and each step's sizes. */
function ScaleEditor({ words, editing, kind }: { words: Words; editing: Editing; kind: "space" | "text" }) {
	const shown = words.styles.tokens;
	const { tokens } = editing.draft;
	const scale = tokens[kind];
	const prefix = kind === "space" ? "space" : "text";
	const setScale = (next: Tokens["space"]) => editing.setSection("tokens", { ...tokens, [kind]: next });
	const steps = editing.preview.scales[kind];
	const range = (value: { min: number; max: number }) =>
		value.min === value.max ? `${value.min}px` : `${value.min}–${value.max}px`;
	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-1 text-[12px]">
				{(
					[
						["base", shown.base, "1"],
						["ratio", shown.ratio, "0.01"],
					] as const
				).map(([part, label, step]) => (
					<span key={part} className="text-chrome-muted inline-flex items-center gap-1.5">
						{label}
						<NumberField
							label={fill(shown.atSmallest, { what: label })}
							value={scale[part].min}
							step={step}
							min={0}
							onCommit={(min) => setScale({ ...scale, [part]: { ...scale[part], min } })}
						/>
						–
						<NumberField
							label={fill(shown.atLargest, { what: label })}
							value={scale[part].max}
							step={step}
							min={0}
							onCommit={(max) => setScale({ ...scale, [part]: { ...scale[part], max } })}
						/>
					</span>
				))}
			</div>
			<TokenTable
				caption={shown.group[kind]}
				columns={[
					[shown.name, "w-[140px]"],
					[shown.property, "w-[200px]"],
					[shown.size, ""],
				]}
			>
				{steps.map((step) => (
					<tr key={step.id} className="border-chrome-line h-11 border-t">
						<td className="text-chrome-text px-1 font-mono text-[12px]">{step.name}</td>
						<td className="text-chrome-muted px-1 font-mono text-[12px]">{`--${prefix}-${step.name}`}</td>
						<td className="text-chrome-muted px-1 font-mono text-[12px]">
							{range(step.size)}
							{step.custom ? (
								<span className="text-chrome-warn ms-2 font-sans text-[11px]">{shown.ownSizes}</span>
							) : null}
						</td>
					</tr>
				))}
			</TokenTable>
			<p className="text-chrome-muted m-0 px-1 text-[11px]">{shown.scaleHelp}</p>
		</div>
	);
}

/** Fonts: each name and its family (a list, the first available used). */
function FontsEditor({ words, editing, announce }: { words: Words; editing: Editing; announce(text: string): void }) {
	const shown = words.styles.tokens;
	const { tokens } = editing.draft;
	const setFonts = (fonts: Tokens["fonts"]) => editing.setSection("tokens", { ...tokens, fonts });
	const change = (fontId: string | undefined, patch: Partial<Tokens["fonts"][number]>) =>
		setFonts(tokens.fonts.map((each) => (each.id === fontId ? { ...each, ...patch } : each)));
	const family = (text: string) =>
		text
			.split(",")
			.map((each) => each.trim().replace(/^["']|["']$/g, ""))
			.filter(Boolean);
	return (
		<>
			<TokenTable
				caption={shown.group.fonts}
				columns={[
					[shown.name, "w-[140px]"],
					[shown.family, ""],
					["", "w-8"],
				]}
			>
				{tokens.fonts.map((font) => (
					<tr key={font.id ?? font.name} className="h-11">
						<td className="px-1">
							<TokenField
								label={fill(shown.nameOf, { name: font.name })}
								value={font.name}
								valid={(text) => TOKEN_NAME.test(text)}
								onCommit={(name) => change(font.id, { name })}
								className="w-[130px]"
							/>
						</td>
						<td className="px-1">
							<TokenField
								label={fill(shown.familyOf, { name: font.name })}
								value={font.family.join(", ")}
								valid={(text) => family(text).length > 0}
								onCommit={(text) => change(font.id, { family: family(text) })}
								mono={false}
								className="w-full"
							/>
						</td>
						<td className="px-1">
							<RemoveButton
								label={fill(shown.remove, { name: font.name })}
								again={fill(shown.removeAgain, { name: font.name })}
								onRemove={() =>
									void removeTokens(editing, {
										...tokens,
										fonts: tokens.fonts.filter((each) => each.id !== font.id),
									}).then((done) => done && announce(fill(shown.removed, { name: font.name })))
								}
							/>
						</td>
					</tr>
				))}
			</TokenTable>
			<AddRow
				label={shown.addFont}
				onAdd={() => {
					const made = { id: newTokenId(), name: freeName("font", tokens.fonts), family: ["system-ui", "sans-serif"] };
					setFonts([...tokens.fonts, made]);
					announce(fill(shown.added, { name: made.name }));
				}}
				data={{ "data-wc-token-add": "fonts" }}
			/>
		</>
	);
}

/** Radius and content widths: each name and its size (px or rem). */
function DimensionsEditor({
	words,
	editing,
	kind,
	announce,
}: {
	words: Words;
	editing: Editing;
	kind: "radius" | "widths";
	announce(text: string): void;
}) {
	const shown = words.styles.tokens;
	const { tokens } = editing.draft;
	const list = tokens[kind];
	const set = (next: Tokens["radius"]) => editing.setSection("tokens", { ...tokens, [kind]: next });
	const change = (tokenId: string | undefined, patch: Partial<Tokens["radius"][number]>) =>
		set(list.map((each) => (each.id === tokenId ? { ...each, ...patch } : each)));
	return (
		<>
			<TokenTable
				caption={shown.group[kind]}
				columns={[
					[shown.name, "w-[140px]"],
					[shown.value, ""],
					["", "w-8"],
				]}
			>
				{list.map((token) => (
					<tr key={token.id ?? token.name} className="h-11">
						<td className="px-1">
							<TokenField
								label={fill(shown.nameOf, { name: token.name })}
								value={token.name}
								valid={(text) => TOKEN_NAME.test(text)}
								onCommit={(name) => change(token.id, { name })}
								className="w-[130px]"
							/>
						</td>
						<td className="px-1">
							<span className="inline-flex items-center gap-1">
								<NumberField
									label={fill(shown.valueOf, { name: token.name })}
									value={token.value.value}
									min={0}
									step="0.125"
									onCommit={(value) => change(token.id, { value: { ...token.value, value } })}
								/>
								<select
									aria-label={fill(shown.unitOf, { name: token.name })}
									value={token.value.unit}
									onChange={(event) =>
										change(token.id, { value: { ...token.value, unit: event.target.value === "rem" ? "rem" : "px" } })
									}
									className="border-chrome-hover bg-chrome-raised text-chrome-text focus:ring-chrome-focus h-7 rounded-[5px] border px-1 text-[12px] outline-none focus:ring-2"
								>
									<option value="px">px</option>
									<option value="rem">rem</option>
								</select>
							</span>
						</td>
						<td className="px-1">
							<RemoveButton
								label={fill(shown.remove, { name: token.name })}
								again={fill(shown.removeAgain, { name: token.name })}
								onRemove={() =>
									void removeTokens(editing, { ...tokens, [kind]: list.filter((each) => each.id !== token.id) }).then(
										(done) => done && announce(fill(shown.removed, { name: token.name })),
									)
								}
							/>
						</td>
					</tr>
				))}
			</TokenTable>
			<AddRow
				label={kind === "radius" ? shown.addRadius : shown.addWidth}
				onAdd={() => {
					const made = {
						id: newTokenId(),
						name: freeName(kind === "radius" ? "radius" : "width", list),
						value: kind === "radius" ? { value: 4, unit: "px" as const } : { value: 60, unit: "rem" as const },
					};
					set([...list, made]);
					announce(fill(shown.added, { name: made.name }));
				}}
				data={{ "data-wc-token-add": kind }}
			/>
		</>
	);
}

type Shadow = Tokens["shadows"][number];
type Layer = Shadow["layers"][number];

/** Shadows: each name and its layers (offsets, blur, spread, colour, inset). */
function ShadowsEditor({ words, editing, announce }: { words: Words; editing: Editing; announce(text: string): void }) {
	const shown = words.styles.tokens;
	const { tokens } = editing.draft;
	const setShadows = (shadows: Shadow[]) => editing.setSection("tokens", { ...tokens, shadows });
	const changeLayer = (shadow: Shadow, index: number, patch: Partial<Layer>) =>
		setShadows(
			tokens.shadows.map((each) =>
				each.id === shadow.id
					? { ...each, layers: each.layers.map((layer, at) => (at === index ? { ...layer, ...patch } : layer)) }
					: each,
			),
		);
	const NEW_LAYER: Layer = { offsetX: 0, offsetY: 2, blur: 8, spread: 0, color: "#00000033", inset: false };
	return (
		<div className="flex flex-col gap-3">
			{tokens.shadows.map((shadow) => (
				<fieldset
					key={shadow.id ?? shadow.name}
					className="border-chrome-line m-0 flex flex-col gap-1 rounded-md border p-2"
				>
					<legend className="sr-only">{shadow.name}</legend>
					<div className="flex items-center gap-2">
						<TokenField
							label={fill(shown.nameOf, { name: shadow.name })}
							value={shadow.name}
							valid={(text) => TOKEN_NAME.test(text)}
							onCommit={(name) =>
								setShadows(tokens.shadows.map((each) => (each.id === shadow.id ? { ...each, name } : each)))
							}
							className="w-[130px]"
						/>
						<span className="ms-auto inline-flex items-center gap-1">
							<AddRow
								label={shown.addLayer}
								onAdd={() =>
									setShadows(
										tokens.shadows.map((each) =>
											each.id === shadow.id ? { ...each, layers: [...each.layers, NEW_LAYER] } : each,
										),
									)
								}
							/>
							<RemoveButton
								label={fill(shown.remove, { name: shadow.name })}
								again={fill(shown.removeAgain, { name: shadow.name })}
								onRemove={() =>
									void removeTokens(editing, {
										...tokens,
										shadows: tokens.shadows.filter((each) => each.id !== shadow.id),
									}).then((done) => done && announce(fill(shown.removed, { name: shadow.name })))
								}
							/>
						</span>
					</div>
					{shadow.layers.map((layer, index) => (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: a layer is its place in the list.
							key={index}
							className="text-chrome-muted flex flex-wrap items-center gap-x-3 gap-y-1 ps-1.5 text-[11px]"
						>
							{(["offsetX", "offsetY", "blur", "spread"] as const).map((part) => (
								<span key={part} className="inline-flex items-center gap-1">
									{shown.layer[part]}
									<NumberField
										label={fill(shown.layerPart, {
											part: shown.layer[part],
											name: shadow.name,
											layer: String(index + 1),
										})}
										value={layer[part]}
										onCommit={(value) => changeLayer(shadow, index, { [part]: value })}
										className="w-12"
									/>
								</span>
							))}
							<span className="inline-flex items-center gap-1">
								{shown.layer.color}
								<TokenField
									label={fill(shown.layerPart, {
										part: shown.layer.color,
										name: shadow.name,
										layer: String(index + 1),
									})}
									value={layer.color}
									valid={(text) => /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text)}
									onCommit={(color) => changeLayer(shadow, index, { color })}
									className="w-24"
								/>
							</span>
							<label className="inline-flex items-center gap-1">
								<input
									type="checkbox"
									checked={layer.inset}
									onChange={(event) => changeLayer(shadow, index, { inset: event.target.checked })}
									className={`accent-chrome-focus ${FOCUS_RING}`}
								/>
								{shown.layer.inset}
							</label>
						</div>
					))}
				</fieldset>
			))}
			<AddRow
				label={shown.addShadow}
				onAdd={() => {
					const made: Shadow = { id: newTokenId(), name: freeName("shadow", tokens.shadows), layers: [NEW_LAYER] };
					setShadows([...tokens.shadows, made]);
					announce(fill(shown.added, { name: made.name }));
				}}
				data={{ "data-wc-token-add": "shadows" }}
			/>
		</div>
	);
}
