/**
 * Image processing (ADR 0027): a port, because it runs only in the worker on Node. The image
 * library is known to break under Bun in some Docker images, and resizing is slow CPU work that must
 * stay out of the request path, so the web process never loads it. The worker (and the test harness)
 * hand in the real one, `@webcraft/worker/images`; every other process gets `imagesOnlyInWorker`.
 */

/** The image formats the worker reads: what a phone or a camera uploads. */
export type ImageInput = "jpeg" | "png" | "webp" | "avif" | "heic";

/** The formats of a cleaned original: a HEIC photo becomes a JPEG, the others keep their own. */
export type OriginalFormat = "jpeg" | "png" | "webp" | "avif";

/** The formats every width is made in. */
export const VARIANT_FORMATS = ["avif", "webp"] as const;

export type VariantFormat = (typeof VARIANT_FORMATS)[number];

/**
 * The fixed widths made of every image, never larger than the original (ADR 0027). Adding one later
 * means running the variants job over the library again.
 */
export const VARIANT_WIDTHS = [320, 640, 960, 1280, 1920, 2560] as const;

/** An image the worker made, in pixels. */
export type ProcessedImage = {
	data: Uint8Array;
	format: OriginalFormat | VariantFormat;
	width: number;
	height: number;
};

export type ImageProcessor = {
	/**
	 * The cleaned original of an upload: every piece of metadata stripped (GPS, camera, EXIF, XMP,
	 * IPTC), turned upright by its EXIF orientation, in sRGB, and a HEIC photo converted to JPEG.
	 * Throws `ImageUnreadableError` for a file that isn't a readable image.
	 */
	prepare(input: Uint8Array, format: ImageInput): Promise<ProcessedImage & { format: OriginalFormat }>;
	/** One width of a cleaned original, in AVIF or WebP. */
	variant(original: Uint8Array, width: number, format: VariantFormat): Promise<ProcessedImage>;
	/**
	 * An uploaded SVG, cleaned: what only a drawing program reads (comments, metadata, editor
	 * attributes) left out, everything that shows kept, through a well-maintained sanitizer. Throws
	 * `SvgRefusedError` when it can't be read, or when cleaning would change what it shows (scripts,
	 * event handlers, `foreignObject`, outside references, entities): such a file is refused rather
	 * than changed. Never resized; its size comes from its own `width`/`height` or `viewBox`.
	 */
	cleanSvg(input: Uint8Array): Promise<CleanedSvg>;
};

/** A cleaned SVG and its size in CSS pixels, when it says one. */
export type CleanedSvg = { data: Uint8Array; width: number | null; height: number | null };

/**
 * What an SVG holds that keeps it from being kept: `script`, `eventHandler`, `foreignObject`,
 * `outsideReference` (anything loaded from elsewhere, or a link out), `entity`, `element` or
 * `attribute` (something else the sanitizer would have removed).
 */
export type SvgFinding =
	| "script"
	| "eventHandler"
	| "foreignObject"
	| "outsideReference"
	| "entity"
	| "element"
	| "attribute";

/**
 * An SVG the worker refused: `svgInvalid` (it can't be read as SVG) or `svgUnsafe` (cleaning would
 * change what it shows; `found` lists what it holds). Trying again won't help.
 */
export class SvgRefusedError extends Error {
	override name = "SvgRefusedError";
	readonly reason: "svgInvalid" | "svgUnsafe";
	readonly found: readonly SvgFinding[];
	constructor(reason: "svgInvalid" | "svgUnsafe", found: readonly SvgFinding[] = [], detail?: string) {
		super(
			reason === "svgInvalid"
				? `The file can't be read as SVG${detail ? `: ${detail}` : "."}`
				: `The SVG holds what can't be kept: ${found.join(", ")}.`,
		);
		this.reason = reason;
		this.found = found;
	}
}

/** A file that claims to be an image but can't be read as one. Trying again won't help. */
export class ImageUnreadableError extends Error {
	override name = "ImageUnreadableError";
}

/** The widths made of an image `width` pixels wide: every fixed width up to its own. */
export function variantWidths(width: number): number[] {
	return VARIANT_WIDTHS.filter((each) => each <= width);
}

/** What the web process and server commands have: they never process images themselves. */
export const imagesOnlyInWorker: ImageProcessor = {
	prepare: () => Promise.reject(new Error("Images are processed only in the worker.")),
	variant: () => Promise.reject(new Error("Images are processed only in the worker.")),
	cleanSvg: () => Promise.reject(new Error("SVG files are cleaned only in the worker.")),
};
