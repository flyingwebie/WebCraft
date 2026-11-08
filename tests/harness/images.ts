// Small images made inside the tests (never files copied from anywhere), and ways to look at what
// the Install serves back.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

export type PhotoOptions = {
	width: number;
	height: number;
	format?: "jpeg" | "png" | "webp" | "avif" | "gif";
	/** An EXIF orientation (1 to 8): how a camera says the picture must be turned to show it upright. */
	orientation?: number;
	/** Adds what a phone camera writes: its make and model, and where the photo was taken (GPS). */
	camera?: boolean;
};

/** The camera make a `camera: true` photo carries; it must never reach visitors. */
export const CAMERA_MAKE = "WebCraftTestCam";

/**
 * A photo: red on its left half and blue on its right half as stored, so a test can tell whether it
 * was turned upright.
 */
export async function photo(options: PhotoOptions): Promise<Uint8Array> {
	const { width, height } = options;
	const half = Math.max(1, Math.floor(width / 2));
	let image = sharp({ create: { width, height, channels: 3, background: { r: 255, g: 0, b: 0 } } }).composite([
		{
			input: { create: { width: width - half, height, channels: 3, background: { r: 0, g: 0, b: 255 } } },
			left: half,
			top: 0,
		},
	]);
	switch (options.format ?? "jpeg") {
		case "png":
			image = image.png();
			break;
		case "webp":
			image = image.webp();
			break;
		case "avif":
			image = image.avif();
			break;
		case "gif":
			image = image.gif();
			break;
		default:
			image = image.jpeg();
	}
	if (options.camera) {
		image = image.withExif({
			IFD0: { Make: CAMERA_MAKE, Model: "Pocket 9" },
			IFD3: { GPSLatitudeRef: "N", GPSLatitude: "53/1 20/1 31/1", GPSLongitudeRef: "W", GPSLongitude: "6/1 15/1 37/1" },
		});
	}
	if (options.orientation) image = image.withMetadata({ orientation: options.orientation });
	// Composite and metadata need a first pass before the format is written.
	return new Uint8Array(
		await sharp(await image.toBuffer())
			.keepMetadata()
			.toBuffer(),
	);
}

/** What a served image is: its format and size, and what metadata it still carries. */
export async function imageInfo(bytes: Uint8Array) {
	const metadata = await sharp(bytes).metadata();
	const exif = metadata.exif;
	return {
		format: metadata.format,
		width: metadata.width,
		height: metadata.height,
		orientation: metadata.orientation,
		exif: exif !== undefined,
		xmp: metadata.xmp !== undefined,
		/** Whether the EXIF data points at GPS data (tag 0x8825, either byte order). */
		gps: exif !== undefined && (exif.includes(Buffer.from([0x88, 0x25])) || exif.includes(Buffer.from([0x25, 0x88]))),
		/** Whether the camera make appears anywhere in the file. */
		camera: Buffer.from(bytes).includes(CAMERA_MAKE),
	};
}

/** The colour of one pixel, as `[red, green, blue]`. */
export async function pixel(bytes: Uint8Array, x: number, y: number): Promise<[number, number, number]> {
	const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
	const at = (y * info.width + x) * info.channels;
	return [data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0];
}

/**
 * A HEIC photo (the format phones take pictures in), made from a PNG with a HEIC encoder on this
 * machine: `sips` on macOS, `heif-enc` where libheif's tools are installed (CI installs them).
 * Undefined when there is none.
 */
export async function heicPhoto(options: { width: number; height: number }): Promise<Uint8Array | undefined> {
	const png = await photo({ ...options, format: "png" });
	const folder = mkdtempSync(join(tmpdir(), "webcraft-heic-"));
	try {
		const input = join(folder, "in.png");
		const output = join(folder, "out.heic");
		writeFileSync(input, png);
		const encoders = [
			["sips", "-s", "format", "heic", input, "--out", output],
			["heif-enc", "-q", "90", "-o", output, input],
		];
		for (const [command = "", ...args] of encoders) {
			const result = spawnSync(command, args, { stdio: "ignore" });
			if (result.status === 0) return new Uint8Array(readFileSync(output));
		}
		return undefined;
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
}

/** Whether this machine can make HEIC photos for the tests. */
export const canMakeHeic = ["sips", "heif-enc"].some(
	(command) => spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0,
);

/** A file as a browser uploads it. */
export function upload(bytes: Uint8Array | string, name: string, type = ""): File {
	return new File([typeof bytes === "string" ? bytes : new Uint8Array(bytes)], name, { type });
}

/** A small PDF: just enough of one to be recognised as one. */
export function pdf(text = "Allergen guide"): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(
		`%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% ${text}\ntrailer << /Root 1 0 R >>\n%%EOF\n`,
	);
}
