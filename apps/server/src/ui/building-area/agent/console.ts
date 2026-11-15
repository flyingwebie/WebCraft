import type { AgentHost, ConsoleEntry } from "./contract.ts";

/**
 * The page's console, for the JS pane (BA-11, SPEC 5): set up by the page agent before any Site script
 * runs, so it sees everything the page's scripts report.
 *
 * - `console.log`, `info`, `warn` and `error` still write to the browser's console, and each call is
 *   handed to the shell as text as well;
 * - an uncaught exception comes with the script and line it was thrown from;
 * - a promise rejected with nothing to catch it, and a script that didn't load, are errors too.
 *
 * Only text reaches the shell, which shows it as text: nothing the page writes is ever markup there.
 * Part of the agent's own bundle: nothing is imported at run time.
 */

/** How long one line may be: a page that logs a huge value doesn't flood the shell. */
const LINE_MAX = 2000;

const LEVELS = ["log", "info", "warn", "error"] as const;

export function pageConsole(
	win: Window & typeof globalThis,
	host: AgentHost,
	listen: typeof EventTarget.prototype.addEventListener,
): void {
	const stringify = win.JSON.stringify;
	const ErrorType = win.Error;
	const StringType = win.String;

	const textOf = (value: unknown): string => {
		if (typeof value === "string") return value;
		if (value instanceof ErrorType) return `${value.name}: ${value.message}`;
		try {
			const written = stringify(value);
			return typeof written === "string" ? written : StringType(value);
		} catch {
			return StringType(value);
		}
	};
	const tell = (entry: ConsoleEntry) => {
		try {
			host.log({ ...entry, text: entry.text.slice(0, LINE_MAX) });
		} catch {
			// The shell went away (the frame is being unloaded): nothing to tell.
		}
	};

	const native = win.console;
	for (const level of LEVELS) {
		const original = native[level];
		if (typeof original !== "function") continue;
		native[level] = function (this: unknown, ...values: unknown[]) {
			original.apply(this ?? native, values);
			tell({ level, text: values.map(textOf).join(" "), source: null, line: null });
		};
	}

	listen.call(
		win,
		"error",
		(event: Event) => {
			if (event instanceof win.ErrorEvent) {
				tell({
					level: "error",
					text: event.message || textOf(event.error),
					source: event.filename || null,
					line: event.lineno || null,
				});
			} else if (event.target instanceof win.HTMLScriptElement) {
				// A script that didn't load (its file is missing or refused).
				tell({ level: "error", text: "", source: event.target.src || null, line: null });
			}
		},
		{ capture: true },
	);
	listen.call(win, "unhandledrejection", (event: Event) => {
		const reason = (event as PromiseRejectionEvent).reason;
		tell({ level: "error", text: textOf(reason), source: null, line: null });
	});
}
