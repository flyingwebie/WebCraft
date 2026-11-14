/**
 * Where each Goal is used, as Staff see it on the Goals screen ("Where it is used"): the Widgets that
 * name it (their Goal filter, a Goal Widget's Goal, a Goals Widget's chosen Goals) on the Site's
 * Dashboards, its Workspace's Dashboards and its Workspace's Dashboard templates, and the Funnels with
 * it as a step. Widgets name Goals by their names (upper and lower case alike), Funnels by their ids.
 * A Goals Widget that chose none shows every Goal and names none of them.
 */
import type { ModuleContext, PlacedWidget } from "@webcraft/module-sdk";

import { listFunnels } from "./funnels.ts";
import { listGoals } from "./goals.ts";

/** A Widget naming a Goal, where it is. */
export type GoalWidgetUse = {
	widgetId: string;
	/** Its title, or null for its kind's own. */
	title: string | null;
	/** Its kind (`goal`, `trend`…). */
	kind: string;
	on: PlacedWidget["on"];
};

/** Where one Goal is used. */
export type GoalUsage = {
	goalId: string;
	/** On the Site's Dashboards and its Workspace's Dashboards. */
	widgets: GoalWidgetUse[];
	/** In its Workspace's Dashboard templates. */
	templates: GoalWidgetUse[];
	funnels: { id: string; name: string }[];
};

/** The Goal names a Widget names, in lower case. */
function namedGoals(widget: PlacedWidget): Set<string> {
	const names = new Set<string>();
	if (widget.filters.goal) names.add(widget.filters.goal.toLowerCase());
	const add = (value: string | readonly string[] | undefined) => {
		for (const name of typeof value === "string" ? [value] : (value ?? [])) names.add(name.toLowerCase());
	};
	if (widget.kind === "goal") add(widget.settings.goal);
	if (widget.kind === "goals") add(widget.settings.goals);
	return names;
}

/** Where each of the Site's Goals is used, in the order `listGoals` answers them. */
export async function goalUsage(context: ModuleContext): Promise<GoalUsage[]> {
	const [goals, funnels, placed] = await Promise.all([
		listGoals(context),
		listFunnels(context),
		context.widgets.placed(),
	]);
	const named = placed.map((widget) => ({ widget, names: namedGoals(widget) }));
	return goals.map((goal) => {
		const uses = named
			.filter(({ names }) => names.has(goal.name.toLowerCase()))
			.map(({ widget }) => ({ widgetId: widget.id, title: widget.title, kind: widget.kind, on: widget.on }));
		return {
			goalId: goal.id,
			widgets: uses.filter((use) => use.on.kind !== "template"),
			templates: uses.filter((use) => use.on.kind === "template"),
			funnels: funnels
				.filter((funnel) => funnel.steps.some((step) => step.kind === "goal" && step.goalId === goal.id))
				.map((funnel) => ({ id: funnel.id, name: funnel.name })),
		};
	});
}
