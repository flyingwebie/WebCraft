import type { Clock } from "../clock.ts";
import { ConfigError } from "../config.ts";
import { type GuardedFetch, GuardedFetchError } from "../guarded-fetch.ts";
import type { LogContext, Logger } from "../log.ts";
import { withoutLogContext } from "../log.ts";
import { WEBCRAFT_VERSION } from "../version.ts";
import { topFrames } from "./fingerprint.ts";
import type { ErrorSource } from "./service.ts";

/**
 * An outside error tracker (`WEBCRAFT_ERROR_DSN`): each unexpected failure is also sent there, as an
 * event in the envelope format of the widely used open error-tracking protocol, so an Install can
 * report to a tracker it already uses (or a self-hosted, compatible one). The subset WebCraft sends:
 *
 * - The DSN `https://<public key>@<host>[:port][/<path>]/<project id>`; a secret key in it is never sent.
 * - One `POST <scheme>://<host>[/<path>]/api/<project id>/envelope/` per event, with
 *   `Content-Type: application/x-sentry-envelope` and `X-Sentry-Auth: Sentry sentry_version=7,
 *   sentry_key=<public key>, sentry_client=webcraft/<version>`.
 * - The envelope: its header (`event_id`, `sent_at`, `dsn`), one item header (`type: event`) and the
 *   event: `event_id`, `timestamp`, `platform`, `level: error`, `logger`, `release`, `transaction`
 *   (the procedure, job or request), `exception.values[0]` (`type`, `value`, `stacktrace.frames` with
 *   `function` and `filename`, oldest first), `fingerprint` (the Error log's cause), `tags`
 *   (where it happened: `source`, `job`, `workspace_id`, `site_id`, `module`) and `extra.request_id`.
 *   Never a request's headers, cookies, body or person: the same redaction as every log line.
 *
 * Best effort: sent through the guarded fetcher (the DSN's host only, a public address, no redirect,
 * 5 seconds), never waited for by the request or job that failed, at most one event per cause a
 * minute per process and `MAX_IN_FLIGHT` at once; what can't be sent is dropped.
 */

/** A parsed `WEBCRAFT_ERROR_DSN`. */
export type ErrorDsn = {
	/** The DSN as written, without any secret key: what the envelope names. */
	dsn: string;
	/** Where events are posted. */
	envelopeUrl: string;
	host: string;
	publicKey: string;
};

/** Reads `WEBCRAFT_ERROR_DSN`: unset for none, else an `https` DSN with a public key and a project id. */
export function loadErrorDsn(env: Record<string, string | undefined>): ErrorDsn | null {
	const value = env.WEBCRAFT_ERROR_DSN?.trim();
	if (!value) return null;
	const dsn = parseErrorDsn(value);
	if (!dsn) {
		throw new ConfigError(
			"WEBCRAFT_ERROR_DSN must be an error tracker's DSN: https://<public key>@<host>/<project id>, as the tracker gives it.",
		);
	}
	return dsn;
}

/** A DSN's parts, or null when it isn't one. */
export function parseErrorDsn(value: string): ErrorDsn | null {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	const segments = url.pathname.split("/").filter(Boolean);
	const project = segments.pop();
	if (url.protocol !== "https:" || !url.username || !project || !/^[A-Za-z0-9_-]{1,64}$/.test(project)) return null;
	const path = segments.length > 0 ? `/${segments.join("/")}` : "";
	const origin = `${url.protocol}//${url.host}`;
	return {
		dsn: `${url.protocol}//${url.username}@${url.host}${path}/${project}`,
		envelopeUrl: `${origin}${path}/api/${project}/envelope/`,
		host: url.hostname.toLowerCase(),
		publicKey: decodeURIComponent(url.username),
	};
}

/** At most one event per cause this often, per process. */
export const TRACKER_EVERY_MS = 60_000;

/** At most this many events on their way at once; more are dropped. */
const MAX_IN_FLIGHT = 5;

export type ErrorTracker = {
	/** Sends a failure (already redacted by the caller) without waiting; never throws. */
	report(
		failure: { name: string; message: string; stack: string | undefined },
		at: { source: ErrorSource; context: LogContext; fingerprint: string },
	): void;
	/** Waits for every event on its way (tests and a stopping process). */
	settled(): Promise<void>;
};

export function createErrorTracker(deps: {
	dsn: ErrorDsn;
	fetch: GuardedFetch;
	clock: Clock;
	/** Where it says an event couldn't be sent: at warn, never at error, which would report again. */
	log: Logger;
}): ErrorTracker {
	const { dsn, clock, log } = deps;
	const lastSent = new Map<string, number>();
	const inFlight = new Set<Promise<void>>();

	const send = async (body: string) => {
		try {
			const answer = await deps.fetch(
				new Request(dsn.envelopeUrl, {
					method: "POST",
					headers: {
						"content-type": "application/x-sentry-envelope",
						"user-agent": `webcraft/${WEBCRAFT_VERSION}`,
						"x-sentry-auth": `Sentry sentry_version=7, sentry_key=${dsn.publicKey}, sentry_client=webcraft/${WEBCRAFT_VERSION}`,
					},
					body,
				}),
				{ allowedHosts: [dsn.host], maxRedirects: 0, timeoutMs: 5_000, maxBytes: 64 * 1024 },
			);
			await answer.body?.cancel();
			if (!answer.ok) log.warn("The error tracker refused an event", { status: answer.status });
		} catch (error) {
			const problem = error instanceof GuardedFetchError ? error.problem : "unreachable";
			log.warn("An event couldn't be sent to the error tracker", { problem });
		}
	};

	return {
		report(failure, { source, context, fingerprint }) {
			const now = clock.now();
			const last = lastSent.get(fingerprint);
			if (last !== undefined && now.getTime() - last < TRACKER_EVERY_MS) return;
			if (inFlight.size >= MAX_IN_FLIGHT) return;
			lastSent.set(fingerprint, now.getTime());
			if (lastSent.size > 1_000) lastSent.clear();
			const body = envelope(dsn, failure, { source, context, fingerprint, at: now });
			// The process's own work: its lines name no request.
			const sending = withoutLogContext(() => send(body)).finally(() => inFlight.delete(sending));
			inFlight.add(sending);
		},
		async settled() {
			await Promise.all([...inFlight]);
		},
	};
}

/** One event in an envelope: the envelope's header, the item's header and the event, a line each. */
function envelope(
	dsn: ErrorDsn,
	failure: { name: string; message: string; stack: string | undefined },
	at: { source: ErrorSource; context: LogContext; fingerprint: string; at: Date },
): string {
	const eventId = crypto.randomUUID().replaceAll("-", "");
	const { source, context } = at;
	const frames = topFrames(failure.stack).map((frame) => {
		const match = frame.match(/^(.*?)\s+\((.*)\)$/);
		return match ? { function: match[1], filename: match[2], in_app: true } : { filename: frame, in_app: true };
	});
	const tags: Record<string, string> = { source: source.kind };
	if (context.job) tags.job = context.job;
	if (context.workspaceId) tags.workspace_id = context.workspaceId;
	if (context.siteId) tags.site_id = context.siteId;
	if (context.module) tags.module = context.module;
	const event = {
		event_id: eventId,
		timestamp: at.at.getTime() / 1000,
		platform: "node",
		level: "error",
		logger: "webcraft",
		release: `webcraft@${WEBCRAFT_VERSION}`,
		...(source.name ? { transaction: source.name } : {}),
		exception: {
			values: [{ type: failure.name, value: failure.message, stacktrace: { frames: frames.reverse() } }],
		},
		fingerprint: [at.fingerprint],
		tags,
		extra: context.requestId ? { request_id: context.requestId } : {},
	};
	const item = JSON.stringify(event);
	return [
		JSON.stringify({ event_id: eventId, sent_at: at.at.toISOString(), dsn: dsn.dsn }),
		JSON.stringify({ type: "event", content_type: "application/json", length: new TextEncoder().encode(item).length }),
		item,
	].join("\n");
}
