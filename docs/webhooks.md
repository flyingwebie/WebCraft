# Receiving Webhooks

A Webhook is a call a WebCraft Install makes to an address you choose when something happens on a Site, such as a publish or a visitor sending a Form. Staff add Webhooks per Site in the admin (Site › Webhooks). This page is for whoever builds the system that receives them.

## The request

Each delivery is an HTTPS `POST` with a small JSON body:

```http
POST /your/path HTTP/1.1
Content-Type: application/json
User-Agent: WebCraft-Webhooks/1
WebCraft-Event: publish
WebCraft-Delivery: 0f6b2c3e-5a1d-4f6e-9c1a-3d2b8e7f4a10
WebCraft-Signature: t=1772442000,v1=5d41402abc4b2a76b9719d911017c592ae7b0b0c2f1e7b9a3c4d5e6f7a8b9c0d

{"id":"0f6b2c3e-5a1d-4f6e-9c1a-3d2b8e7f4a10","type":"publish","occurredAt":"2026-03-02T09:00:00.000Z","site":{"id":"…","name":"Acme Bakery","url":"https://acmebakery.ie"},"data":{"item":{"kind":"entry","id":"…","postTypeId":"…","path":"/blog/fresh-bread"},"pathChanges":[],"by":{"id":"…","name":"Ada"},"via":"admin"}}
```

- `id` is the delivery id, the same as `WebCraft-Delivery`. It stays the same on every attempt of a delivery, so use it to skip a delivery you already handled.
- `type` is the event: `publish`, `formSubmitted`, or `test` when Staff press Send test.
- `site.url` is where visitors find the Site (its Primary domain, or its Staging address while it has none); it is `null` when it has neither.
- For `publish`, `data.item` says what was published: `kind` is `entry`, `template`, `component`, `script`, `globals`, `form`, `formEmails` (a Form's Notifications and Auto-reply), `loop` or `designSystem` (later versions add more), with its `id`; an Entry also has its `postTypeId` and `path`. `data.pathChanges` lists the published addresses the publish changed (`{ entryId, language, from, to }`). `data.by` is the person who published it (`null` when nobody did, such as a Module by itself), and `data.via` how (`admin`, `editMode`, `module`, `token`, `aiClient`, `translation`, `impersonation` when the Superadmin or Staff impersonated the person, …). Publish all, which publishes several items together, sends one `publish` event per item, once all of them are published.
- For `formSubmitted`, a visitor sent one of the Site's Forms and its Submission was kept (never spam; also when someone takes one out of the Spam folder). `data.form` is the Form (`id`, `key`, `name`), and `data.submission` the Submission: its `id` (the same in every delivery about it), `language` (the language the visitor used), `page` (the path it was sent from, or `null`), `receivedAt`, and `values`, the Form's fields in order, each `{ key, label, type, value }`, where `value` is text, a list of texts (checkboxes), a number, `true`/`false` (a consent box) or `null` (left empty). It carries what the visitor typed: treat it as personal data.
- The body never holds a secret. Apart from a Submission's values in `formSubmitted`, it holds no content either (no titles or text): fetch what you need from the Site or its Content API.

## Checking the signature

Each Webhook has a signing secret, shown once when it is made (or set by Staff to one you give them). Check every request before you trust it:

1. Read `t` and `v1` from `WebCraft-Signature` (`t=<unix seconds>,v1=<hex>`).
2. Compute HMAC-SHA256 of `<t>.<body>`, the timestamp, a dot and the raw body exactly as received (before any JSON parsing), with the signing secret's UTF-8 bytes as the key, in lower-case hex.
3. Compare it with `v1` in constant time.
4. Refuse a `t` more than 5 minutes away from your own clock, so a captured delivery can't be sent to you again later.

In Node.js:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function isFromWebCraft(rawBody, signatureHeader, secret, now = Date.now()) {
	const parts = Object.fromEntries(signatureHeader.split(",").map((part) => part.split("=", 2)));
	const timestamp = Number(parts.t);
	if (!Number.isInteger(timestamp) || Math.abs(now / 1000 - timestamp) > 300) return false;
	const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
	const given = Buffer.from(parts.v1 ?? "", "hex");
	return given.length === expected.length && timingSafeEqual(given, expected);
}
```

When Staff replace the secret, every attempt from then on is signed with the new one.

## Answering

- Answer with any `2xx` status within 10 seconds; the start of your answer (500 characters) shows in the delivery log, so keep it short and never put a secret in it.
- No answer, a timeout, `408`, `429` and `5xx` answers are tried again after 1, 4, 16, 64 and 256 minutes, or after your `Retry-After` when that is longer (up to 6 hours): 6 attempts in all. Each attempt is signed again, with its own `t`.
- Redirects are never followed, and any other answer (`4xx`) fails the delivery at once.
- Deliveries can arrive more than once (a retry after your answer was lost, or a redelivery Staff asked for), and not in the order they happened: use the delivery id and `occurredAt`.
- After 10 deliveries in a row fail, the Webhook is switched off and the Site's Owners are told by email. Staff switch it on again and can redeliver what it missed from its delivery log, kept for 30 days.
