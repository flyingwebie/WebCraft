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

export type S3ClientOptions = {
	settings: S3Settings;
	http: OutgoingHttp;
	clock: Clock;
	/** Runs `use` with the bucket's secret access key, which never leaves the call. */
	withSecret<Result>(use: (secretAccessKey: string) => Promise<Result>): Promise<Result>;
};

/** A request to a bucket: a method, a key and, optionally, query parameters, a body and headers. */
export type S3Request = {
	query?: Record<string, string>;
	body?: Uint8Array;
	headers?: Record<string, string>;
};

/** Signed requests to one bucket: what `s3Storage` and Backups to a bucket send. */
export type S3Client = {
	/** Where the bucket keeps `key`, such as `https://s3.example/bucket/prefix/key`. */
	urlOf(key: string): string;
	/** Sends one request signed with AWS Signature Version 4; `StorageError` when the bucket can't be reached. */
	send(method: string, key: string, request?: S3Request): Promise<Response>;
};

/** Signs and sends requests to an S3-compatible bucket through the Install's outgoing HTTP. */
export function s3Client({ settings, http, clock, withSecret }: S3ClientOptions): S3Client {
	const endpoint = new URL(settings.endpoint);
	const prefix = settings.prefix.replace(/^\/+|\/+$/g, "");

	const urlOf = (key: string) => {
		const path = [...(prefix ? prefix.split("/") : []), ...keyParts(key)].map(encodeURIComponent).join("/");
		const base = endpoint.pathname.replace(/\/+$/, "");
		return settings.pathStyle
			? `${endpoint.origin}${base}/${encodeURIComponent(settings.bucket)}/${path}`
			: `${endpoint.protocol}//${settings.bucket}.${endpoint.host}${base}/${path}`;
	};

	const send = (method: string, key: string, init: S3Request = {}) =>
		withSecret(async (secretAccessKey) => {
			const client = new AwsClient({
				accessKeyId: settings.accessKeyId,
				secretAccessKey,
				service: "s3",
				region: settings.region,
			});
			const body = init.body ?? new Uint8Array();
			const url = new URL(urlOf(key));
			for (const [name, value] of Object.entries(init.query ?? {})) url.searchParams.set(name, value);
			const request = await client.sign(url.toString(), {
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

	return { urlOf, send };
}

/**
 * An S3-compatible bucket (AWS S3, Cloudflare R2, MinIO and others), spoken to through the Install's
 * outgoing HTTP with requests signed with AWS Signature Version 4.
 */
export function s3Storage(options: S3ClientOptions): StorageBackend {
	const { send } = s3Client(options);

	return {
		kind: "s3",
		async put(key, data, contentType) {
			const response = await send("PUT", key, { body: data, headers: { "content-type": contentType } });
			if (!response.ok) throw await refused(response, "store a file");
			await response.body?.cancel();
		},
		async putStream(key, data, contentType) {
			await writeS3Stream({ send }, key, data, contentType);
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

/** The error for a bucket's refusal, with its status and S3 error code. */
export async function refused(response: Response, action: string): Promise<StorageError> {
	const answer = await response.text().catch(() => "");
	const code = /<Code>([^<]+)<\/Code>/.exec(answer)?.[1];
	return new StorageError(`The bucket refused to ${action}: ${response.status}${code ? ` ${code}` : ""}.`);
}

/** A time as AWS Signature Version 4 writes it: `20260302T090000Z`. */
function amzDate(date: Date): string {
	return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

async function sha256Hex(data: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(data)));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Multipart upload: abort on any source, checksum or bucket failure. */
export async function writeS3Stream(
	client: Pick<S3Client, "send">,
	key: string,
	bytes: AsyncIterable<Uint8Array>,
	contentType: string,
	partBytes = 5 * 1024 * 1024,
): Promise<number> {
	const started = await client.send("POST", key, {
		query: { uploads: "" },
		headers: { "content-type": contentType },
	});
	if (!started.ok) throw await refused(started, "start an upload");
	const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await started.text())?.[1];
	if (!uploadId) throw new StorageError("The bucket started an upload without saying its id.");
	const parts: { number: number; etag: string }[] = [];
	let size = 0;
	try {
		for await (const part of inParts(bytes, partBytes)) {
			const number = parts.length + 1;
			const response = await client.send("PUT", key, {
				query: { partNumber: String(number), uploadId },
				body: part,
			});
			if (!response.ok) throw await refused(response, "store part of a file");
			await response.body?.cancel();
			const etag = response.headers.get("etag");
			if (!etag) throw new StorageError("The bucket stored part of a file without saying its ETag.");
			parts.push({ number, etag });
			size += part.length;
		}
		const list = parts
			.map((part) => `<Part><PartNumber>${part.number}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`)
			.join("");
		const done = await client.send("POST", key, {
			query: { uploadId },
			body: new TextEncoder().encode(`<CompleteMultipartUpload>${list}</CompleteMultipartUpload>`),
			headers: { "content-type": "application/xml" },
		});
		// A bucket can answer 200 and still say the upload failed.
		const answer = await done.text();
		if (!done.ok || answer.includes("<Error>")) {
			const code = /<Code>([^<]+)<\/Code>/.exec(answer)?.[1];
			throw new StorageError(`The bucket refused to finish the upload: ${done.status}${code ? ` ${code}` : ""}.`);
		}
	} catch (error) {
		await client
			.send("DELETE", key, { query: { uploadId } })
			.then((response) => response.body?.cancel())
			.catch(() => {});
		throw error;
	}
	return size;
}
/** Regroups chunks into parts of `size` bytes (the last one smaller); one empty part for no bytes. */
async function* inParts(bytes: AsyncIterable<Uint8Array>, size: number): AsyncGenerator<Uint8Array> {
	let part = new Uint8Array(size);
	let filled = 0;
	let sent = false;
	for await (const chunk of bytes) {
		let offset = 0;
		while (offset < chunk.length) {
			const taken = Math.min(size - filled, chunk.length - offset);
			part.set(chunk.subarray(offset, offset + taken), filled);
			filled += taken;
			offset += taken;
			if (filled === size) {
				yield part;
				sent = true;
				part = new Uint8Array(size);
				filled = 0;
			}
		}
	}
	if (filled > 0 || !sent) yield part.subarray(0, filled);
}

function escapeXml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
