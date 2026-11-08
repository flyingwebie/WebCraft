import type { ReactNode } from "react";

/** A step's heading and introduction. The wizard moves focus to the heading when the step opens. */
export function StepHeader({ heading, children }: { heading: string; children?: ReactNode }) {
	return (
		<div className="space-y-2">
			<h1 tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">
				{heading}
			</h1>
			{children ? <div className="text-muted-foreground space-y-2">{children}</div> : null}
		</div>
	);
}
