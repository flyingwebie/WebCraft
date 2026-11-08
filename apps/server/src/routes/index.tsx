import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
	component: AdminHome,
});

/** A placeholder until the setup wizard and the admin shell exist. */
function AdminHome() {
	return (
		<main className="mx-auto flex min-h-svh max-w-xl flex-col justify-center gap-2 p-8">
			<h1 className="text-2xl font-semibold">WebCraft</h1>
			<p className="text-muted-foreground">This Install is running. The admin screens are not built yet.</p>
		</main>
	);
}
