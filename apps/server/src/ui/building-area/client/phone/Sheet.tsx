import { ChevronRightIcon, XIcon } from "lucide-react";
import { type ReactNode, type Ref, useEffect, useLayoutEffect, useRef } from "react";

import { CHROME_EASE, FOCUS_RING, type Icon } from "../../controls.tsx";

/**
 * A sheet from the bottom of a phone's screen (SPEC 13.9, `client-flows/06`): the dark card along the
 * bottom with rounded top corners and a handle, the page dimmed behind it. A modal dialog (the
 * browser's own, so what is behind it can't be reached while it is up): Escape, its close button or a
 * tap on the dimmed page closes it, and focus goes back to `from` (the control that opened it).
 */
export function Sheet({
	label,
	closeLabel,
	kind,
	onClose,
	from,
	children,
	start,
}: {
	/** The sheet's name, for screen readers ("More"). */
	label: string;
	closeLabel: string;
	/** Which sheet, for tests and styles. */
	kind: string;
	/** Asked to close (Escape, Close, a tap outside). `returnFocus`: focus goes back to `from`. */
	onClose(returnFocus: boolean): void;
	/** Where focus goes back to as it closes. */
	from: () => HTMLElement | null;
	children: ReactNode;
	/** Before the handle's row, at its start (a way back to the sheet it came from). */
	start?: ReactNode;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	const fromRef = useRef(from);
	fromRef.current = from;

	// Shown as a modal as it mounts, taken away as it unmounts; focus then goes back where it came from.
	useLayoutEffect(() => {
		const shown = dialog.current;
		if (!shown) return;
		if (!shown.open) shown.showModal();
		return () => {
			if (shown.open) shown.close();
		};
	}, []);
	useEffect(
		() => () => {
			const back = fromRef.current();
			if (back?.isConnected) back.focus();
		},
		[],
	);

	return (
		// oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- a tap on the dimmed page; from the keyboard, Escape (the dialog's cancel) closes it.
		<dialog
			ref={dialog}
			aria-label={label}
			onCancel={(event) => {
				// Escape: the sheet's owner closes it, so React keeps the one state.
				event.preventDefault();
				closeRef.current(true);
			}}
			onClick={(event) => {
				// A tap on the dimmed page (the dialog's backdrop) closes it; one on the sheet itself doesn't.
				if (event.target !== event.currentTarget) return;
				const box = event.currentTarget.getBoundingClientRect();
				const inside =
					event.clientX >= box.left &&
					event.clientX <= box.right &&
					event.clientY >= box.top &&
					event.clientY <= box.bottom;
				if (!inside) closeRef.current(true);
			}}
			className="bg-chrome-menu text-chrome-text fixed inset-x-0 top-auto bottom-0 m-0 flex max-h-[85dvh] w-full max-w-none flex-col overflow-y-auto rounded-t-[20px] border-0 p-0 pb-[max(12px,env(safe-area-inset-bottom))] text-[14px] shadow-[0_-12px_32px_rgba(0,0,0,0.45)] outline-none backdrop:bg-black/45"
			data-wc-phone-sheet={kind}
		>
			<div className="relative flex h-11 shrink-0 items-center justify-center">
				{start ? <div className="absolute start-1.5 top-0">{start}</div> : null}
				<span aria-hidden="true" className="h-1 w-9 rounded-sm bg-[#3f3f46]" />
				<button
					type="button"
					aria-label={closeLabel}
					onClick={() => closeRef.current(true)}
					className={`text-chrome-muted hover:bg-chrome-hover hover:text-chrome-strong absolute end-1.5 top-0 grid size-11 place-items-center rounded-[10px] ${CHROME_EASE} ${FOCUS_RING}`}
					data-wc-phone-sheet-close=""
				>
					<XIcon aria-hidden="true" className="size-[18px]" />
				</button>
			</div>
			{children}
		</dialog>
	);
}

/** One row of a phone sheet (`SheetRow` of `client-flows/06`): an icon, its words, a value, a chevron; 48 high. */
export function SheetRow({
	icon: Glyph,
	children,
	value,
	onClick,
	disabled,
	pressed,
	chevron = true,
	data,
	label,
	ref,
}: {
	icon: Icon;
	children: ReactNode;
	value?: string;
	onClick(): void;
	disabled?: boolean;
	pressed?: boolean;
	chevron?: boolean;
	data?: Record<`data-${string}`, string>;
	/** Its name when its words alone don't say it all (the value is read after them otherwise). */
	label?: string;
	ref?: Ref<HTMLButtonElement>;
}) {
	return (
		<button
			ref={ref}
			type="button"
			onClick={disabled ? undefined : onClick}
			aria-disabled={disabled || undefined}
			aria-pressed={pressed}
			aria-label={label}
			className={`hover:bg-chrome-hover flex h-12 w-full shrink-0 items-center gap-2.5 px-3.5 text-start aria-disabled:cursor-default aria-disabled:opacity-45 aria-disabled:hover:bg-transparent ${CHROME_EASE} ${FOCUS_RING} focus-visible:ring-inset`}
			{...data}
		>
			<Glyph aria-hidden="true" className="text-chrome-text size-[18px] shrink-0" />
			<span className="text-chrome-strong min-w-0 grow truncate text-[14px] font-medium">{children}</span>
			{value ? <span className="text-chrome-muted shrink-0 text-[13px]">{value}</span> : null}
			{chevron ? (
				<ChevronRightIcon aria-hidden="true" className="text-chrome-muted size-4 shrink-0 rtl:-scale-x-100" />
			) : null}
		</button>
	);
}
