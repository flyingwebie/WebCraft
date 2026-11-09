import { Button } from "@webcraft/ui/components/button.tsx";
import { CrosshairIcon } from "lucide-react";
import { type PointerEvent, useId, useRef } from "react";

import { useT } from "../i18n.tsx";

/** An image's Focal point: whole percentages of its width and height, from its top left. */
export type FocalPoint = { x: number; y: number };

/**
 * Sets an image's Focal point. Two sliders (across and down, in whole percentages) work from the
 * keyboard; clicking or dragging on the image sets both at once. Without a point the image is
 * centred on pages; moving either slider sets one.
 */
export function FocalPointPicker({
	src,
	value,
	onChange,
}: {
	/** The image to point at, or null when there is no preview. */
	src: string | null;
	value: FocalPoint | null;
	onChange(next: FocalPoint | null): void;
}) {
	const t = useT();
	const id = useId();
	const area = useRef<HTMLDivElement>(null);
	const point = value ?? { x: 50, y: 50 };

	const pointAt = (event: PointerEvent) => {
		const box = area.current?.getBoundingClientRect();
		if (!box || box.width === 0 || box.height === 0) return;
		const clamp = (share: number) => Math.min(100, Math.max(0, Math.round(share * 100)));
		onChange({ x: clamp((event.clientX - box.left) / box.width), y: clamp((event.clientY - box.top) / box.height) });
	};

	return (
		<fieldset className="grid gap-3" aria-describedby={`${id}-help`}>
			<legend className="mb-1 flex items-center gap-2 text-sm font-medium">
				<CrosshairIcon className="size-4" aria-hidden="true" />
				{t("media.focal.heading")}
			</legend>
			<p id={`${id}-help`} className="text-muted-foreground text-sm">
				{t("media.focal.help")}
			</p>
			{src ? (
				// The sliders below are the keyboard's way; pointing at the image is a shortcut for the mouse.
				<div
					ref={area}
					className="bg-muted relative cursor-crosshair touch-none overflow-hidden rounded-lg select-none"
					onPointerDown={(event) => {
						event.currentTarget.setPointerCapture(event.pointerId);
						pointAt(event);
					}}
					onPointerMove={(event) => {
						if (event.currentTarget.hasPointerCapture(event.pointerId)) pointAt(event);
					}}
				>
					<img src={src} alt="" draggable={false} className="block w-full" />
					{value ? (
						<span
							aria-hidden="true"
							className="ring-primary absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow ring-2"
							style={{ left: `${point.x}%`, top: `${point.y}%` }}
						/>
					) : null}
				</div>
			) : null}
			<div className="grid gap-3 sm:grid-cols-2">
				<Slider
					id={`${id}-x`}
					label={t("media.focal.across")}
					value={point.x}
					valueText={t("media.focal.fromLeft", { value: point.x })}
					onChange={(x) => onChange({ ...point, x })}
				/>
				<Slider
					id={`${id}-y`}
					label={t("media.focal.down")}
					value={point.y}
					valueText={t("media.focal.fromTop", { value: point.y })}
					onChange={(y) => onChange({ ...point, y })}
				/>
			</div>
			<div className="flex flex-wrap items-center gap-3">
				<p className="text-muted-foreground text-sm">
					{value
						? `${t("media.focal.fromLeft", { value: point.x })}, ${t("media.focal.fromTop", { value: point.y })}`
						: t("media.focal.none")}
				</p>
				{value ? (
					<Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
						{t("media.focal.clear")}
					</Button>
				) : null}
			</div>
		</fieldset>
	);
}

function Slider({
	id,
	label,
	value,
	valueText,
	onChange,
}: {
	id: string;
	label: string;
	value: number;
	valueText: string;
	onChange(value: number): void;
}) {
	return (
		<div className="grid gap-1.5">
			<label htmlFor={id} className="text-sm">
				{label}
			</label>
			<input
				id={id}
				type="range"
				min={0}
				max={100}
				step={1}
				value={value}
				aria-valuetext={valueText}
				onChange={(event) => onChange(Number(event.target.value))}
				className="accent-primary focus-visible:ring-ring/50 h-6 w-full rounded-md outline-none focus-visible:ring-3"
			/>
		</div>
	);
}
