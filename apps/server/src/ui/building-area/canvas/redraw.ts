/**
 * A place over the canvas asks for the page to be drawn again in place (the frame's `rerender()`,
 * BA-08) after a change it saved that the page's markup shows: a Class renamed in Styles (BA-24).
 * Places are given no handle on the frame, so the ask is an event on the frame's element, which the
 * canvas (`Frame.tsx`) answers with the drawing's promise.
 */

const REDRAW = "webcraft:redraw";

type RedrawAsk = { drawn?: Promise<void> };

/** Draws the page in `frame` again in place; answers once it is drawn (at once when nothing answers). */
export async function redrawCanvas(frame: HTMLIFrameElement | null): Promise<void> {
	if (!frame) return;
	const ask = new CustomEvent<RedrawAsk>(REDRAW, { detail: {} });
	frame.dispatchEvent(ask);
	await ask.detail.drawn;
}

/** Answers the asks on `frame` with `rerender`; returns what stops answering. */
export function answerRedraws(frame: HTMLIFrameElement, rerender: () => Promise<void>): () => void {
	const answer = (event: Event) => {
		(event as CustomEvent<RedrawAsk>).detail.drawn = rerender();
	};
	frame.addEventListener(REDRAW, answer);
	return () => frame.removeEventListener(REDRAW, answer);
}
