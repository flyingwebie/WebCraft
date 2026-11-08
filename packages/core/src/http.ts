/**
 * Outgoing HTTP: every call WebCraft makes to another server goes through this one function, with
 * the standard `Request` and `Response`. Tests answer it with a fake; the guarded fetcher (which
 * refuses internal addresses) will wrap it.
 */
export type OutgoingHttp = (request: Request) => Promise<Response>;

/** Outgoing HTTP over the runtime's own `fetch`. */
export const fetchHttp: OutgoingHttp = (request) => fetch(request);
