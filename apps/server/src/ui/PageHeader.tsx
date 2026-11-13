import type { ReactNode } from "react";

/** A page's main heading, a short line about it, and the page's main action (such as "New Site"). */
export function PageHeader({
	heading,
	children,
	action,
}: {
	heading: string;
	children?: ReactNode;
	action?: ReactNode;
}) {
	return (
		<div className="mb-8 flex flex-wrap items-start justify-between gap-4">
			<div className="space-y-1">
				<h1 className="text-2xl font-semibold tracking-tight">{heading}</h1>
				{children ? <p className="text-muted-foreground">{children}</p> : null}
			</div>
			{action ? <div className="shrink-0">{action}</div> : null}
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
