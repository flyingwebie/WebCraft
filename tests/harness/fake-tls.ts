import type { TlsCertificate, TlsProbe } from "@webcraft/core";

/**
 * TLS that never leaves the test: a host answers with the certificate a test gives it, and every other
 * host answers with none, as a host without a certificate does.
 */
export type FakeTls = {
	readonly probe: TlsProbe;
	/** Gives `hostname` a certificate (`trusted` unless said otherwise), or none (null). */
	answer(hostname: string, certificate: { expiresAt: Date; trusted?: boolean } | null): void;
	/** Every certificate asked for so far, oldest first: the host name and the address it was asked at. */
	readonly probes: readonly { hostname: string; address: string }[];
};

export function createFakeTls(): FakeTls {
	const certificates = new Map<string, TlsCertificate | null>();
	const probes: { hostname: string; address: string }[] = [];
	return {
		probes,
		answer(hostname, certificate) {
			certificates.set(
				hostname.toLowerCase(),
				certificate && { trusted: certificate.trusted ?? true, expiresAt: certificate.expiresAt },
			);
		},
		probe: {
			async certificate(hostname, address) {
				probes.push({ hostname, address });
				return certificates.get(hostname.toLowerCase()) ?? null;
			},
		},
	};
}
