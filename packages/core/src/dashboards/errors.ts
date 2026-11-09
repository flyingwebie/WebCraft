/** No such Dashboard here, or one the person isn't shown. */
export class DashboardNotFoundError extends Error {
	override name = "DashboardNotFoundError";
	constructor() {
		super("There is no such Dashboard here.");
	}
}

/** No such Widget on the Dashboard. */
export class WidgetNotFoundError extends Error {
	override name = "WidgetNotFoundError";
	constructor() {
		super("There is no such Widget on this Dashboard.");
	}
}

/** No such Dashboard template in a Workspace where the person builds Dashboards. */
export class DashboardTemplateNotFoundError extends Error {
	override name = "DashboardTemplateNotFoundError";
	constructor() {
		super("There is no such Dashboard template.");
	}
}

/**
 * What a Dashboard or Widget can't be: `kind` (no such Widget kind), `filter` (one the kind doesn't
 * take), `setting` (one it doesn't have, or a value it doesn't offer), `range`, `widgets` (too many on
 * one Dashboard), `dashboards` (too many in one place), `templates` (too many in one Workspace).
 */
export type DashboardProblem = "kind" | "filter" | "setting" | "range" | "widgets" | "dashboards" | "templates";

export class DashboardInvalidError extends Error {
	override name = "DashboardInvalidError";
	readonly problem: DashboardProblem;
	constructor(problem: DashboardProblem, message: string) {
		super(message);
		this.problem = problem;
	}
}
