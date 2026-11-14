import { CheckIcon, LoaderIcon, SendIcon, TriangleAlertIcon, UploadIcon } from "lucide-react";
import type { ReactNode, Ref } from "react";

import { fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";

/**
 * Publish's one cell (SPEC 4 and 10, `docking/08`, `client-flows/05`): the label with its count,
 * "Publishing…", "Published" for 2 s, "Try again"; all in one cell that never changes width. Staff's
 * bar draws it 112 × 32; the client bar 132 × 40 (BA-14). An Author's is "Send for review", 164 wide.
 */
export type CellState =
	| { kind: "ready"; count: number }
	| { kind: "publishing" }
	| { kind: "published" }
	| { kind: "failed" }
	| { kind: "review" };

/** The sizes of the bars that hold the cell. */
export type CellSize = "bar" | "client";

const SIZES: Record<CellSize, { box: string; author: string; text: string; icon: string; badge: string }> = {
	bar: {
		box: "h-8 w-28 rounded-lg gap-1.5",
		author: "h-8 w-[164px] rounded-lg gap-1.5",
		text: "text-[13px]",
		icon: "size-3.5",
		badge: "h-[18px] min-w-[18px] px-[5px] text-[11px]",
	},
	client: {
		box: "h-10 w-[132px] rounded-[10px] gap-2",
		author: "h-10 w-[164px] rounded-[10px] gap-2",
		text: "text-[14px]",
		icon: "size-4",
		badge: "h-5 min-w-5 px-1.5 text-[12px]",
	},
};

/** The keys that open Publish (SPEC 13.9): ⌘↵, or Ctrl+Enter away from Apple. */
export function publishKeys(): { shown: string; aria: string } {
	const apple = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
	return apple ? { shown: "⌘↵", aria: "Meta+Enter" } : { shown: "Ctrl+↵", aria: "Control+Enter" };
}

export function PublishCell({
	state,
	words,
	language,
	size = "bar",
	open,
	sheetId,
	disabled,
	onPress,
	ref,
}: {
	state: CellState;
	words: Words;
	language: string;
	size?: CellSize;
	/** Whether the sheet above it is open. */
	open: boolean;
	sheetId: string;
	disabled: boolean;
	onPress(): void;
	ref?: Ref<HTMLButtonElement>;
}) {
	const shown = words.publishing;
	const look = SIZES[size];
	const icon = `${look.icon} shrink-0`;
	let face: { colours: string; content: ReactNode };
	switch (state.kind) {
		case "publishing":
			face = {
				colours: "bg-primary text-primary-foreground",
				content: (
					<>
						<LoaderIcon aria-hidden="true" className={`${icon} animate-spin motion-reduce:animate-none`} />
						<span>{shown.publishing}</span>
					</>
				),
			};
			break;
		case "published":
			face = {
				colours: "bg-[#14532d] text-[#86efac]",
				content: (
					<>
						<CheckIcon aria-hidden="true" className={icon} />
						<span>{shown.published}</span>
					</>
				),
			};
			break;
		case "failed":
			face = {
				colours: "bg-[#3b1212] text-[#fecaca] hover:bg-[#4c1717]",
				content: (
					<>
						<TriangleAlertIcon aria-hidden="true" className={icon} />
						<span>{shown.tryAgain}</span>
					</>
				),
			};
			break;
		case "review":
			face = {
				colours: "bg-primary text-primary-foreground hover:bg-primary/90",
				content: (
					<>
						<SendIcon aria-hidden="true" className={icon} />
						<span>{shown.sendForReview}</span>
					</>
				),
			};
			break;
		default: {
			const count = state.count;
			const form = new Intl.PluralRules(language).select(count) === "one" ? "one" : "other";
			face = {
				colours:
					count > 0 ? "bg-primary text-primary-foreground hover:bg-primary/90" : "bg-chrome-raised text-chrome-faint",
				content: (
					<>
						{size === "client" ? <UploadIcon aria-hidden="true" className={icon} /> : null}
						<span>{shown.cell}</span>
						{count > 0 ? (
							<>
								<span
									aria-hidden="true"
									className={`inline-grid place-items-center rounded-full bg-black/25 font-bold ${look.badge}`}
								>
									{count}
								</span>
								<span className="sr-only">{`, ${fill(shown.changes[form], { count: String(count) })}`}</span>
							</>
						) : null}
					</>
				),
			};
		}
	}
	const keys = publishKeys();
	return (
		<button
			ref={ref}
			type="button"
			disabled={disabled}
			onClick={onPress}
			aria-haspopup={state.kind === "failed" ? undefined : "dialog"}
			aria-expanded={state.kind === "failed" ? undefined : open}
			aria-controls={open ? sheetId : undefined}
			aria-keyshortcuts={keys.aria}
			aria-busy={state.kind === "publishing" ? true : undefined}
			className={`inline-flex shrink-0 items-center justify-center font-semibold whitespace-nowrap disabled:cursor-default ${
				state.kind === "review" ? look.author : look.box
			} ${look.text} ${face.colours} ${CHROME_EASE} ${FOCUS_RING}`}
			data-wc-publish={state.kind}
		>
			{face.content}
		</button>
	);
}
