import type { BuildingAreaApiClient } from "@webcraft/api";
import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { fill, type Words } from "../../api.ts";
import type { GoToData } from "../../management.ts";
import { dangerLook } from "../content/post-types/DeleteDialog.tsx";
import { buttonLook } from "../content/ui.tsx";
import { type ComponentUse, codeOf, counted, nameOfUse, orderedUses, reasonText } from "./data.ts";

/** A Component as the dialog names it. */
export type DeletingComponent = { id: string; name: string };

/** What the dialog knows: still asking, what goes (with the confirmation), or why it can't. */
type State =
	| { kind: "asking" }
	| { kind: "ready"; pages: number; usedIn: ComponentUse[]; confirmation: string }
	| { kind: "inUse"; usedIn: ComponentUse[] }
	| { kind: "failed"; reason: string };

/**
 * The dialog that deletes a Component (SPEC 10: a thing in use gets a dialog that names it and where
 * it is used, focus on Cancel; `docking/08`): "Delete “Hero split”? Used on 4 pages, including Home.
 * Deleting it removes every instance." It asks `components.delete` with its Placements to go first,
 * which deletes nothing and answers where it is placed; Delete makes the second call, which removes
 * every Placement with it. A Popup or the accessibility statement showing it still refuses it: the
 * dialog lists those, with only Close. A modal `<dialog>`: everything under it is inert, Escape and
 * Cancel close it, and focus goes back to what opened it.
 */
export function DeleteComponentDialog({
	words,
	language,
	api,
	siteId,
	component,
	goTo,
	onClose,
	onDeleted,
}: {
	words: Words;
	language: string;
	api: BuildingAreaApiClient;
	siteId: string;
	component: DeletingComponent;
	goTo: GoToData;
	onClose(): void;
	onDeleted(): void;
}) {
	const shown = words.components;
	const dialog = useRef<HTMLDialogElement>(null);
	const cancel = useRef<HTMLButtonElement>(null);
	const [state, setState] = useState<State>({ kind: "asking" });
	const [busy, setBusy] = useState(false);
	const title = useId();
	const text = useId();
	const latest = useRef({ words, onDeleted });
	latest.current = { words, onDeleted };

	useEffect(() => {
		const shownDialog = dialog.current;
		if (shownDialog && !shownDialog.open) shownDialog.showModal();
		cancel.current?.focus();
		return () => shownDialog?.close();
	}, []);

	// The first call is made once per dialog, whatever the place draws meanwhile.
	useEffect(() => {
		let alive = true;
		api.components
			.delete({ siteId, componentId: component.id, placements: "remove" })
			.then((answer) => {
				if (!alive) return;
				if (answer.deleted) return latest.current.onDeleted();
				setState({
					kind: "ready",
					pages: answer.usage?.pages ?? 0,
					usedIn: orderedUses(answer.usage?.usedIn ?? []),
					confirmation: answer.confirmation.id,
				});
			})
			.catch((error: unknown) => {
				if (!alive) return;
				if (codeOf(error) === "COMPONENT_IN_USE")
					setState({
						kind: "inUse",
						usedIn: ((error as { data?: { usedIn?: ComponentUse[] } }).data?.usedIn ?? []) as ComponentUse[],
					});
				else setState({ kind: "failed", reason: reasonText(latest.current.words, error) });
			});
		return () => {
			alive = false;
		};
	}, [api, siteId, component.id]);

	const close = () => {
		dialog.current?.close();
		onClose();
	};

	const confirm = async () => {
		if (state.kind !== "ready" || busy) return;
		setBusy(true);
		try {
			await api.components.delete({
				siteId,
				componentId: component.id,
				confirmation: state.confirmation,
				placements: "remove",
			});
			dialog.current?.close();
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
			? fill(shown.inUseTitle, { name: component.name })
			: fill(shown.deleteTitle, { name: component.name });
	let body: string;
	switch (state.kind) {
		case "asking":
			body = shown.deleteChecking;
			break;
		case "ready": {
			const first = state.usedIn[0];
			body =
				state.usedIn.length === 0
					? fill(shown.deleteUnused, { name: component.name })
					: state.pages > 0 && first
						? fill(shown.deleteUsed, {
								pages: counted(words.templates.shownOn, state.pages, language),
								first: nameOfUse(words, first, goTo),
							})
						: fill(shown.deletePlaced, { count: counted(shown.places, state.usedIn.length, language) });
			break;
		}
		case "inUse":
			body = shown.inUseText;
			break;
		case "failed":
			body = fill(shown.deleteFailed, { reason: state.reason });
			break;
	}
	const uses = state.kind === "ready" || state.kind === "inUse" ? state.usedIn : [];

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
				close();
			}}
			onCancel={(event) => {
				event.preventDefault();
				close();
			}}
			className="bg-chrome-menu text-chrome-text border-chrome-hover m-auto w-[440px] max-w-[calc(100vw-32px)] rounded-[10px] border p-4 shadow-[0_24px_64px_rgba(0,0,0,0.6)] backdrop:bg-black/50"
			data-wc-delete-component={component.id}
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
					{uses.length > 0 ? (
						<ul
							className="text-chrome-text m-0 flex max-h-40 list-disc flex-col gap-1 overflow-y-auto ps-5 text-[12px]"
							data-wc-used-in=""
						>
							{uses.map((use) => (
								<li key={`${use.kind}:${use.id}`}>{nameOfUse(words, use, goTo)}</li>
							))}
						</ul>
					) : null}
				</div>
				<div className="flex items-center justify-end gap-2">
					<button
						ref={cancel}
						type="button"
						onClick={close}
						// Focus starts here when the dialog opens, by any means: its ring shows then too (SPEC 10).
						className={`${buttonLook("outline")} focus:ring-chrome-focus focus:ring-offset-chrome w-[90px] focus:ring-2 focus:ring-offset-1`}
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
