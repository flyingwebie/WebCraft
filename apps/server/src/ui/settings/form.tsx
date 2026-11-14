import { useRouter } from "@tanstack/react-router";
import {
	createContext,
	type FormEvent,
	type ReactNode,
	type RefObject,
	useCallback,
	useContext,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";

import { errorMessage } from "../errors.ts";
import type { MessageKey } from "../i18n.tsx";
import { SaveBar, type SaveState } from "../shell/page.tsx";

/**
 * What a settings screen edits, and its one foot bar. A screen wraps its cards in `SettingsForm`;
 * each part that saves on its own (one procedure, or one group of fields) is a `useSettingsSection`.
 * The foot bar sums them up: "No changes" with Save off until a section changed, "Unsaved changes"
 * with Discard and Save, then "Saving…", "Saved" or "Could not save" with "Try again". Save saves
 * every changed section in the order they appear, and stops at the first that fails, which shows
 * why in its card; the ones before it stay saved. Leaving with changes not saved asks first.
 *
 *     <SettingsForm>
 *       <NameCard saved={settings} />   // useSettingsSection({ saved, save })
 *     </SettingsForm>
 */

/** What the foot bar knows of one section. */
type SectionHandle = {
	changed: () => boolean;
	/** Saves the section; answers whether it worked. */
	save: () => Promise<boolean>;
	discard: () => void;
};

type Registry = {
	register: (id: string, handle: RefObject<SectionHandle>) => () => void;
	/** A section's changed-ness moved. */
	report: (id: string, changed: boolean) => void;
	/** The person edited something: a "Saved" or "Could not save" is over. */
	edited: () => void;
	saveAll: () => Promise<void>;
	saving: boolean;
};

const RegistryContext = createContext<Registry | null>(null);

/**
 * The settings screen's sections and its foot bar. `onSaved` runs after everything saved (the
 * route's data is loaded again first).
 */
export function SettingsForm({ children, onSaved }: { children: ReactNode; onSaved?: () => void }) {
	const router = useRouter();
	const sections = useRef(new Map<string, RefObject<SectionHandle>>());
	const [changed, setChanged] = useState<ReadonlySet<string>>(new Set());
	const [phase, setPhase] = useState<"idle" | "saving" | "saved" | "failed">("idle");
	const busy = useRef(false);

	const register = useCallback((id: string, handle: RefObject<SectionHandle>) => {
		sections.current.set(id, handle);
		return () => {
			sections.current.delete(id);
			setChanged((ids) => without(ids, id));
		};
	}, []);
	const report = useCallback((id: string, isChanged: boolean) => {
		setChanged((ids) => (isChanged ? (ids.has(id) ? ids : new Set([...ids, id])) : without(ids, id)));
	}, []);
	const edited = useCallback(() => {
		if (!busy.current) setPhase("idle");
	}, []);

	const saveAll = useCallback(async () => {
		if (busy.current) return;
		const dirty = [...sections.current.values()].filter((handle) => handle.current.changed());
		if (dirty.length === 0) return;
		busy.current = true;
		setPhase("saving");
		let ok = true;
		for (const handle of dirty) {
			if (!(await handle.current.save())) {
				ok = false;
				break;
			}
		}
		await router.invalidate();
		busy.current = false;
		setPhase(ok ? "saved" : "failed");
		if (ok) onSaved?.();
	}, [router, onSaved]);

	const discard = () => {
		for (const handle of sections.current.values()) handle.current.discard();
		setPhase("idle");
	};

	const anyChanged = changed.size > 0;
	const state: SaveState =
		phase === "saving"
			? "saving"
			: phase === "failed" && anyChanged
				? "failed"
				: anyChanged
					? "dirty"
					: phase === "saved"
						? "saved"
						: "clean";

	const registry = useMemo<Registry>(
		() => ({ register, report, edited, saveAll, saving: phase === "saving" }),
		[register, report, edited, saveAll, phase],
	);
	return (
		<RegistryContext.Provider value={registry}>
			{children}
			<SaveBar state={state} onDiscard={discard} onSave={() => void saveAll()} />
		</RegistryContext.Provider>
	);
}

function without(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
	if (!ids.has(id)) return ids;
	const next = new Set(ids);
	next.delete(id);
	return next;
}

/** One part of a settings screen that saves on its own, as `useSettingsSection` answers it. */
export type SettingsSection<Values> = {
	values: Values;
	/** Changes some of the values. */
	set: (patch: Partial<Values>) => void;
	/** Whether the values differ from what is saved. */
	changed: boolean;
	/** Why the last save of this section failed, to show in its card. */
	error: MessageKey | null;
	/** The failure itself, for a card that shows it field by field. */
	failure: unknown;
	/** While the screen saves. */
	saving: boolean;
	/** Props for a `<form>` around the section's fields: Enter in a field saves the screen. */
	formProps: { onSubmit: (event: FormEvent) => void; noValidate: true };
};

/**
 * One part of a settings screen inside `SettingsForm`: the values as saved, and how to save them.
 * `save` gets the values and what they were (and may throw a Management API error, shown as `error`); `check` can refuse
 * them first with a message. When the saved values change (the route loaded again), a section with
 * nothing changed follows them.
 */
export function useSettingsSection<Values>({
	saved,
	save,
	check,
}: {
	saved: Values;
	/** Saves the values; `saved` is what they were, to send only what changed. */
	save: (values: Values, saved: Values) => Promise<unknown>;
	check?: (values: Values) => MessageKey | null;
}): SettingsSection<Values> {
	const savedKey = JSON.stringify(saved);
	const [baseline, setBaseline] = useState<{ key: string; values: Values }>({ key: savedKey, values: saved });
	const [values, setValues] = useState(saved);
	const [failure, setFailure] = useState<{ error: MessageKey; failure: unknown } | null>(null);
	const changed = JSON.stringify(values) !== JSON.stringify(baseline.values);

	// The route's data changed (saved here, or loaded again): follow it unless the person is editing.
	if (baseline.key !== savedKey) {
		setBaseline({ key: savedKey, values: saved });
		if (!changed) setValues(saved);
	}

	const latest = useRef({ values, save, check, baseline: baseline.values });
	latest.current = { values, save, check, baseline: baseline.values };
	const part = useSettingsPart({
		changed,
		save: async () => {
			const { values: snapshot, save: run, check: refuse, baseline: previous } = latest.current;
			const refused = refuse?.(snapshot) ?? null;
			if (refused) {
				setFailure({ error: refused, failure: null });
				return false;
			}
			try {
				await run(snapshot, previous);
				setBaseline((current) => ({ key: current.key, values: snapshot }));
				setFailure(null);
				return true;
			} catch (caught) {
				setFailure({ error: errorMessage(caught), failure: caught });
				return false;
			}
		},
		discard: () => {
			setValues(latest.current.baseline);
			setFailure(null);
		},
	});
	const { edited } = part;

	const set = useCallback(
		(patch: Partial<Values>) => {
			setValues((current) => ({ ...current, ...patch }));
			edited();
		},
		[edited],
	);
	return {
		values,
		set,
		changed,
		error: failure?.error ?? null,
		failure: failure?.failure ?? null,
		saving: part.saving,
		formProps: part.formProps,
	};
}

/** A part of a settings screen that keeps its own state, as `useSettingsPart` answers it. */
export type SettingsPart = {
	/** Call when the person edits something: a "Saved" or "Could not save" is over. */
	edited: () => void;
	/** While the screen saves. */
	saving: boolean;
	/** Props for a `<form>` around the part's fields: Enter in a field saves the screen. */
	formProps: { onSubmit: (event: FormEvent) => void; noValidate: true };
};

/**
 * A part of a settings screen inside `SettingsForm` that keeps its own state (a form with its own
 * checks and focus, shared with another screen): it says whether it changed, saves (answering
 * whether that worked; it shows its own errors) and discards. `useSettingsSection` is built on it.
 */
export function useSettingsPart(part: {
	changed: boolean;
	save: () => Promise<boolean>;
	discard: () => void;
}): SettingsPart {
	const answer = useOptionalSettingsPart(part);
	if (!answer) throw new Error("A part of a settings screen needs a SettingsForm around it.");
	return answer;
}

/**
 * `useSettingsPart` for a form that is shown both on a settings screen and elsewhere (the setup
 * wizard): null outside a `SettingsForm`, where the form keeps its own buttons.
 */
export function useOptionalSettingsPart({
	changed,
	save,
	discard,
}: {
	changed: boolean;
	save: () => Promise<boolean>;
	discard: () => void;
}): SettingsPart | null {
	const registry = useContext(RegistryContext);
	const id = useId();
	const latest = useRef({ changed, save, discard });
	latest.current = { changed, save, discard };
	const handle = useRef<SectionHandle>({
		changed: () => latest.current.changed,
		save: () => latest.current.save(),
		discard: () => latest.current.discard(),
	});
	const register = registry?.register;
	const report = registry?.report;
	useEffect(() => register?.(id, handle), [register, id]);
	useEffect(() => report?.(id, changed), [report, id, changed]);
	if (!registry) return null;
	const { edited, saveAll, saving } = registry;
	return {
		edited,
		saving,
		formProps: {
			onSubmit: (event: FormEvent) => {
				event.preventDefault();
				void saveAll();
			},
			noValidate: true,
		},
	};
}
