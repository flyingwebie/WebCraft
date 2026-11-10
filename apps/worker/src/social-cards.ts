/** Original Social card artwork, rasterised only in the worker. No browser, scripts, URLs or external assets. */
import { SOCIAL_CARD_HEIGHT, SOCIAL_CARD_WIDTH, type SocialCardRenderer } from "@webcraft/core";
import sharp, { type OverlayOptions } from "sharp";

type Box = { x: number; y: number; width: number; height: number };

export function createSocialCardRenderer(): SocialCardRenderer {
	return {
		async render(input) {
			const colour = (value: string, fallback: string) =>
				/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value) ? value.slice(0, 7) : fallback;
			const primary = colour(input.colours.primary, "#2563eb");
			const accent = colour(input.colours.accent, "#f97316");
			const background = colour(input.colours.background, "#fafafa");
			const text = readable(colour(input.colours.text, "#18181b"), background);
			const onPrimary = readable("#ffffff", primary);
			let box: Box = { x: 80, y: 200, width: 1040, height: 300 };
			let logo: Box = { x: 80, y: 62, width: 160, height: 90 };
			let label: Box = { x: 80, y: 545, width: 1040, height: 40 };
			let ink = text;
			let labelInk = text;
			let align: "left" | "centre" = "left";
			const rect = (x: number, y: number, w: number, h: number, fill: string, r = 0) =>
				`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"/>`;
			const circle = (x: number, y: number, r: number, fill: string) =>
				`<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"/>`;
			let art = rect(0, 0, 1200, 630, background);
			switch (input.layout) {
				case "editorial":
					art += rect(80, 168, 1040, 8, primary) + rect(80, 510, 120, 6, accent);
					break;
				case "frame":
					art += rect(24, 24, 1152, 582, primary, 16) + rect(40, 40, 1120, 550, background, 8);
					box = { x: 100, y: 210, width: 1000, height: 270 };
					logo = { x: 520, y: 72, width: 160, height: 90 };
					align = "centre";
					break;
				case "split":
					art += rect(820, 0, 380, 630, primary) + circle(1000, 330, 130, accent);
					box = { x: 70, y: 155, width: 690, height: 340 };
					logo = { x: 920, y: 260, width: 160, height: 110 };
					label = { x: 70, y: 540, width: 680, height: 40 };
					break;
				case "band":
					art += rect(0, 170, 1200, 300, primary);
					box = { x: 80, y: 205, width: 1040, height: 230 };
					ink = onPrimary;
					break;
				case "corner":
					art += `<path d="M880 0H1200V320Z" fill="${primary}"/>${rect(0, 580, 1200, 50, accent)}`;
					box = { x: 80, y: 200, width: 890, height: 290 };
					label.y = 520;
					break;
				case "orbit":
					art += circle(1080, 90, 220, primary) + circle(1080, 90, 150, background) + circle(1030, 215, 45, accent);
					box = { x: 80, y: 210, width: 780, height: 300 };
					break;
				case "arch":
					art += rect(880, 190, 250, 500, primary, 125) + rect(940, 300, 130, 400, accent, 65);
					box = { x: 70, y: 190, width: 750, height: 320 };
					label.width = 730;
					break;
				case "steps":
					art +=
						rect(950, 370, 250, 260, primary) + rect(1040, 250, 160, 120, accent) + rect(1120, 130, 80, 120, primary);
					box = { x: 80, y: 200, width: 820, height: 310 };
					label.width = 800;
					break;
				case "grid":
					for (let x = 0; x < 1200; x += 100) art += rect(x, 0, 1, 630, primary);
					for (let y = 0; y < 630; y += 90) art += rect(0, y, 1200, 1, primary);
					art += rect(50, 45, 1100, 540, background, 18);
					box = { x: 95, y: 205, width: 1010, height: 300 };
					logo.x = 95;
					label.x = 95;
					break;
				case "spotlight":
					art += circle(600, 320, 410, primary) + circle(600, 320, 370, background) + circle(1080, 540, 55, accent);
					box = { x: 290, y: 205, width: 620, height: 270 };
					logo = { x: 520, y: 72, width: 160, height: 90 };
					label = { x: 360, y: 530, width: 480, height: 40 };
					align = "centre";
					break;
				case "ribbon":
					art += `${rect(0, 0, 38, 630, primary)}<path d="M980 0H1120V205L1050 160L980 205Z" fill="${accent}"/>`;
					box = { x: 100, y: 210, width: 900, height: 300 };
					logo.x = 100;
					label.x = 100;
					break;
				case "window":
					art +=
						rect(55, 45, 1090, 540, primary, 24) +
						rect(70, 110, 1060, 460, background, 12) +
						circle(93, 78, 9, background) +
						circle(125, 78, 9, accent) +
						circle(157, 78, 9, background);
					logo = { x: 95, y: 130, width: 140, height: 75 };
					box = { x: 95, y: 245, width: 1010, height: 250 };
					label = { x: 95, y: 520, width: 1010, height: 35 };
					break;
				case "stack":
					art +=
						rect(75, 65, 1050, 510, accent, 16) +
						rect(55, 45, 1050, 510, primary, 16) +
						rect(35, 25, 1050, 510, background, 16);
					logo = { x: 85, y: 65, width: 150, height: 85 };
					box = { x: 85, y: 180, width: 940, height: 270 };
					label = { x: 85, y: 475, width: 940, height: 35 };
					break;
				case "diagonal":
					art +=
						'<path d="M900 0H1200V630H600Z" fill="' +
						primary +
						'"/><path d="M1120 0H1200V630H820Z" fill="' +
						accent +
						'"/>';
					box = { x: 65, y: 180, width: 550, height: 330 };
					label.width = 510;
					break;
				case "horizon":
					art += rect(0, 420, 1200, 210, primary) + circle(1030, 420, 95, accent);
					box = { x: 80, y: 175, width: 1040, height: 210 };
					logo.y = 48;
					labelInk = onPrimary;
					break;
				case "columns":
					art += rect(0, 0, 240, 630, primary) + rect(255, 0, 12, 630, accent);
					logo = { x: 40, y: 70, width: 160, height: 110 };
					box = { x: 320, y: 140, width: 800, height: 360 };
					label = { x: 320, y: 545, width: 800, height: 40 };
					break;
				case "ticket":
					art +=
						rect(40, 40, 1120, 550, primary, 30) +
						rect(58, 58, 1084, 514, background, 20) +
						circle(40, 315, 35, background) +
						circle(1160, 315, 35, background);
					for (let y = 80; y < 560; y += 28) art += rect(910, y, 3, 13, primary);
					box = { x: 100, y: 195, width: 750, height: 310 };
					logo = { x: 952, y: 260, width: 140, height: 110 };
					label = { x: 100, y: 530, width: 750, height: 35 };
					break;
				case "underline":
					box = { x: 120, y: 150, width: 960, height: 310 };
					logo = { x: 960, y: 40, width: 150, height: 85 };
					art += rect(120, 485, 720, 22, primary) + rect(850, 485, 140, 22, accent);
					label.x = 120;
					break;
				case "mosaic":
					art +=
						rect(900, 0, 300, 210, primary) +
						circle(1050, 315, 100, accent) +
						rect(900, 420, 150, 210, accent) +
						rect(1050, 420, 150, 210, primary);
					box = { x: 75, y: 190, width: 765, height: 320 };
					label.width = 765;
					break;
				case "capsule":
					art += rect(35, 35, 1130, 560, primary, 200) + rect(58, 58, 1084, 514, background, 180);
					box = { x: 180, y: 210, width: 840, height: 285 };
					logo = { x: 520, y: 80, width: 160, height: 85 };
					label = { x: 180, y: 530, width: 840, height: 35 };
					align = "centre";
					break;
			}
			// A neutral backing keeps a transparent logo legible on every composition.
			if (input.layout === "split" || input.layout === "columns")
				art += rect(logo.x - 12, logo.y - 12, logo.width + 24, logo.height + 24, background, 16);
			const overlays: OverlayOptions[] = [];
			const title = limited(input.title || input.siteName || "—", 240);
			overlays.push(await textLayer(title, box, ink, 64, align));
			overlays.push(await textLayer(limited(input.siteName || "—", 80), label, labelInk, 26, align));
			if (input.logo) {
				// Decode only a bounded raster image. SVG and all non-raster inputs are refused, including forged port inputs.
				const source = sharp(input.logo, { limitInputPixels: 40_000_000, failOn: "error" });
				const metadata = await source.metadata();
				if (!["jpeg", "png", "webp", "avif", "heif", "gif"].includes(metadata.format ?? ""))
					throw new Error("A Social card logo must be a raster image.");
				const bytes = await source
					.resize({ width: logo.width, height: logo.height, fit: "inside" })
					.png()
					.toBuffer({ resolveWithObject: true });
				overlays.push({
					input: bytes.data,
					left: logo.x + Math.floor((logo.width - bytes.info.width) / 2),
					top: logo.y + Math.floor((logo.height - bytes.info.height) / 2),
				});
			} else {
				// A missing logo leaves a small original brand mark, never a broken image.
				art += rect(logo.x, logo.y + 18, 42, 42, primary, 10) + circle(logo.x + 57, logo.y + 39, 13, accent);
			}
			const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SOCIAL_CARD_WIDTH}" height="${SOCIAL_CARD_HEIGHT}">${art}</svg>`;
			return new Uint8Array(await sharp(Buffer.from(svg)).composite(overlays).png().toBuffer());
		},
	};
}

/** Pango handles Unicode shaping, bidi and word/character wrapping. User text is always literal. */
async function textLayer(
	value: string,
	box: Box,
	colour: string,
	size: number,
	align: "left" | "centre",
): Promise<OverlayOptions> {
	const escaped = value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
	const rendered = await sharp({
		text: {
			text: `<span foreground="${colour}">${escaped}</span>`,
			font: `Liberation Sans Bold ${size}`,
			width: box.width,
			wrap: "word-char",
			align,
			rgba: true,
		},
	})
		.png()
		.toBuffer();
	const fitted = await sharp(rendered)
		.resize({ width: box.width, height: box.height, fit: "inside", withoutEnlargement: true })
		.png()
		.toBuffer({ resolveWithObject: true });
	return {
		input: fitted.data,
		left: box.x + (align === "centre" ? Math.floor((box.width - fitted.info.width) / 2) : 0),
		top: box.y + Math.floor((box.height - fitted.info.height) / 2),
	};
}
function limited(text: string, max: number): string {
	const clean =
		text
			.replace(/\p{Cc}/gu, " ")
			.replace(/\s+/g, " ")
			.trim() || "—";
	const graphemes = Array.from(
		new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(clean),
		(part) => part.segment,
	);
	return graphemes.length > max ? `${graphemes.slice(0, max - 1).join("")}…` : clean;
}
function readable(preferred: string, background: string): string {
	const luminance = (hex: string) => {
		const rgb = [1, 3, 5]
			.map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255)
			.map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
		return (rgb[0] ?? 0) * 0.2126 + (rgb[1] ?? 0) * 0.7152 + (rgb[2] ?? 0) * 0.0722;
	};
	const back = luminance(background);
	const front = luminance(preferred);
	return (Math.max(front, back) + 0.05) / (Math.min(front, back) + 0.05) >= 4.5
		? preferred
		: back > 0.179
			? "#000000"
			: "#ffffff";
}
