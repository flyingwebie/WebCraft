/**
 * Outgoing HTTP: every call WebCraft makes to another server goes through this one function, with
 * the standard `Request` and `Response`. Tests answer it with a fake; the guarded fetcher (which
 * refuses internal addresses) wraps it and pins each of its calls to the address it checked.
 */
export type OutgoingHttp = (request: Request, options?: OutgoingHttpOptions) => Promise<Response>;

export type OutgoingHttpOptions = {
	/**
	 * The address to connect to (an IPv4 or IPv6 address, without brackets), instead of resolving the
	 * URL's host name again: the guarded fetcher gives the one it checked. The host name still goes in
	 * the `Host` header, the TLS server name (SNI) and the certificate check, and a pinned call never
	 * follows a redirect itself.
	 */
	connectTo?: string;
};
