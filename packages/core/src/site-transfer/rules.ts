/**
 * The rules of a Site export's passphrase, which the admin's browser code reads too
 * (`@webcraft/core/site-transfer-rules`): this file imports nothing.
 */

/** The shortest passphrase taken: a passphrase guards every secret of the Site wherever the file goes. */
export const PASSPHRASE_MIN_LENGTH = 12;
/** The longest passphrase taken. */
export const PASSPHRASE_MAX_LENGTH = 1024;
