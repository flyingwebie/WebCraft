import type { BuildingAreaApiClient } from "@webcraft/api";
import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { fill, type Words } from "../../../api.ts";
import { buttonLook } from "../ui.tsx";
import { codeOf, reasonText } from "./controls.tsx";

/** A Post Type as the dialog names it. */
export type Deleting = { id: string; name: string };

/** Where a Post Type is named by other Structure (`POST_TYPE_IN_USE`'s `usedIn`). */
type Use =
	| { kind: "postType"; id: string; name: string; path: string }
	| { kind: "component"; id: string; name: string; path: string }
	| { kind: "loop"; id: string; name: string };

/** What the dialog knows: still asking, what would go (with the confirmation), or why it can't. */
type State =
	| { kind: "asking" }
	| { kind: "ready"; entries: number; templates: number; confirmation: string }
	| { kind: "inUse"; usedIn: Use[] }
	| { kind: "builtIn" }
	| { kind: "failed"; reason: string };

/** "8 Entries", "1 Template", in the person's language. */
function counted(forms: { one: string; other: string }, count: number, language: string): string {
	return fill(forms[new Intl.PluralRules(language).select(count) === "one" ? "one" : "other"], {
		count: String(count),
	});
}

/**
 * The dialog that deletes a Post Type (SPEC 10: a thing in use gets a dialog that names it and what
 * goes with it, focus on Cancel; `places-content/02`). It asks `postTypes.delete` first, which deletes
 * nothing and answers how many Entries and Templates would go (or why it can't go: the Page Post Type,
 * or other Structure naming it); Delete makes the second call with that answer's confirmation. A
 * modal `<dialog>`: everything under it is inert, Escape and Cancel close it, and focus goes back to
 * what opened it.
 */
export function DeleteDialog({
	words,
	language,
	api,
	siteId,
	postType,
	onClose,
	onDeleted,
}: {
	words: Words;
	language: string;
	api: BuildingAreaApiClient;
	siteId: string;
	postType: Deleting;
	/** Closes the dialog without deleting (focus goes back to the button that opened it). */
	onClose(): void;
	onDeleted(): void;
}) {
	const shown = words.postTypes;
	const dialog = useRef<HTMLDialogElement>(null);
	const cancel = useRef<HTMLButtonElement>(null);
	const [state, setState] = useState<State>({ kind: "asking" });
	const [busy, setBusy] = useState(false);
	const title = useId();
	const text = useId();
	// The first call is made once per dialog, whatever the place draws meanwhile.
	const latest = useRef({ words, onDeleted });
	latest.current = { words, onDeleted };

	useEffect(() => {
		const shownDialog = dialog.current;
		if (shownDialog && !shownDialog.open) shownDialog.showModal();
		cancel.current?.focus();
		return () => shownDialog?.close();
	}, []);

	useEffect(() => {
		let alive = true;
		api.postTypes
			.delete({ siteId, postTypeId: postType.id })
			.then((answer) => {
				if (!alive) return;
				if (answer.deleted) return latest.current.onDeleted();
				setState({
					kind: "ready",
					entries: answer.entries,
					templates: answer.templates,
					confirmation: answer.confirmation.id,
				});
			})
			.catch((error: unknown) => {
				if (!alive) return;
				const code = codeOf(error);
				if (code === "POST_TYPE_IN_USE")
					setState({ kind: "inUse", usedIn: ((error as { data?: { usedIn?: Use[] } }).data?.usedIn ?? []) as Use[] });
				else if (code === "POST_TYPE_BUILT_IN") setState({ kind: "builtIn" });
				else setState({ kind: "failed", reason: reasonText(latest.current.words, error) });
			});
		return () => {
			alive = false;
		};
	}, [api, siteId, postType.id]);

	const confirm = async () => {
		if (state.kind !== "ready" || busy) return;
		setBusy(true);
		try {
			await api.postTypes.delete({ siteId, postTypeId: postType.id, confirmation: state.confirmation });
			onDeleted();
		} catch (error) {
			setBusy(false);
			setState({ kind: "failed", reason: reasonText(words, error) });
			cancel.current?.focus();
		}
	};

	const ready = state.kind === "ready";
	const heading =
		state.kind === "inUse"
			? fill(shown.inUseTitle, { name: postType.name })
			: fill(shown.deleteTitle, { name: postType.name });
	let body: string;
	switch (state.kind) {
		case "asking":
			body = shown.deleteChecking;
			break;
		case "ready":
			body =
				state.entries === 0 && state.templates === 0
					? fill(shown.deleteEmpty, { name: postType.name })
					: fill(shown.deleteText, {
							name: postType.name,
							entries: counted(shown.entries, state.entries, language),
							templates: counted(shown.templates, state.templates, language),
						});
			break;
		case "inUse":
			body = shown.inUseText;
			break;
		case "builtIn":
			body = shown.builtInRefused;
			break;
		case "failed":
			body = fill(shown.deleteFailed, { reason: state.reason });
			break;
	}

	return (
		<dialog
			ref={dialog}
			role="alertdialog"
			aria-labelledby={title}
			aria-describedby={text}
			aria-busy={state.kind === "asking" || busy}
			onKeyDown={(event) => {
				if (event.key !== "Escape") return;
				// The dialog closes; the place under it stays (its own Escape goes back to the canvas).
				event.preventDefault();
				event.stopPropagation();
				onClose();
			}}
			onCancel={(event) => {
				event.preventDefault();
				onClose();
			}}
			className="bg-chrome-menu text-chrome-text border-chrome-hover m-auto w-[440px] max-w-[calc(100vw-32px)] rounded-[10px] border p-4 shadow-[0_24px_64px_rgba(0,0,0,0.6)] backdrop:bg-black/50"
			data-wc-delete-post-type={postType.id}
		>
			<div className="flex flex-col gap-3">
				<h2 id={title} className="text-chrome-strong m-0 flex items-center gap-2 text-[14px] font-semibold">
					<TriangleAlertIcon aria-hidden="true" className="text-chrome-danger size-[18px] shrink-0" />
					{heading}
				</h2>
				<div id={text} className="flex flex-col gap-2">
					<p
						className={`m-0 text-[13px] ${state.kind === "failed" ? "text-chrome-danger" : "text-chrome-muted"}`}
						role={state.kind === "failed" ? "alert" : undefined}
					>
						{body}
					</p>
					{state.kind === "inUse" ? (
						<ul className="text-chrome-text m-0 flex list-disc flex-col gap-1 ps-5 text-[12px]" data-wc-used-in="">
							{state.usedIn.map((use) => (
								<li key={`${use.kind}:${use.id}:${"path" in use ? use.path : ""}`}>
									{use.kind === "loop"
										? fill(shown.usedByLoop, { name: use.name })
										: fill(use.kind === "postType" ? shown.usedByPostType : shown.usedByComponent, {
												name: use.name,
												path: use.path,
											})}
								</li>
							))}
						</ul>
					) : null}
				</div>
				<div className="flex items-center justify-end gap-2">
					<button
						ref={cancel}
						type="button"
						onClick={onClose}
						className={`${buttonLook("outline")} w-[90px]`}
						data-wc-dialog-cancel=""
					>
						{ready || state.kind === "asking" ? shown.cancel : shown.close}
					</button>
					{state.kind === "ready" || state.kind === "asking" ? (
						<button
							type="button"
							onClick={() => void confirm()}
							disabled={!ready || busy}
							className={`${dangerLook} w-[90px]`}
							data-wc-dialog-delete=""
						>
							{busy ? shown.deleting : shown.confirmDelete}
						</button>
					) : null}
				</div>
			</div>
		</dialog>
	);
}

/** The danger button (Delete, Delete Field): dark red with a red edge, as the frames draw it. */
export const dangerLook =
	"inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[7px] border border-[#b91c1c] bg-[#450a0a] px-2.5 text-[12px] font-semibold text-[#fecaca] hover:bg-[#7f1d1d] disabled:opacity-60 transition-[background-color,color,opacity] duration-150 ease-in-out motion-reduce:transition-none outline-none focus-visible:ring-2 focus-visible:ring-chrome-focus focus-visible:ring-offset-1 focus-visible:ring-offset-chrome";
