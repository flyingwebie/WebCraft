import { z } from "zod";

/**
 * A path on the admin itself, as `?redirect=` carries one back from the sign-in page: one `/`, never
 * followed by another `/` or a backslash (which a browser reads as another host's address), and no
 * backslash, whitespace or control character anywhere. A browser drops tabs and line breaks from an
 * address before reading it, so `/<tab>/other.example` would read as `//other.example`. The page
 * can't be used to send people away.
 */
export const localPath = z
	.string()
	.max(2048)
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
	.refine((path) => /^\/(?![/\\])[^\s\\\u0000-\u001f\u007f]*$/.test(path));
