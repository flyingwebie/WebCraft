import { formSettings } from "@webcraft/db/schema";

import type { ContentProblem } from "../content/errors.ts";
import { clearPageCache } from "../content/page-cache.ts";
import type { SecretDescription } from "../secrets/index.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { CaptchaInvalidError } from "./errors.ts";
import { type CaptchaSettings, siteCaptcha } from "./page-forms.ts";
import { CAPTCHA_SECRET } from "./receive.ts";

/**
 * A Site's CAPTCHA (optional, off by default): Site settings, Structure (`structure.edit`), no
 * Draft, applying at once. It works with any challenge provider of the usual shape: a script that
 * draws a widget into an element with the provider's class and the Site's public key, which fills in
 * a hidden field the Form sends; and an address WebCraft posts that answer to with the Site's secret
 * key, which says `{ "success": true }` when a person answered. The script is an outside script (it
 * never runs in Edit mode); the check goes through the guarded fetcher. Setting it is a Sensitive
 * action: the secret key is a secret.
 */

export type CaptchaView = { captcha: CaptchaSettings | null; secret: SecretDescription };

export async function getCaptcha(scope: SiteScope): Promise<CaptchaView> {
	return { captcha: await siteCaptcha(scope), secret: await scope.secrets.describe(CAPTCHA_SECRET) };
}

/**
 * Sets the Site's CAPTCHA, or switches it off (null, which also forgets its secret key). The secret
 * key is given when it changes; it must be set before the CAPTCHA is on. Clears the page cache, as
 * every page with a Form changes, and is logged without the secret.
 */
export async function setCaptcha(
	scope: SiteScope,
	input: { captcha: Record<string, unknown> | null; secret?: string },
): Promise<CaptchaView> {
	const problems: ContentProblem[] = [];
	const captcha = input.captcha === null ? null : readCaptcha(input.captcha, problems);
	const secret = input.secret?.trim();
	if (secret !== undefined && (secret === "" || secret.length > 2000)) {
		problems.push({ at: "secret", message: "The secret key is 1 to 2,000 characters." });
	}
	if (captcha && secret === undefined && !(await scope.secrets.describe(CAPTCHA_SECRET)).set) {
		problems.push({ at: "secret", message: "Give the provider's secret key: answers are checked with it." });
	}
	if (problems.length > 0) throw new CaptchaInvalidError(problems);
	await scope.transaction(async (tx) => {
		const now = tx.now();
		const [updated] = await tx.update(formSettings, { captcha, updatedAt: now });
		if (!updated) await tx.insert(formSettings, { captcha, updatedAt: now });
		if (captcha === null) await tx.secrets.remove(CAPTCHA_SECRET);
		else if (secret !== undefined) await tx.secrets.set(CAPTCHA_SECRET, secret);
		await clearPageCache(tx);
		await tx.audit("formCaptcha.change", {
			on: captcha !== null,
			script: captcha ? new URL(captcha.scriptUrl).host : null,
			verify: captcha ? new URL(captcha.verifyUrl).host : null,
			secretChanged: captcha === null || secret !== undefined,
		});
	});
	return getCaptcha(scope);
}

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,99}$/;
const CLASS_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/;
const KEY = /^[\x21-\x7e]{1,500}$/;

function readCaptcha(input: Record<string, unknown>, problems: ContentProblem[]): CaptchaSettings {
	const address = (name: "scriptUrl" | "verifyUrl") => {
		const value = typeof input[name] === "string" ? (input[name] as string).trim() : "";
		try {
			const url = new URL(value);
			if (url.protocol === "https:" && !url.username && !url.password && value.length <= 2000) return url.href;
		} catch {
			// Reported below.
		}
		problems.push({ at: name, message: "An https:// address on the provider's host." });
		return "";
	};
	const text = (name: "siteKey" | "responseField" | "widgetClass", rule: RegExp, message: string) => {
		const value = typeof input[name] === "string" ? (input[name] as string).trim() : "";
		if (!rule.test(value)) problems.push({ at: name, message });
		return value;
	};
	const captcha = {
		scriptUrl: address("scriptUrl"),
		verifyUrl: address("verifyUrl"),
		siteKey: text("siteKey", KEY, "The provider's public key for the Site: 1 to 500 characters, no spaces."),
		responseField: text(
			"responseField",
			FIELD_NAME,
			"The name of the field the widget fills in: letters, digits, dashes and underscores.",
		),
		widgetClass: text(
			"widgetClass",
			CLASS_NAME,
			"The class the provider's script looks for, such as challenge-widget.",
		),
	};
	if (captcha.responseField.startsWith("wc-")) {
		problems.push({ at: "responseField", message: "Names starting with wc- are WebCraft's own." });
	}
	for (const key of Object.keys(input)) {
		if (!(key in captcha)) problems.push({ at: key, message: `A CAPTCHA has no ${key}.` });
	}
	return captcha;
}
