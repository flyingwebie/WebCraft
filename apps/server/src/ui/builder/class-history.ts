import type { ApiClient } from "@webcraft/api";
import type { Json } from "@webcraft/core/draft-document";
import type { CssPanelPort } from "./CssPanel.tsx";
import { editorHistory, type HistoryLocation } from "./editor-history.ts";

export type ClassReceipt = Pick<Awaited<ReturnType<ApiClient["designSystem"]["createClass"]>>, "class" | "history">;

/** Both canvases record only the locked change returned by the Class save, never a later reread. */
export function classHistoryPort(port: {
	create(name: string): Promise<ClassReceipt>;
	rename(classId: string, name: string): Promise<ClassReceipt>;
	location(): HistoryLocation;
	label(action: "created" | "renamed", name: string): string;
}): Pick<CssPanelPort, "createClass" | "renameClass"> {
	const record = (saved: ClassReceipt, label: string, step?: number) => {
		const location = port.location();
		editorHistory().record({
			step,
			resource: `draft:${location.siteId}:designSystem`,
			before: saved.history.before as unknown as Json,
			after: saved.history.after as unknown as Json,
			label,
			location,
		});
	};
	return {
		createClass: async (name, step) => {
			const made = await port.create(name);
			record(made, port.label("created", name), step);
			return made.class;
		},
		renameClass: async (classId, name) => {
			const saved = await port.rename(classId, name);
			record(saved, port.label("renamed", name));
		},
	};
}
