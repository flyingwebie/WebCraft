import type { Json as DocumentJson, DraftRefused } from "@webcraft/core/draft-document";
import { useRef, useState } from "react";

import { type PublishedBy, type SharedDraft, useSharedDraft } from "./shared-draft.ts";

/**
 * A shared Draft's status in the words the (pre-Co-editing) autosave status badge and save-error
 * retry button already take, and whether the fieldset around its values should be disabled: offline
 * or read-only (no longer, or not yet, able to change it), or the session ended.
 */
export type LegacyAutosave = { status: "saved" | "saving" | "waiting"; flush(): Promise<boolean> };

/**
 * A form's values kept in a shared Draft (Co-editing, ADR 0025): what the form shows, read from the
 * document (others' changes show as they are saved), and its person's changes written into it. A
 * change made before the document arrived is written once it has; one made while the Draft can't be
 * changed here (read-only) is put back as the document holds it.
 */
export function useCoEditedValues<Values, Change>(options: {
	path: string;
	initial: Values;
	read(draft: DocumentJson): Values;
	write(draft: DocumentJson, change: Change): DocumentJson;
	/** What the form shows at once for a change, before the document has it. */
	merge(values: Values, change: Change): Values;
	onRefused(refusal: DraftRefused): void;
	/** A moment after changes were saved: read what the server worked out (problems, status). */
	onSettled(): void;
}): {
	values: Values;
	change(change: Change): void;
	shared: SharedDraft;
	publishedBy: PublishedBy | undefined;
	autosave: LegacyAutosave;
	/** Whether the values can't be changed here: offline, read-only, or the session ended. */
	locked: boolean;
} {
	const [values, setValues] = useState(options.initial);
	const [publishedBy, setPublishedBy] = useState<PublishedBy | undefined>(undefined);
	const waiting = useRef<Change[]>([]);
	const own = useRef<SharedDraft | null>(null);
	const latest = useRef(options);
	latest.current = options;

	const shared = useSharedDraft({
		path: options.path,
		onRemote: (draft) => {
			const current = own.current;
			if (current && waiting.current.length > 0) {
				for (const change of waiting.current.splice(0)) current.change((next) => latest.current.write(next, change));
				setValues(latest.current.read(current.draft()));
				return;
			}
			setValues(latest.current.read(draft));
		},
		onSettled: () => latest.current.onSettled(),
		onRefused: (refusal) => latest.current.onRefused(refusal),
		onPublished: (by) => {
			const self = own.current?.participants.find((participant) => participant.self);
			// Others see who published; the person who did knows.
			if (by && self && by.personId === self.personId && by.via === null) return;
			setPublishedBy(by);
		},
	});
	own.current = shared;

	const change = (next: Change) => {
		setValues((before) => latest.current.merge(before, next));
		if (shared.change((draft) => latest.current.write(draft, next))) return;
		if (shared.status === "connecting") waiting.current.push(next);
		else setValues(latest.current.read(shared.draft()));
	};

	const autosave: LegacyAutosave = {
		status: shared.status === "saved" ? "saved" : shared.status === "saving" ? "saving" : "waiting",
		flush: shared.flush,
	};
	const locked = shared.status === "readOnly" || shared.status === "ended" || !shared.editable;

	return { values, change, shared, publishedBy, autosave, locked };
}
