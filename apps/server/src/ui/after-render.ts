import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Runs a callback once React has drawn the state changes made alongside it: for moving focus to
 * something those changes show, such as a problem summary or a field's settings. The next animation
 * frame isn't enough: on a busy machine React may not have drawn by then, and the focus is lost.
 */
export function useAfterRender(): (callback: () => void) => void {
	const pending = useRef<(() => void)[]>([]);
	const [, setDrawn] = useState(0);
	// Every commit runs what was asked before it; the counter only makes sure a commit happens.
	useEffect(() => {
		for (const callback of pending.current.splice(0)) callback();
	});
	return useCallback((callback: () => void) => {
		pending.current.push(callback);
		setDrawn((count) => count + 1);
	}, []);
}
