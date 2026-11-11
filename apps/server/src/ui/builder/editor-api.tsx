import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ApiClient } from "@webcraft/api";
import { createContext, useContext } from "react";

/** Browser-only services for panels that mount on either canvas. */
export type EditorApi = {
	designSystem: Pick<ApiClient["designSystem"], "createClass" | "updateClass">;
	media: Pick<ApiClient["media"], "list">;
	globals: Pick<ApiClient["globals"], "get" | "setFields">;
	postTypes: Pick<ApiClient["postTypes"], "get" | "update">;
};
export const EditorEnvironment = createContext({ siteMedia: false, adminOrigin: "" });
export const EditorApiContext = createContext<(() => Promise<EditorApi>) | null>(null);
let admin: EditorApi | undefined;
async function adminApi(): Promise<EditorApi> {
	admin ??= createORPCClient(new RPCLink({ url: new URL("/api/rpc", window.location.origin).toString() }));
	return admin;
}
export function useEditorApi(): () => Promise<EditorApi> {
	return useContext(EditorApiContext) ?? adminApi;
}
