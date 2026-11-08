export { assertMasterKeyMatches, MasterKeyMismatchError } from "./key-versions.ts";
export {
	loadMasterKey,
	MASTER_KEY_MIN_LENGTH,
	MASTER_KEY_VARIABLE,
	MasterKey,
	parseMasterKey,
} from "./master-key.ts";
export type { SecretOwner, SecretRef } from "./refs.ts";
export {
	CONFIRM_FINGERPRINT_LENGTH,
	KeyRotationError,
	type KeyRotationReport,
	type LostKeyReport,
	OLD_MASTER_KEY_VARIABLE,
	replaceLostMasterKey,
	rotateMasterKey,
} from "./rotate.ts";
export {
	createSecrets,
	openSecrets,
	type SecretDescription,
	SecretNotSetError,
	type Secrets,
	SecretUnreadableError,
} from "./store.ts";
