// Image processing for the Media library (ADR 0027), with sharp (libvips). Only the worker on Node
// loads it, and the test harness, which drains the worker's jobs; the web process never does.
// HEIC photos are decoded with libheif (WebAssembly), since sharp's own libvips reads only AVIF of
// the HEIF family.
/// <reference path="./heic-decode.d.ts" />
import {
	type ImageInput,
	type ImageProcessor,
	ImageUnreadableError,
	type OriginalFormat,
	type ProcessedImage,
	type VariantFormat,
} from "@webcraft/core";
import decodeHeic from "heic-decode";
import sharp, { type Sharp } from "sharp";

/** The largest image read, in pixels (sharp's own default): a guard against decompression bombs. */
const MAX_INPUT_PIXELS = 268_402_689;

export type ImageProcessorOptions = {
	/** The largest image read, in pixels; checked before an image is decoded. */
	maxInputPixels?: number;
};

/** Encoder settings: good-looking, small files, at a speed a worker can keep up with. */
const ORIGINAL_SETTINGS = {
	jpeg: { quality: 90, mozjpeg: true },
	png: { compressionLevel: 9 },
	webp: { quality: 90 },
	avif: { quality: 70, effort: 4 },
} as const;
const VARIANT_SETTINGS = { avif: { quality: 55, effort: 4 }, webp: { quality: 78 } } as const;

/** The real image processing: the worker hands it to its services, and so does the test harness. */
export function createImageProcessor(options: ImageProcessorOptions = {}): ImageProcessor {
	const maxInputPixels = options.maxInputPixels ?? MAX_INPUT_PIXELS;
	return {
		async prepare(input, format) {
			const source = await open(input, format, maxInputPixels);
			const outputFormat: OriginalFormat = format === "heic" ? "jpeg" : format;
			// sharp writes no metadata unless asked to: EXIF (with GPS and camera data), XMP and IPTC are
			// dropped. `autoOrient` turns the pixels upright first, so the orientation tag isn't needed.
			const image = encode(source.autoOrient().toColourspace("srgb"), outputFormat, ORIGINAL_SETTINGS[outputFormat]);
			return finish(image, outputFormat);
		},
		async variant(original, width, format) {
			const image = encode(
				sharp(original, { limitInputPixels: maxInputPixels }).resize({ width, withoutEnlargement: true }),
				format,
				VARIANT_SETTINGS[format],
			);
			return finish(image, format);
		},
	};
}

async function open(input: Uint8Array, format: ImageInput, maxInputPixels: number): Promise<Sharp> {
	if (format !== "heic") return sharp(input, { limitInputPixels: maxInputPixels, failOn: "error" });
	try {
		// The size comes from the file's headers, so a small file that declares a huge image is refused
		// before any pixels are decoded (decoding first would allocate them all).
		const images = await decodeHeic.all({ buffer: input });
		try {
			const [first] = images;
			if (!first) throw new ImageUnreadableError("The HEIC photo holds no image.");
			if (first.width * first.height > maxInputPixels) {
				throw new ImageUnreadableError("The photo is too large to process.");
			}
			// libheif applies the photo's rotation and mirroring as it decodes.
			const { width, height, data } = await first.decode();
			return sharp(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), {
				raw: { width, height, channels: 4 },
			});
		} finally {
			images.dispose();
		}
	} catch (error) {
		if (error instanceof ImageUnreadableError) throw error;
		throw new ImageUnreadableError("The HEIC photo can't be read.", { cause: error });
	}
}

function encode(image: Sharp, format: OriginalFormat | VariantFormat, settings: object): Sharp {
	switch (format) {
		case "jpeg":
			return image.jpeg(settings);
		case "png":
			return image.png(settings);
		case "webp":
			return image.webp(settings);
		case "avif":
			return image.avif(settings);
	}
}

async function finish<Format extends OriginalFormat | VariantFormat>(
	image: Sharp,
	format: Format,
): Promise<ProcessedImage & { format: Format }> {
	try {
		const { data, info } = await image.toBuffer({ resolveWithObject: true });
		return {
			data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
			format,
			width: info.width,
			height: info.height,
		};
	} catch (error) {
		throw new ImageUnreadableError("The image can't be read.", { cause: error });
	}
}
