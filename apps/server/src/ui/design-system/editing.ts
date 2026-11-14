import type { ApiClient } from "@webcraft/api";
import { useCallback, useEffect, useRef, useState } from "react";

import { type AutosaveStatus, useAutosave } from "../content/autosave.ts";
import {
	type Change,
	type ClassPatch,
	type ColourMode,
	type DesignSystemView,
	type Draft,
	mergeChanges,
	type Preview,
	type Problem,
	problemsOf,
} from "./model.ts";

/**
 * The Design system procedures its editors call, and nothing else: the admin hands them the admin's
 * Management API client, the building area's Styles place the one on the Site's own address (ADR
 * 0037), whose list serves the same procedures. Neither editor imports a client of its own.
 */
export type DesignSystemClient = {
	designSystem: Pick<
		ApiClient["designSystem"],
		| "get"
		| "saveDraft"
		| "preview"
		| "createClass"
		| "updateClass"
		| "deleteClass"
		| "exportTokens"
		| "importTokens"
		| "exportFile"
		| "importFile"
		| "publish"
	>;
};

/** How an editor reaches its client: at once, or once it has loaded (the admin's is loaded on first use). */
export type DesignSystemApi = () => Promise<DesignSystemClient>;

/** What every editor of the Design system edits with: the Draft as it is now, its preview and how to change it. */
export type Editing = {
	siteId: string;
	/** The client its changes go through. */
	api: DesignSystemApi;
	draft: Draft;
	preview: Preview;
	mode: ColourMode;
	setMode(mode: ColourMode): void;
	/** Replaces a section of the Draft; saved a moment later. */
	setSection<Key extends "tokens" | "baseStyles" | "customCss" | "darkMode">(key: Key, value: Draft[Key]): void;
	/** Changes a Class; saved a moment later. */
	changeClass(classId: string, patch: ClassPatch): void;
	/** Saves what is waiting, then runs a change the server must answer at once (adding or removing). */
	now<Result>(work: () => Promise<Result>): Promise<Result | undefined>;
	/** The Draft as the server answered after such a change. */
	replaceDraft(draft: Draft): void;
};

/** The Draft being edited, with how its saving stands and what the preview couldn't build. */
export type DesignSystemEditing = {
	editing: Editing;
	/** The Design system as the server last answered it (its status and when it was saved). */
	view: DesignSystemView;
	setView(view: DesignSystemView): void;
	/** Takes a Design system the server answered whole (an import): the view and the Draft. */
	replaceAll(view: DesignSystemView): void;
	status: AutosaveStatus;
	/** Saves what is waiting; false when the save failed. */
	flush(): Promise<boolean>;
	/** What the preview couldn't build from the Draft as it is on screen (each problem and where). */
	previewProblems: Problem[];
};

/**
 * The Design system's Draft as an editor holds it while Staff edit (ADR 0009): each change shown at
 * once and saved by itself a moment after it (sections whole, Classes one by one, merged while one
 * save runs), the preview built again from the Draft on screen 300 ms after it stops changing, and the
 * changes the server must answer at once (adding or removing) run after what is waiting is saved.
 * `onFailure` hears every refusal; `onSaved` each save that went through.
 */
export function useDesignSystemEditing({
	siteId,
	api,
	designSystem,
	preview: firstPreview,
	onFailure,
	onSaved,
}: {
	siteId: string;
	api: DesignSystemApi;
	designSystem: DesignSystemView;
	preview: Preview;
	onFailure(error: unknown): void;
	onSaved?(): void;
}): DesignSystemEditing {
	const [view, setView] = useState(designSystem);
	const [draft, setDraft] = useState(designSystem.draft);
	const [preview, setPreview] = useState(firstPreview);
	const [previewProblems, setPreviewProblems] = useState<Problem[]>([]);
	const [mode, setMode] = useState<ColourMode>("light");
	const heard = useRef({ onFailure, onSaved });
	heard.current = { onFailure, onSaved };

	const autosave = useAutosave<Change>({
		merge: mergeChanges,
		save: async (change) => {
			const client = await api();
			const sections = change.sections ?? {};
			if (Object.keys(sections).length > 0) {
				const saved = await client.designSystem.saveDraft({ siteId, ...sections });
				setView(saved.designSystem);
			}
			for (const [id, patch] of Object.entries(change.classes ?? {})) {
				const saved = await client.designSystem.updateClass({ siteId, classId: id, ...patch });
				setView(saved.designSystem);
			}
		},
		onSaved: () => heard.current.onSaved?.(),
		onFailed: (error) => heard.current.onFailure(error),
	});

	// The preview follows the Draft as it is on screen, a moment after it stops changing.
	const shown = JSON.stringify({
		tokens: draft.tokens,
		classes: draft.classes.map(({ id, name, styles, breakpoints, css }) => ({ id, name, styles, breakpoints, css })),
		baseStyles: draft.baseStyles,
		customCss: draft.customCss,
		darkMode: draft.darkMode,
	});
	useEffect(() => {
		let current = true;
		const timer = setTimeout(async () => {
			try {
				const client = await api();
				const answered = await client.designSystem.preview({ siteId, ...JSON.parse(shown) });
				if (!current) return;
				setPreview(answered.preview);
				setPreviewProblems([]);
			} catch (error) {
				if (current) setPreviewProblems(problemsOf(error));
			}
		}, 300);
		return () => {
			current = false;
			clearTimeout(timer);
		};
	}, [api, siteId, shown]);

	const replaceAll = useCallback((next: DesignSystemView) => {
		setView(next);
		setDraft(next.draft);
	}, []);

	const editing: Editing = {
		siteId,
		api,
		draft,
		preview,
		mode,
		setMode,
		setSection: (key, value) => {
			setDraft((before) => ({ ...before, [key]: value }));
			autosave.change({ sections: { [key]: value } });
		},
		changeClass: (classId, patch) => {
			setDraft((before) => ({
				...before,
				classes: before.classes.map((each) => (each.id === classId ? { ...each, ...patch } : each)),
			}));
			autosave.change({ classes: { [classId]: patch } });
		},
		now: async (work) => {
			if (!(await autosave.flush())) return undefined;
			try {
				const result = await work();
				heard.current.onSaved?.();
				return result;
			} catch (error) {
				heard.current.onFailure(error);
				return undefined;
			}
		},
		replaceDraft: (next) => {
			setDraft(next);
			setView((before) => ({ ...before, draft: next }));
		},
	};

	return {
		editing,
		view,
		setView,
		replaceAll,
		status: autosave.status,
		flush: autosave.flush,
		previewProblems,
	};
}
