import { encode } from "uqr";

/**
 * A QR code for `value`, drawn as one SVG path (dark modules on a white square, so phones read it in
 * dark mode too). `label` is its accessible name; the same value is always shown as text beside it.
 */
export function QrCode({ value, label, size = 192 }: { value: string; label: string; size?: number }) {
	const { data } = encode(value, { ecc: "M", border: 2 });
	const modules = data.length;
	let path = "";
	data.forEach((row, y) => {
		row.forEach((dark, x) => {
			if (dark) path += `M${x} ${y}h1v1h-1z`;
		});
	});
	return (
		<svg
			role="img"
			aria-label={label}
			width={size}
			height={size}
			viewBox={`0 0 ${modules} ${modules}`}
			shapeRendering="crispEdges"
			className="rounded-md"
		>
			<rect width={modules} height={modules} fill="#ffffff" />
			<path d={path} fill="#000000" />
		</svg>
	);
}
