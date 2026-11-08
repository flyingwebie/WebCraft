import type { ReactNode } from "react";

/** A page's main heading and a short line about it. */
export function PageHeader({ heading, children }: { heading: string; children?: ReactNode }) {
	return (
		<div className="mb-8 space-y-1">
			<h1 className="text-2xl font-semibold tracking-tight">{heading}</h1>
			{children ? <p className="text-muted-foreground">{children}</p> : null}
		</div>
	);
}

/** Shown in place of a page the person may not open. */
export function Forbidden({ heading, body }: { heading: string; body: string }) {
	return (
		<div className="space-y-2">
			<h1 className="text-2xl font-semibold tracking-tight">{heading}</h1>
			<p className="text-muted-foreground">{body}</p>
		</div>
	);
}
