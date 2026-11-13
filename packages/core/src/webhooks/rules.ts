import { isIP } from "node:net";

import { isPublicAddress } from "../guarded-fetch.ts";
import { WebhookInvalidError } from "./errors.ts";

/** The longest Webhook URL. */
const LONGEST_URL = 2048;

/** Names that only ever reach this server or its own network, never a host on the internet. */
const LOCAL_ONLY_SUFFIXES = ["localhost", "local", "internal", "home.arpa"];

/**
 * A Webhook's URL as stored: `https`, without credentials, naming a host that could be on the
 * internet; its fragment, which is never sent, dropped. Refuses at once what could never be called
 * (`WebhookInvalidError`); whether the host resolves to a public address is the guarded fetcher's to
 * check on every call, since DNS can change.
 */
export function webhookUrl(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length > LONGEST_URL || !URL.canParse(trimmed)) throw new WebhookInvalidError("url", "format");
	const url = new URL(trimmed);
	if (url.protocol !== "https:") throw new WebhookInvalidError("url", "scheme");
	if (url.username || url.password) throw new WebhookInvalidError("url", "credentials");
	if (!callableHost(url.hostname)) throw new WebhookInvalidError("url", "host");
	url.hash = "";
	return url.toString();
}

function callableHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	const literal = host.startsWith("[") ? host.slice(1, -1) : host;
	if (isIP(literal)) return isPublicAddress(literal);
	if (!host.includes(".")) return false;
	return !LOCAL_ONLY_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** A Webhook's host, as the Audit log and the people without `structure.edit` see it. */
export function hostOf(url: string): string {
	return new URL(url).host;
}

/** What a signing secret Staff give may be: 16 to 200 visible ASCII characters, no spaces. */
const GIVEN_SECRET = /^[\x21-\x7e]{16,200}$/;

/** A signing secret Staff typed, without the spaces around it; refuses one that breaks the rule. */
export function givenSecret(text: string): string {
	const trimmed = text.trim();
	if (!GIVEN_SECRET.test(trimmed)) throw new WebhookInvalidError("secret", "format");
	return trimmed;
}
