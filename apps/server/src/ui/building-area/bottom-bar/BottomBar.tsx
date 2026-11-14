import { ExternalLinkIcon, Redo2Icon, Undo2Icon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { editorHistory } from "../../builder/editor-history.ts";
import { ariaKeys, shortcutText } from "../../builder/shortcuts.ts";
import { fill, type Words } from "../api.ts";
import { FOCUS_RING, IconButton, IconLink, Tip } from "../controls.tsx";
import { type DraftState, DraftStateCell } from "./DraftState.tsx";
import { LanguageMenu, type PageLanguage } from "./LanguageMenu.tsx";

/** What the shell's Undo history offers now: the step each way, by its label. */
type HistoryState = { undo: string | null; redo: string | null; busy: boolean };

/** The shell's one Undo history (one per tab, ADR 0037 › 1.5), as Undo and Redo show it. */
function useHistory(): HistoryState {
	const history = editorHistory();
	const [state, setState] = useState<HistoryState>(() => history.state());
	useEffect(() => history.subscribe(() => setState(history.state())), [history]);
	return state;
}

/** The keys of one of the editor's shortcuts, as a tooltip shows them and as `aria-keyshortcuts` says them. */
function keysOf(id: string) {
	return { shown: shortcutText(id), aria: ariaKeys(id) };
}

/**
 * The bottom bar (SPEC 2 and 4): 48 high, full width. Left (400): Undo, Redo and the open document's
 * own controls (Back to its page, the Entry it previews, the Template rendering it). Centre: the insert
 * row's place (it comes with BA-10). Right (400): the page's language, View on Staging, the Draft
 * state and Publish (112 × 32, never changing width; it publishes from BA-12). A place with something of
 * its own to publish hands it in (`onPublish`: the Forms place's Form, BA-26): its label, progress and
 * result then share the button's one cell (SPEC 10).
 */
export function BottomBar({
	words,
	nav,
	language,
	languages,
	onLanguage,
	staging,
	draft,
	insertRow = true,
	onPublish,
}: {
	words: Words;
	/** The open document's part of the left cluster, after Undo and Redo (`DocumentNav`). */
	nav?: ReactNode;
	/** The person's Admin language, for the Draft state's plural. */
	language: string;
	/** The page's languages, when the Site has more than one. */
	languages: readonly PageLanguage[];
	onLanguage(language: PageLanguage): void;
	/** The page on the Site's Staging address, or null when there is none to open. */
	staging: string | null;
	draft: DraftState;
	/** Whether the insert row has its place in the middle: none while a place is open (SPEC 8); the middle stays. */
	insertRow?: boolean;
	/** Publishes what a place hands in; answers whether it was published. None: Publish waits for BA-12. */
	onPublish?(): Promise<boolean>;
}) {
	const history = useHistory();
	const [publishing, setPublishing] = useState<"idle" | "busy" | "done">("idle");
	const shownDone = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => () => clearTimeout(shownDone.current ?? undefined), []);
	const publish = async () => {
		if (!onPublish || publishing === "busy") return;
		setPublishing("busy");
		const published = await onPublish();
		setPublishing(published ? "done" : "idle");
		if (published) {
			clearTimeout(shownDone.current ?? undefined);
			shownDone.current = setTimeout(() => setPublishing("idle"), 2000);
		}
	};
	const undoLabel = history.undo ? fill(words.undoStep, { step: history.undo }) : words.undo;
	const redoLabel = history.redo ? fill(words.redoStep, { step: history.redo }) : words.redo;
	return (
		<section
			aria-label={words.bar}
			data-building-region="bar"
			className="border-chrome-line bg-chrome focus-visible:ring-chrome-focus col-span-full col-start-1 row-start-2 flex h-12 min-w-0 items-center border-t px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-inset"
		>
			<div className="flex h-full w-[400px] shrink items-center gap-2" data-wc-bar-cluster="start">
				<IconButton
					icon={Undo2Icon}
					label={undoLabel}
					keys={keysOf("editor.undo")}
					side="top"
					align="start"
					size="bar"
					disabled={!history.undo || history.busy}
					onClick={() => void editorHistory().undo()}
					data={{ "data-wc-bar": "undo" }}
				/>
				<IconButton
					icon={Redo2Icon}
					label={redoLabel}
					keys={keysOf("editor.redo")}
					side="top"
					size="bar"
					disabled={!history.redo || history.busy}
					onClick={() => void editorHistory().redo()}
					data={{ "data-wc-bar": "redo" }}
				/>
				{nav}
			</div>
			{/* The insert row (BA-10) goes here, in the middle of the bar. */}
			<div
				className="flex h-full min-w-0 grow items-center justify-center"
				data-wc-insert-row={insertRow ? "" : undefined}
			/>
			<div className="flex h-full w-[400px] shrink items-center justify-end gap-2" data-wc-bar-cluster="end">
				{languages.length > 1 ? <LanguageMenu languages={languages} words={words} onChoose={onLanguage} /> : null}
				{staging ? (
					<IconLink
						icon={ExternalLinkIcon}
						label={words.viewOnStaging}
						side="top"
						size="bar"
						href={staging}
						newTab
						data={{ "data-wc-bar": "staging" }}
					/>
				) : null}
				<DraftStateCell state={draft} words={words} language={language} />
				<span className="group relative inline-flex shrink-0">
					<button
						type="button"
						disabled={!onPublish || publishing === "busy"}
						aria-busy={publishing === "busy" || undefined}
						onClick={() => void publish()}
						className={`bg-primary text-primary-foreground h-8 w-28 shrink-0 rounded-lg text-[13px] font-semibold disabled:opacity-60 ${FOCUS_RING}`}
						data-wc-publish={publishing}
					>
						{publishing === "busy" ? words.publishing : publishing === "done" ? words.publishedNow : words.publish}
					</button>
					{onPublish ? null : <Tip label={words.publishLater} side="top" align="end" />}
				</span>
			</div>
		</section>
	);
}
