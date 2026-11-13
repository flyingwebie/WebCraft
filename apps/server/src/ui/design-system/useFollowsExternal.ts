import { useEffect, useRef } from "react";

/**
 * Tells apart an outside change to `external` (the Draft replaced wholesale, by an import or any
 * other such replace) from the echo of this editor's own last edit, which arrives back through the
 * same prop a moment later (an optimistic update to the Draft, round through the parent's state).
 * Calls `onExternalChange` with the new value only for the former, leaving what is being typed alone.
 *
 * The caller's own `set` function must mark, with `stamp`, the value it sends up through its
 * `onChange`: that is how the next render tells its own echo from someone else's change.
 */
export function useFollowsExternal<T>(external: T, onExternalChange: (value: T) => void): (stamp: T) => void {
	const last = useRef(external);
	// `onExternalChange` is the caller's setter, not a value to react to: only `external` changing
	// (not a re-render with a freshly made setter) should resync.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above.
	useEffect(() => {
		if (external === last.current) return;
		last.current = external;
		onExternalChange(external);
	}, [external]);
	return (stamp: T) => {
		last.current = stamp;
	};
}
