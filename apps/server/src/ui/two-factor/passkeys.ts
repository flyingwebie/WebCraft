/**
 * Passkeys in the browser: the WebAuthn ceremonies, with the options the Management API gives as
 * JSON and answers turned back into JSON for it (binary values as base64url). Uses the browser's
 * own JSON helpers where it has them, and converts by hand where it doesn't.
 */

/** Whether this browser can use passkeys at all. */
export function passkeysAvailable(): boolean {
	return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function";
}

/** The person closed the device's prompt, or it timed out: nothing to say but "try again". */
export class PasskeyCancelledError extends Error {
	override name = "PasskeyCancelledError";
	readonly code = "PASSKEY_CANCELLED";
	constructor() {
		super("The passkey prompt was closed.");
	}
}

type CreationOptionsJSON = {
	challenge: string;
	rp: { id: string; name: string };
	user: { id: string; name: string; displayName: string };
	pubKeyCredParams: { type: "public-key"; alg: number }[];
	excludeCredentials: { id: string; type: "public-key"; transports?: string[] }[];
	authenticatorSelection: { residentKey: "required"; userVerification: "required" };
	attestation: "none";
	timeout: number;
};

type RequestOptionsJSON = {
	challenge: string;
	rpId: string;
	allowCredentials: { id: string; type: "public-key"; transports?: string[] }[];
	userVerification: "required";
	timeout: number;
};

/** Makes a passkey on the person's device, answering the device's registration as JSON. */
export async function createPasskey(options: CreationOptionsJSON) {
	const publicKey: PublicKeyCredentialCreationOptions = {
		...options,
		challenge: fromBase64url(options.challenge),
		user: { ...options.user, id: fromBase64url(options.user.id) },
		excludeCredentials: options.excludeCredentials.map(toDescriptor),
	};
	const credential = await ceremony(() => navigator.credentials.create({ publicKey }));
	const response = credential.response as AuthenticatorAttestationResponse;
	return {
		id: credential.id,
		rawId: toBase64url(credential.rawId),
		type: "public-key" as const,
		response: {
			clientDataJSON: toBase64url(response.clientDataJSON),
			attestationObject: toBase64url(response.attestationObject),
			transports: typeof response.getTransports === "function" ? response.getTransports() : [],
		},
	};
}

/** Uses one of the person's passkeys, answering the device's assertion as JSON. */
export async function getPasskey(options: RequestOptionsJSON) {
	const publicKey: PublicKeyCredentialRequestOptions = {
		...options,
		challenge: fromBase64url(options.challenge),
		allowCredentials: options.allowCredentials.map(toDescriptor),
	};
	const credential = await ceremony(() => navigator.credentials.get({ publicKey }));
	const response = credential.response as AuthenticatorAssertionResponse;
	return {
		id: credential.id,
		rawId: toBase64url(credential.rawId),
		type: "public-key" as const,
		response: {
			clientDataJSON: toBase64url(response.clientDataJSON),
			authenticatorData: toBase64url(response.authenticatorData),
			signature: toBase64url(response.signature),
			userHandle: response.userHandle ? toBase64url(response.userHandle) : null,
		},
	};
}

async function ceremony(run: () => Promise<Credential | null>): Promise<PublicKeyCredential> {
	try {
		const credential = await run();
		if (!credential) throw new PasskeyCancelledError();
		return credential as PublicKeyCredential;
	} catch (error) {
		// The person closed the prompt, the device refused, or it took too long.
		if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "AbortError")) {
			throw new PasskeyCancelledError();
		}
		throw error;
	}
}

function toDescriptor(credential: { id: string; transports?: string[] }): PublicKeyCredentialDescriptor {
	return {
		id: fromBase64url(credential.id),
		type: "public-key",
		...(credential.transports ? { transports: credential.transports as AuthenticatorTransport[] } : {}),
	};
}

function fromBase64url(text: string): ArrayBuffer {
	const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes.buffer;
}

function toBase64url(buffer: ArrayBuffer): string {
	let binary = "";
	for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
