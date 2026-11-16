import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";

import type { ClientRole, ShellConfig, ViewAsClient, Words } from "./api.ts";
import { FOCUS_RING } from "./controls.tsx";

/**
 * The building area's shell (ADR 0037), served as a hashed file from the Site's address: it reads
 * what the server gave its document (a JSON block, which runs nothing) and draws itself. Someone who
 * may change Structure (Staff) gets the whole shell; a Member gets client editing (SPEC 13, BA-14).
 * Each of the two is a file of its own (BA-30), fetched here, so a Member never loads Staff's shell
 * nor Staff a Member's; the document preloads the one its person gets (`preload` in `assets.ts`).
 *
 * Staff may see the page as a client does (FX-04, "View as a client"): client editing's file is then
 * fetched and drawn in place of Staff's shell, as a Member of the role chosen would get it, until they
 * go back. Which view the tab is in survives a reload (`sessionStorage`).
 */
const block = document.getElementById("webcraft-building-area-config");
const root = document.getElementById("webcraft-building-area");

/**
 * Staff seeing the page as a client: the role, Staff's address and panels to go back to (the panels as
 * they were handed over: their preferences are written a moment after a change, which a reload can
 * outrun), and the session's header token, so a later session in the same tab (entered again from the
 * admin) starts in Staff's view.
 */
type ClientView = { role: ClientRole["key"]; back: string; layout: ViewAsClient["layout"]; token: string };

/** Where the tab keeps the view it is in, so a reload stays in it. */
const VIEW_KEY = "webcraft.building.clientView";

function storedView(): ClientView | null {
	try {
		const value = JSON.parse(sessionStorage.getItem(VIEW_KEY) ?? "null") as ClientView | null;
		return value && typeof value.role === "string" && typeof value.back === "string" && typeof value.token === "string"
			? value
			: null;
	} catch {
		return null;
	}
}

function storeView(view: ClientView | null): void {
	try {
		if (view) sessionStorage.setItem(VIEW_KEY, JSON.stringify(view));
		else sessionStorage.removeItem(VIEW_KEY);
	} catch {
		// Without storage a reload goes back to Staff's view.
	}
}

if (block && root) {
	const config = JSON.parse(block.textContent ?? "{}") as ShellConfig;
	const drawn = createRoot(root);
	const show = (shell: Promise<ReactNode>) =>
		shell.then(
			(element) => drawn.render(element),
			() => drawn.render(<ShellFailed words={config.words} />),
		);
	// Client editing's file, fetched once whoever asks: a Member, or Staff seeing the page as a client.
	const clientShell = () => import("./client/ClientShell.tsx");
	// The panels as Staff left them, while the tab is in client editing (their preferences follow).
	let layout = config.layout;
	const staff = (returned = false) =>
		show(
			import("./Shell.tsx").then(({ Shell }) => (
				<Shell config={{ ...config, layout }} returned={returned} onViewAsClient={(handed) => client(handed)} />
			)),
		);
	const client = (view: ViewAsClient) => {
		layout = view.layout;
		storeView({ role: view.role.key, back: view.back, layout: view.layout, token: config.token });
		show(
			clientShell().then(({ ClientShell }) => (
				<ClientShell
					// A Member's Permissions: what client editing draws by is the role's, never Staff's.
					config={{ ...config, permissions: config.permissions.filter((each) => view.role.permissions.includes(each)) }}
					asClient={{
						role: view.role,
						back: view.back,
						done: () => {
							storeView(null);
							staff(true);
						},
					}}
				/>
			)),
		);
	};
	if (!config.permissions.includes("structure.edit"))
		show(clientShell().then(({ ClientShell }) => <ClientShell config={config} />));
	else {
		const stored = storedView();
		const role =
			stored?.token === config.token ? config.clientRoles.find((each) => each.key === stored.role) : undefined;
		if (stored && role) client({ role, back: stored.back, layout: stored.layout ?? config.layout });
		else staff();
	}
}

/** The shell's own file couldn't be fetched (offline, or WebCraft updated meanwhile): says so, with Reload. */
function ShellFailed({ words }: { words: Words }) {
	return (
		<main className="bg-chrome text-chrome-text grid h-dvh place-items-center p-8 font-sans text-[13px]">
			<div className="flex max-w-md flex-col items-center gap-3 text-center" data-wc-shell-failed="">
				<h1 className="text-chrome-strong m-0 text-[16px] font-semibold">{words.pageTitle}</h1>
				<p role="alert" className="m-0">
					{words.shellFailed}
				</p>
				<button
					type="button"
					onClick={() => location.reload()}
					className={`border-chrome-hover text-chrome-strong hover:bg-chrome-hover inline-flex h-8 items-center rounded-md border px-3 text-[12px] font-medium ${FOCUS_RING}`}
				>
					{words.shellReload}
				</button>
			</div>
		</main>
	);
}
