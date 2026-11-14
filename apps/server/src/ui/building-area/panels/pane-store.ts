import { useSyncExternalStore } from "react";

/** A pane's state, kept outside React so it outlives the pane's body (moved to another dock, hidden a while). */
export type PaneStore<State> = {
	get(): State;
	set(change: Partial<State> | ((state: State) => Partial<State>)): void;
	subscribe(listener: () => void): () => void;
};

export function paneStore<State extends object>(initial: State): PaneStore<State> {
	let state = initial;
	const listeners = new Set<() => void>();
	return {
		get: () => state,
		set(change) {
			const next = typeof change === "function" ? change(state) : change;
			if (Object.entries(next).every(([key, value]) => Object.is(state[key as keyof State], value))) return;
			state = { ...state, ...next };
			for (const listener of listeners) listener();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

/** A pane store's state, following it. */
export function usePane<State extends object>(store: PaneStore<State>): State {
	return useSyncExternalStore(store.subscribe, store.get);
}
