/**
 * Auth: WebCraft's own sign-in interface, with Better Auth (version pinned) behind it, so the rest
 * of WebCraft never imports Better Auth directly. Later tickets add 2FA, lockout, the recent
 * identity check, Impersonation and per-Site permissions here.
 */
export {
	type Auth,
	type AuthOptions,
	createAuth,
	InvalidCredentialsError,
	SESSION_IDLE_LIMIT_MS,
	SESSION_MAX_AGE_MS,
	type Session,
} from "./auth.ts";
export {
	assertNewPasswordAllowed,
	MAX_PASSWORD_LENGTH,
	MIN_PASSWORD_LENGTH,
	type PasswordCheck,
	type PasswordProblem,
	PasswordRefusedError,
} from "./passwords.ts";
export {
	assertValidEmail,
	EmailInUseError,
	InvalidEmailError,
	type NewPerson,
	normaliseEmail,
} from "./people.ts";
