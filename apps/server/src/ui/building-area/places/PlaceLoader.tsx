import { useCallback, useEffect, useState } from "react";

import { fill } from "../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";
import { Place } from "./Place.tsx";
import type { PlaceComponent, PlaceEntry, PlaceProps } from "./registry.ts";

/**
 * What draws an open place (BA-30). Each place's code is a file of its own, fetched the first time the
 * place is opened: until it has arrived the place's frame shows at once, with its header and a quiet
 * line saying it is loading; a fetch that fails says so in words, with Try again. Once loaded, a place
 * draws straight away whenever it is opened again in this tab.
 */
export function PlaceLoader({ entry, ...props }: PlaceProps & { entry: PlaceEntry }) {
	const { key } = entry;
	const [state, setState] = useState<LoadState>(() => stateOf(key));

	const load = useCallback(() => {
		setState({ status: "loading" });
		void loadPlace(entry).then((component) =>
			setState(component ? { status: "loaded", component } : { status: "failed" }),
		);
	}, [entry]);

	// Opened (again), or another place opened: its code is asked for unless it is here already; a place
	// whose fetch failed the last time is asked for again.
	useEffect(() => {
		const now = stateOf(key);
		setState(now);
		if (now.status !== "loaded") load();
	}, [key, load]);

	const { words, config, announce } = props;
	const name = words.places[key];
	useEffect(() => {
		if (state.status === "failed") announce(fill(words.place.loadFailed, { place: name }), true);
	}, [state.status, announce, words, name]);

	if (state.status === "loaded") {
		const Loaded = state.component;
		return <Loaded {...props} />;
	}

	// A Member's back button names the page (Content's, as the loaded place draws it).
	const staff = config.permissions.includes("structure.edit");
	const backTo = entry.namesPage && !staff ? props.documentName || words.documents.page : null;
	return (
		<Place words={words} title={name} backTo={backTo} onBack={props.leave} place={props.place}>
			{state.status === "failed" ? (
				<div className="flex flex-col items-start gap-3 p-5" data-wc-place-load="failed">
					<p role="alert" className="text-chrome-danger m-0 text-[12px]">
						{fill(words.place.loadFailed, { place: name })}
					</p>
					<button
						type="button"
						onClick={() => void retry(load)}
						className={`border-chrome-hover text-chrome-strong hover:bg-chrome-hover inline-flex h-7 items-center rounded-md border px-3 text-[12px] font-medium ${CHROME_EASE} ${FOCUS_RING}`}
					>
						{words.place.tryAgain}
					</button>
				</div>
			) : (
				<p role="status" className="text-chrome-muted m-0 p-5 text-[12px]" data-wc-place-load="loading">
					{fill(words.place.loading, { place: name })}
				</p>
			)}
		</Place>
	);
}

type LoadState = { status: "loading" } | { status: "failed" } | { status: "loaded"; component: PlaceComponent };

/** The places loaded in this tab. */
const loaded = new Map<PlaceEntry["key"], PlaceComponent>();
/** A fetch under way, so a place opened twice quickly is asked for once. */
const pending = new Map<PlaceEntry["key"], Promise<PlaceComponent | null>>();

function stateOf(key: PlaceEntry["key"]): LoadState {
	const component = loaded.get(key);
	return component ? { status: "loaded", component } : { status: "loading" };
}

/** Fetches a place's code once: what draws it, or null when the fetch failed. */
function loadPlace(entry: PlaceEntry): Promise<PlaceComponent | null> {
	const under = pending.get(entry.key);
	if (under) return under;
	const fetching = entry
		.load()
		.then(
			(component) => {
				loaded.set(entry.key, component);
				return component;
			},
			() => null,
		)
		.finally(() => pending.delete(entry.key));
	pending.set(entry.key, fetching);
	return fetching;
}

/**
 * Try again: the place's file is asked for again. When the shell's own file is gone from the server
 * (WebCraft was updated since this page loaded, so the files have new names), asking again can't work:
 * the page is loaded again instead, which keeps its address and so opens the place again.
 */
async function retry(load: () => void): Promise<void> {
	const shell = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src;
	if (shell) {
		try {
			const answer = await fetch(shell, { method: "HEAD", cache: "no-store" });
			if (answer.status === 404) {
				location.reload();
				return;
			}
		} catch {
			// Still offline: asking again says so again.
		}
	}
	load();
}
