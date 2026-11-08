/**
 * Where the current time comes from. WebCraft code reads the time only through a Clock, never
 * through `new Date()` or `Date.now()`, so tests can move time forward.
 */
export type Clock = {
	now(): Date;
};

/** The real clock. */
export const systemClock: Clock = {
	now: () => new Date(),
};
