import { ORPCError } from "@orpc/server";
import {
	type DashboardPlace,
	dashboardRangeSchema,
	GRID_COLUMNS,
	WIDGET_ROWS,
	WIDGET_SIZE,
	widgetFiltersSchema,
	widgetSettingsSchema,
} from "@webcraft/core";
import { z } from "zod";

import { signedIn } from "../context.ts";
import { id } from "../inputs.ts";
import { languageOf } from "./modules.ts";

/**
 * Where a Dashboard is: a Site (`siteId`), or a Workspace (`workspaceId`) for a Workspace Dashboard,
 * whose Widgets add up the Workspace's Sites the caller sees. Exactly one of the two.
 */
export const place = { siteId: id.optional(), workspaceId: id.optional() };

export function placeOf(input: { siteId?: string; workspaceId?: string }): DashboardPlace {
	if (input.siteId !== undefined && input.workspaceId === undefined) return { siteId: input.siteId };
	if (input.workspaceId !== undefined && input.siteId === undefined) return { workspaceId: input.workspaceId };
	throw new ORPCError("BAD_REQUEST", {
		status: 400,
		message: "Name the Dashboard's Site (siteId) or its Workspace (workspaceId), not both.",
	});
}

const name = z.string().trim().min(1).max(100);

/** A Widget's own words, settings and range: what adding or changing one gives. */
const widgetFields = {
	/** Its own title; empty or null for the kind's name. */
	title: z.string().trim().max(100).nullable().optional(),
	/** Its own range, or null to show the Dashboard's. */
	range: dashboardRangeSchema.nullable().optional(),
	filters: widgetFiltersSchema.optional(),
	settings: widgetSettingsSchema.optional(),
	/** How many rows a table shows. */
	rows: z
		.number()
		.int()
		.refine(
			(rows) => (WIDGET_ROWS as readonly number[]).includes(rows),
			`A table shows ${WIDGET_ROWS.join(", ")} rows.`,
		)
		.optional(),
};

/** A Widget's place and size on the grid (columns and rows of cells). */
const rect = {
	x: z
		.number()
		.int()
		.min(0)
		.max(GRID_COLUMNS - 1),
	y: z.number().int().min(0).max(1000),
	w: z.number().int().min(WIDGET_SIZE.min).max(WIDGET_SIZE.maxWidth),
	h: z.number().int().min(WIDGET_SIZE.min).max(WIDGET_SIZE.maxHeight),
};

/** A range to explore with, in place of the Dashboard's, for the Widgets that show the Dashboard's. */
const exploring = { range: dashboardRangeSchema.optional() };

/**
 * Dashboards (spec story 131, #103): a Site's, and Workspace Dashboards adding up their Sites, made of
 * Widgets from the catalog Modules add (and WebCraft's note), each with its own range and filters.
 * Staff build them (`dashboard.manage`); Staff and Owners see them all (`dashboard.view`); Editors and
 * Authors see those Staff show to everyone, and only those. Data are worked out when asked, one
 * Widget at a time, so a slow Widget never holds up the rest.
 */
export const dashboards = {
	/** The Widget kinds that can be added here, with their filters and settings, and whether each one's Module runs here. */
	catalog: signedIn.input(z.object({ ...place })).handler(async ({ context, input }) => ({
		kinds: await context.services.dashboards.catalog(
			context.access,
			placeOf(input),
			await languageOf(context.services, context.person),
		),
	})),

	/**
	 * What a Widget kind's setting offers here, such as the Site's Goals (`filter:goal`: the Goals a
	 * Widget can be narrowed to). A Workspace Dashboard's add up its Sites', each value once.
	 */
	options: signedIn
		.input(z.object({ ...place, kind: z.string().max(200), setting: z.string().max(40) }))
		.handler(async ({ context, input }) => ({
			options: await context.services.dashboards.options(
				context.access,
				placeOf(input),
				input.kind,
				input.setting,
				await languageOf(context.services, context.person),
			),
		})),

	/** The Dashboards here the caller sees, by name. */
	list: signedIn.input(z.object({ ...place })).handler(async ({ context, input }) => ({
		dashboards: await context.services.dashboards.list(context.access, placeOf(input)),
	})),

	/** One Dashboard, with its Widgets (kind, place, size, range, filters and settings), without their data. */
	get: signedIn.input(z.object({ ...place, dashboardId: id })).handler(async ({ context, input }) => ({
		dashboard: await context.services.dashboards.get(
			context.access,
			placeOf(input),
			input.dashboardId,
			await languageOf(context.services, context.person),
		),
	})),

	/**
	 * A new Dashboard, empty or from a Dashboard template (of any Workspace where the caller builds
	 * Dashboards). Its Widgets name Goals and Funnels by name: `unmatched` lists those this place
	 * doesn't have, whose Widgets say so until they are added.
	 */
	create: signedIn
		.input(z.object({ ...place, name, template: z.object({ workspaceId: id, templateId: id }).optional() }))
		.handler(
			async ({ context, input }) =>
				await context.services.dashboards.create(
					context.access,
					placeOf(input),
					{ name: input.name, template: input.template },
					await languageOf(context.services, context.person),
				),
		),

	/** Renames a Dashboard, changes its range, or whether everyone who works here sees it. */
	update: signedIn
		.input(
			z.object({
				...place,
				dashboardId: id,
				name: name.optional(),
				range: dashboardRangeSchema.optional(),
				sharedWithEveryone: z.boolean().optional(),
			}),
		)
		.handler(async ({ context, input }) => ({
			dashboard: await context.services.dashboards.update(
				context.access,
				placeOf(input),
				input.dashboardId,
				{ name: input.name, range: input.range, sharedWithEveryone: input.sharedWithEveryone },
				await languageOf(context.services, context.person),
			),
		})),

	/** Deletes a Dashboard. Its data stay where Site analytics keeps them. */
	delete: signedIn.input(z.object({ ...place, dashboardId: id })).handler(async ({ context, input }) => {
		await context.services.dashboards.delete(context.access, placeOf(input), input.dashboardId);
		return { deleted: true as const };
	}),

	/** Keeps a Dashboard's Widgets and range as a Dashboard template in its Workspace. */
	saveAsTemplate: signedIn.input(z.object({ ...place, dashboardId: id, name })).handler(async ({ context, input }) => ({
		template: await context.services.dashboards.saveAsTemplate(
			context.access,
			placeOf(input),
			input.dashboardId,
			input.name,
		),
	})),

	/**
	 * Every Widget of a Dashboard as one CSV file (UTF-8 with a BOM, formulas made text), each Widget
	 * headed by its title and range. Recorded in the Audit log.
	 */
	export: signedIn.input(z.object({ ...place, dashboardId: id, ...exploring })).handler(
		async ({ context, input }) =>
			await context.services.dashboards.export(context.access, placeOf(input), input.dashboardId, {
				range: input.range,
				language: await languageOf(context.services, context.person),
			}),
	),

	widgets: {
		/**
		 * Adds a Widget of a kind from the catalog, at the first free place unless `x` and `y` are
		 * given, at its kind's size unless `w` and `h` are; Widgets it would cover move down.
		 */
		add: signedIn
			.input(
				z.object({
					...place,
					dashboardId: id,
					kind: z.string().max(200),
					...widgetFields,
					x: rect.x.optional(),
					y: rect.y.optional(),
					w: rect.w.optional(),
					h: rect.h.optional(),
				}),
			)
			.handler(async ({ context, input }) => {
				const { x, y, w, h, kind, title, range, filters, settings, rows } = input;
				return await context.services.dashboards.addWidget(
					context.access,
					placeOf(input),
					input.dashboardId,
					{ kind, title, range, filters, settings, rows, at: { x, y, w, h } },
					await languageOf(context.services, context.person),
				);
			}),

		/** Changes a Widget's title, range, filters, settings or rows. */
		update: signedIn
			.input(z.object({ ...place, dashboardId: id, widgetId: id, ...widgetFields }))
			.handler(async ({ context, input }) => {
				const { title, range, filters, settings, rows } = input;
				return {
					dashboard: await context.services.dashboards.updateWidget(
						context.access,
						placeOf(input),
						input.dashboardId,
						input.widgetId,
						{ title, range, filters, settings, rows },
						await languageOf(context.services, context.person),
					),
				};
			}),

		/** Moves and resizes a Widget; the Widgets it would cover move down below it, nothing else moves. */
		move: signedIn
			.input(z.object({ ...place, dashboardId: id, widgetId: id, ...rect }))
			.handler(async ({ context, input }) => ({
				dashboard: await context.services.dashboards.moveWidget(
					context.access,
					placeOf(input),
					input.dashboardId,
					input.widgetId,
					{ x: input.x, y: input.y, w: input.w, h: input.h },
					await languageOf(context.services, context.person),
				),
			})),

		/** Takes a Widget off its Dashboard. */
		remove: signedIn
			.input(z.object({ ...place, dashboardId: id, widgetId: id }))
			.handler(async ({ context, input }) => ({
				dashboard: await context.services.dashboards.removeWidget(
					context.access,
					placeOf(input),
					input.dashboardId,
					input.widgetId,
					await languageOf(context.services, context.person),
				),
			})),

		/**
		 * What a Widget shows now: counts (a rate as two counts) for its own range, else `range` when
		 * given, else the Dashboard's; or the `problem` that keeps it from counting (no such Goal here,
		 * its Module off). A Workspace Dashboard's add up the Sites the caller sees (`sites`).
		 */
		data: signedIn
			.input(z.object({ ...place, dashboardId: id, widgetId: id, ...exploring }))
			.handler(async ({ context, input }) => ({
				widget: await context.services.dashboards.widgetData(
					context.access,
					placeOf(input),
					input.dashboardId,
					input.widgetId,
					{ range: input.range, language: await languageOf(context.services, context.person) },
				),
			})),

		/** One Widget as a CSV file (UTF-8 with a BOM, formulas made text). Recorded in the Audit log. */
		export: signedIn
			.input(z.object({ ...place, dashboardId: id, widgetId: id, ...exploring }))
			.handler(
				async ({ context, input }) =>
					await context.services.dashboards.exportWidget(
						context.access,
						placeOf(input),
						input.dashboardId,
						input.widgetId,
						{ range: input.range, language: await languageOf(context.services, context.person) },
					),
			),
	},
};

/** Dashboard templates: a Dashboard's Widgets and range, kept in its Workspace to start other Dashboards from. */
export const dashboardTemplates = {
	/** The templates of every Workspace where the caller builds Dashboards (an API token's: its own). */
	list: signedIn.handler(async ({ context }) => ({
		templates: await context.services.dashboards.templates(context.access),
	})),

	/** Deletes a template. Dashboards made from it stay as they are. */
	delete: signedIn.input(z.object({ workspaceId: id, templateId: id })).handler(async ({ context, input }) => {
		await context.services.dashboards.deleteTemplate(context.access, input.workspaceId, input.templateId);
		return { deleted: true as const };
	}),
};
