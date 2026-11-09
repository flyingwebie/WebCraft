import { useCallback, useEffect, useRef, useState } from "react";

/** Where a Draft's saving stands: everything saved, a change waiting, saving now, or the last save failed. */
export type AutosaveStatus = "saved" | "waiting" | "saving" | "failed";

/** How long typing must pause before a change is saved. */
const PAUSE_MS = 800;

/**
 * Saves changes to a Draft by itself, a moment after typing pauses, through the same procedures the
 * rest of the admin uses (every Draft write goes through the content store's one Draft writer). One
 * save runs at a time; changes made meanwhile are merged and saved next. A change that fails to save
 * is kept and sent again with the next one, so nothing typed is lost; leaving the page saves what is
 * waiting, and the browser asks before closing a tab with unsaved changes.
 */
export function useAutosave<Change>({
	save,
	merge,
	onSaved,
	onFailed,
}: {
	save(change: Change): Promise<void>;
	/** One change made of an older and a newer one (the newer wins where both change a value). */
	merge(older: Change, newer: Change): Change;
	onSaved?(): void;
	onFailed(error: unknown): void;
}) {
	const [status, setStatus] = useState<AutosaveStatus>("saved");
	const pending = useRef<Change | null>(null);
	const running = useRef<Promise<boolean> | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const handlers = useRef({ save, merge, onSaved, onFailed });
	handlers.current = { save, merge, onSaved, onFailed };

	const flush = useCallback(async (): Promise<boolean> => {
		clearTimeout(timer.current);
		while (running.current) await running.current;
		const change = pending.current;
		if (change === null) return true;
		pending.current = null;
		setStatus("saving");
		const run = (async () => {
			try {
				await handlers.current.save(change);
				handlers.current.onSaved?.();
				setStatus(pending.current === null ? "saved" : "waiting");
				return true;
			} catch (error) {
				pending.current = pending.current === null ? change : handlers.current.merge(change, pending.current);
				setStatus("failed");
				handlers.current.onFailed(error);
				return false;
			}
		})();
		running.current = run;
		const saved = await run;
		running.current = null;
		if (saved && pending.current !== null) {
			timer.current = setTimeout(() => void flush(), PAUSE_MS);
		}
		return saved && pending.current === null;
	}, []);

	const change = useCallback(
		(part: Change) => {
			pending.current = pending.current === null ? part : handlers.current.merge(pending.current, part);
			setStatus((before) => (before === "saving" ? before : "waiting"));
			clearTimeout(timer.current);
			timer.current = setTimeout(() => void flush(), PAUSE_MS);
		},
		[flush],
	);

	// Leaving the page saves what is waiting; closing the tab first asks.
	useEffect(() => {
		const warn = (event: BeforeUnloadEvent) => {
			if (pending.current !== null || running.current !== null) event.preventDefault();
		};
		window.addEventListener("beforeunload", warn);
		return () => {
			window.removeEventListener("beforeunload", warn);
			if (pending.current !== null) void flush();
		};
	}, [flush]);

	return { status, change, flush };
}
