import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@webcraft/ui/components/card.tsx";
import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
import { Field, FieldDescription, FieldError, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import {
	ALargeSmallIcon,
	CircleCheckIcon,
	LayersIcon,
	MonitorSmartphoneIcon,
	MoveHorizontalIcon,
	PaletteIcon,
	PencilIcon,
	PlusIcon,
	RotateCcwIcon,
	RulerIcon,
	SquareRoundCornerIcon,
	Trash2Icon,
	TriangleAlertIcon,
	TypeIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { getApi } from "../api.ts";
import { Segmented } from "../filters/Segmented.tsx";
import { useT } from "../i18n.tsx";
import type { Editing } from "./DesignSystemScreen.tsx";
import {
	BASE_STEP,
	type ColourMode,
	type ColourToken,
	type ContrastResult,
	freeName,
	html,
	newTokenId,
	SHADE_STEPS,
	type Tokens,
} from "./model.ts";
import { StylePreview } from "./StylePreview.tsx";

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** The groups of Design tokens, each a section of the tab, in the order the prototype shows them. */
const GROUPS = [
	{ id: "colours", icon: PaletteIcon },
	{ id: "space", icon: MoveHorizontalIcon },
	{ id: "text", icon: TypeIcon },
	{ id: "fonts", icon: ALargeSmallIcon },
	{ id: "radius", icon: SquareRoundCornerIcon },
	{ id: "shadows", icon: LayersIcon },
	{ id: "breakpoints", icon: MonitorSmartphoneIcon },
	{ id: "widths", icon: RulerIcon },
] as const;
type Group = (typeof GROUPS)[number]["id"];

/**
 * The Tokens tab: every kind of Design token, each group a card beside a list that moves to it. The
 * colour ramps are one set with a Light/Dark switch (the switch shows each colour's dark values,
 * worked out along the same steps); the spacing and type scales are edited by their base, ratio and
 * viewport, any step given its own sizes; each card shows its tokens in a live preview built from the
 * Draft's compiled stylesheet.
 */
export function TokensTab({ editing }: { editing: Editing }) {
	const t = useT();
	const { tokens } = editing.draft;
	const counts: Record<Group, number> = {
		colours: tokens.colours.length,
		space: tokens.space.steps.length,
		text: tokens.text.steps.length,
		fonts: tokens.fonts.length,
		radius: tokens.radius.length,
		shadows: tokens.shadows.length,
		breakpoints: tokens.breakpoints.length,
		widths: tokens.widths.length,
	};
	return (
		<div className="grid gap-6 lg:grid-cols-[12rem_minmax(0,1fr)]">
			<nav aria-label={t("designSystem.tokens.groups")} className="lg:sticky lg:top-4 lg:self-start">
				<ul className="grid gap-0.5">
					{GROUPS.map((group) => (
						<li key={group.id}>
							<button
								type="button"
								onClick={() => {
									const heading = document.getElementById(`design-${group.id}`);
									heading?.scrollIntoView({ block: "start" });
									heading?.focus();
								}}
								className="hover:bg-muted focus-visible:ring-ring/50 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm outline-none focus-visible:ring-3"
							>
								<group.icon className="size-4" aria-hidden="true" />
								<span>{t(`designSystem.tokens.group.${group.id}`)}</span>
								<span className="text-muted-foreground ms-auto text-xs">{counts[group.id]}</span>
							</button>
						</li>
					))}
				</ul>
			</nav>
			<div className="grid min-w-0 gap-6">
				<ColoursCard editing={editing} />
				<ContrastCard editing={editing} />
				<div className="grid gap-6 2xl:grid-cols-2">
					<ScaleCard editing={editing} kind="space" />
					<ScaleCard editing={editing} kind="text" />
				</div>
				<FontsCard editing={editing} />
				<div className="grid gap-6 xl:grid-cols-2">
					<DimensionsCard editing={editing} kind="radius" />
					<ShadowsCard editing={editing} />
				</div>
				<div className="grid gap-6 xl:grid-cols-2">
					<BreakpointsCard editing={editing} />
					<DimensionsCard editing={editing} kind="widths" />
				</div>
			</div>
		</div>
	);
}

/** A card of the tab, its heading the place the groups list moves to. */
function Section({
	group,
	description,
	action,
	children,
}: {
	group: Group;
	description: ReactNode;
	action?: ReactNode;
	children: ReactNode;
}) {
	const t = useT();
	return (
		<Card aria-labelledby={`design-${group}`} role="region">
			<CardHeader className="flex flex-wrap items-start justify-between gap-3">
				<div className="grid gap-1">
					<CardTitle>
						<h2 id={`design-${group}`} tabIndex={-1} className="scroll-mt-4 outline-none">
							{t(`designSystem.tokens.group.${group}`)}
						</h2>
					</CardTitle>
					<CardDescription>{description}</CardDescription>
				</div>
				{action}
			</CardHeader>
			<CardContent className="grid gap-4">{children}</CardContent>
		</Card>
	);
}

/** Uses of a token, as a short badge. */
function Uses({ count }: { count: number | undefined }) {
	const t = useT();
	return (
		<Badge variant="secondary" className="whitespace-nowrap">
			{t("designSystem.uses", { count: count ?? 0 })}
		</Badge>
	);
}

/** Removes a token through an immediate save, so a token in use is refused at once, with where. */
async function removeToken(editing: Editing, tokens: Tokens) {
	await editing.now(async () => {
		const api = await getApi();
		const { designSystem } = await api.designSystem.saveDraft({ siteId: editing.siteId, tokens });
		editing.replaceDraft(designSystem.draft);
	});
}

// ---------------------------------------------------------------------------------------------
// Colours

function ColoursCard({ editing }: { editing: Editing }) {
	const t = useT();
	const id = useId();
	const { tokens, darkMode } = editing.draft;
	const { mode } = editing;
	const [selected, setSelected] = useState<{ colour: string; step: string } | null>(null);
	const colour = tokens.colours.find((each) => each.id === selected?.colour);

	const setColours = (colours: ColourToken[]) => editing.setSection("tokens", { ...tokens, colours });
	const changeColour = (colourId: string, change: (colour: ColourToken) => ColourToken) =>
		setColours(tokens.colours.map((each) => (each.id === colourId ? change(each) : each)));

	const add = () => {
		const made: ColourToken = {
			id: newTokenId(),
			name: freeName("colour", tokens.colours),
			light: { base: "#71717a", steps: {} },
			dark: { base: null, steps: {} },
		};
		setColours([...tokens.colours, made]);
		setSelected({ colour: made.id, step: BASE_STEP });
	};

	const sample = tokens.colours
		.map(
			(each) =>
				`<div data-ramp="${html(each.name)}"><p data-tint>${html(t("designSystem.colours.sampleText", { name: each.name }))}</p><span data-solid>${html(t("designSystem.colours.sampleLabel"))}</span><span data-outline>${html(t("designSystem.colours.sampleOutline"))}</span></div>`,
		)
		.join("");
	const sampleCss = [
		"[data-ramp]{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-block-end:12px;font-family:var(--font-body)}",
		"[data-ramp] p{margin:0;padding:8px 12px;border-radius:var(--radius-m)}",
		"[data-ramp] span{padding:6px 12px;border-radius:var(--radius-m)}",
		...tokens.colours.map(
			(each) =>
				`[data-ramp="${each.name}"] [data-tint]{background:var(--${each.name}-10);color:var(--${each.name}-95)}[data-ramp="${each.name}"] [data-solid]{background:var(--${each.name}-60);color:var(--${each.name}-10)}[data-ramp="${each.name}"] [data-outline]{border:2px solid var(--${each.name}-60);color:var(--${each.name}-95)}`,
		),
	].join("\n");

	return (
		<Section
			group="colours"
			description={
				<>
					{t("designSystem.colours.intro")}{" "}
					{darkMode ? t("designSystem.colours.darkOn") : t("designSystem.colours.darkOff")}
				</>
			}
			action={
				<div className="flex flex-wrap items-center gap-2">
					<Segmented<ColourMode>
						label={t("designSystem.colours.mode")}
						value={mode}
						options={[
							{ value: "light", label: t("designSystem.colours.light") },
							{ value: "dark", label: t("designSystem.colours.dark") },
						]}
						onChange={editing.setMode}
					/>
					<Button type="button" variant="outline" onClick={add}>
						<PlusIcon aria-hidden="true" />
						{t("designSystem.colours.add")}
					</Button>
				</div>
			}
		>
			<Field orientation="horizontal">
				<Checkbox
					id={`${id}-dark`}
					checked={darkMode}
					onCheckedChange={(checked) => editing.setSection("darkMode", checked === true)}
					aria-describedby={`${id}-dark-help`}
				/>
				<div className="grid gap-1">
					<FieldLabel htmlFor={`${id}-dark`}>{t("designSystem.colours.darkMode")}</FieldLabel>
					<FieldDescription id={`${id}-dark-help`}>{t("designSystem.colours.darkModeHelp")}</FieldDescription>
				</div>
			</Field>
			<div className="overflow-x-auto">
				<table className="w-full min-w-[44rem] border-separate border-spacing-1 text-sm">
					<caption className="sr-only">
						{t("designSystem.colours.caption", { mode: t(`designSystem.colours.${mode}`) })}
					</caption>
					<thead>
						<tr>
							<th scope="col" className="text-muted-foreground w-36 text-start text-xs font-medium">
								{t("designSystem.colours.colour")}
							</th>
							{SHADE_STEPS.map((step) => (
								<th key={step} scope="col" className="text-muted-foreground text-xs font-medium">
									{step}
								</th>
							))}
							<th scope="col" className="text-muted-foreground text-end text-xs font-medium">
								{t("designSystem.usesHeading")}
							</th>
						</tr>
					</thead>
					<tbody>
						{tokens.colours.map((each) => {
							const ramp = editing.preview.ramps[each.id]?.[mode];
							const overrides = each[mode].steps;
							return (
								<tr key={each.id}>
									<th scope="row" className="text-start align-middle font-medium">
										<span className="block">{each.name}</span>
										<span className="text-muted-foreground block font-mono text-xs font-normal">--{each.name}-*</span>
									</th>
									{SHADE_STEPS.map((step) => {
										const value = ramp?.shown[step] ?? "";
										const overridden = step !== BASE_STEP && Boolean(overrides[step]);
										const pressed = selected?.colour === each.id && selected.step === step;
										return (
											<td key={step} className="p-0">
												<button
													type="button"
													aria-pressed={pressed}
													aria-label={t(
														overridden ? "designSystem.colours.swatchOverridden" : "designSystem.colours.swatch",
														{
															name: each.name,
															step,
															value,
														},
													)}
													onClick={() => setSelected(pressed ? null : { colour: each.id, step })}
													style={{ backgroundColor: value }}
													className="focus-visible:ring-ring aria-pressed:ring-foreground relative flex h-9 w-full items-end justify-end rounded-md border p-0.5 outline-none focus-visible:ring-3 aria-pressed:ring-2"
												>
													{overridden ? (
														<span className="bg-background text-foreground flex size-4 items-center justify-center rounded-full">
															<PencilIcon className="size-2.5" aria-hidden="true" />
														</span>
													) : null}
												</button>
											</td>
										);
									})}
									<td className="text-end">
										<Uses count={editing.preview.uses.tokens[each.id]} />
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
			{colour && selected ? (
				<SwatchEditor
					key={`${colour.id}:${selected.step}:${mode}`}
					editing={editing}
					colour={colour}
					step={selected.step}
					onChange={(change) => changeColour(colour.id, change)}
					onRemove={async () => {
						setSelected(null);
						await removeToken(editing, {
							...tokens,
							colours: tokens.colours.filter((each) => each.id !== colour.id),
						});
					}}
				/>
			) : (
				<p className="text-muted-foreground text-sm">{t("designSystem.colours.pick")}</p>
			)}
			<StylePreview
				title={t("designSystem.colours.previewTitle", { mode: t(`designSystem.colours.${mode}`) })}
				stylesheet={editing.preview.stylesheet}
				markup={sample}
				extraCss={sampleCss}
				mode={mode}
			/>
		</Section>
	);
}

/** The selected swatch: its value (the base colour for step 60, else an override), the colour's name, and removing it. */
function SwatchEditor({
	editing,
	colour,
	step,
	onChange,
	onRemove,
}: {
	editing: Editing;
	colour: ColourToken;
	step: string;
	onChange(change: (colour: ColourToken) => ColourToken): void;
	onRemove(): void;
}) {
	const t = useT();
	const id = useId();
	const { mode } = editing;
	const ramp = editing.preview.ramps[colour.id]?.[mode];
	const isBase = step === BASE_STEP;
	const own = isBase
		? mode === "light"
			? colour.light.base
			: (colour.dark.base ?? "")
		: (colour[mode].steps[step] ?? "");
	const [value, setValue] = useState(own || ramp?.shown[step] || "");
	const [name, setName] = useState(colour.name);
	const valid = HEX.test(value);
	const generated = ramp?.generated[step] ?? "";

	const setValueOf = (next: string) => {
		setValue(next);
		if (!HEX.test(next)) return;
		onChange((before) => {
			if (isBase && mode === "light") return { ...before, light: { ...before.light, base: next } };
			if (isBase) return { ...before, dark: { ...before.dark, base: next } };
			return { ...before, [mode]: { ...before[mode], steps: { ...before[mode].steps, [step]: next } } };
		});
	};

	const reset = () => {
		onChange((before) => {
			if (isBase) return { ...before, dark: { ...before.dark, base: null } };
			const { [step]: _, ...steps } = before[mode].steps;
			return { ...before, [mode]: { ...before[mode], steps } };
		});
		setValue(isBase ? colour.light.base : generated);
	};
	const resettable = isBase ? mode === "dark" && colour.dark.base !== null : Boolean(colour[mode].steps[step]);

	return (
		<fieldset className="bg-muted/50 m-0 grid min-w-0 gap-4 rounded-lg border-0 p-4">
			<legend className="float-start mb-0 flex items-center gap-2 text-sm font-medium">
				<PencilIcon className="size-4" aria-hidden="true" />
				{t("designSystem.colours.editing", {
					name: colour.name,
					step,
					mode: t(`designSystem.colours.${mode}`),
				})}
			</legend>
			<div className="grid gap-4 md:grid-cols-2">
				<Field data-invalid={valid ? undefined : true}>
					<FieldLabel htmlFor={`${id}-value`}>
						{isBase
							? mode === "light"
								? t("designSystem.colours.base")
								: t("designSystem.colours.darkBase")
							: t("designSystem.colours.override")}
					</FieldLabel>
					<div className="flex gap-2">
						<Input
							id={`${id}-value`}
							value={value}
							onChange={(event) => setValueOf(event.target.value.trim())}
							className="font-mono"
							spellCheck={false}
							autoComplete="off"
							aria-invalid={valid ? undefined : true}
							aria-describedby={`${id}-value-help`}
						/>
						<input
							type="color"
							aria-label={t("designSystem.colours.picker", { name: colour.name, step })}
							value={valid && value.length === 7 ? value : "#000000"}
							onChange={(event) => setValueOf(event.target.value)}
							className="h-9 w-12 shrink-0 cursor-pointer rounded-md border"
						/>
					</div>
					<FieldDescription id={`${id}-value-help`}>
						{isBase ? t("designSystem.colours.baseHelp") : t("designSystem.colours.generated", { value: generated })}
					</FieldDescription>
					{valid ? null : <FieldError>{t("designSystem.colours.hexInvalid")}</FieldError>}
				</Field>
				<Field>
					<FieldLabel htmlFor={`${id}-name`}>{t("designSystem.colours.name")}</FieldLabel>
					<Input
						id={`${id}-name`}
						value={name}
						onChange={(event) => {
							setName(event.target.value);
							if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(event.target.value))
								onChange((before) => ({ ...before, name: event.target.value }));
						}}
						className="font-mono"
						spellCheck={false}
						autoComplete="off"
						aria-describedby={`${id}-name-help`}
					/>
					<FieldDescription id={`${id}-name-help`}>{t("designSystem.colours.nameHelp")}</FieldDescription>
				</Field>
			</div>
			<div className="flex flex-wrap gap-2">
				{resettable ? (
					<Button type="button" variant="outline" onClick={reset}>
						<RotateCcwIcon aria-hidden="true" />
						{isBase ? t("designSystem.colours.useLightBase") : t("designSystem.colours.reset")}
					</Button>
				) : null}
				<Button type="button" variant="outline" onClick={onRemove}>
					<Trash2Icon aria-hidden="true" />
					{t("designSystem.colours.remove", { name: colour.name })}
				</Button>
			</div>
		</fieldset>
	);
}

// ---------------------------------------------------------------------------------------------
// The contrast Check

/**
 * The contrast Check: colour pairs below what they need, in light and (with Dark mode on) dark.
 * It warns and never stops a save or a publish. The Site's list of Checks (#95) collects the same
 * results (`designSystemChecks` in core).
 */
function ContrastCard({ editing }: { editing: Editing }) {
	const t = useT();
	const results = editing.preview.contrast;
	const failing = results.filter((result) => !result.passes);
	return (
		<Card role="region" aria-labelledby="design-contrast">
			<CardHeader>
				<CardTitle>
					<h2 id="design-contrast" className="flex items-center gap-2">
						{failing.length > 0 ? (
							<TriangleAlertIcon className="size-4 text-amber-600" aria-hidden="true" />
						) : (
							<CircleCheckIcon className="size-4" aria-hidden="true" />
						)}
						{t("designSystem.contrast.heading")}
					</h2>
				</CardTitle>
				<CardDescription>{t("designSystem.contrast.intro")}</CardDescription>
			</CardHeader>
			<CardContent className="grid gap-3">
				<p role="status" className="text-sm">
					{failing.length > 0
						? t("designSystem.contrast.failing", { count: failing.length, checked: results.length })
						: t("designSystem.contrast.allPass", { checked: results.length })}
				</p>
				{failing.length > 0 ? (
					<ul className="grid gap-2">
						{failing.map((result) => (
							<ContrastRow key={result.id} result={result} />
						))}
					</ul>
				) : null}
			</CardContent>
		</Card>
	);
}

function ContrastRow({ result }: { result: ContrastResult }) {
	const t = useT();
	const source = result.sources[0];
	const why =
		source?.kind === "baseStyle"
			? t("designSystem.contrast.source.baseStyle", { target: source.target })
			: source?.kind === "focus"
				? t("designSystem.contrast.source.focus")
				: t(`designSystem.contrast.source.${source?.role ?? "textOnTint"}`);
	return (
		<li className="flex flex-wrap items-center gap-3 rounded-md border p-2 text-sm">
			<span
				aria-hidden="true"
				style={{ color: result.foreground.value, backgroundColor: result.background.value }}
				className="flex h-8 w-12 items-center justify-center rounded border font-semibold"
			>
				Aa
			</span>
			<span className="grid">
				<span className="font-medium">
					{t("designSystem.contrast.pair", {
						foreground: `${result.foreground.name}-${result.foreground.step}`,
						background: `${result.background.name}-${result.background.step}`,
					})}
				</span>
				<span className="text-muted-foreground text-xs">
					{why} · {t(`designSystem.contrast.use.${result.use}`)} · {t(`designSystem.colours.${result.mode}`)}
				</span>
			</span>
			<span className="ms-auto font-mono text-sm">
				{t("designSystem.contrast.ratio", { ratio: result.ratio.toFixed(2), required: String(result.required) })}
			</span>
		</li>
	);
}

// ---------------------------------------------------------------------------------------------
// Spacing and type

/** A number field that hands back a number once what is typed is one. */
function NumberField({
	label,
	value,
	onChange,
	step = "any",
	min,
}: {
	label: string;
	value: number;
	onChange(value: number): void;
	step?: string;
	min?: number;
}) {
	const id = useId();
	const [text, setText] = useState(String(value));
	return (
		<Field>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<Input
				id={id}
				type="number"
				inputMode="decimal"
				step={step}
				min={min}
				value={text}
				onChange={(event) => {
					setText(event.target.value);
					const next = Number(event.target.value);
					if (event.target.value.trim() !== "" && Number.isFinite(next)) onChange(next);
				}}
			/>
		</Field>
	);
}

function ScaleCard({ editing, kind }: { editing: Editing; kind: "space" | "text" }) {
	const t = useT();
	const { tokens } = editing.draft;
	const scale = tokens[kind];
	const steps = editing.preview.scales[kind];
	const setScale = (next: Tokens["space"]) => editing.setSection("tokens", { ...tokens, [kind]: next });
	const setStepSize = (stepId: string, size: { min: number; max: number } | null) =>
		setScale({ ...scale, steps: scale.steps.map((each) => (each.id === stepId ? { ...each, size } : each)) });
	const prefix = kind === "space" ? "space" : "text";

	const sample = steps
		.map((step) =>
			kind === "space"
				? `<div data-step><code>${html(step.name)}</code><span data-bar="${html(step.name)}"></span></div>`
				: `<p data-type="${html(step.name)}">${html(step.name)} · ${html(t("designSystem.scales.sample"))}</p>`,
		)
		.join("");
	const sampleCss =
		kind === "space"
			? [
					"[data-step]{display:flex;align-items:center;gap:12px;margin-block-end:6px;font-family:var(--font-mono)}",
					"[data-step] code{inline-size:3em}",
					...steps.map(
						(step) =>
							`[data-bar="${step.name}"]{display:block;block-size:12px;inline-size:var(--space-${step.name});background:var(--primary-60);border-radius:2px}`,
					),
				].join("\n")
			: [
					"[data-type]{margin:0 0 8px;font-family:var(--font-heading);line-height:1.2}",
					...steps.map((step) => `[data-type="${step.name}"]{font-size:var(--text-${step.name})}`),
				].join("\n");

	return (
		<Section
			group={kind}
			description={kind === "space" ? t("designSystem.scales.spaceIntro") : t("designSystem.scales.textIntro")}
		>
			<div className="grid gap-3 sm:grid-cols-2">
				<NumberField
					label={t("designSystem.scales.baseMin")}
					value={scale.base.min}
					min={0}
					onChange={(min) => setScale({ ...scale, base: { ...scale.base, min } })}
				/>
				<NumberField
					label={t("designSystem.scales.baseMax")}
					value={scale.base.max}
					min={0}
					onChange={(max) => setScale({ ...scale, base: { ...scale.base, max } })}
				/>
				<NumberField
					label={t("designSystem.scales.ratioMin")}
					value={scale.ratio.min}
					step="0.01"
					min={1}
					onChange={(min) => setScale({ ...scale, ratio: { ...scale.ratio, min } })}
				/>
				<NumberField
					label={t("designSystem.scales.ratioMax")}
					value={scale.ratio.max}
					step="0.01"
					min={1}
					onChange={(max) => setScale({ ...scale, ratio: { ...scale.ratio, max } })}
				/>
				<NumberField
					label={t("designSystem.scales.viewportMin")}
					value={tokens.viewport.min}
					min={0}
					onChange={(min) => editing.setSection("tokens", { ...tokens, viewport: { ...tokens.viewport, min } })}
				/>
				<NumberField
					label={t("designSystem.scales.viewportMax")}
					value={tokens.viewport.max}
					min={0}
					onChange={(max) => editing.setSection("tokens", { ...tokens, viewport: { ...tokens.viewport, max } })}
				/>
			</div>
			<div className="overflow-x-auto rounded-md border">
				<table className="w-full text-sm">
					<caption className="sr-only">{t(`designSystem.tokens.group.${kind}`)}</caption>
					<thead className="bg-muted text-muted-foreground text-xs">
						<tr>
							<th scope="col" className="px-3 py-2 text-start font-medium">
								{t("designSystem.scales.step")}
							</th>
							<th scope="col" className="px-3 py-2 text-start font-medium">
								{t("designSystem.scales.property")}
							</th>
							<th scope="col" className="px-3 py-2 text-start font-medium">
								{t("designSystem.scales.size")}
							</th>
							<th scope="col" className="px-3 py-2 text-start font-medium">
								{t("designSystem.usesHeading")}
							</th>
						</tr>
					</thead>
					<tbody>
						{steps.map((step) => (
							<tr key={step.id} className="border-t">
								<th scope="row" className="px-3 py-1.5 text-start font-medium">
									<span className="inline-flex items-center gap-1">
										{step.name}
										{step.custom ? (
											<PencilIcon className="text-primary size-3" aria-label={t("designSystem.scales.ownSizes")} />
										) : null}
									</span>
								</th>
								<td className="text-muted-foreground px-3 py-1.5 font-mono text-xs">
									--{prefix}-{step.name}
								</td>
								<td className="px-3 py-1.5">
									<StepSize
										key={step.id}
										name={step.name}
										size={step.size}
										custom={step.custom}
										onChange={(size) => setStepSize(step.id, size)}
									/>
								</td>
								<td className="px-3 py-1.5">{editing.preview.uses.tokens[step.id] ?? 0}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<StylePreview
				title={t("designSystem.scales.previewTitle", { scale: t(`designSystem.tokens.group.${kind}`) })}
				stylesheet={editing.preview.stylesheet}
				markup={sample}
				extraCss={sampleCss}
				mode={editing.mode}
			/>
		</Section>
	);
}

/** A step's sizes at the smallest and largest viewport, in px; changing them gives the step its own. */
function StepSize({
	name,
	size,
	custom,
	onChange,
}: {
	name: string;
	size: { min: number; max: number };
	custom: boolean;
	onChange(size: { min: number; max: number } | null): void;
}) {
	const t = useT();
	const holder = useRef<HTMLSpanElement>(null);
	const [min, setMin] = useState(String(size.min));
	const [max, setMax] = useState(String(size.max));
	// Sizes worked out again (a new base or ratio) show at once, unless the step is being typed in.
	useEffect(() => {
		if (holder.current?.contains(document.activeElement)) return;
		setMin(String(size.min));
		setMax(String(size.max));
	}, [size.min, size.max]);
	const send = (nextMin: string, nextMax: string) => {
		const a = Number(nextMin);
		const b = Number(nextMax);
		if (nextMin.trim() && nextMax.trim() && Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b >= 0)
			onChange({ min: a, max: b });
	};
	return (
		<span ref={holder} className="flex items-center gap-1">
			<Input
				type="number"
				inputMode="decimal"
				step="any"
				min={0}
				aria-label={t("designSystem.scales.minOf", { name })}
				value={min}
				onChange={(event) => {
					setMin(event.target.value);
					send(event.target.value, max);
				}}
				className="h-7 w-16 px-1.5 text-xs"
			/>
			<span aria-hidden="true">→</span>
			<Input
				type="number"
				inputMode="decimal"
				step="any"
				min={0}
				aria-label={t("designSystem.scales.maxOf", { name })}
				value={max}
				onChange={(event) => {
					setMax(event.target.value);
					send(min, event.target.value);
				}}
				className="h-7 w-16 px-1.5 text-xs"
			/>
			<span className="text-muted-foreground text-xs">px</span>
			{custom ? (
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label={t("designSystem.scales.reset", { name })}
					onClick={() => onChange(null)}
				>
					<RotateCcwIcon aria-hidden="true" />
				</Button>
			) : null}
		</span>
	);
}

// ---------------------------------------------------------------------------------------------
// Fonts, radius, content widths, shadows and breakpoints

/** A token's name as typed: kept on screen as typed, sent once it is a valid name. */
function NameInput({ label, value, onChange }: { label: string; value: string; onChange(name: string): void }) {
	const [text, setText] = useState(value);
	return (
		<Input
			aria-label={label}
			value={text}
			onChange={(event) => {
				setText(event.target.value);
				if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(event.target.value)) onChange(event.target.value);
			}}
			className="font-mono text-xs"
			spellCheck={false}
			autoComplete="off"
		/>
	);
}

function RemoveButton({ label, onClick }: { label: string; onClick(): void }) {
	return (
		<Button type="button" variant="ghost" size="icon-sm" aria-label={label} onClick={onClick}>
			<Trash2Icon aria-hidden="true" />
		</Button>
	);
}

function AddButton({ label, onClick }: { label: string; onClick(): void }) {
	return (
		<Button type="button" variant="outline" size="sm" onClick={onClick}>
			<PlusIcon aria-hidden="true" />
			{label}
		</Button>
	);
}

function FontsCard({ editing }: { editing: Editing }) {
	const t = useT();
	const { tokens } = editing.draft;
	const set = (fonts: Tokens["fonts"]) => editing.setSection("tokens", { ...tokens, fonts });
	return (
		<Section
			group="fonts"
			description={t("designSystem.fonts.intro")}
			action={
				<AddButton
					label={t("designSystem.fonts.add")}
					onClick={() =>
						set([...tokens.fonts, { id: newTokenId(), name: freeName("font", tokens.fonts), family: ["system-ui"] }])
					}
				/>
			}
		>
			<ul className="grid gap-2">
				{tokens.fonts.map((font) => (
					<li key={font.id} className="grid grid-cols-[10rem_minmax(0,1fr)_auto_auto] items-center gap-2">
						<NameInput
							label={t("designSystem.fonts.name", { name: font.name })}
							value={font.name}
							onChange={(name) => set(tokens.fonts.map((each) => (each.id === font.id ? { ...each, name } : each)))}
						/>
						<FamilyInput
							label={t("designSystem.fonts.family", { name: font.name })}
							family={font.family}
							onChange={(family) => set(tokens.fonts.map((each) => (each.id === font.id ? { ...each, family } : each)))}
						/>
						<Uses count={editing.preview.uses.tokens[font.id]} />
						<RemoveButton
							label={t("designSystem.removeToken", { name: font.name })}
							onClick={() =>
								void removeToken(editing, { ...tokens, fonts: tokens.fonts.filter((each) => each.id !== font.id) })
							}
						/>
					</li>
				))}
			</ul>
		</Section>
	);
}

function FamilyInput({
	label,
	family,
	onChange,
}: {
	label: string;
	family: readonly string[];
	onChange(family: string[]): void;
}) {
	const [text, setText] = useState(family.join(", "));
	return (
		<Input
			aria-label={label}
			value={text}
			onChange={(event) => {
				setText(event.target.value);
				const names = event.target.value
					.split(",")
					.map((name) => name.trim().replace(/^["']|["']$/g, ""))
					.filter(Boolean);
				if (names.length > 0) onChange(names);
			}}
			className="text-xs"
			spellCheck={false}
			autoComplete="off"
		/>
	);
}

function DimensionsCard({ editing, kind }: { editing: Editing; kind: "radius" | "widths" }) {
	const t = useT();
	const { tokens } = editing.draft;
	const list = tokens[kind];
	const prefix = kind === "radius" ? "radius" : "width";
	const set = (next: Tokens["radius"]) => editing.setSection("tokens", { ...tokens, [kind]: next });
	const sample =
		kind === "radius"
			? list
					.map(
						(each) =>
							`<figure data-radius="${html(each.name)}"><div></div><figcaption>${html(each.name)}</figcaption></figure>`,
					)
					.join("")
			: list.map((each) => `<div data-width="${html(each.name)}">${html(each.name)}</div>`).join("");
	const sampleCss =
		kind === "radius"
			? [
					"body{display:flex;flex-wrap:wrap;gap:16px}figure{margin:0;text-align:center;font-family:var(--font-mono);font-size:12px}",
					"figure div{inline-size:48px;block-size:48px;background:var(--neutral-20);border:1px solid var(--neutral-40)}",
					...list.map((each) => `[data-radius="${each.name}"] div{border-radius:var(--radius-${each.name})}`),
				].join("\n")
			: [
					"[data-width]{max-inline-size:100%;margin-block-end:6px;padding:4px 8px;background:var(--primary-20);color:var(--primary-95);font-family:var(--font-mono);font-size:12px}",
					...list.map((each) => `[data-width="${each.name}"]{inline-size:var(--width-${each.name})}`),
				].join("\n");
	return (
		<Section
			group={kind}
			description={kind === "radius" ? t("designSystem.radius.intro") : t("designSystem.widths.intro")}
			action={
				<AddButton
					label={kind === "radius" ? t("designSystem.radius.add") : t("designSystem.widths.add")}
					onClick={() =>
						set([
							...list,
							{
								id: newTokenId(),
								name: freeName(kind === "radius" ? "radius" : "width", list),
								value: kind === "radius" ? { value: 12, unit: "px" } : { value: 60, unit: "rem" },
							},
						])
					}
				/>
			}
		>
			<ul className="grid gap-2">
				{list.map((each) => (
					<li key={each.id} className="grid grid-cols-[minmax(0,1fr)_6rem_5rem_auto_auto] items-center gap-2">
						<NameInput
							label={t("designSystem.tokenName", { name: each.name })}
							value={each.name}
							onChange={(name) => set(list.map((other) => (other.id === each.id ? { ...other, name } : other)))}
						/>
						<NumberInput
							label={t("designSystem.tokenValue", { name: `--${prefix}-${each.name}` })}
							value={each.value.value}
							onChange={(value) =>
								set(
									list.map((other) => (other.id === each.id ? { ...other, value: { ...other.value, value } } : other)),
								)
							}
						/>
						<NativeSelect
							aria-label={t("designSystem.tokenUnit", { name: `--${prefix}-${each.name}` })}
							value={each.value.unit}
							onChange={(event) =>
								set(
									list.map((other) =>
										other.id === each.id
											? { ...other, value: { ...other.value, unit: event.target.value as "px" | "rem" } }
											: other,
									),
								)
							}
						>
							<NativeSelectOption value="px">px</NativeSelectOption>
							<NativeSelectOption value="rem">rem</NativeSelectOption>
						</NativeSelect>
						<Uses count={editing.preview.uses.tokens[each.id]} />
						<RemoveButton
							label={t("designSystem.removeToken", { name: each.name })}
							onClick={() =>
								void removeToken(editing, { ...tokens, [kind]: list.filter((other) => other.id !== each.id) })
							}
						/>
					</li>
				))}
			</ul>
			<StylePreview
				title={t("designSystem.scales.previewTitle", { scale: t(`designSystem.tokens.group.${kind}`) })}
				stylesheet={editing.preview.stylesheet}
				markup={sample}
				extraCss={sampleCss}
				mode={editing.mode}
			/>
		</Section>
	);
}

function NumberInput({ label, value, onChange }: { label: string; value: number; onChange(value: number): void }) {
	const [text, setText] = useState(String(value));
	return (
		<Input
			type="number"
			inputMode="decimal"
			step="any"
			min={0}
			aria-label={label}
			value={text}
			onChange={(event) => {
				setText(event.target.value);
				const next = Number(event.target.value);
				if (event.target.value.trim() !== "" && Number.isFinite(next) && next >= 0) onChange(next);
			}}
			className="text-xs"
		/>
	);
}

function ShadowsCard({ editing }: { editing: Editing }) {
	const t = useT();
	const { tokens } = editing.draft;
	const set = (shadows: Tokens["shadows"]) => editing.setSection("tokens", { ...tokens, shadows });
	const sample = tokens.shadows
		.map(
			(each) =>
				`<figure data-shadow="${html(each.name)}"><div></div><figcaption>${html(each.name)}</figcaption></figure>`,
		)
		.join("");
	const sampleCss = [
		"body{display:flex;flex-wrap:wrap;gap:24px;padding:24px!important}figure{margin:0;text-align:center;font-family:var(--font-mono);font-size:12px}",
		"figure div{inline-size:48px;block-size:48px;border-radius:var(--radius-m);background:var(--neutral-10);margin-block-end:8px}",
		...tokens.shadows.map((each) => `[data-shadow="${each.name}"] div{box-shadow:var(--shadow-${each.name})}`),
	].join("\n");
	return (
		<Section group="shadows" description={t("designSystem.shadows.intro")}>
			<ul className="grid gap-2">
				{tokens.shadows.map((each) => (
					<li key={each.id} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2">
						<NameInput
							label={t("designSystem.tokenName", { name: each.name })}
							value={each.name}
							onChange={(name) =>
								set(tokens.shadows.map((other) => (other.id === each.id ? { ...other, name } : other)))
							}
						/>
						<Uses count={editing.preview.uses.tokens[each.id]} />
						<RemoveButton
							label={t("designSystem.removeToken", { name: each.name })}
							onClick={() =>
								void removeToken(editing, {
									...tokens,
									shadows: tokens.shadows.filter((other) => other.id !== each.id),
								})
							}
						/>
					</li>
				))}
			</ul>
			<StylePreview
				title={t("designSystem.scales.previewTitle", { scale: t("designSystem.tokens.group.shadows") })}
				stylesheet={editing.preview.stylesheet}
				markup={sample}
				extraCss={sampleCss}
				mode={editing.mode}
			/>
		</Section>
	);
}

function BreakpointsCard({ editing }: { editing: Editing }) {
	const t = useT();
	const { tokens } = editing.draft;
	const set = (breakpoints: Tokens["breakpoints"]) => editing.setSection("tokens", { ...tokens, breakpoints });
	return (
		<Section
			group="breakpoints"
			description={t("designSystem.breakpoints.intro")}
			action={
				<AddButton
					label={t("designSystem.breakpoints.add")}
					onClick={() =>
						set([...tokens.breakpoints, { id: newTokenId(), name: freeName("bp", tokens.breakpoints), width: 1920 }])
					}
				/>
			}
		>
			<ul className="grid gap-2">
				{tokens.breakpoints.map((each) => (
					<li key={each.id} className="grid grid-cols-[minmax(0,1fr)_6rem_auto_auto_auto] items-center gap-2">
						<NameInput
							label={t("designSystem.tokenName", { name: each.name })}
							value={each.name}
							onChange={(name) =>
								set(tokens.breakpoints.map((other) => (other.id === each.id ? { ...other, name } : other)))
							}
						/>
						<NumberInput
							label={t("designSystem.breakpoints.width", { name: each.name })}
							value={each.width}
							onChange={(width) =>
								set(tokens.breakpoints.map((other) => (other.id === each.id ? { ...other, width } : other)))
							}
						/>
						<span className="text-muted-foreground text-xs">px</span>
						<Uses count={editing.preview.uses.tokens[each.id]} />
						<RemoveButton
							label={t("designSystem.removeToken", { name: each.name })}
							onClick={() =>
								void removeToken(editing, {
									...tokens,
									breakpoints: tokens.breakpoints.filter((other) => other.id !== each.id),
								})
							}
						/>
					</li>
				))}
			</ul>
		</Section>
	);
}
