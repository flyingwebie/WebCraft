import { AwsClient } from "aws4fetch";

import type { Clock } from "../clock.ts";
import type { OutgoingHttp } from "../http.ts";
import { type ByteRange, keyParts, type StorageBackend, StorageError } from "./storage.ts";

/** An S3-compatible bucket, as the Superadmin sets it (the secret access key is apart, as a secret). */
export type S3Settings = {
	/** The service's address, such as `https://s3.eu-west-1.amazonaws.com` or `http://minio:9000`. */
	endpoint: string;
	region: string;
	bucket: string;
	/** Put in front of every key (`install-1/…`); empty for none. */
	prefix: string;
	/** `<endpoint>/<bucket>/<key>` when true, `<bucket>.<endpoint host>/<key>` when false. */
	pathStyle: boolean;
	accessKeyId: string;
};

type Options = {
	settings: S3Settings;
	http: OutgoingHttp;
	clock: Clock;
	/** Runs `use` with the bucket's secret access key, which never leaves the call. */
	withSecret<Result>(use: (secretAccessKey: string) => Promise<Result>): Promise<Result>;
};

/**
 * An S3-compatible bucket (AWS S3, Cloudflare R2, MinIO and others), spoken to through the Install's
 * outgoing HTTP with requests signed with AWS Signature Version 4.
 */
export function s3Storage({ settings, http, clock, withSecret }: Options): StorageBackend {
	const endpoint = new URL(settings.endpoint);
	const prefix = settings.prefix.replace(/^\/+|\/+$/g, "");

	const urlOf = (key: string) => {
		const path = [...(prefix ? prefix.split("/") : []), ...keyParts(key)].map(encodeURIComponent).join("/");
		const base = endpoint.pathname.replace(/\/+$/, "");
		return settings.pathStyle
			? `${endpoint.origin}${base}/${encodeURIComponent(settings.bucket)}/${path}`
			: `${endpoint.protocol}//${settings.bucket}.${endpoint.host}${base}/${path}`;
	};

	const send = (method: string, key: string, init: { body?: Uint8Array; headers?: Record<string, string> } = {}) =>
		withSecret(async (secretAccessKey) => {
			const client = new AwsClient({
				accessKeyId: settings.accessKeyId,
				secretAccessKey,
				service: "s3",
				region: settings.region,
			});
			const body = init.body ?? new Uint8Array();
			const request = await client.sign(urlOf(key), {
				method,
				body: init.body ? new Uint8Array(init.body) : undefined,
				headers: { ...init.headers, "x-amz-content-sha256": await sha256Hex(body) },
				aws: { datetime: amzDate(clock.now()) },
			});
			try {
				return await http(request);
			} catch (error) {
				throw new StorageError(`The bucket at ${endpoint.origin} can't be reached.`, { cause: error });
			}
		});

	const refused = async (response: Response, action: string) => {
		const answer = await response.text().catch(() => "");
		const code = /<Code>([^<]+)<\/Code>/.exec(answer)?.[1];
		return new StorageError(`The bucket refused to ${action}: ${response.status}${code ? ` ${code}` : ""}.`);
	};

	return {
		kind: "s3",
		async put(key, data, contentType) {
			const response = await send("PUT", key, { body: data, headers: { "content-type": contentType } });
			if (!response.ok) throw await refused(response, "store a file");
			await response.body?.cancel();
		},
		async read(key) {
			const response = await send("GET", key);
			if (response.status === 404) {
				await response.body?.cancel();
				return null;
			}
			if (!response.ok) throw await refused(response, "read a file");
			return new Uint8Array(await response.arrayBuffer());
		},
		async stream(key, range?: ByteRange) {
			const headers: Record<string, string> = range ? { range: `bytes=${range.start}-${range.end}` } : {};
			const response = await send("GET", key, { headers });
			if (response.status === 404) {
				await response.body?.cancel();
				return null;
			}
			if (!response.ok) throw await refused(response, "read a file");
			return response.body ?? new ReadableStream({ start: (controller) => controller.close() });
		},
		async delete(key) {
			const response = await send("DELETE", key);
			await response.body?.cancel();
			if (!response.ok && response.status !== 404)
				throw new StorageError(`The bucket refused to remove a file: ${response.status}.`);
		},
	};
}

/** A time as AWS Signature Version 4 writes it: `20260302T090000Z`. */
function amzDate(date: Date): string {
	return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

async function sha256Hex(data: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(data)));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
