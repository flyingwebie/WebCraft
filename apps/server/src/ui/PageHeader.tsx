/**
 * A page's main heading, a short line about it, and the page's actions: the admin shell's page header
 * (`shell/page.tsx`), kept here for the screens that import it from this place.
 */
export { PageHeader } from "./shell/page.tsx";

/** Shown in place of a page the person may not open. */
export function Forbidden({ heading, body }: { heading: string; body: string }) {
	return (
		<div className="space-y-2">
			<h1 className="text-2xl font-semibold tracking-tight">{heading}</h1>
			<p className="text-muted-foreground">{body}</p>
		</div>
	);
}
