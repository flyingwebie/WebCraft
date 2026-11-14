import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";

import type { ShellConfig, Words } from "./api.ts";
import { FOCUS_RING } from "./controls.tsx";

/**
 * The building area's shell (ADR 0037), served as a hashed file from the Site's address: it reads
 * what the server gave its document (a JSON block, which runs nothing) and draws itself. Someone who
 * may change Structure (Staff) gets the whole shell; a Member gets client editing (SPEC 13, BA-14).
 * Each of the two is a file of its own (BA-30), fetched here, so a Member never loads Staff's shell
 * nor Staff a Member's; the document preloads the one its person gets (`preload` in `assets.ts`).
 */
const block = document.getElementById("webcraft-building-area-config");
const root = document.getElementById("webcraft-building-area");
if (block && root) {
	const config = JSON.parse(block.textContent ?? "{}") as ShellConfig;
	const drawn = createRoot(root);
	const shell: Promise<ReactNode> = config.permissions.includes("structure.edit")
		? import("./Shell.tsx").then(({ Shell }) => <Shell config={config} />)
		: import("./client/ClientShell.tsx").then(({ ClientShell }) => <ClientShell config={config} />);
	shell.then(
		(element) => drawn.render(element),
		() => drawn.render(<ShellFailed words={config.words} />),
	);
}

/** The shell's own file couldn't be fetched (offline, or WebCraft updated meanwhile): says so, with Reload. */
function ShellFailed({ words }: { words: Words }) {
	return (
		<main className="bg-chrome text-chrome-text grid h-dvh place-items-center p-8 font-sans text-[13px]">
			<div className="flex max-w-md flex-col items-center gap-3 text-center" data-wc-shell-failed="">
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
