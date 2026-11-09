import { formSettings } from "@webcraft/db/schema";
import { type FormState, formWords, renderForm } from "@webcraft/renderer";

import type { VisitorScope } from "../tenancy/data-layer.ts";
import { siteForms } from "./forms.ts";
import { sentMessage } from "./messages.ts";

/**
 * A Site's CAPTCHA (optional, off unless Staff set one up; provider-agnostic): the provider's script
 * (an outside script), where its answers are checked, the Site's public key, the name of the field
 * the widget fills in, and the class the widget's element takes. Its secret key is the Site secret
 * `forms.captcha.secret`.
 */
export type CaptchaSettings = {
	scriptUrl: string;
	verifyUrl: string;
	siteKey: string;
	responseField: string;
	widgetClass: string;
};

/** The Site's CAPTCHA, or null while it has none. */
export async function siteCaptcha(scope: Pick<VisitorScope, "first">): Promise<CaptchaSettings | null> {
	const row = await scope.first(formSettings);
	return (row?.captcha as CaptchaSettings | null | undefined) ?? null;
}

/** What one answer shows in a page's Forms: the time-trap token, and one visitor's state of one Form. */
export type PageFormsOptions = {
	/**
	 * The page goes into the page cache: its Forms hold the mark the Site pipeline fills a new token in
	 * at each answer (`FORM_TOKEN_MARK`), never one visitor's token. Every other answer gets its own.
	 */
	cached?: boolean;
	/** What one visitor sent to one Form of the page (by its id and which Form of the page it is). */
	state?: { formId: string; instance: number; state: FormState };
	/** Which Form of the page was just sent: it shows its message in its place. */
	sent?: number;
};

/** One Form a page showed: its id, and which Form of the page it is. */
export type ShownForm = { formId: string; instance: number };

/**
 * How a page's Forms render: each placed Form's version (published, or its Draft in Code mode), in
 * the page's language, posting back with the page's path; nothing where no Module keeps Submissions
 * on the Site, or for a Form the page can't show. Forms are numbered in the order they render.
 */
export async function pageForms(
	scope: Pick<VisitorScope, "select" | "first">,
	options: {
		on: boolean;
		which: "published" | "draft";
		language: string;
		page: string;
		/** The time-trap token the page's Forms carry, or the mark for a cached page. */
		token: string;
		forms?: PageFormsOptions;
		/** Edit mode loads no outside script, so no CAPTCHA either. */
		editMode: boolean;
	},
): Promise<{ render: (formId: string) => string; shown: ShownForm[]; outsideScripts: () => string[] }> {
	const shown: ShownForm[] = [];
	if (!options.on) return { render: () => "", shown, outsideScripts: () => [] };
	const catalogue = await siteForms(scope, options.which);
	const captcha = options.editMode ? null : await siteCaptcha(scope);
	const words = formWords(options.language);
	return {
		shown,
		render(formId) {
			const version = catalogue.version(formId);
			if (!version) return "";
			const instance = shown.length + 1;
			shown.push({ formId, instance });
			const state = options.forms?.state;
			const sent = options.forms?.sent === instance;
			return renderForm({
				id: formId,
				instance,
				version,
				language: options.language,
				page: options.page,
				token: options.token,
				captcha: captcha && { widgetClass: captcha.widgetClass, siteKey: captcha.siteKey },
				words,
				state: sent
					? { kind: "sent", message: sentMessage(version, options.language) }
					: state && state.formId === formId && state.instance === instance
						? state.state
						: null,
			});
		},
		outsideScripts: () => (captcha && shown.length > 0 ? [captcha.scriptUrl] : []),
	};
}
