import type { Json } from "@webcraft/core/draft-document";
import type { FormEmails } from "@webcraft/renderer/forms/emails";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { editorHistory } from "../../../../builder/editor-history.ts";
import { type FormProblem, problemsOf } from "../../../../forms/model.ts";
import { fill, type Words } from "../../../api.ts";
import { type FormsApi, type OpenedForm, reasonText } from "../data.ts";
import { SAVE_AFTER_MS } from "../editor.ts";

/**
 * How many parts of the emails differ from what is published (as the admin's Emails tab counts them):
 * each Notification added, removed or changed, the Auto-reply, and how much a Notification attaches.
 * Never published: each Notification, and the Auto-reply once it is on.
 */
export function emailChanges(published: FormEmails | null, draft: FormEmails): number {
	if (!published) return draft.notifications.length + (draft.autoReply.enabled ? 1 : 0);
	const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
	let count = 0;
	const most = Math.max(published.notifications.length, draft.notifications.length);
	for (let at = 0; at < most; at++) if (!same(published.notifications[at], draft.notifications[at])) count++;
	if (!same(published.autoReply, draft.autoReply)) count++;
	if (published.attachmentsMaxBytes !== draft.attachmentsMaxBytes) count++;
	return count;
}

export type EmailsEditor = {
	emails: FormEmails;
	published: FormEmails | null;
	changes: number;
	saving: "idle" | "saving" | "failed";
	problems: readonly FormProblem[];
	/** Changes the emails' words: one step of the shell's Undo history, saved after the pause. */
	change(emails: FormEmails, label: string, group?: string): void;
	/** Saves what waits, then publishes the emails (never the fields); answers whether they were. */
	publish(): Promise<boolean>;
};

/**
 * A Form's emails as the Emails tab edits them (BA-27): Content with a Draft of their own, apart from
 * the fields. Kept in the browser, saved with `forms.saveEmails` after the pause (one save at a time),
 * each change a step of the shell's one Undo history (resource `form-emails:<id>`), and published with
 * `forms.publishEmails` by the tab's own "Publish emails". The tab changes their words and the
 * Auto-reply only: who receives Submissions is the admin's (a Sensitive action).
 */
export function useEmailsEditor({
	api,
	siteId,
	form,
	words,
	announce,
	onTaken,
}: {
	api: FormsApi;
	siteId: string;
	form: OpenedForm["form"];
	words: Words;
	announce(text: string, urgent?: boolean): void;
	onTaken(form: OpenedForm["form"]): void;
}): EmailsEditor {
	const formId = form.id;
	const [emails, setEmails] = useState<FormEmails>(form.emails.draft as FormEmails);
	const [published, setPublished] = useState<FormEmails | null>(form.emails.published as FormEmails | null);
	const [saving, setSaving] = useState<"idle" | "saving" | "failed">("idle");
	const [problems, setProblems] = useState<readonly FormProblem[]>([]);
	const latest = useRef({ emails, words, announce, onTaken, name: form.name });
	latest.current = { emails, words, announce, onTaken, name: form.name };
	const pending = useRef<FormEmails | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const running = useRef<Promise<boolean> | null>(null);

	const save = useCallback(async (): Promise<boolean> => {
		const waiting = pending.current;
		pending.current = null;
		if (!waiting) return true;
		setSaving("saving");
		try {
			const { form: stored } = await api.saveEmails({ siteId, formId, emails: waiting });
			setProblems([]);
			latest.current.onTaken(stored);
			if (!pending.current) setSaving("idle");
			return true;
		} catch (error) {
			const found = problemsOf(error);
			setProblems(found);
			setSaving("failed");
			const { words: shown, name } = latest.current;
			latest.current.announce(
				found.length > 0
					? fill(shown.forms.emails.problemsFound, { count: String(found.length) })
					: fill(shown.forms.saveFailed, { name, reason: reasonText(shown, error) }),
				true,
			);
			return false;
		}
	}, [api, siteId, formId]);

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

	const put = useCallback(
		(next: FormEmails) => {
			latest.current.emails = next;
			setEmails(next);
			pending.current = next;
			if (timer.current) clearTimeout(timer.current);
			timer.current = setTimeout(() => {
				timer.current = null;
				void flush();
			}, SAVE_AFTER_MS);
		},
		[flush],
	);

	// What waits is saved when the tab goes.
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
			if (pending.current) void save();
		},
		[save],
	);

	useEffect(
		() =>
			editorHistory().register(`form-emails:${formId}`, {
				reverse: async (from, to) => {
					put(to as unknown as FormEmails);
					return { ok: true, before: from, after: to };
				},
			}),
		[formId, put],
	);

	const change = useCallback(
		(next: FormEmails, label: string, group?: string) => {
			editorHistory().record({
				resource: `form-emails:${formId}`,
				before: latest.current.emails as unknown as Json,
				after: next as unknown as Json,
				label,
				group,
				location: { siteId, panel: "inspector", title: latest.current.name },
			});
			put(next);
		},
		[formId, siteId, put],
	);

	const publish = useCallback(async (): Promise<boolean> => {
		if (!(await flush())) return false;
		const { words: shown, name } = latest.current;
		try {
			const answer = await api.publishEmails({ siteId, formId });
			setPublished(answer.form.emails.published as FormEmails | null);
			latest.current.onTaken(answer.form);
			latest.current.announce(fill(shown.forms.emails.published, { name }));
			return true;
		} catch (error) {
			latest.current.announce(fill(shown.forms.emails.publishFailed, { name, reason: reasonText(shown, error) }), true);
			return false;
		}
	}, [api, siteId, formId, flush]);

	const changes = useMemo(() => emailChanges(published, emails), [published, emails]);
	return { emails, published, changes, saving, problems, change, publish };
}
