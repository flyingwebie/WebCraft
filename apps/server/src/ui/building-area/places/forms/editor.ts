import type { Json } from "@webcraft/core/draft-document";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { editorHistory } from "../../../builder/editor-history.ts";
import { changeOf, type FormField, type FormProblem, type FormVersion, problemsOf } from "../../../forms/model.ts";
import { fill, type Words } from "../../api.ts";
import { changesOf } from "./build/layout.ts";
import { type FormsApi, type OpenedForm, reasonText } from "./data.ts";

/** How long after the last change the Draft is saved (as the other places save). */
export const SAVE_AFTER_MS = 800;

export type FormEditor = {
	formId: string;
	version: FormVersion;
	published: FormVersion | null;
	/** How many changes the Draft holds against what is published. */
	changes: number;
	saving: "idle" | "saving" | "failed";
	/** What the server refused in the last save, at its place (`fields[2].label`). */
	problems: readonly FormProblem[];
	/** Changes the fields: one step of the shell's Undo history (`group` merges a run of typing). */
	change(fields: FormField[], label: string, group?: string): void;
	/** Saves what waits now; answers whether the Draft holds it. */
	flush(): Promise<boolean>;
	/** Saves what waits, then publishes the Form's fields; answers whether they were published. */
	publish(): Promise<boolean>;
};

/** The Form being edited: which one, its Draft as changed here, and what is published. */
type Editing = { formId: string; version: FormVersion; published: FormVersion | null };

/**
 * The open Form's Draft as the place edits it (BA-26): kept in the browser, saved with
 * `forms.saveDraft` 0.8 s after the last change (one save at a time, the newest after it; each save
 * names the Form it was made on, so opening another Form meanwhile never mixes them up), each change
 * a step of the shell's one Undo history (the bottom bar's Undo and Redo, ⌘Z), and published with
 * `forms.publish`. The Draft state beside Publish follows what is saved and what is refused.
 */
export function useFormEditor({
	api,
	siteId,
	opened,
	words,
	announce,
	onSaving,
	onTaken,
}: {
	api: FormsApi;
	siteId: string;
	opened: OpenedForm["form"] | null;
	words: Words;
	announce(text: string, urgent?: boolean): void;
	onSaving(status: "saving" | "saved" | "failed"): void;
	/** The Form as a save or a publish answered it (its status, its published version). */
	onTaken(form: OpenedForm["form"]): void;
}): FormEditor | null {
	const [editing, setEditing] = useState<Editing | null>(null);
	const [saving, setSaving] = useState<"idle" | "saving" | "failed">("idle");
	const [problems, setProblems] = useState<readonly FormProblem[]>([]);
	// A Form opened anew starts from its stored Draft (derived as it renders, so nothing of the Form
	// before shows with it).
	if (opened && editing?.formId !== opened.id) {
		setEditing({ formId: opened.id, version: opened.draft, published: opened.published });
		setProblems([]);
		setSaving("idle");
	}
	const current = editing && opened && editing.formId === opened.id ? editing : null;
	const latest = useRef({ editing: current, words, announce, onSaving, onTaken, name: opened?.name ?? "" });
	latest.current = { editing: current, words, announce, onSaving, onTaken, name: opened?.name ?? "" };
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const running = useRef<Promise<boolean> | null>(null);
	/** What waits to be saved: the Form it was made on, and its fields then. */
	const pending = useRef<{ formId: string; version: FormVersion } | null>(null);

	const save = useCallback(async (): Promise<boolean> => {
		const waiting = pending.current;
		pending.current = null;
		if (!waiting) return true;
		const mine = () => latest.current.editing?.formId === waiting.formId;
		setSaving("saving");
		latest.current.onSaving("saving");
		try {
			const { form } = await api.saveDraft({ siteId, formId: waiting.formId, form: changeOf(waiting.version) });
			if (!mine()) return true;
			setProblems([]);
			latest.current.onTaken(form);
			if (!pending.current) {
				setSaving("idle");
				latest.current.onSaving("saved");
			}
			return true;
		} catch (error) {
			if (!mine()) return false;
			const found = problemsOf(error);
			setProblems(found);
			setSaving("failed");
			latest.current.onSaving("failed");
			const { words: shown, name } = latest.current;
			latest.current.announce(
				found.length > 0
					? fill(shown.forms.problemsFound, { name, count: String(found.length) })
					: fill(shown.forms.saveFailed, { name, reason: reasonText(shown, error) }),
				true,
			);
			return false;
		}
	}, [api, siteId]);

	const flush = useCallback(async (): Promise<boolean> => {
		if (timer.current) {
			clearTimeout(timer.current);
			timer.current = null;
		}
		while (running.current) await running.current;
		if (!pending.current) return true;
		const run = save().finally(() => {
			running.current = null;
		});
		running.current = run;
		return run;
	}, [save]);

	const schedule = useCallback(() => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => {
			timer.current = null;
			void flush();
		}, SAVE_AFTER_MS);
	}, [flush]);

	// What waits is saved when the place goes.
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
			if (pending.current) void save();
		},
		[save],
	);

	/** Puts fields in the Form being edited, and saves them after the pause. */
	const setFields = useCallback(
		(formId: string, fields: FormField[]) => {
			const now = latest.current.editing;
			if (!now || now.formId !== formId) return false;
			const version = { ...now.version, fields };
			const next = { ...now, version };
			latest.current.editing = next;
			setEditing(next);
			pending.current = { formId, version };
			schedule();
			return true;
		},
		[schedule],
	);

	// The shell's Undo history takes a Form's fields back (and forward) through this.
	const formId = current?.formId ?? null;
	useEffect(() => {
		if (!formId) return;
		return editorHistory().register(`form:${formId}`, {
			reverse: async (from, to) =>
				setFields(formId, to as unknown as FormField[])
					? { ok: true, before: from, after: to }
					: { ok: false, code: "HISTORY_UNAVAILABLE" },
		});
	}, [formId, setFields]);

	const change = useCallback(
		(fields: FormField[], label: string, group?: string) => {
			const now = latest.current.editing;
			if (!now) return;
			editorHistory().record({
				resource: `form:${now.formId}`,
				before: now.version.fields as unknown as Json,
				after: fields as unknown as Json,
				label,
				group,
				location: { siteId, panel: "inspector", title: latest.current.name },
			});
			setFields(now.formId, fields);
		},
		[siteId, setFields],
	);

	const publish = useCallback(async (): Promise<boolean> => {
		const id = latest.current.editing?.formId;
		if (!id) return false;
		if (!(await flush())) return false;
		const { words: shown, name } = latest.current;
		try {
			const answer = await api.publish({ siteId, formId: id });
			setEditing((was) => (was && was.formId === id ? { ...was, published: answer.form.published } : was));
			latest.current.onTaken(answer.form);
			latest.current.announce(fill(shown.forms.published, { name }));
			return true;
		} catch (error) {
			const found = problemsOf(error);
			if (found.length > 0) setProblems(found);
			latest.current.announce(
				found.length > 0
					? fill(shown.forms.problemsFound, { name, count: String(found.length) })
					: fill(shown.forms.publishFailed, { name, reason: reasonText(shown, error) }),
				true,
			);
			return false;
		}
	}, [api, siteId, flush]);

	const changes = useMemo(() => (current ? changesOf(current.version, current.published) : 0), [current]);
	if (!current) return null;
	return {
		formId: current.formId,
		version: current.version,
		published: current.published,
		changes,
		saving,
		problems,
		change,
		flush,
		publish,
	};
}
