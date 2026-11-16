import { type Json, reverseChange, sameValue } from "@webcraft/core/draft-document";

export type HistoryLocation = {
	siteId: string;
	draft?: string;
	resource?: string;
	inspectorTab?: "builder-settings" | "builder-style";
	selection?: string | null;
	/** Code mode: the rendered element's reference. Edit mode: the Field whose region shows a typed value. */
	ref?: string;
	/** Where the step was made; `page` is the page itself in Edit mode (text typed in place, a Placement's own tools). */
	panel: "html" | "css" | "js" | "inspector" | "tree" | "page";
	title: string;
};
/**
 * A step's change taken back (or made again), or why not. `HISTORY_UNAVAILABLE` means not now: the
 * Draft can't be reached or changed at this moment (offline, reconnecting, a save under way). Any
 * other code is final: the step no longer applies, or the server's rules refuse it.
 */
export type HistoryResult = { ok: true; before: Json; after: Json } | { ok: false; code: string };
export type HistoryPort = { reverse(from: Json, to: Json): Promise<HistoryResult> };
type Change = { resource: string; before: Json; after: Json };
type Step = { id: number; label: string; location: HistoryLocation; changes: Change[]; group?: string; at: number };
type Listener = {
	/** Complete an in-progress gesture before another command or editor navigation. */
	finish?(): void;
	reveal?(location: HistoryLocation): boolean | Promise<boolean>;
	announce?(message: string, refused?: boolean): void;
};

/** One own-step history for this Window. It is deliberately not localStorage or a per-panel stack. */
export class EditorHistory {
	siteId = "";
	reverseValue = reverseChange;
	private past: Step[] = [];
	private future: Step[] = [];
	private ports = new Map<string, HistoryPort>();
	private watchers = new Set<() => void>();
	private listeners = new Set<Listener>();
	private serial = 0;
	private revision = 0;
	private busy = false;
	private pending = Promise.resolve();
	private grouping: string | undefined;
	private compounds = new Map<number, Step>();
	private actions = new Set<Promise<unknown>>();
	private label = (message: string) => message;
	private words = (key: string, label: string, _title?: string) => `${key} ${label}`;
	private fallback?: (resource: string) => Promise<HistoryPort | undefined>;
	/**
	 * Where a step's Draft is reached when no open part registered it (a Draft the building area doesn't
	 * hold open now, a page left earlier): opened for the step alone.
	 */
	reachWith(fallback: (resource: string) => Promise<HistoryPort | undefined>) {
		this.fallback = fallback;
	}

	/** A first Template acquires its stable document id on its first accepted save. */
	renameResource(from: string, to: string) {
		for (const step of [...this.past, ...this.future]) {
			if (step.location.draft === from) step.location.draft = to;
			if (step.location.resource === from) step.location.resource = to;
			for (const change of step.changes) {
				if (change.resource === from) change.resource = to;
				if (change.resource === `input:${from}`) change.resource = `input:${to}`;
			}
		}
	}
	/** Pending materialisation receipts, in own action order, detached from later typing. */
	pendingChanges(resource: string, through: number | undefined) {
		return this.past.flatMap((step) =>
			through !== undefined && step.id <= through
				? step.changes.filter((change) => change.resource === resource).map((change) => ({ id: step.id, ...change }))
				: [],
		);
	}
	forgetResource(resource: string, through: number | undefined) {
		for (const step of [...this.past, ...this.future])
			if (through !== undefined && step.id <= through)
				step.changes = step.changes.filter((change) => change.resource !== resource);
	}

	configure(language: { words(key: string, label: string, title?: string): string; label(message: string): string }) {
		this.words = language.words;
		this.label = language.label;
	}

	state() {
		return { undo: this.past.at(-1)?.label ?? null, redo: this.future.at(-1)?.label ?? null, busy: this.busy };
	}
	subscribe(listener: () => void) {
		this.watchers.add(listener);
		return () => {
			this.watchers.delete(listener);
		};
	}
	listen(listener: Listener) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	register(resource: string, port: HistoryPort) {
		this.ports.set(resource, port);
		return () => {
			if (this.ports.get(resource) === port) this.ports.delete(resource);
		};
	}
	boundary() {
		this.grouping = undefined;
	}
	private notify() {
		for (const listener of this.watchers) listener();
	}

	record(
		change: Change & { label: string; location: HistoryLocation; group?: string; step?: number },
	): number | undefined {
		if (sameValue(change.before, change.after)) return;
		this.revision++;
		const last = this.past.at(-1);
		const merge =
			(change.step === undefined ? undefined : this.compounds.get(change.step)) ??
			(change.group && this.grouping === change.group && last?.group === change.group && Date.now() - last.at < 1000
				? last
				: undefined);
		const step = merge ?? {
			id: ++this.serial,
			label: this.label(change.label),
			location: change.location,
			group: change.group,
			at: Date.now(),
			changes: [],
		};
		const existing = step.changes.at(-1);
		if (existing?.resource === change.resource && sameValue(existing.after, change.before))
			existing.after = change.after;
		else step.changes.push({ resource: change.resource, before: change.before, after: change.after });
		step.at = Date.now();
		step.location = { ...change.location, resource: change.resource };
		if (!this.past.includes(step)) this.past.push(step);
		if (this.past.length > 200) this.past.splice(0, this.past.length - 200);
		this.future.length = 0;
		this.grouping = change.group;
		this.notify();
		return step.id;
	}
	/** Associates a parsed tree/HTTP acknowledgement with the input step that caused it. */
	attach(id: number | undefined, change: Change) {
		const step = this.past.find((step) => step.id === id);
		if (!step || sameValue(change.before, change.after)) return false;
		const existing = step.changes.at(-1);
		if (existing?.resource === change.resource && sameValue(existing.after, change.before))
			existing.after = change.after;
		else step.changes.push(change);
		this.notify();
		return true;
	}
	/** Once valid HTML is represented by its tree, keep only the shared change. Incomplete input
	 * remains reversible locally; canonical printing and selection changes are not extra steps. */
	settleInput(id: number | undefined) {
		const step = this.past.find((step) => step.id === id);
		if (step) step.changes = step.changes.filter((change) => !change.resource.startsWith("input:"));
	}
	async compound<T>(label: string, action: (step: number) => Promise<T>): Promise<T> {
		this.boundary();
		const step: Step = {
			id: ++this.serial,
			label: this.label(label),
			location: { siteId: "", title: "", panel: "tree" },
			at: Date.now(),
			changes: [],
		};
		this.compounds.set(step.id, step);
		const finished = action(step.id);
		this.actions.add(finished);
		try {
			return await finished;
		} finally {
			this.compounds.delete(step.id);
			this.actions.delete(finished);
			if (this.past.length > 200) this.past.splice(0, this.past.length - 200);
			this.boundary();
			this.notify();
		}
	}
	undo() {
		this.pending = this.pending.catch(() => {}).then(() => this.travel(this.past, this.future, "undid"));
		return this.pending;
	}
	redo() {
		this.pending = this.pending.catch(() => {}).then(() => this.travel(this.future, this.past, "redid"));
		return this.pending;
	}
	private async travel(source: Step[], destination: Step[], verb: string) {
		if (this.busy) return;
		for (const listener of this.listeners) listener.finish?.();
		this.boundary();
		if (source.length) this.revision++;
		this.busy = true;
		this.notify();
		const notices: string[] = [];
		let message = "";
		try {
			while (source.length) {
				const step = source.pop() as Step;
				const revision = this.revision;
				const applied: Change[] = [];
				let failure = "";
				for (const change of [...step.changes]
					.reverse()
					.sort((a, b) => Number(b.resource.startsWith("input:")) - Number(a.resource.startsWith("input:")))) {
					try {
						const port = this.ports.get(change.resource) ?? (await this.fallback?.(change.resource));
						const result = await port?.reverse(change.after, change.before);
						if (!result?.ok) {
							failure = result?.code ?? "HISTORY_UNAVAILABLE";
							break;
						}
						applied.push({ resource: change.resource, before: result.before, after: result.after });
					} catch (error) {
						failure = (error as { code?: string }).code ?? "HISTORY_UNAVAILABLE";
						break;
					}
				}
				if (failure) {
					// A refused compound is compensated through the same guarded writes, never snapshots.
					let partial = false;
					for (const change of [...applied].reverse()) {
						const port = this.ports.get(change.resource) ?? (await this.fallback?.(change.resource));
						try {
							const result = await port?.reverse(change.after, change.before);
							if (!result?.ok) partial = true;
						} catch {
							partial = true;
						}
					}
					if (partial) notices.push(this.words("HISTORY_PARTIAL", ""));
					else if (failure === "HISTORY_UNAVAILABLE") {
						// Not now is not never (ADR 0036 skips only what no longer applies or is refused): the
						// step keeps its place, and so does every step behind it. The person tries again.
						source.push(step);
						notices.push(
							`${this.words(verb === "undid" ? "keptUndo" : "keptRedo", step.label)} ${this.words(failure, "")}`,
						);
						break;
					}
					notices.push(`${this.words("skipped", step.label)} ${this.words(failure, "")}`);
					if (partial) break;
					continue;
				}
				if (revision === this.revision || destination === this.past) destination.push({ ...step, changes: applied });
				// A new own step may have filled the stack while Redo awaited its write.
				if (this.past.length > 200) this.past.splice(0, this.past.length - 200);
				let shown = false;
				for (const listener of this.listeners) if (await listener.reveal?.(step.location)) shown = true;
				message = this.words(verb, step.label);
				if (!shown && step.location.title) message = this.words("on", message, step.location.title);
				break;
			}
		} finally {
			const announcement = [...notices, message].filter(Boolean).join(" ");
			if (announcement) for (const listener of this.listeners) listener.announce?.(announcement, notices.length > 0);
			this.busy = false;
			this.notify();
		}
	}
}
let history: EditorHistory | undefined;
export function editorHistory() {
	history ??= new EditorHistory();
	return history;
}
