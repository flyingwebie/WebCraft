import { CrosshairIcon, ImageIcon, ImagePlusIcon, SparklesIcon, UploadIcon } from "lucide-react";
import { type DragEvent, type PointerEvent, useEffect, useId, useRef, useState } from "react";

import { formatBytes } from "../../media/preview.ts";
import { fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";
import { pickMedia } from "../places/media/pick.ts";
import { INPUT, Popover, PopoverButton, PopoverField } from "./Popover.tsx";
import type { PhotoMedia, RegionPopovers } from "./popovers.ts";

/** The image files Upload offers (the Media library takes these as photos). */
const PHOTO_TYPES = "image/jpeg,image/png,image/webp,image/avif,image/gif,image/heic,image/heif";
/** How long after typing stops a description saves, and after the dot stops moving its Focal point. */
const DESCRIBE_AFTER_MS = 800;
const FOCAL_AFTER_POINTER_MS = 400;
const FOCAL_AFTER_KEYS_MS = 600;
/** How long "Click again to remove" waits for the second click. */
const CONFIRM_MS = 4000;

type Point = { x: number; y: number };

/**
 * The photo popover (SPEC 13.3, `client/03`): beside a photo on the page, named by its Field. Choose
 * from Media (the Media picker, `pickMedia`) or Upload (or a file dropped on the photo, which the photo
 * takes once the worker has made it ready) put another photo in the Draft. Its description is written
 * in the page's language, with an AI's suggestion where the Workspace has an AI key; its Focal point is
 * a dot dragged on the photo itself, or moved with the arrow keys (Shift for 10). Both are the Media
 * item's own, saved as they change. "Remove photo" asks for a second click.
 */
export function PhotoPopover({
	popovers,
	words,
	element,
	name,
	focus,
	seq,
	hidden,
	status,
	box,
}: {
	popovers: RegionPopovers;
	words: Words;
	element: HTMLElement;
	name: string;
	focus: string | null;
	seq: number;
	hidden: boolean;
	status: string | null;
	box: DOMRect;
}) {
	const said = words.client.photo;
	const mediaId = element.dataset.wcMedia || null;
	const language = popovers.language();
	const [loaded, setLoaded] = useState<{ media: PhotoMedia; suggestions: boolean } | null>(null);
	const [alt, setAlt] = useState("");
	const savedAlt = useRef("");
	const altTimer = useRef<number | undefined>(undefined);
	const [suggesting, setSuggesting] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const confirmTimer = useRef<number | undefined>(undefined);
	const fileInput = useRef<HTMLInputElement>(null);
	const altId = useId();
	const altHintId = useId();

	// The photo the region shows, its description in the page's language.
	useEffect(() => {
		setLoaded(null);
		if (!mediaId) return;
		let current = true;
		void popovers.photo.load(mediaId).then((found) => {
			if (!current || !found) return;
			setLoaded(found);
			setAlt(found.media.alt ?? "");
			savedAlt.current = found.media.alt ?? "";
		});
		return () => {
			current = false;
		};
	}, [mediaId, popovers]);

	useEffect(
		() => () => {
			window.clearTimeout(altTimer.current);
			window.clearTimeout(confirmTimer.current);
		},
		[],
	);

	const media = loaded?.media ?? null;
	const editable = media?.canEdit === true;

	const saveAlt = async (value: string) => {
		window.clearTimeout(altTimer.current);
		if (!media || !editable || value === savedAlt.current) return;
		if (await popovers.photo.describe(media.id, value)) savedAlt.current = value;
	};

	const choose = async () => {
		popovers.picking(true);
		const picked = await pickMedia({ kind: "image", current: mediaId });
		popovers.picking(false);
		if (picked) await popovers.photo.choose(element, picked.id);
	};

	const remove = () => {
		if (!confirming) {
			setConfirming(true);
			window.clearTimeout(confirmTimer.current);
			confirmTimer.current = window.setTimeout(() => setConfirming(false), CONFIRM_MS);
			return;
		}
		window.clearTimeout(confirmTimer.current);
		setConfirming(false);
		void popovers.photo.choose(element, null);
	};

	const dropped = (event: DragEvent) => {
		const file = event.dataTransfer.files[0];
		if (!file) return;
		event.preventDefault();
		void popovers.photo.upload(element, file);
	};
	const dragOver = (event: DragEvent) => {
		if ([...event.dataTransfer.types].includes("Files")) event.preventDefault();
	};

	return (
		<Popover
			kind="photo"
			icon={ImageIcon}
			title={name}
			closeLabel={fill(said.close, { name })}
			box={box}
			where="side"
			focus={focus}
			seq={seq}
			hidden={hidden}
			onClose={(back) => popovers.close(back)}
		>
			{/* A file dropped on the popover takes the photo's place too; Upload is the keyboard's way. */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target, with Upload beside it. */}
			<div className="flex w-full flex-col gap-[14px]" onDragOver={dragOver} onDrop={dropped}>
				<div className="flex w-full gap-2">
					<PopoverButton
						icon={ImagePlusIcon}
						className="flex-1"
						data-wc-autofocus=""
						data-wc-focus-key="choose"
						onClick={() => void choose()}
					>
						{said.chooseFromMedia}
					</PopoverButton>
					<PopoverButton
						icon={UploadIcon}
						className="flex-1"
						data-wc-focus-key="upload"
						onClick={() => fileInput.current?.click()}
					>
						{said.upload}
					</PopoverButton>
					<input
						ref={fileInput}
						type="file"
						accept={PHOTO_TYPES}
						className="sr-only"
						tabIndex={-1}
						aria-hidden="true"
						data-wc-photo-file=""
						onChange={(event) => {
							const file = event.currentTarget.files?.[0];
							event.currentTarget.value = "";
							if (file) void popovers.photo.upload(element, file);
						}}
					/>
				</div>
				<p className="text-chrome-muted m-0 -mt-1 text-center text-[12px]" data-wc-photo-status="">
					{status ?? said.dropHint}
				</p>
				{mediaId && !loaded ? <p className="text-chrome-muted m-0 text-[12px]">{said.loading}</p> : null}
				{media ? (
					<>
						<PopoverField
							label={fill(said.alt, { language: language?.name ?? "" })}
							htmlFor={altId}
							hint={editable ? said.altHint : said.notYours}
							hintId={altHintId}
							end={
								loaded?.suggestions && editable ? (
									<button
										type="button"
										aria-label={said.suggestLabel}
										title={said.suggestLabel}
										aria-disabled={suggesting || undefined}
										className={`text-chrome-accent hover:bg-chrome-hover inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] font-semibold ${CHROME_EASE} ${FOCUS_RING}`}
										onClick={async () => {
											if (suggesting) return;
											setSuggesting(true);
											const text = await popovers.photo.suggest(media.id);
											setSuggesting(false);
											if (text === null) return;
											// Only a suggestion: the person reads it; it is saved once they move on.
											setAlt(text);
											const field = document.getElementById(altId) as HTMLTextAreaElement | null;
											field?.focus();
											field?.select();
										}}
									>
										<SparklesIcon className="size-3.5" aria-hidden="true" />
										{said.suggest}
									</button>
								) : null
							}
						>
							<textarea
								id={altId}
								rows={2}
								maxLength={1000}
								value={alt}
								readOnly={!editable}
								aria-describedby={altHintId}
								className={`${INPUT} h-[60px] resize-none py-2.5`}
								data-wc-photo-alt=""
								onChange={(event) => {
									const value = event.currentTarget.value;
									setAlt(value);
									window.clearTimeout(altTimer.current);
									altTimer.current = window.setTimeout(() => void saveAlt(value), DESCRIBE_AFTER_MS);
								}}
								onBlur={(event) => void saveAlt(event.currentTarget.value)}
							/>
						</PopoverField>
						{media.url ? (
							<FocalPoint
								key={media.id}
								media={media}
								words={words}
								box={box}
								popovers={popovers}
								onFile={(file) => void popovers.photo.upload(element, file)}
							/>
						) : null}
						<div className="flex w-full items-center gap-3">
							<span className="text-chrome-muted min-w-0 flex-1 truncate text-[12px]" data-wc-photo-file-name="">
								{fill(said.file, { name: media.fileName, size: formatBytes(media.sizeBytes) })}
							</span>
							<RemoveButton confirming={confirming} words={words} onClick={remove} />
						</div>
					</>
				) : null}
			</div>
		</Popover>
	);
}

function RemoveButton({ confirming, words, onClick }: { confirming: boolean; words: Words; onClick(): void }) {
	const said = words.client.photo;
	return (
		<button
			type="button"
			className={`shrink-0 rounded-md px-1 text-[12px] font-semibold text-[#fca5a5] hover:underline ${FOCUS_RING}`}
			onClick={onClick}
			data-wc-photo-remove=""
		>
			{confirming ? said.removeAgain : said.remove}
		</button>
	);
}

/**
 * The Focal point (GLOSSARY.md): its row in the popover, and on the photo itself faint cross lines and
 * a dot, dragged with a pointer, or moved with the arrow keys once it has focus (Shift for 10). Saved a
 * moment after it stops moving; the page's images of the photo follow at once.
 */
function FocalPoint({
	media,
	words,
	box,
	popovers,
	onFile,
}: {
	media: PhotoMedia;
	words: Words;
	box: DOMRect;
	popovers: RegionPopovers;
	onFile(file: File): void;
}) {
	const said = words.client.photo;
	const [point, setPoint] = useState<Point>(media.focalPoint ?? { x: 50, y: 50 });
	const timer = useRef<number | undefined>(undefined);
	const area = useRef<HTMLDivElement>(null);
	const dot = useRef<HTMLDivElement>(null);
	const hintId = useId();
	useEffect(() => () => window.clearTimeout(timer.current), []);

	const moveTo = (next: Point, wait: number) => {
		const clamped = {
			x: Math.max(0, Math.min(100, Math.round(next.x))),
			y: Math.max(0, Math.min(100, Math.round(next.y))),
		};
		setPoint(clamped);
		window.clearTimeout(timer.current);
		timer.current = window.setTimeout(() => void popovers.photo.focus(media.id, clamped), wait);
	};
	const fromPointer = (event: PointerEvent) => {
		const shown = area.current?.getBoundingClientRect();
		if (!shown || shown.width === 0 || shown.height === 0) return;
		moveTo(
			{ x: ((event.clientX - shown.left) / shown.width) * 100, y: ((event.clientY - shown.top) / shown.height) * 100 },
			FOCAL_AFTER_POINTER_MS,
		);
	};

	// The photo's box, inside the canvas.
	const canvas = document.querySelector("[data-wc-canvas]")?.getBoundingClientRect();
	const clip = canvas
		? {
				left: Math.max(box.left, canvas.left),
				top: Math.max(box.top, canvas.top),
				right: Math.min(box.right, canvas.right),
				bottom: Math.min(box.bottom, canvas.bottom),
			}
		: { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
	const at = fill(said.focalAt, { x: String(point.x), y: String(point.y) });
	const editable = media.canEdit;

	return (
		<>
			<div className="flex w-full items-center gap-2.5">
				<span className="bg-chrome-hover text-chrome-text grid size-9 shrink-0 place-items-center rounded-lg">
					<CrosshairIcon className="size-4" aria-hidden="true" />
				</span>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="text-chrome-strong text-[13px] font-medium">{said.focalPoint}</span>
					<span id={hintId} className="text-chrome-muted text-[12px]">
						{said.focalHint}
					</span>
				</div>
			</div>
			{/* On the photo itself: drawn over the page, where the photo is. The dot is its keyboard way. */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: dragging the dot; the slider inside takes the keys. */}
			<div
				ref={area}
				className="fixed z-20 cursor-crosshair overflow-hidden rounded-[2px]"
				data-wc-focal-area=""
				style={{
					left: box.left,
					top: box.top,
					width: box.width,
					height: box.height,
					clipPath: `inset(${clip.top - box.top}px ${box.right - clip.right}px ${box.bottom - clip.bottom}px ${clip.left - box.left}px)`,
				}}
				onPointerDown={(event) => {
					if (!editable || event.button !== 0) return;
					event.preventDefault();
					event.currentTarget.setPointerCapture(event.pointerId);
					dot.current?.focus();
					fromPointer(event);
				}}
				onPointerMove={(event) => {
					if (event.currentTarget.hasPointerCapture(event.pointerId)) fromPointer(event);
				}}
				onDragOver={(event) => {
					if ([...event.dataTransfer.types].includes("Files")) event.preventDefault();
				}}
				onDrop={(event) => {
					const file = event.dataTransfer.files[0];
					if (!file) return;
					event.preventDefault();
					onFile(file);
				}}
			>
				<span
					aria-hidden="true"
					className="pointer-events-none absolute inset-x-0 h-px bg-white/35"
					style={{ top: `${point.y}%` }}
				/>
				<span
					aria-hidden="true"
					className="pointer-events-none absolute inset-y-0 w-px bg-white/35"
					style={{ left: `${point.x}%` }}
				/>
				<div
					ref={dot}
					role="slider"
					tabIndex={editable ? 0 : -1}
					aria-label={said.focalPoint}
					aria-describedby={hintId}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={point.x}
					aria-valuetext={at}
					aria-disabled={editable ? undefined : true}
					aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
					title={said.focalKeys}
					data-wc-focal-dot=""
					className="focus-visible:ring-chrome-focus absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-white/20 shadow-[0_0_0_1px_rgba(0,0,0,0.35)] outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-black/40"
					style={{ left: `${point.x}%`, top: `${point.y}%` }}
					onKeyDown={(event) => {
						if (!editable) return;
						const step = event.shiftKey ? 10 : 1;
						const moves: Record<string, [number, number]> = {
							ArrowLeft: [-step, 0],
							ArrowRight: [step, 0],
							ArrowUp: [0, -step],
							ArrowDown: [0, step],
						};
						const move = moves[event.key];
						if (!move) return;
						event.preventDefault();
						moveTo({ x: point.x + move[0], y: point.y + move[1] }, FOCAL_AFTER_KEYS_MS);
					}}
				/>
			</div>
		</>
	);
}
