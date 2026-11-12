// Redaction (docs/development.md § Logs; packages/core/src/redaction.ts): every log line is
// redacted before it is written, and the Error log's sample and an event sent to an error tracker
// carry the same redacted text, never a secret or a piece of people's content.
//
// Two ways a secret reaches a line:
// - As free text (TEXT_RULES): a token or key in a URL's query string, a password in a URL, a
//   quoted secret in a message, an Authorization credential written out. Planted through a real
//   job here, the way tests/errors/error-tracker.test.ts already plants one token in a job's URL:
//   the fake outgoing HTTP throws with the target URL in its message when nothing answers it
//   (tests/harness/fake-http.ts), so the planted values ride along into "A job failed", the Error
//   log's sample and the tracker's event, the way a real failure's text would.
// - As a named field (SECRET_NAMES, CONTENT_NAMES): a password, a cookie, a Submission's values.
//   WebCraft's own code is careful never to log these by name (a job's payload, a Submission's
//   values and an SMTP password are deliberately left out of every log call this review could
//   find), so there is no request or job today that carries one into a line to prove the field-name
//   rule holds. Planted instead through `createLogger`, the function every process's logger is
//   made from (packages/core/src/log.ts): "every entry is redacted first" is its own documented
//   contract, so calling it directly tests that contract, not an internal detail. The same path
//   covers export passphrases, which arrive with #109 and have no request to plant them through yet.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createLogger, type LogEntry, REDACTED, samplePing } from "@webcraft/core";

import { createTestInstall, type RecordedRequest, type TestBrowser, type TestInstall } from "../harness/index.ts";

const DSN = "https://f00dfeedc0ffee42@redaction.agency.example/tracker/99";
const ENVELOPES = "https://redaction.agency.example/tracker/api/99/envelope/";

let install: TestInstall;
let admin: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall({ errorDsn: DSN });
	admin = await install.superadmin();
	install.dns.answer("redaction.agency.example", ["93.184.216.34"]);
	install.http.respond("POST", ENVELOPES, { status: 200, body: '{"id":"ok"}' });
});

afterAll(async () => {
	await install.close();
});

/** The events the tracker received so far, read as it reads an envelope (see error-tracker.test.ts). */
function trackerEvents(): Record<string, unknown>[] {
	return install.http.requests
		.filter((request: RecordedRequest) => request.url === ENVELOPES)
		.map((request) => JSON.parse(request.body.split("\n")[2] ?? "{}"));
}

/** Waits until `ready` holds (the tracker's event goes out in the background), for at most `ms`. */
async function until(ready: () => boolean, ms = 3_000): Promise<void> {
	const end = Date.now() + ms;
	while (!ready() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
}

test("a secret planted in a real job's URL never reaches the log, the Error log's sample, or the tracker's event", async () => {
	const RAW = {
		token: "planted-oauth-token-9f8e7d",
		key: "planted-webhook-key-6c5b4a",
		apiKey: "planted-api-key-3a2b1c",
		contentKey: "planted-content-key-0d9e2f",
		password: "planted-url-password-77aa88",
		secret: "planted-client-secret-55bb66",
		passphrase: "planted-export-passphrase-33cc44",
	};
	const url =
		"https://status.unreachable.example/redaction-check" +
		`?token=${RAW.token}&key=${RAW.key}&api_key=${RAW.apiKey}&content_key=${RAW.contentKey}` +
		`&password=${RAW.password}&secret=${RAW.secret}&passphrase=${RAW.passphrase}`;

	await install.jobs.send(samplePing, { url });
	expect((await install.drainJobs()).failed).toHaveLength(1);

	const logText = JSON.stringify(install.logs);
	for (const value of Object.values(RAW)) expect(logText).not.toContain(value);
	expect(logText).toContain(REDACTED);

	const { groups } = await admin.api.errorLog.list({});
	const group = groups.find((candidate) => candidate.message.includes("redaction-check"));
	if (!group) throw new Error("No cause was noted for the planted job.");
	const { group: detail } = await admin.api.errorLog.get({ groupId: group.id });
	const sampleText = JSON.stringify(detail);
	for (const value of Object.values(RAW)) expect(sampleText).not.toContain(value);
	expect(sampleText).toContain(REDACTED);

	await until(() => trackerEvents().length > 0);
	const [sent] = trackerEvents();
	const sentText = JSON.stringify(sent);
	for (const value of Object.values(RAW)) expect(sentText).not.toContain(value);
	expect(sentText).toContain(REDACTED);
});

test("every other redacted kind, planted through the logger directly: never written, at any depth", () => {
	const entries: LogEntry[] = [];
	const log = createLogger({ write: (entry) => entries.push(entry) });

	// One planted value per name SECRET_NAMES matches (passphrase stands in for a Site export's,
	// which arrives with #109).
	const SECRET_FIELDS = {
		password: "planted-password-aa11",
		passwd: "planted-passwd-aa12",
		passphrase: "planted-export-passphrase-aa13",
		secret: "planted-secret-aa14",
		token: "planted-token-aa15",
		apiKey: "planted-api-key-aa16",
		aiKey: "planted-ai-key-aa17",
		contentKey: "planted-content-key-aa18",
		privateKey: "planted-private-key-aa19",
		accessKey: "planted-access-key-aa20",
		secretAccessKey: "planted-secret-access-key-aa21",
		authorization: "Bearer planted-authorization-aa22",
		proxyAuthorization: "Basic planted-proxy-authorization-aa23",
		cookie: "session=planted-cookie-aa24",
		cookies: "session=planted-cookies-aa25",
		setCookie: "session=planted-set-cookie-aa26",
		credentials: "planted-credentials-aa27",
		signature: "planted-signature-aa28",
		otp: "123456-aa29",
		totp: "654321-aa30",
		backupCode: "planted-backup-code-aa31",
		backupCodes: "planted-backup-codes-aa32",
		recoveryCode: "planted-recovery-code-aa33",
	};
	// One planted value per name CONTENT_NAMES matches: a Submission's values and an email's body.
	const CONTENT_FIELDS = {
		submission: "a visitor's planted Submission value, cc01",
		submissions: "another planted Submission value, cc02",
		submissionValues: "a third planted Submission value, cc03",
		formValues: "a planted Form value, cc04",
		emailBody: "a planted email body, cc05",
		emailHtml: "<p>a planted email body, cc06</p>",
		html: "<p>a planted email body, cc07</p>",
	};
	// The same names nested inside objects and arrays: redaction looks at any depth.
	const NESTED = {
		password: "planted-nested-password-gg01",
		token: "planted-nested-token-gg02",
		secret: "planted-nested-array-secret-gg03",
	};
	// A Headers instance (an Authorization header and a Cookie, the shape a request's headers take).
	const headerValues = {
		authorization: "Bearer planted-header-token-dd01",
		cookie: "session=planted-header-cookie-dd02",
	};
	const headers = new Headers({ Authorization: headerValues.authorization, Cookie: headerValues.cookie });
	// A Map, keyed the same way.
	const mapValue = "planted-map-cookie-dd03";
	const map = new Map([["cookie", mapValue]]);
	// An Error cause chain: the outer failure wraps an inner one whose own message quotes a secret
	// the way a caught database or SMTP error's text can.
	const innerMessage = 'Login failed: "password":"planted-cause-password-ee01"';
	const failure = new Error("The outer failure", { cause: new Error(innerMessage) });
	// A deliberate exception, thrown and caught the way WebCraft's own catches log one.
	let caught: unknown;
	try {
		throw new Error("Bearer planted-exception-bearer-ff01");
	} catch (error) {
		caught = error;
	}

	log.error("a planted failure for the redaction test", {
		...SECRET_FIELDS,
		...CONTENT_FIELDS,
		nested: {
			again: { password: NESTED.password },
			list: [{ token: NESTED.token }, [{ secret: NESTED.secret }]],
		},
		headers,
		map,
		failure,
		error: caught,
	});

	const text = JSON.stringify(entries);
	for (const value of Object.values(SECRET_FIELDS)) expect(text).not.toContain(value);
	for (const value of Object.values(CONTENT_FIELDS)) expect(text).not.toContain(value);
	for (const value of Object.values(NESTED)) expect(text).not.toContain(value);
	expect(text).not.toContain("planted-header-token-dd01");
	expect(text).not.toContain("planted-header-cookie-dd02");
	expect(text).not.toContain(mapValue);
	expect(text).not.toContain("planted-cause-password-ee01");
	expect(text).not.toContain("planted-exception-bearer-ff01");
	expect(text).toContain(REDACTED);
});

// The report's "Sloppy code": a device sign-in's codes were the one kind of OAuth secret the rules
// missed, so `/oauth/device?user_code=…` was logged whole when a request failed.
test("a device sign-in's codes are never written: the device code, and the user code in the page's address", () => {
	const entries: LogEntry[] = [];
	const log = createLogger({ write: (entry) => entries.push(entry) });
	const deviceCode = "webcraft-dc_plantedDeviceCode0123456789abcdef";

	log.error("A request failed unexpectedly", {
		url: "https://admin.test/oauth/device?user_code=BCDF-GHJK",
		form: `grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=${deviceCode}&client_id=abc`,
		note: `The client polled with ${deviceCode} too fast.`,
	});

	const written = JSON.stringify(entries);
	expect(written).not.toContain("BCDF-GHJK");
	expect(written).not.toContain("plantedDeviceCode");
	expect(written).toContain(REDACTED);
	// What isn't a secret stays readable.
	expect(written).toContain("client_id=abc");
});
