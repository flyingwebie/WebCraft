import { useCallback, useEffect, useState } from "react";
import { type AnnouncementPriority, editorAccessibility } from "./editor-accessibility.ts";

/** Keep optional visible feedback local; speech always uses the editor-wide sink. */
export function useEditorAnnouncement() {
	const [message, setMessage] = useState("");
	useEffect(() => {
		editorAccessibility(document);
	}, []);
	const announce = useCallback((text: string, priority: AnnouncementPriority = "polite") => {
		setMessage(text);
		editorAccessibility(document).announce(text, priority);
	}, []);
	return [message, announce] as const;
}
