import { InfoIcon } from "lucide-react";
import type { ReactNode } from "react";

/** A short note beside an Import's form, sheet or report: an icon (information unless given) and a sentence. */
export function Note({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
	return (
		<p className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100">
			<span className="mt-0.5 shrink-0">{icon ?? <InfoIcon className="size-4" aria-hidden="true" />}</span>
			{children}
		</p>
	);
}
