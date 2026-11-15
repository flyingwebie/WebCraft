import { HandIcon } from "lucide-react";
import { useId } from "react";

import type { Words } from "../../api.ts";
import { FOCUS_RING } from "../../controls.tsx";

/**
 * The first visit on a phone (`client-flows/06`, "Edit view"): one line over the page, above the bar,
 * instead of the desktop's card ("Tap the dashed outline to make changes."). Got it puts it away for
 * good (the person's editor preferences, as the card does); Help in More shows the whole card.
 */
export function PhoneHint({ words, onClose }: { words: Words; onClose(): void }) {
	const phone = words.client.phone;
	const textId = useId();
	return (
		<div
			role="dialog"
			aria-modal="false"
			aria-labelledby={textId}
			onKeyDown={(event) => {
				if (event.key !== "Escape") return;
				event.preventDefault();
				event.stopPropagation();
				onClose();
			}}
			className="text-chrome-text absolute inset-x-3 bottom-3 z-30 flex min-h-14 items-center gap-2.5 rounded-xl bg-[#18181bf2] py-1.5 ps-3.5 pe-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.4)]"
			data-wc-phone-hint=""
		>
			<HandIcon aria-hidden="true" className="size-4 shrink-0" />
			<p id={textId} className="m-0 grow text-[12px] leading-4">
				{phone.hint}
			</p>
			<button
				type="button"
				onClick={onClose}
				className={`h-8 shrink-0 rounded-lg bg-white px-3 text-[12px] font-semibold text-[#18181b] ${FOCUS_RING}`}
				data-wc-help-close=""
			>
				{words.client.hint.gotIt}
			</button>
		</div>
	);
}
