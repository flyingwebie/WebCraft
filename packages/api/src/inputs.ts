import { ADMIN_LANGUAGE_CODES } from "@webcraft/core";
import { z } from "zod";

/** A person's name as they type it. */
export const personName = z.string().trim().min(1).max(200);

/** An email address; WebCraft's auth checks its shape and normalises it. */
export const email = z.string().max(320);

/** A password; WebCraft's auth decides which ones are allowed. */
export const password = z.string().max(4096);

export const adminLanguage = z.enum(ADMIN_LANGUAGE_CODES);
