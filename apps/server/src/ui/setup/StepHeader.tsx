import type { ReactNode } from "react";

/** A step's heading and introduction. The wizard moves focus to the heading when the step opens. */
export function StepHeader({ heading, children }: { heading: string; children?: ReactNode }) {
	return (
		<div className="grid gap-2">
			<h1 tabIndex={-1} className="text-xl font-semibold tracking-tight outline-none">
				{heading}
			</h1>
			{children ? <div className="text-muted-foreground grid gap-2 text-sm">{children}</div> : null}
		</div>
	);
}
