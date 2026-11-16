import { CircleCheckIcon, OctagonXIcon, XIcon } from "lucide-react";
import { useSyncExternalStore } from "react";

import { CHROME_EASE, FOCUS_RING } from "../../controls.tsx";

/**
 * The shell's toasts (SPEC 10: top centre, mostly for failures, paused while hovered): what the Media
 * parts say after a change. Drawn by the shell itself, with no style block of its own, which the shell's
 * policy (`style-src 'self'`) would refuse. Successes are said politely, failures at once.
 */

type Toast = { id: number; kind: "success" | "error"; text: string; action?: ToastAction };

/** What a toast offers to do (Undo, after a field was removed): its words, and what it does. */
export type ToastAction = { label: string; run(): void };

/** How long a toast stays, unless the pointer is on it. */
const SHOWN_MS = 4000;

let shown: readonly Toast[] = [];
let next = 0;
let paused = false;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function publish(toasts: readonly Toast[]): void {
	shown = toasts;
	for (const listener of listeners) listener();
}

function dismiss(id: number): void {
	clearTimeout(timers.get(id));
	timers.delete(id);
	publish(shown.filter((toast) => toast.id !== id));
}

function schedule(id: number): void {
	clearTimeout(timers.get(id));
	timers.set(
		id,
		setTimeout(() => dismiss(id), SHOWN_MS),
	);
}

/** Shows a toast, with an action when it offers one. */
export function notify(kind: "success" | "error", text: string, action?: ToastAction): void {
	const toast = { id: ++next, kind, text, action };
	publish([...shown, toast].slice(-4));
	if (!paused) schedule(toast.id);
}

function hold(on: boolean): void {
	paused = on;
	for (const toast of shown) {
		if (on) clearTimeout(timers.get(toast.id));
		else schedule(toast.id);
	}
}

/** The toasts, top centre over the shell. */
export function Toasts({ closeLabel }: { closeLabel: string }) {
	const toasts = useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => shown,
		() => shown,
	);
	const politely = toasts.filter((toast) => toast.kind === "success");
	const atOnce = toasts.filter((toast) => toast.kind === "error");
	const list = (items: readonly Toast[]) =>
		items.map((toast) => {
			const Glyph = toast.kind === "success" ? CircleCheckIcon : OctagonXIcon;
			return (
				<li
					key={toast.id}
					className="border-chrome-hover bg-chrome-menu text-chrome-text pointer-events-auto flex w-[min(420px,calc(100vw-2rem))] items-start gap-2 rounded-lg border px-3 py-2.5 text-[12px] shadow-[0_12px_32px_rgba(0,0,0,0.55)]"
					data-wc-toast={toast.kind}
				>
					<Glyph
						aria-hidden="true"
						className={`mt-px size-4 shrink-0 ${toast.kind === "success" ? "text-chrome-ok" : "text-chrome-danger"}`}
					/>
					<span className="min-w-0 grow">{toast.text}</span>
					{toast.action ? (
						<button
							type="button"
							onClick={() => {
								dismiss(toast.id);
								toast.action?.run();
							}}
							className={`text-chrome-accent hover:text-chrome-strong -my-0.5 shrink-0 rounded-[4px] px-1.5 py-0.5 text-[12px] font-semibold ${CHROME_EASE} ${FOCUS_RING}`}
							data-wc-toast-action=""
						>
							{toast.action.label}
						</button>
					) : null}
					<button
						type="button"
						aria-label={closeLabel}
						onClick={() => dismiss(toast.id)}
						className={`text-chrome-muted hover:text-chrome-strong inline-grid size-5 shrink-0 place-items-center rounded-[4px] ${CHROME_EASE} ${FOCUS_RING}`}
					>
						<XIcon aria-hidden="true" className="size-3.5" />
					</button>
				</li>
			);
		});
	return (
		<div
			className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2"
			onPointerEnter={() => hold(true)}
			onPointerLeave={() => hold(false)}
			data-wc-toasts=""
		>
			<div role="status" aria-live="polite">
				<ul className="m-0 flex list-none flex-col items-center gap-2 p-0">{list(politely)}</ul>
			</div>
			<div role="alert" aria-live="assertive">
				<ul className="m-0 flex list-none flex-col items-center gap-2 p-0">{list(atOnce)}</ul>
			</div>
		</div>
	);
}
