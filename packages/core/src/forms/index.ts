import { siteLanguages } from "../content/languages.ts";
import type { SiteHost } from "../site-pages/index.ts";
import type { Site, SiteScope } from "../tenancy/data-layer.ts";
import { type CaptchaView, getCaptcha, setCaptcha } from "./captcha.ts";
import type { FormVersionInput } from "./definition.ts";
import type { FormEmailsInput } from "./emails.ts";
import {
	createForm,
	deleteForm,
	type Form,
	type FormDeletion,
	type FormUsage,
	getForm,
	listForms,
	type NewForm,
	renameForm,
	saveFormDraft,
	saveFormEmails,
} from "./forms.ts";
import { type FormPost, type FormPostAnswer, type ReceiveDeps, receiveFormPost } from "./receive.ts";
import type { FormTokens } from "./tokens.ts";

export type { CaptchaView } from "./captcha.ts";
export type { FormVersionInput } from "./definition.ts";
export type { FormEmailsInput } from "./emails.ts";
export {
	CaptchaInvalidError,
	FormInUseError,
	FormInvalidError,
	FormKeyTakenError,
	FormNotFoundError,
	type FormPlacement,
} from "./errors.ts";
export type { Form, FormDeletion, FormStatus, FormUsage, NewForm } from "./forms.ts";
export type { CaptchaSettings, PageFormsOptions } from "./page-forms.ts";
export { FORM_POST_MAX_BYTES, type FormPost, type FormPostAnswer, SENT_PARAMETER } from "./receive.ts";
export { createFormTokens, type FormTokens } from "./tokens.ts";

/**
 * Forms (GLOSSARY.md), behind `services.forms`: the Site's Forms as Structure (open the Site with
 * `structure.edit`; publishing goes through `services.publishing.publish` with `{ kind: "form" }`).
 */
export type Forms = {
	list(scope: SiteScope): Promise<(Form & { usage: FormUsage })[]>;
	get(scope: SiteScope, formId: string): Promise<{ form: Form; usage: FormUsage }>;
	/** Creates a Form with its name (and key, made from the name when not given), as an empty Draft. */
	create(scope: SiteScope, input: NewForm): Promise<Form>;
	/** Saves its Draft: each part given (`fields`, `submitLabel`, `success`, `spam`) replaces that part. */
	saveDraft(scope: SiteScope, formId: string, input: FormVersionInput): Promise<Form>;
	/**
	 * Saves its emails Draft (`formEmails.edit`): each part given (`notifications`, `autoReply`) replaces
	 * that part. Publishing goes through `services.publishing.publish` with `{ kind: "formEmails" }`.
	 */
	saveEmails(scope: SiteScope, formId: string, input: FormEmailsInput): Promise<Form>;
	/** Changes its name or key: `{{@form <key>}}` writes the new key everywhere at once. */
	rename(scope: SiteScope, formId: string, input: { name?: string; key?: string }): Promise<Form>;
	/** Deletes it in two steps; refused while a Template or Component places it. */
	delete(scope: SiteScope, formId: string, confirmation?: string): Promise<FormDeletion>;
	/**
	 * Receives what a visitor sent to a Form on the Site the hostname found (`POST
	 * /_webcraft/forms/<id>`): checks it, then hands it to the Module that keeps Submissions.
	 */
	receive(host: SiteHost, formId: string, post: FormPost): Promise<FormPostAnswer>;
	/** A time-trap token for a page of the Site handed out now (see `FORM_TOKEN_MARK`). */
	issueToken(site: Site): Promise<string>;
	/** The Site's CAPTCHA (`structure.edit`): off unless Staff set one up. */
	captcha: {
		get(scope: SiteScope): Promise<CaptchaView>;
		/** Sets it, with its secret key when that changes, or switches it off (null). A Sensitive action. */
		set(scope: SiteScope, input: { captcha: Record<string, unknown> | null; secret?: string }): Promise<CaptchaView>;
	};
};

export function createForms(deps: ReceiveDeps & { tokens: FormTokens }): Forms {
	return {
		list: listForms,
		get: getForm,
		async create(scope, input) {
			const site = await siteLanguages(scope);
			const others = site.languages.map((language) => language.code).filter((code) => code !== site.defaultLanguage);
			return createForm(scope, input, { defaultLanguage: site.defaultLanguage, others });
		},
		saveDraft: saveFormDraft,
		saveEmails: saveFormEmails,
		rename: renameForm,
		delete: deleteForm,
		receive: (host, formId, post) => receiveFormPost(deps, host, formId, post),
		issueToken: (site) => deps.tokens.issue(site.id),
		captcha: { get: getCaptcha, set: setCaptcha },
	};
}
