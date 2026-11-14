import type { BuildingAreaApiClient } from "@webcraft/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fill, type Words } from "../../api.ts";
import { managementApi } from "../../management.ts";

/**
 * What the Forms place reads and writes (BA-26), on the Site's own address: the Site's Forms
 * (`forms.list`, with where each is placed), the open Form (`forms.get`: its Draft and published
 * version), New Form (`forms.create`, then the starter's fields as its first Draft), the Draft saved as
 * fields change (`forms.saveDraft`) and its fields published (`forms.publish`).
 */

export type FormListing = Awaited<ReturnType<BuildingAreaApiClient["forms"]["list"]>>["forms"][number];

export type OpenedForm = Awaited<ReturnType<BuildingAreaApiClient["forms"]["get"]>>;

export type FormsApi = BuildingAreaApiClient["forms"];

/** The code a call was refused with (`network` when the server didn't answer one). */
export function codeOf(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : "network";
}

/** Why a call was refused, in the person's words. */
export function reasonText(words: Words, error: unknown): string {
	const shown = words.forms.reasons;
	const code = codeOf(error);
	switch (code) {
		case "FORM_KEY_TAKEN":
			return shown.keyTaken;
		case "FORM_INVALID":
			return shown.invalid;
		case "FORBIDDEN":
			return shown.forbidden;
		case "network":
			return shown.network;
		default:
			return fill(shown.generic, { code });
	}
}

/** The Site's Forms, read when the place opens and again after a change; or that the person may not build them. */
export function useFormsList(token: string, siteId: string) {
	const api = useMemo(() => managementApi(token).forms, [token]);
	const [forms, setForms] = useState<FormListing[] | null>(null);
	const [failed, setFailed] = useState<string | null>(null);
	const [forbidden, setForbidden] = useState(false);
	const alive = useRef(true);
	useEffect(
		() => () => {
			alive.current = false;
		},
		[],
	);

	const reload = useCallback(async () => {
		try {
			const listed = await api.list({ siteId });
			if (!alive.current) return;
			setForms(listed.forms);
			setFailed(null);
		} catch (error) {
			if (!alive.current) return;
			if (codeOf(error) === "FORBIDDEN") setForbidden(true);
			else setFailed(codeOf(error));
		}
	}, [api, siteId]);

	useEffect(() => {
		void reload();
	}, [reload]);

	return { api, forms, failed, forbidden, reload };
}

/** One Form, read as it opens; null while it is read. */
export function useOpenedForm(api: FormsApi, siteId: string, formId: string | null) {
	const [opened, setOpened] = useState<{ id: string; form: OpenedForm } | null>(null);
	const [failed, setFailed] = useState<string | null>(null);
	useEffect(() => {
		if (!formId) return;
		let current = true;
		setFailed(null);
		api
			.get({ siteId, formId })
			.then((form) => {
				if (current) setOpened({ id: formId, form });
			})
			.catch((error: unknown) => {
				if (current) setFailed(codeOf(error));
			});
		return () => {
			current = false;
		};
	}, [api, siteId, formId]);
	return {
		form: opened && opened.id === formId ? opened.form : null,
		failed,
		/** Takes what a save or a publish answered as the Form now. */
		take: (form: OpenedForm["form"]) =>
			setOpened((was) => (was && was.id === form.id ? { id: form.id, form: { ...was.form, form } } : was)),
	};
}
