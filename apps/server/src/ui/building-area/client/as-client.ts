import type { ClientRole, EditAnswer, EditRequests } from "../api.ts";

/**
 * Staff seeing the page as a client does (FX-04): client editing drawn for them as for a Member of
 * `role`, with "Viewing as a client" and the way back. It is a view only: the server still answers as
 * Staff (they keep their own Permissions), so what Staff could do beyond the role is taken out of the
 * answers the view reads (`asClientRequests`) and out of what it draws (the shell's permissions).
 */
export type AsClient = {
	role: ClientRole;
	/** Staff's own address to go back to: the document, the place and the selection. */
	back: string;
	/** Hands the tab back to Staff's shell, once client editing has saved what was typed and put `back` in place. */
	done(): void;
};

/** The items a Member publishes from the building area: Content, never Structure (nor a Loop's items, which Staff publish). */
const CONTENT_ITEMS = new Set(["entry", "globals"]);

/** What `publish/items` answers, as far as the view changes it. */
type PublishAnswer = {
	canPublish: boolean;
	canCode: boolean;
	drafts: { item: { kind: string } }[];
	items: { kind: string }[];
	popup: unknown;
};

/** What `layout/get` and `layout/save` answer, as far as the view changes it. */
type LayoutAnswer = {
	settings: { enabled: boolean; allowedComponents: string[] };
	canArrange: boolean;
	canLock: boolean;
	components: { id: string }[];
};

/** Publish as a Member of the role sees it: no Structure rows or items; an Author sends for review. */
export function asClientPublish<T extends PublishAnswer>(data: T, role: ClientRole): T {
	const publishes = role.permissions.includes("entry.publish");
	return {
		...data,
		canCode: false,
		canPublish: data.canPublish && publishes,
		drafts: data.drafts.filter((draft) => CONTENT_ITEMS.has(draft.item.kind)),
		items: publishes ? data.items.filter((item) => CONTENT_ITEMS.has(item.kind)) : [],
		popup: null,
	};
}

/** A Page layout as a Member arranges it: only where the Site lets Members, the Allowed components only, no locking. */
export function asClientLayout<T extends LayoutAnswer>(data: T): T {
	const { settings } = data;
	return {
		...data,
		canArrange: data.canArrange && settings.enabled,
		canLock: false,
		components: data.components.filter((component) => settings.allowedComponents.includes(component.id)),
	};
}

/** The edit requests client editing sends, their answers read as a Member of the role would get them. */
export function asClientRequests(request: EditRequests, role: ClientRole): EditRequests {
	return async <T>(action: string, body: unknown): Promise<EditAnswer<T>> => {
		const answer = await request<T>(action, body);
		if (!answer.ok) return answer;
		if (action === "publish/items")
			return { ok: true, data: asClientPublish(answer.data as unknown as PublishAnswer, role) as unknown as T };
		if (action === "layout/get" || action === "layout/save")
			return { ok: true, data: asClientLayout(answer.data as unknown as LayoutAnswer) as unknown as T };
		return answer;
	};
}
