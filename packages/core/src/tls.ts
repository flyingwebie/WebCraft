import { connect } from "node:tls";

/** A certificate a host answered with over HTTPS. */
export type TlsCertificate = {
	/** Whether it is valid for the host name and signed by a certificate authority the system trusts. */
	trusted: boolean;
	/** When it runs out. */
	expiresAt: Date;
};

/**
 * TLS: the certificate a host answers with on port 443, for the Domain check. It only reads the
 * certificate during the handshake and sends nothing else. Tests answer it with a fake.
 */
export type TlsProbe = {
	/**
	 * The certificate `hostname` answers with at `address` (one its DNS gave, already checked), or null
	 * when nothing answers over TLS there.
	 */
	certificate(hostname: string, address: string): Promise<TlsCertificate | null>;
};

/** How long a TLS handshake may take: an on-demand certificate is issued during the first one. */
const HANDSHAKE_TIMEOUT_MS = 30_000;

/** TLS over the runtime's own sockets. */
export const systemTls: TlsProbe = {
	certificate(hostname, address) {
		return new Promise((resolve) => {
			const socket = connect({ host: address, port: 443, servername: hostname, rejectUnauthorized: false });
			const done = (certificate: TlsCertificate | null) => {
				socket.destroy();
				resolve(certificate);
			};
			socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => done(null));
			socket.once("error", () => done(null));
			socket.once("secureConnect", () => {
				const peer = socket.getPeerCertificate();
				const expiresAt = peer?.valid_to ? new Date(peer.valid_to) : null;
				// `authorized` covers the chain and the host name (Node checks the name even when it doesn't refuse).
				done(expiresAt && !Number.isNaN(expiresAt.getTime()) ? { trusted: socket.authorized, expiresAt } : null);
			});
		});
	},
};
