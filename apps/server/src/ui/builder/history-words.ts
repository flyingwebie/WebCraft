const OUTCOMES = [
	"undid",
	"redid",
	"skipped",
	"keptUndo",
	"keptRedo",
	"HISTORY_OBSOLETE",
	"HISTORY_UNAVAILABLE",
	"HISTORY_PARTIAL",
];

/**
 * How every host of the one Undo history words a step's outcome (the Builder, Code mode and Edit
 * mode): the history's own messages by key, where a step happened when it isn't on this canvas, and a
 * refusal's code as the host words refusals.
 */
export function historyWords(
	message: (key: string, values: Record<string, string>) => string,
	refusal: (code: string) => string,
) {
	return (key: string, label: string, title?: string): string => {
		if (key === "on") return message("on", { message: label, title: title ?? "" });
		if (OUTCOMES.includes(key)) return message(key, { label });
		return refusal(key);
	};
}
