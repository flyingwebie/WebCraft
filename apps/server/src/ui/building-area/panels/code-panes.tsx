import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { ShellConfig, Words } from "../api.ts";
import type { FrameHandle } from "../canvas/Frame.tsx";
import type { MenuEntry } from "../docks/Menu.tsx";
import type { PanelKey } from "../docks/panels.ts";
import type { ShellHistory } from "../editing/history.ts";
import type { Structure } from "../editing/selection.ts";

/**
 * The code panes in the shell (BA-11; SPEC 2 and 5, ADR 0037 › 1.7): HTML, CSS and JS in the bottom
 * dock while an element of a Template or Component (or a Placement, a Loop, a Condition) is selected.
 * Their code is a file of its own (`CodePanes.tsx`), fetched the first time something is selected, so
 * Staff's first load carries only this file; until it arrives the panes say they are loading.
 */

/** What the panes need from the shell. */
export type CodePanesDeps = {
	config: ShellConfig;
	words: Words;
	/** The page's Structure (BA-08): the selection, its source and its changes. */
	structure: Structure;
	/** The tab's one Undo history. */
	history: ShellHistory;
	frame: RefObject<FrameHandle | null>;
	/** The page the frame shows now (its path, no query), or none (a stand-in, nothing). */
	path(): string | null;
	announce(text: string, urgent?: boolean): void;
};

/** What the panes give the docks: each pane's body, its header's controls, the words beside its title and its menu. */
export type CodePaneParts = {
	bodies: Partial<Record<PanelKey, ReactNode>>;
	actions: Partial<Record<PanelKey, ReactNode>>;
	subs: Partial<Record<PanelKey, string>>;
	menus: Partial<Record<PanelKey, readonly MenuEntry[]>>;
};

/** What `CodePanes.tsx` exports: the panes made once for the shell's life, and their parts as drawn now. */
export type CodePanesModule = {
	createCodePanes(deps: () => CodePanesDeps): CodePanesInstance;
	/** Each pane's parts for the docks, from the panes' header state now (`header()`). */
	paneParts(panes: CodePanesInstance, ui: PaneUi): CodePaneParts;
};

/** What the shell keeps of the panes' look: the pane opened wide, and the selection's name. */
export type PaneUi = {
	wide: PanelKey | null;
	setWide(wide: PanelKey | null): void;
	/** What is selected, as its chip names it (`h1 · Heading`). */
	selectionName: string;
};

/** The panes' own state, kept for the shell's life (a pane moved to another dock keeps what was typed). */
export type CodePanesInstance = {
	/** What the panes' headers and menus show; a new value only when one of those changes, not as people type. */
	header(): unknown;
	subscribeHeader(listener: () => void): () => void;
	/** Saves what was typed in the panes and not saved yet. */
	flush(): Promise<void>;
	destroy(): void;
};

/**
 * Loads the panes' file the first time `wanted` holds (something is selected, for Staff) and keeps
 * the panes for the shell's life. Answers the module and the panes once loaded, and the pane opened
 * wide (its Expand, which the docks draw alone in its dock).
 */
export function useCodePanes(deps: CodePanesDeps, wanted: boolean) {
	const [loaded, setLoaded] = useState<CodePanesModule | null>(null);
	const [failed, setFailed] = useState(false);
	const [wide, setWide] = useState<PanelKey | null>(null);
	const latest = useRef(deps);
	latest.current = deps;
	const asked = useRef(false);

	useEffect(() => {
		if (!wanted || asked.current) return;
		asked.current = true;
		import("./CodePanes.tsx")
			.then((module) => setLoaded(module as CodePanesModule))
			.catch(() => {
				asked.current = false;
				setFailed(true);
			});
	}, [wanted]);

	const panes = useMemo(() => (loaded ? loaded.createCodePanes(() => latest.current) : null), [loaded]);
	useEffect(() => () => panes?.destroy(), [panes]);

	// A pane opened wide goes back to its share once nothing is selected.
	useEffect(() => {
		if (!wanted) setWide(null);
	}, [wanted]);

	const header = useSyncExternalStore(panes?.subscribeHeader ?? noSubscription, () => panes?.header() ?? null);
	return { module: loaded, panes, failed, wide, setWide, header };
}

const noSubscription = () => () => {};

/** The panes' parts for the docks: the panes' own once loaded, else a quiet line in each well. */
export function codePaneParts(
	panes: ReturnType<typeof useCodePanes>,
	words: Words,
	selectionName: string,
): CodePaneParts {
	if (!panes.module || !panes.panes) return waitingParts(words, panes.failed);
	return panes.module.paneParts(panes.panes, { wide: panes.wide, setWide: panes.setWide, selectionName });
}

/** The panes' bodies while their file loads (or couldn't): a quiet line in each well. */
function waitingParts(words: Words, failed: boolean): CodePaneParts {
	const line = (
		<p className="text-chrome-muted m-0 p-3 text-[12px]" role="status">
			{failed ? words.code.loadFailed : words.code.loading}
		</p>
	);
	return { bodies: { html: line, css: line, js: line }, actions: {}, subs: {}, menus: {} };
}
