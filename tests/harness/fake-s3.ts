// A fake S3-compatible bucket behind the fake outgoing HTTP: WebCraft's real S3 storage talks to it
// through `services.http`, never the internet. It checks every request's AWS Signature Version 4
// with its own implementation (node:crypto), so a request WebCraft signs wrongly is refused the way
// a real bucket refuses it. It takes multipart uploads (Backups go up that way) as S3 does: started
// with `POST ?uploads`, a `PUT` per part, then `POST ?uploadId` with the parts' ETags, or a `DELETE
// ?uploadId` that aborts it.
import { createHash, createHmac } from "node:crypto";

import type { FakeAnswer, FakeHttp, RecordedRequest } from "./fake-http.ts";

export type FakeS3Options = {
	/** Where the bucket answers, such as `https://s3.storage.test`; path-style addressing. */
	endpoint: string;
	bucket: string;
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
};

export type FakeS3Object = { body: Uint8Array; contentType: string | null };

export type FakeS3 = FakeS3Options & {
	/** Every object in the bucket, by key. */
	readonly objects: ReadonlyMap<string, FakeS3Object>;
	/** Every request the bucket received, with whether its signature held. */
	readonly requests: readonly { method: string; key: string; signed: boolean }[];
	/** Multipart uploads started and neither finished nor aborted. */
	readonly openUploads: number;
	/** Make the bucket fail a method until recovered (an external storage outage). */
	fail(method: string, status: number): void;
	recover(): void;
};

/** Answers S3 requests for one bucket on the fake outgoing HTTP. */
export function createFakeS3(http: FakeHttp, options: FakeS3Options): FakeS3 {
	const objects = new Map<string, FakeS3Object>();
	const failures = new Map<string, number>();
	const requests: { method: string; key: string; signed: boolean }[] = [];
	const uploads = new Map<string, { key: string; contentType: string | null; parts: Map<number, Uint8Array> }>();
	const prefix = `${options.endpoint.replace(/\/$/, "")}/${options.bucket}/`;
	const matcher = new RegExp(`^${escapeRegExp(prefix)}`);

	const answer = (request: RecordedRequest): FakeAnswer => {
		const url = new URL(request.url);
		const key = decodeURIComponent(url.pathname.slice(`/${options.bucket}/`.length));
		const signed = signatureHolds(request, options);
		requests.push({ method: request.method, key, signed });
		if (!signed) return xmlError(403, "SignatureDoesNotMatch");
		const failure = failures.get(request.method);
		if (failure) return xmlError(failure, "StorageUnavailable");
		const uploadId = url.searchParams.get("uploadId");
		if (request.method === "POST" && url.searchParams.has("uploads")) {
			const id = crypto.randomUUID();
			uploads.set(id, { key, contentType: request.headers.get("content-type"), parts: new Map() });
			return xml(
				200,
				`<InitiateMultipartUploadResult><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
			);
		}
		if (uploadId !== null) {
			const upload = uploads.get(uploadId);
			if (!upload || upload.key !== key) return xmlError(404, "NoSuchUpload");
			if (request.method === "PUT") {
				upload.parts.set(Number(url.searchParams.get("partNumber")), request.bytes);
				return { status: 200, headers: { etag: `"${md5Hex(request.bytes)}"` } };
			}
			if (request.method === "DELETE") {
				uploads.delete(uploadId);
				return { status: 204 };
			}
			if (request.method === "POST") {
				const listed = [...request.body.matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>([^<]+)<\/ETag>/g)];
				const parts = listed.map(([, number, etag]) => ({ part: upload.parts.get(Number(number)), etag }));
				if (
					parts.length === 0 ||
					parts.some(({ part, etag }) => !part || etag?.replaceAll("&quot;", '"') !== `"${md5Hex(part)}"`)
				) {
					return xmlError(400, "InvalidPart");
				}
				const body = Buffer.concat(parts.map(({ part }) => part ?? new Uint8Array()));
				objects.set(key, { body: new Uint8Array(body), contentType: upload.contentType });
				uploads.delete(uploadId);
				return xml(200, `<CompleteMultipartUploadResult><Key>${key}</Key></CompleteMultipartUploadResult>`);
			}
		}
		switch (request.method) {
			case "PUT":
				objects.set(key, { body: request.bytes, contentType: request.headers.get("content-type") });
				return { status: 200, headers: { etag: `"${sha256Hex(request.bytes)}"` } };
			case "GET":
			case "HEAD": {
				const object = objects.get(key);
				if (!object) return xmlError(404, "NoSuchKey");
				const headers: Record<string, string> = { "content-type": object.contentType ?? "application/octet-stream" };
				const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "");
				if (range) {
					const start = Number(range[1]);
					const end = range[2] ? Math.min(Number(range[2]), object.body.length - 1) : object.body.length - 1;
					const part = object.body.subarray(start, end + 1);
					return {
						status: 206,
						body: request.method === "HEAD" ? null : part,
						headers: {
							...headers,
							"content-length": String(part.length),
							"content-range": `bytes ${start}-${end}/${object.body.length}`,
						},
					};
				}
				return {
					status: 200,
					body: request.method === "HEAD" ? null : object.body,
					headers: { ...headers, "content-length": String(object.body.length) },
				};
			}
			case "DELETE":
				objects.delete(key);
				return { status: 204 };
			default:
				return xmlError(405, "MethodNotAllowed");
		}
	};

	for (const method of ["PUT", "GET", "HEAD", "DELETE", "POST"]) http.respond(method, matcher, answer);
	return {
		...options,
		objects,
		fail(method, status) {
			failures.set(method.toUpperCase(), status);
		},
		recover() {
			failures.clear();
		},
		requests,
		get openUploads() {
			return uploads.size;
		},
	};
}

/** Whether a request carries a valid AWS Signature Version 4 for the bucket's credentials. */
function signatureHolds(request: RecordedRequest, options: FakeS3Options): boolean {
	const authorization = request.headers.get("authorization") ?? "";
	const parsed =
		/^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, ?SignedHeaders=([^,]+), ?Signature=([0-9a-f]{64})$/.exec(
			authorization,
		);
	if (!parsed) return false;
	const [, accessKeyId, day, region, signedHeaders = "", signature] = parsed;
	if (accessKeyId !== options.accessKeyId || region !== options.region) return false;
	const amzDate = request.headers.get("x-amz-date") ?? "";
	if (!amzDate.startsWith(day ?? "-")) return false;
	const payloadHash = request.headers.get("x-amz-content-sha256") ?? "";
	if (payloadHash !== "UNSIGNED-PAYLOAD" && payloadHash !== sha256Hex(request.bytes)) return false;

	const url = new URL(request.url);
	const headerNames = signedHeaders.split(";");
	if (!headerNames.includes("host") || !headerNames.includes("x-amz-date")) return false;
	const canonicalHeaders = headerNames
		.map((name) => {
			const value = name === "host" ? (request.headers.get("host") ?? url.host) : (request.headers.get(name) ?? "");
			return `${name}:${value.trim().replace(/\s+/g, " ")}\n`;
		})
		.join("");
	const canonicalQuery = [...url.searchParams]
		.map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)])
		.sort(([a = ""], [b = ""]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([key, value]) => `${key}=${value}`)
		.join("&");
	const canonicalRequest = [
		request.method,
		url.pathname,
		canonicalQuery,
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	].join("\n");
	const scope = `${day}/${region}/s3/aws4_request`;
	const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
	let key: Buffer = hmac(`AWS4${options.secretAccessKey}`, day ?? "");
	for (const part of [region ?? "", "s3", "aws4_request"]) key = hmac(key, part);
	return hmac(key, stringToSign).toString("hex") === signature;
}

function hmac(key: string | Buffer, data: string): Buffer {
	return createHmac("sha256", key).update(data).digest();
}

function md5Hex(data: Uint8Array): string {
	return createHash("md5").update(data).digest("hex");
}

function xml(status: number, body: string): FakeAnswer {
	return {
		status,
		body: `<?xml version="1.0" encoding="UTF-8"?>${body}`,
		headers: { "content-type": "application/xml" },
	};
}

function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function encodeRfc3986(text: string): string {
	return encodeURIComponent(text).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function xmlError(status: number, code: string): FakeAnswer {
	return {
		status,
		body: `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code></Error>`,
		headers: { "content-type": "application/xml" },
	};
}
