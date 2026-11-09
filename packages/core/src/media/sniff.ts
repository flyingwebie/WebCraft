/**
 * What an uploaded file is, read from its first bytes. The name and the type the browser claims are
 * never trusted: a page named `photo.jpg` stays a page, and is refused.
 */

import type { MediaKind } from "./kinds.ts";

/** A file format WebCraft accepts, how it is stored and served, and what happens to it. */
export type FileFormat = {
	format: string;
	kind: MediaKind;
	contentType: string;
	/** The extension its served name ends in. */
	extension: string;
	/**
	 * `clean`: an image the worker strips, turns upright and resizes before anyone sees it.
	 * `as-is`: stored and served as uploaded (documents, video, audio, and GIFs, which keep their
	 * animation).
	 */
	handling: "clean" | "as-is";
};

const FORMATS = {
	jpeg: { format: "jpeg", kind: "image", contentType: "image/jpeg", extension: "jpg", handling: "clean" },
	png: { format: "png", kind: "image", contentType: "image/png", extension: "png", handling: "clean" },
	webp: { format: "webp", kind: "image", contentType: "image/webp", extension: "webp", handling: "clean" },
	avif: { format: "avif", kind: "image", contentType: "image/avif", extension: "avif", handling: "clean" },
	heic: { format: "heic", kind: "image", contentType: "image/heic", extension: "heic", handling: "clean" },
	gif: { format: "gif", kind: "image", contentType: "image/gif", extension: "gif", handling: "as-is" },
	pdf: { format: "pdf", kind: "document", contentType: "application/pdf", extension: "pdf", handling: "as-is" },
	mp4: { format: "mp4", kind: "video", contentType: "video/mp4", extension: "mp4", handling: "as-is" },
	mov: { format: "mov", kind: "video", contentType: "video/quicktime", extension: "mov", handling: "as-is" },
	webm: { format: "webm", kind: "video", contentType: "video/webm", extension: "webm", handling: "as-is" },
	m4a: { format: "m4a", kind: "audio", contentType: "audio/mp4", extension: "m4a", handling: "as-is" },
	mp3: { format: "mp3", kind: "audio", contentType: "audio/mpeg", extension: "mp3", handling: "as-is" },
	ogg: { format: "ogg", kind: "audio", contentType: "audio/ogg", extension: "ogg", handling: "as-is" },
	wav: { format: "wav", kind: "audio", contentType: "audio/wav", extension: "wav", handling: "as-is" },
	flac: { format: "flac", kind: "audio", contentType: "audio/flac", extension: "flac", handling: "as-is" },
} as const satisfies Record<string, FileFormat>;

/** A format WebCraft stores, by name. */
export function fileFormat(format: string): FileFormat | undefined {
	return Object.hasOwn(FORMATS, format) ? FORMATS[format as keyof typeof FORMATS] : undefined;
}

/** What a file's first bytes say it is: a format, an SVG (refused until SVGs are cleaned), or unknown. */
export type Sniffed = { format: FileFormat } | { refused: "svg" | "unknown" };

/** The ISO base media brands (the box after `ftyp`) of HEIC and HEIF photos. */
const HEIC_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs", "mif1", "msf1"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);
const QUICKTIME_BRANDS = new Set(["qt  "]);
const AUDIO_MP4_BRANDS = new Set(["M4A ", "M4B ", "M4P "]);

/** Reads what a file is from its bytes. */
export function sniff(bytes: Uint8Array): Sniffed {
	const ascii = (start: number, length: number) =>
		String.fromCharCode(...bytes.subarray(start, Math.min(bytes.length, start + length)));
	const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);

	if (bytes.length < 4) return { refused: "unknown" };
	if (starts(0xff, 0xd8, 0xff)) return { format: FORMATS.jpeg };
	if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { format: FORMATS.png };
	if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return { format: FORMATS.gif };
	if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return { format: FORMATS.webp };
	if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return { format: FORMATS.wav };
	if (ascii(0, 5) === "%PDF-") return { format: FORMATS.pdf };
	if (starts(0x1a, 0x45, 0xdf, 0xa3)) return { format: FORMATS.webm };
	if (ascii(0, 4) === "OggS") return { format: FORMATS.ogg };
	if (ascii(0, 4) === "fLaC") return { format: FORMATS.flac };
	if (ascii(0, 3) === "ID3" || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) {
		return { format: FORMATS.mp3 };
	}
	if (ascii(4, 4) === "ftyp") return isoBaseMedia(bytes, ascii);
	if (looksLikeSvg(bytes)) return { refused: "svg" };
	return { refused: "unknown" };
}

/** An ISO base media file (MP4, MOV, M4A, HEIC, AVIF): which one, from its brands. */
function isoBaseMedia(bytes: Uint8Array, ascii: (start: number, length: number) => string): Sniffed {
	const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
	const end = Math.min(bytes.length, Math.max(16, boxSize));
	const brands = [ascii(8, 4)];
	for (let at = 16; at + 4 <= end; at += 4) brands.push(ascii(at, 4));
	if (brands.some((brand) => AVIF_BRANDS.has(brand))) return { format: FORMATS.avif };
	if (brands.some((brand) => HEIC_BRANDS.has(brand))) return { format: FORMATS.heic };
	if (QUICKTIME_BRANDS.has(brands[0] ?? "")) return { format: FORMATS.mov };
	if (AUDIO_MP4_BRANDS.has(brands[0] ?? "")) return { format: FORMATS.m4a };
	return { format: FORMATS.mp4 };
}

/** Whether a file is SVG text (or XML that holds an SVG). */
function looksLikeSvg(bytes: Uint8Array): boolean {
	const head = new TextDecoder("utf-8", { fatal: false })
		.decode(bytes.subarray(0, 4096))
		.replace(/^﻿/, "")
		.trimStart()
		.toLowerCase();
	return (
		head.startsWith("<svg") || ((head.startsWith("<?xml") || head.startsWith("<!doctype svg")) && head.includes("<svg"))
	);
}

/** The size of a GIF, from its header. */
export function gifSize(bytes: Uint8Array): { width: number; height: number } | undefined {
	if (bytes.length < 10) return undefined;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}
