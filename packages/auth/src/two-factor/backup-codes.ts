/** How many backup codes a person gets at a time. */
export const BACKUP_CODE_COUNT = 10;

/**
 * The characters of a backup code: lower-case letters and digits, without the ones easily mistaken
 * for each other (0 and o, 1, i and l). Ten of them make about 50 bits.
 */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

const CODE_LENGTH = 10;

/** New backup codes, as the person sees them: `abcde-23456`. */
export function newBackupCodes(): string[] {
	const codes = new Set<string>();
	while (codes.size < BACKUP_CODE_COUNT) codes.add(newCode());
	return [...codes];
}

function newCode(): string {
	let code = "";
	// Rejection sampling keeps every character equally likely.
	while (code.length < CODE_LENGTH) {
		for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
			if (byte >= 248 || code.length === CODE_LENGTH) continue;
			code += ALPHABET[byte % ALPHABET.length];
		}
	}
	return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/**
 * A backup code as typed, in the form its hash is made from: any case, with or without the dash and
 * spaces. Null for anything that can't be a backup code.
 */
export function normaliseBackupCode(code: string): string | null {
	const plain = code.replace(/[\s-]/g, "").toLowerCase();
	if (plain.length !== CODE_LENGTH) return null;
	for (const character of plain) if (!ALPHABET.includes(character)) return null;
	return plain;
}
