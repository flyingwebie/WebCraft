import { ClassNotFoundError, publishPermission } from "@webcraft/core";
import { CSS_MAX_LENGTH, DESIGN_SYSTEM_LIMITS } from "@webcraft/renderer";
import { z } from "zod";

import { confirmationInput, confirmedForApiClients, confirmedPublish } from "../confirm.ts";
import { signedIn } from "../context.ts";
import { id } from "../inputs.ts";

/** The id of a token or a Class. */
const designId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const name = z.string().max(200);
const colourValue = z.string().max(16);
const range = z.object({ min: z.number(), max: z.number() });
const steps = z.record(z.string().max(8), colourValue);
const dimension = z.object({ value: z.number(), unit: z.enum(["px", "rem"]) });
const many = <T extends z.ZodType>(item: T) => z.array(item).max(200);

const scale = z.object({
	base: range,
	ratio: range,
	steps: many(z.object({ id: designId.optional(), name, exponent: z.number(), size: range.nullable().default(null) })),
});

/** Design tokens as data: a token without an id is new; one with an id keeps it (and every use of it). */
const tokens = z.object({
	viewport: range,
	colours: many(
		z.object({
			id: designId.optional(),
			name,
			light: z.object({ base: colourValue, steps: steps.default({}) }),
			dark: z.object({ base: colourValue.nullable(), steps: steps.default({}) }).default({ base: null, steps: {} }),
		}),
	),
	space: scale,
	text: scale,
	fonts: many(z.object({ id: designId.optional(), name, family: z.array(z.string().max(200)).max(20) })),
	radius: many(z.object({ id: designId.optional(), name, value: dimension })),
	shadows: many(
		z.object({
			id: designId.optional(),
			name,
			layers: z
				.array(
					z.object({
						offsetX: z.number(),
						offsetY: z.number(),
						blur: z.number(),
						spread: z.number(),
						color: colourValue,
						inset: z.boolean().default(false),
					}),
				)
				.max(20),
		}),
	),
	breakpoints: many(z.object({ id: designId.optional(), name, width: z.number() })),
	widths: many(z.object({ id: designId.optional(), name, value: dimension })),
	focus: z.object({
		colour: z.object({ colour: designId, step: z.string().max(8) }),
		width: z.number(),
		offset: z.number(),
	}),
});

/** CSS as Staff write it, with tokens and Classes by name. */
const css = z.string().max(CSS_MAX_LENGTH);

const classFields = {
	name,
	/** Declarations for every width. */
	styles: css.optional(),
	/** Declarations from a breakpoint's width up, by the breakpoint token's id. */
	breakpoints: z.record(designId, css).optional(),
	/** The Class's own custom CSS: declarations and rules nested with `&`. */
	css: css.optional(),
};

/** A change to the Draft: each section given replaces that section. */
const draftChange = z.object({
	siteId: id,
	tokens: tokens.optional(),
	classes: z
		.array(z.object({ id: designId.optional(), ...classFields }))
		.max(DESIGN_SYSTEM_LIMITS.classes + 1)
		.optional(),
	baseStyles: z.record(z.string().max(100), css).optional(),
	customCss: css.optional(),
	darkMode: z.boolean().optional(),
});

/**
 * The Design system (ADR 0009): each Site's Design tokens, Classes, base styles, custom CSS and dark
 * mode, with a Draft and a published version. Structure: only Staff read and change it.
 */
export const designSystem = {
	/** The Design system's Draft and published version (null until the first publish). */
	get: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return { designSystem: await context.services.designSystem.get(site) };
	}),

	/**
	 * Saves a change to the Draft: each section given replaces that section (`classes` is every
	 * Class, in order; one left out is deleted), and sections left out stay as they are. Refused with
	 * every problem and where (`DESIGN_SYSTEM_INVALID`), or when it removes a Class or token something
	 * uses (`CLASS_IN_USE`, `TOKEN_IN_USE`, with where).
	 */
	saveDraft: signedIn.input(draftChange).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		const { siteId: _, ...change } = input;
		return { designSystem: await context.services.designSystem.saveDraft(site, change) };
	}),

	/**
	 * The Draft with a change not saved yet, as the Design system screen shows it: its compiled
	 * stylesheet (every Class, and the dark values whether Dark mode is on or not), each colour's
	 * ramp in light and dark with the generated values beneath overrides, each scale step's sizes,
	 * how many places use each Class and token, and the contrast Check. Saves nothing; refused as
	 * saving the change would be (`DESIGN_SYSTEM_INVALID`).
	 */
	preview: signedIn.input(draftChange).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		const { siteId: _, ...change } = input;
		return { preview: await context.services.designSystem.preview(site, change) };
	}),

	/** Adds a Class to the Draft. Its name is unique on the Site and never starts with `wc-`. */
	createClass: signedIn.input(z.object({ siteId: id, ...classFields })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		const { siteId: _, ...change } = input;
		return context.services.designSystem.createClass(site, change);
	}),

	/**
	 * Renames or restyles a Class of the Draft. Elements and CSS refer to it by id, so they follow a
	 * new name; published pages show it once the Design system is published.
	 */
	updateClass: signedIn
		.input(z.object({ siteId: id, classId: designId, ...classFields, name: name.optional() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			const { siteId: _, classId, ...change } = input;
			return context.services.designSystem.updateClass(site, classId, change);
		}),

	/** Deletes a Class from the Draft; refused while an element or CSS uses it (`CLASS_IN_USE`, with where). */
	deleteClass: signedIn
		.input(z.object({ siteId: id, classId: designId, confirmation: confirmationInput }))
		.use(
			confirmedForApiClients({
				action: "class.delete",
				permission: () => "structure.edit",
				describe: async (site, input, services) => {
					const { draft } = await services.designSystem.get(site);
					const found = draft.classes.find((each) => each.id === input.classId);
					if (!found) throw new ClassNotFoundError();
					return { target: found.id, preview: { class: { id: found.id, name: found.name } } };
				},
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return { designSystem: await context.services.designSystem.deleteClass(site, input.classId) };
		}),

	/**
	 * The Design tokens as a DTCG file (2025.10): the Draft's, or the published ones. WebCraft's own
	 * details sit in `$extensions.webcraft`, so importing the file gives back the same tokens.
	 */
	exportTokens: signedIn
		.input(z.object({ siteId: id, version: z.enum(["draft", "published"]).default("draft") }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return { tokens: await context.services.designSystem.exportTokens(site, input.version) };
		}),

	/**
	 * Imports a DTCG file into the Draft: each kind of token it holds (colours, spacing, type, fonts,
	 * radius, shadows, breakpoints, content widths) replaces the Draft's; kinds it leaves out stay.
	 * Tokens keep their ids by the file's `$extensions.webcraft.id`, else by name.
	 */
	importTokens: signedIn
		.input(z.object({ siteId: id, tokens: z.record(z.string(), z.unknown()) }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return { designSystem: await context.services.designSystem.importTokens(site, input.tokens) };
		}),

	/**
	 * The whole Design system as one file (format `webcraft-design-system`, version 1): Dark mode, the
	 * Design tokens as DTCG, every Class with its CSS (breakpoint styles by the breakpoint's name), the
	 * base styles and the custom CSS. The Draft's, or the published one. Logged as `designSystem.export`.
	 */
	exportFile: signedIn
		.input(z.object({ siteId: id, version: z.enum(["draft", "published"]).default("draft") }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return { file: await context.services.designSystem.exportFile(site, input.version) };
		}),

	/**
	 * Imports a Design system file over the Draft (never the published version), in two steps for
	 * everyone: the first call changes nothing and answers what would change (`preview.changes`: each
	 * kind of token, the Classes, base styles, custom CSS and Dark mode) and a `confirmation`; the
	 * second, with the same file and that confirmation (5 minutes, once, while the file and the Draft
	 * are unchanged), replaces the Draft. Tokens and Classes keep their ids by name. Refused: a file
	 * this version can't read (`DESIGN_SYSTEM_FILE_INVALID`, `data.problems` each `{ at, message }`),
	 * CSS or tokens that can't be saved (`DESIGN_SYSTEM_INVALID`), leaving out a Class or token
	 * something uses (`CLASS_IN_USE`, `TOKEN_IN_USE`) and a stale confirmation (`CONFIRMATION_INVALID`).
	 * Logged as `designSystem.import`.
	 */
	importFile: signedIn
		.input(z.object({ siteId: id, file: z.record(z.string(), z.unknown()), confirmation: confirmationInput }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return await context.services.designSystem.importFile(site, input.file, input.confirmation);
		}),

	/**
	 * Publishes the Draft as one item: every page's stylesheet changes at once, and the Site's page
	 * cache is cleared.
	 */
	publish: signedIn
		.input(z.object({ siteId: id, confirmation: confirmationInput }))
		.use(confirmedPublish(() => ({ kind: "designSystem" })))
		.handler(async ({ context, input }) => {
			const item = { kind: "designSystem" } as const;
			const site = await context.services.data.site(context.access, input.siteId, publishPermission(item));
			return { published: await context.services.publishing.publish(site, item) };
		}),
};
