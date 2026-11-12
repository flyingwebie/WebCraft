import { z } from "zod";

// The admin's Content Security Policy runs no `eval` (`admin/security-headers.ts`). Zod tries one as it
// makes an object schema, to see whether it may compile its checks, and the browser reports the
// refusal as an error on every page: in the browser it is told not to compile. The server keeps
// compiling. Loaded before anything that makes a schema (`router.tsx`).
if (typeof window !== "undefined") z.config({ jitless: true });
