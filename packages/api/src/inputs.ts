import { ADMIN_LANGUAGE_CODES } from "@webcraft/core";
import { z } from "zod";

/** A person's name as they type it. */
export const personName = z.string().trim().min(1).max(200);

/** An email address; WebCraft's auth checks its shape and normalises it. */
export const email = z.string().max(320);

/** A password; WebCraft's auth decides which ones are allowed. */
export const password = z.string().max(4096);

export const adminLanguage = z.enum(ADMIN_LANGUAGE_CODES);

/** The id of a Workspace, Site, person or invite. */
export const id = z.uuid();

/** Which Workspaces (or Sites) something reaches: `"all"`, including ones created later, or a list of ids. */
export const reach = z.union([z.literal("all"), z.array(id).max(1000)]);
