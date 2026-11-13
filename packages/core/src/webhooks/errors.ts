/**
 * Why a Webhook's URL or signing secret is refused when it is saved:
 * - `url`, `format`: not an absolute URL (or longer than 2048 characters);
 * - `url`, `scheme`: not `https`;
 * - `url`, `credentials`: a user name or password in the URL;
 * - `url`, `host`: a host that can never be called: `localhost`, a name with no dot, a local-only name
 *   (`.local`, `.internal`, `.home.arpa`) or an IP address inside a network;
 * - `secret`, `format`: a signing secret shorter than 16 or longer than 200 characters, or with
 *   characters other than visible ASCII (no spaces).
 */
export type WebhookInvalidField = "url" | "secret";

export type WebhookInvalidReason = "format" | "scheme" | "credentials" | "host";

export class WebhookInvalidError extends Error {
	override name = "WebhookInvalidError";
	readonly field: WebhookInvalidField;
	readonly reason: WebhookInvalidReason;
	constructor(field: WebhookInvalidField, reason: WebhookInvalidReason) {
		super(WORDS[field === "secret" ? "secret" : reason]);
		this.field = field;
		this.reason = reason;
	}
}

const WORDS: Record<WebhookInvalidReason | "secret", string> = {
	format: "A Webhook's URL is a full address, such as https://hooks.example.com/webcraft.",
	scheme: "A Webhook's URL must start with https://.",
	credentials: "A Webhook's URL can't hold a user name or password: give the receiver a signing secret instead.",
	host: "A Webhook's URL must name a host on the internet, not this server or its network.",
	secret: "A signing secret is 16 to 200 visible characters, without spaces.",
};

/** The Site has no Webhook with this id. */
export class WebhookNotFoundError extends Error {
	override name = "WebhookNotFoundError";
	constructor() {
		super("The Site has no such Webhook.");
	}
}

/** A Site has at most `max` Webhooks. */
export class TooManyWebhooksError extends Error {
	override name = "TooManyWebhooksError";
	readonly max: number;
	constructor(max: number) {
		super(`A Site has at most ${max} Webhooks: remove one first.`);
		this.max = max;
	}
}

/** The Webhook has no delivery with this id (it may be older than 30 days). */
export class WebhookDeliveryNotFoundError extends Error {
	override name = "WebhookDeliveryNotFoundError";
	constructor() {
		super("The Webhook has no such delivery.");
	}
}

/**
 * Why a delivery can't be sent again:
 * - `not-failed`: only a failed delivery is redelivered (one still being tried, or delivered, isn't);
 * - `test`: a test send isn't redelivered: send another test;
 * - `switched-off`: the Webhook is switched off: switch it on first.
 */
export type WebhookRedeliveryProblem = "not-failed" | "test" | "switched-off";

export class WebhookRedeliveryRefusedError extends Error {
	override name = "WebhookRedeliveryRefusedError";
	readonly problem: WebhookRedeliveryProblem;
	constructor(problem: WebhookRedeliveryProblem) {
		super(
			problem === "switched-off"
				? "The Webhook is switched off: switch it on to redeliver."
				: problem === "test"
					? "A test send isn't redelivered: send another test."
					: "Only a failed delivery can be redelivered.",
		);
		this.problem = problem;
	}
}
