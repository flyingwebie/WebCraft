import type { AgentHost, ScriptFailure } from "./contract.ts";

/**
 * The Site's own scripts that fail in the frame (BA-32; ADR 0022, "Safe mode" in GLOSSARY.md), for the
 * shell's notice: set up by the page agent before any Site script runs, as the editing bar's was.
 *
 * - A script the page tags as one of the Site's (`data-wc-script="site"` or `"page"`, a Library's
 *   `data-wc-library`, a Component script's loader `data-wc-component-script`) that throws as it runs
 *   (an `ErrorEvent` from its file; a Component script's loader imports the script's own file, named by
 *   the same hash) or doesn't load (an error on its element).
 * - A Component script's call that failed on one of its Placements: WebCraft's runtime reports it as
 *   `webcraft:component-error`. The agent takes it (the runtime then writes nothing to the console) and
 *   hands it to the shell as a console line against its Component, as Code mode's panel did.
 *
 * Errors of anything else (WebCraft's own files, an outside script's placeholder) are not the Site's
 * scripts: the console still lists them. Part of the agent's own bundle: nothing is imported at run time.
 */

/** How long a failure's message may be: a script that throws a huge text doesn't flood the notice. */
const MESSAGE_MAX = 300;

/** The tags of the Site's own scripts, as an Edit mode render writes them. */
const OWN_SCRIPTS = "script[data-wc-script], script[data-wc-library], script[data-wc-component-script]";

/** A Component script loader's address: its Component, then its script's hash. */
const LOADER = /\/component\/[^/]+\/([0-9a-f]{16})\.js$/;

export function pageFailures(
	win: Window & typeof globalThis,
	host: AgentHost,
	kept: {
		listen: typeof EventTarget.prototype.addEventListener;
		querySelectorAll: typeof Element.prototype.querySelectorAll;
		getAttribute: typeof Element.prototype.getAttribute;
		preventDefault: typeof Event.prototype.preventDefault;
	},
): void {
	const { listen, querySelectorAll, getAttribute, preventDefault } = kept;
	const doc = win.document;
	const ErrorEventType = win.ErrorEvent;
	const ScriptType = win.HTMLScriptElement;
	const ElementType = win.Element;
	const StringType = win.String;

	const tell = (failure: ScriptFailure) => {
		try {
			host.failed({ ...failure, message: failure.message.slice(0, MESSAGE_MAX) });
		} catch {
			// The shell went away (the frame is being unloaded): nothing to tell.
		}
	};

	/** The Site's own script an error came from: the tag whose file (or whose loader's script) threw. */
	const scriptOf = (filename: string): Element | null => {
		let found: Element | null = null;
		for (const candidate of querySelectorAll.call(doc.documentElement, OWN_SCRIPTS)) {
			const src = (candidate as HTMLScriptElement).src;
			if (src === filename) found = candidate;
			const hash = LOADER.exec(src)?.[1];
			if (hash && filename.endsWith(`/${hash}.js`)) found = candidate;
		}
		return found;
	};

	const failureOf = (script: Element, message: string, line: number | null): ScriptFailure | null => {
		const component = getAttribute.call(script, "data-wc-component-script");
		if (component !== null) {
			const name = getAttribute.call(script, "data-wc-component-name") ?? "";
			return { kind: "component", name, componentId: component, message, line };
		}
		const tagged = getAttribute.call(script, "data-wc-script");
		if (tagged === "site" || tagged === "page") return { kind: tagged, name: "", componentId: null, message, line };
		const library = getAttribute.call(script, "data-wc-library");
		if (library !== null) return { kind: "library", name: library, componentId: null, message, line };
		return null;
	};

	listen.call(
		win,
		"error",
		(event: Event) => {
			let failure: ScriptFailure | null = null;
			if (event instanceof ErrorEventType) {
				const script = event.filename ? scriptOf(event.filename) : null;
				if (script) failure = failureOf(script, StringType(event.message ?? ""), event.lineno || 0);
			} else if (event.target instanceof ScriptType) {
				// A script that didn't load: its file is missing or refused.
				failure = failureOf(event.target, "", null);
			}
			if (failure) tell(failure);
		},
		{ capture: true },
	);

	// A Component script's call that failed on a Placement, as WebCraft's runtime reports it.
	listen.call(
		win,
		"webcraft:component-error",
		(event: Event) => {
			const detail = ((event as CustomEvent).detail ?? {}) as {
				component?: unknown;
				name?: unknown;
				message?: unknown;
			};
			const componentId = StringType(detail.component ?? "");
			const name = StringType(detail.name ?? "");
			const message = StringType(detail.message ?? "");
			// Taken here: the console line below says it, against its Component.
			preventDefault.call(event);
			tell({ kind: "component", name, componentId, message, line: 0 });
			try {
				host.log({
					level: "error",
					text: message.slice(0, MESSAGE_MAX),
					source: null,
					line: null,
					component: { id: componentId, name },
					// Where on the page it failed: the Placement's root, by its Structure reference (Staff's page).
					placement: event.target instanceof ElementType ? getAttribute.call(event.target, "data-wc-code") : null,
				});
			} catch {
				// The shell went away.
			}
		},
		{ capture: true },
	);
}
