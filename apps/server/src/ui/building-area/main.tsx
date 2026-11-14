import { createRoot } from "react-dom/client";

import type { ShellConfig } from "./api.ts";
import { ClientShell } from "./client/ClientShell.tsx";
import { Shell } from "./Shell.tsx";

/**
 * The building area's shell (ADR 0037), served as a hashed file from the Site's address: it reads
 * what the server gave its document (a JSON block, which runs nothing) and draws itself. Someone who
 * may change Structure (Staff) gets the whole shell; a Member gets client editing (SPEC 13, BA-14).
 */
const block = document.getElementById("webcraft-building-area-config");
const root = document.getElementById("webcraft-building-area");
if (block && root) {
	const config = JSON.parse(block.textContent ?? "{}") as ShellConfig;
	createRoot(root).render(
		config.permissions.includes("structure.edit") ? <Shell config={config} /> : <ClientShell config={config} />,
	);
}
