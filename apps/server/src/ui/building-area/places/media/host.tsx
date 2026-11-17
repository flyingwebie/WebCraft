import { type ComponentType, useEffect, useRef, useState } from "react";

import type { MediaItem } from "../../../media/preview.ts";
import type { ShellConfig } from "../../api.ts";
import { PICK_MEDIA_EVENT, type PickMediaDetail } from "./pick.ts";
import type { PickerDialog } from "./Picker.tsx";
import { notify, Toasts } from "./toasts.tsx";

/**
 * What the shell keeps mounted for Media, whatever is open (BA-22): the Media picker, opened by
 * `pickMedia()` from anywhere in the shell (`pick.ts`), and the toasts the Media parts send (top
 * centre, SPEC 10). The picker's code (the dialog and the Media parts it draws with) is a file of its
 * own, fetched the first time a file is asked for (BA-30); if it can't be fetched, a toast says so and
 * the caller gets null, as when nothing is chosen.
 */
export function MediaShellHost({ config }: { config: ShellConfig }) {
	const [request, setRequest] = useState<PickMediaDetail | null>(null);
	const [Dialog, setDialog] = useState<PickerComponent | null>(() => picker);
	const opener = useRef<HTMLElement | null>(null);
	const asked = useRef<PickMediaDetail | null>(null);

	const answer = (item: MediaItem | null) => {
		const detail = asked.current;
		asked.current = null;
		setRequest(null);
		detail?.answer(item);
	};
	const answerRef = useRef(answer);
	answerRef.current = answer;
	const failedWords = config.words.media.pickerFailed;

	useEffect(() => {
		const onPick = (event: Event) => {
			const detail = (event as CustomEvent<PickMediaDetail>).detail;
			if (!detail || typeof detail.answer !== "function") return;
			detail.taken = true;
			// A second request while one is open answers the first: nothing was chosen for it.
			asked.current?.answer(null);
			asked.current = detail;
			opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			setRequest(detail);
			if (picker) return;
			void loadPicker().then((loaded) => {
				if (loaded) setDialog(() => loaded);
				else if (asked.current === detail) {
					notify("error", failedWords);
					answerRef.current(null);
				}
			});
		};
		document.addEventListener(PICK_MEDIA_EVENT, onPick);
		return () => document.removeEventListener(PICK_MEDIA_EVENT, onPick);
	}, [failedWords]);

	return (
		<>
			{request && Dialog ? <Dialog config={config} request={request} finalFocus={opener} onAnswer={answer} /> : null}
			<Toasts closeLabel={config.words.media.closeToast} />
		</>
	);
}

type PickerComponent = ComponentType<Parameters<typeof PickerDialog>[0]>;

/** The picker's code once fetched in this tab. */
let picker: PickerComponent | null = null;
let fetching: Promise<PickerComponent | null> | null = null;

/** Fetches the picker's code once: the dialog, or null when the fetch failed (asked again next time). */
function loadPicker(): Promise<PickerComponent | null> {
	fetching ??= import("./Picker.tsx").then(
		(module) => {
			picker = module.PickerDialog;
			return picker;
		},
		() => {
			fetching = null;
			return null;
		},
	);
	return fetching;
}
