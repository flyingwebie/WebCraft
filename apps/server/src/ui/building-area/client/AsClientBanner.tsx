import { ArrowLeftIcon, ScanEyeIcon } from "lucide-react";

import { fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";
import type { AsClient } from "./as-client.ts";

/**
 * "Viewing as a client" (FX-04): a band across the top of client editing while Staff see the page as a
 * Member of a role does, naming the role, saying that changes are still saved, with the way back. It
 * stays whatever the client shell shows (a place, a side panel, a phone's width).
 */
export function AsClientBanner({
	words,
	asClient,
	busy,
	onBack,
}: {
	words: Words;
	asClient: AsClient;
	busy: boolean;
	onBack(): void;
}) {
	const said = words.viewAs;
	return (
		<section
			aria-label={said.banner}
			className="flex h-9 shrink-0 items-center gap-3 border-b border-[#4f46e5]/50 bg-[#1e1b4b] px-3 text-[12px] text-[#e0e7ff]"
			data-wc-as-client={asClient.role.key}
		>
			<ScanEyeIcon aria-hidden="true" className="size-4 shrink-0 text-[#a5b4fc]" />
			<p className="m-0 flex min-w-0 items-baseline gap-2">
				<strong className="shrink-0 font-semibold text-white">{said.banner}</strong>
				<span className="shrink-0">{fill(said.role, { role: said.roles[asClient.role.key] })}</span>
				<span className="hidden truncate text-[#c7d2fe] min-[900px]:inline">{said.note}</span>
			</p>
			<button
				type="button"
				onClick={onBack}
				disabled={busy}
				className={`ms-auto inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-white px-3 font-medium text-[#1e1b4b] hover:bg-[#e0e7ff] disabled:opacity-60 ${CHROME_EASE} ${FOCUS_RING}`}
				data-wc-as-client-back=""
			>
				<ArrowLeftIcon aria-hidden="true" className="size-3.5" />
				{said.back}
			</button>
		</section>
	);
}
