/**
 * Design tokens as DTCG files (the Design Tokens Community Group format, 2025.10): groups of tokens,
 * each with a `$value` and a `$type`, so other tools can read a Site's tokens and Staff can bring
 * tokens from elsewhere (spec story 65).
 *
 * The export writes every value as visitors get it: each colour's every shade and transparency,
 * each scale step's size at the smallest viewport (the fluid range is in `$extensions`), fonts,
 * radius, shadows, breakpoints and content widths, and the focus style as aliases. WebCraft's own
 * details (ids, base colours, overrides, dark values, scale ratios) sit in `$extensions.webcraft`,
 * so importing an export gives back exactly the tokens it came from, ids included, and every use of
 * them stays linked.
 *
 * An import reads files from other tools too: plain colour tokens, hex strings, dimensions as
 * `{ value, unit }` or `"16px"`. Each top-level group it holds replaces that kind of token; kinds it
 * leaves out stay as they are. A token keeps its id when the file gives it, else when a token of the
 * same kind has its name.
 */
import {
	BASE_STEP,
	COLOUR_STEPS,
	colourRamp,
	normaliseHex,
	normaliseHexWithAlpha,
	rgbOf,
	SHADE_STEPS,
} from "./colour.ts";
import {
	type Breakpoint,
	type ColourToken,
	type Dimension,
	type DimensionToken,
	type FontToken,
	type Range,
	type Scale,
	type ScaleStep,
	type ShadowLayer,
	type ShadowToken,
	stepRange,
	type Tokens,
} from "./tokens.ts";

/** The key WebCraft's own details sit under in `$extensions`. */
export const DTCG_EXTENSION = "webcraft";

type Json = Record<string, unknown>;

/** The group each kind of token is exported as, and the names an import also accepts. */
const GROUPS = {
	colours: ["color", "colour", "colors", "colours"],
	space: ["space", "spacing"],
	text: ["text", "fontSize", "font-size", "type"],
	fonts: ["font", "fontFamily", "font-family", "fonts"],
	radius: ["radius", "borderRadius", "border-radius", "radii"],
	shadows: ["shadow", "shadows", "boxShadow"],
	breakpoints: ["breakpoint", "breakpoints"],
	widths: ["width", "widths", "contentWidth", "content-width"],
} as const;

// ---------------------------------------------------------------------------------------------
// Export

/** The tokens as a DTCG file. */
export function exportTokens(tokens: Tokens, description?: string): Json {
	const ours = (details: Json) => ({ $extensions: { [DTCG_EXTENSION]: details } });
	const colours: Json = { $type: "color" };
	for (const colour of tokens.colours) {
		const ramp = colourRamp(colour.light.base, "light", colour.light.steps);
		const group: Json = ours({
			id: colour.id,
			base: colour.light.base,
			overrides: colour.light.steps,
			dark: colour.dark,
		});
		for (const step of COLOUR_STEPS) group[step] = { $value: colourValue(ramp[step] ?? "") };
		colours[colour.name] = group;
	}
	const scale = (each: Scale): Json => {
		const group: Json = { $type: "dimension", ...ours({ base: each.base, ratio: each.ratio }) };
		for (const step of each.steps) {
			const size = stepRange(each, step);
			group[step.name] = {
				$value: px(size.min),
				...ours({ id: step.id, exponent: step.exponent, fluid: size, fixed: step.size !== null }),
			};
		}
		return group;
	};
	const dimensions = (list: readonly DimensionToken[]): Json => {
		const group: Json = { $type: "dimension" };
		for (const each of list) group[each.name] = { $value: each.value, ...ours({ id: each.id }) };
		return group;
	};
	const fonts: Json = { $type: "fontFamily" };
	for (const font of tokens.fonts) fonts[font.name] = { $value: font.family, ...ours({ id: font.id }) };
	const shadows: Json = { $type: "shadow" };
	for (const shadow of tokens.shadows) {
		shadows[shadow.name] = {
			$value: shadow.layers.map((layer) => ({
				color: colourValue(layer.color),
				offsetX: px(layer.offsetX),
				offsetY: px(layer.offsetY),
				blur: px(layer.blur),
				spread: px(layer.spread),
				inset: layer.inset,
			})),
			...ours({ id: shadow.id }),
		};
	}
	const breakpoints: Json = { $type: "dimension" };
	for (const each of tokens.breakpoints) breakpoints[each.name] = { $value: px(each.width), ...ours({ id: each.id }) };
	const focusColour = tokens.colours.find((colour) => colour.id === tokens.focus.colour.colour);
	return {
		...(description ? { $description: description } : {}),
		...ours({ version: 1, viewport: tokens.viewport }),
		color: colours,
		space: scale(tokens.space),
		text: scale(tokens.text),
		font: fonts,
		radius: dimensions(tokens.radius),
		shadow: shadows,
		breakpoint: breakpoints,
		width: dimensions(tokens.widths),
		focus: {
			color: { $type: "color", $value: `{color.${focusColour?.name ?? ""}.${tokens.focus.colour.step}}` },
			width: { $type: "dimension", $value: px(tokens.focus.width) },
			offset: { $type: "dimension", $value: px(tokens.focus.offset) },
		},
	};
}

function px(value: number): Dimension {
	return { value, unit: "px" };
}

/** A colour as DTCG 2025.10 writes it, from `#rrggbb` or `#rrggbbaa`. */
function colourValue(hex: string): Json {
	const value: Json = {
		colorSpace: "srgb",
		components: rgbOf(hex).map((channel) => round(channel)),
		hex: hex.slice(0, 7),
	};
	if (hex.length === 9) value.alpha = round(Number.parseInt(hex.slice(7), 16) / 255);
	return value;
}

function round(value: number): number {
	return Math.round(value * 10_000) / 10_000;
}

// ---------------------------------------------------------------------------------------------
// Import

/** One reason a DTCG file can't be imported, and where in it (`color.primary.60`). */
export type DtcgProblem = { at: string; message: string };

/**
 * The tokens a DTCG file holds, in place of `current`'s for each kind it has. Answers every problem
 * found instead when it can't be read; the tokens it gives are checked like any others when saved.
 */
export function importTokens(file: unknown, current: Tokens): { tokens: Tokens } | { problems: DtcgProblem[] } {
	const problems: DtcgProblem[] = [];
	const problem = (at: string, message: string) => problems.push({ at, message });
	if (!isObject(file)) return { problems: [{ at: "", message: "A DTCG file is a JSON object of token groups." }] };
	const tokens: Tokens = structuredClone(current);
	const groupOf = (kind: keyof typeof GROUPS): [string, Json] | undefined => {
		for (const name of GROUPS[kind]) {
			const group = file[name];
			if (group !== undefined) {
				if (isObject(group)) return [name, group];
				problem(name, "A group of tokens is a JSON object.");
				return undefined;
			}
		}
		return undefined;
	};
	const root = extensionOf(file);
	if (root && isRange(root.viewport)) tokens.viewport = root.viewport;

	const colours = groupOf("colours");
	if (colours) tokens.colours = readColours(colours[0], colours[1], current.colours, problem);
	for (const kind of ["space", "text"] as const) {
		const group = groupOf(kind);
		if (group) tokens[kind] = readScale(group[0], group[1], current[kind], problem);
	}
	const fonts = groupOf("fonts");
	if (fonts) {
		tokens.fonts = entriesOf(fonts[1]).map(([name, token]): FontToken => {
			const value = token.$value;
			const family = typeof value === "string" ? value.split(",").map((each) => unquote(each.trim())) : value;
			if (!Array.isArray(family) || !family.every((each) => typeof each === "string")) {
				problem(`${fonts[0]}.${name}`, "A font family is a name or a list of names.");
			}
			return { id: idFor(token, name, current.fonts), name, family: Array.isArray(family) ? (family as string[]) : [] };
		});
	}
	for (const kind of ["radius", "widths"] as const) {
		const group = groupOf(kind);
		if (!group) continue;
		tokens[kind] = entriesOf(group[1]).map(([name, token]): DimensionToken => {
			const value = dimensionOf(token.$value);
			if (!value) problem(`${group[0]}.${name}`, 'Give a dimension, such as { "value": 8, "unit": "px" }.');
			return { id: idFor(token, name, current[kind]), name, value: value ?? px(0) };
		});
	}
	const breakpoints = groupOf("breakpoints");
	if (breakpoints) {
		tokens.breakpoints = entriesOf(breakpoints[1]).map(([name, token]): Breakpoint => {
			const value = dimensionOf(token.$value);
			if (!value) problem(`${breakpoints[0]}.${name}`, 'Give a width, such as { "value": 768, "unit": "px" }.');
			return { id: idFor(token, name, current.breakpoints), name, width: value ? pixels(value) : 0 };
		});
	}
	const shadows = groupOf("shadows");
	if (shadows) {
		tokens.shadows = entriesOf(shadows[1]).map(([name, token]): ShadowToken => {
			const at = `${shadows[0]}.${name}`;
			const value = token.$value;
			const layers = (Array.isArray(value) ? value : [value]).map((layer, index) =>
				readShadowLayer(layer, `${at}[${index}]`, problem),
			);
			return { id: idFor(token, name, current.shadows), name, layers };
		});
	}
	const focus = file.focus;
	if (isObject(focus)) readFocus(focus, tokens, problem);
	return problems.length > 0 ? { problems } : { tokens };
}

function readColours(
	groupName: string,
	group: Json,
	current: readonly ColourToken[],
	problem: (at: string, message: string) => void,
): ColourToken[] {
	return entriesOf(group).map(([name, token]): ColourToken => {
		const at = `${groupName}.${name}`;
		const ours = extensionOf(token);
		// A plain colour token is the base colour; a group holds steps, its base at 60.
		const base =
			hexOf(ours?.base) ??
			hexOf(token.$value) ??
			(isObject(token[BASE_STEP]) ? hexOf((token[BASE_STEP] as Json).$value) : undefined);
		if (!base) {
			problem(at, `Give the colour as a $value, or its shades with the base colour at ${BASE_STEP}.`);
			return {
				id: idFor(token, name, current),
				name,
				light: { base: "#000000", steps: {} },
				dark: { base: null, steps: {} },
			};
		}
		let overrides: Record<string, string> = {};
		if (isObject(ours?.overrides)) {
			for (const [step, value] of Object.entries(ours.overrides)) {
				const hex = hexOf(value);
				if (hex) overrides[step] = hex;
				else problem(`${at}.$extensions.${DTCG_EXTENSION}.overrides.${step}`, "Give a colour as #rrggbb.");
			}
		} else {
			// Steps written in the file that differ from the ones WebCraft makes are overrides.
			const ramp = colourRamp(base, "light");
			overrides = {};
			for (const step of SHADE_STEPS) {
				if (step === BASE_STEP || !isObject(token[step])) continue;
				const hex = hexOf((token[step] as Json).$value);
				if (!hex) problem(`${at}.${step}`, "Give a colour as #rrggbb or a DTCG colour.");
				else if (hex !== ramp[step]) overrides[step] = hex;
			}
		}
		const dark = isObject(ours?.dark) ? ours.dark : {};
		const darkBase = dark.base === null || dark.base === undefined ? null : (hexOf(dark.base) ?? null);
		const darkSteps: Record<string, string> = {};
		if (isObject(dark.steps)) {
			for (const [step, value] of Object.entries(dark.steps)) {
				const hex = hexOf(value);
				if (hex) darkSteps[step] = hex;
			}
		}
		return {
			id: idFor(token, name, current),
			name,
			light: { base, steps: overrides },
			dark: { base: darkBase, steps: darkSteps },
		};
	});
}

function readScale(
	groupName: string,
	group: Json,
	current: Scale,
	problem: (at: string, message: string) => void,
): Scale {
	const ours = extensionOf(group);
	const base = isRange(ours?.base) ? ours.base : current.base;
	const ratio = isRange(ours?.ratio) ? ours.ratio : current.ratio;
	const steps = entriesOf(group).map(([name, token]): ScaleStep => {
		const at = `${groupName}.${name}`;
		const details = extensionOf(token);
		const id = idFor(token, name, current.steps);
		if (details && typeof details.exponent === "number") {
			const fluid = isRange(details.fluid) ? details.fluid : undefined;
			return { id, name, exponent: details.exponent, size: details.fixed === true && fluid ? fluid : null };
		}
		const value = dimensionOf(token.$value);
		if (!value) problem(at, 'Give a dimension, such as { "value": 16, "unit": "px" }.');
		const size = value ? pixels(value) : 16;
		// A size from another tool is the step's own, at every viewport.
		return { id, name, exponent: 0, size: { min: size, max: size } };
	});
	return { base, ratio, steps };
}

function readShadowLayer(layer: unknown, at: string, problem: (at: string, message: string) => void): ShadowLayer {
	if (!isObject(layer)) {
		problem(at, "A shadow is an object with color, offsetX, offsetY, blur and spread.");
		return { offsetX: 0, offsetY: 0, blur: 0, spread: 0, color: "#000000ff", inset: false };
	}
	const length = (key: string) => {
		const value = dimensionOf(layer[key] ?? px(0));
		if (!value) problem(`${at}.${key}`, "Give a dimension in px.");
		return value ? pixels(value) : 0;
	};
	const color = colourWithAlphaOf(layer.color);
	if (!color) problem(`${at}.color`, "Give a colour.");
	return {
		offsetX: length("offsetX"),
		offsetY: length("offsetY"),
		blur: length("blur"),
		spread: length("spread"),
		color: color ?? "#000000ff",
		inset: layer.inset === true,
	};
}

function readFocus(focus: Json, tokens: Tokens, problem: (at: string, message: string) => void): void {
	const colour = isObject(focus.color) ? focus.color.$value : undefined;
	if (typeof colour === "string") {
		const alias = /^\{(?:color|colour|colors|colours)\.([^.{}]+)\.([^.{}]+)\}$/.exec(colour);
		const found = alias && tokens.colours.find((each) => each.name === alias[1]);
		if (alias && found) tokens.focus.colour = { colour: found.id, step: alias[2] ?? "" };
		else problem("focus.color", "The focus colour is an alias of a colour's shade, such as {color.primary.70}.");
	}
	for (const key of ["width", "offset"] as const) {
		const token = focus[key];
		if (!isObject(token)) continue;
		const value = dimensionOf(token.$value);
		if (value) tokens.focus[key] = pixels(value);
		else problem(`focus.${key}`, "Give a dimension in px.");
	}
}

/** A group's tokens and subgroups, by name: everything but its `$` properties. */
function entriesOf(group: Json): [string, Json][] {
	return Object.entries(group).filter(
		(entry): entry is [string, Json] => !entry[0].startsWith("$") && isObject(entry[1]),
	);
}

/** The id a token keeps: the one the file gives, else the id of a token of the same kind with its name, else a new one. */
function idFor(token: Json, name: string, current: readonly { id: string; name: string }[]): string {
	const given = extensionOf(token)?.id;
	if (typeof given === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(given)) return given;
	return current.find((each) => each.name === name)?.id ?? crypto.randomUUID();
}

function extensionOf(token: unknown): Json | undefined {
	if (!isObject(token) || !isObject(token.$extensions)) return undefined;
	const ours = token.$extensions[DTCG_EXTENSION];
	return isObject(ours) ? ours : undefined;
}

/** A dimension: DTCG's `{ value, unit }`, or the older `"16px"` / `"1rem"`. */
function dimensionOf(value: unknown): Dimension | undefined {
	if (isObject(value) && typeof value.value === "number" && (value.unit === "px" || value.unit === "rem")) {
		return { value: value.value, unit: value.unit };
	}
	if (typeof value === "string") {
		const match = /^(-?\d+(?:\.\d+)?)(px|rem)$/.exec(value.trim());
		if (match) return { value: Number(match[1]), unit: match[2] as "px" | "rem" };
	}
	if (value === 0) return px(0);
	return undefined;
}

function pixels(dimension: Dimension): number {
	return dimension.unit === "rem" ? dimension.value * 16 : dimension.value;
}

/** An opaque colour as `#rrggbb`: a hex string, or a DTCG colour object in sRGB. */
function hexOf(value: unknown): string | undefined {
	const withAlpha = colourWithAlphaOf(value);
	return withAlpha?.endsWith("ff") ? withAlpha.slice(0, 7) : undefined;
}

/** A colour as `#rrggbbaa`. */
function colourWithAlphaOf(value: unknown): string | undefined {
	if (typeof value === "string") return normaliseHexWithAlpha(value.trim()) ?? normaliseHex(value.trim());
	if (!isObject(value)) return undefined;
	const alpha = typeof value.alpha === "number" ? value.alpha : 1;
	const alphaHex = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
		.toString(16)
		.padStart(2, "0");
	if (typeof value.hex === "string") {
		const hex = normaliseHex(value.hex.trim());
		if (hex) return `${hex}${alphaHex}`;
	}
	const components = value.components;
	if (
		(value.colorSpace === "srgb" || value.colorSpace === undefined) &&
		Array.isArray(components) &&
		components.length === 3 &&
		components.every((each) => typeof each === "number")
	) {
		const hex = components
			.map((channel: number) =>
				Math.round(Math.min(1, Math.max(0, channel)) * 255)
					.toString(16)
					.padStart(2, "0"),
			)
			.join("");
		return `#${hex}${alphaHex}`;
	}
	return undefined;
}

function isRange(value: unknown): value is Range {
	return isObject(value) && typeof value.min === "number" && typeof value.max === "number";
}

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unquote(name: string): string {
	return name.replace(/^(["'])(.*)\1$/, "$2");
}
