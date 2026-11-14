import { createRoot } from "react-dom/client";

import type { ShellConfig } from "./api.ts";
import { Shell } from "./Shell.tsx";

/**
 * The building area's shell (ADR 0037), served as a hashed file from the Site's address: it reads
 * what the server gave its document (a JSON block, which runs nothing) and draws itself.
 */
const block = document.getElementById("webcraft-building-area-config");
const root = document.getElementById("webcraft-building-area");
if (block && root) {
	const config = JSON.parse(block.textContent ?? "{}") as ShellConfig;
	createRoot(root).render(<Shell config={config} />);
}
