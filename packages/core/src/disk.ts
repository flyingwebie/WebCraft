import { statfs } from "node:fs/promises";

/** How much room a disk has: free (for this process) and in all, in bytes. */
export type DiskRoom = { freeBytes: number; totalBytes: number };

/**
 * The room on the disk holding a folder (local storage, for Install health), or null when it can't
 * be read. A port, so tests can make a disk nearly full.
 */
export type DiskSpace = (path: string) => Promise<DiskRoom | null>;

/** The real disk, as the operating system reports it. */
export const systemDiskSpace: DiskSpace = async (path) => {
	try {
		const found = await statfs(path);
		return { freeBytes: found.bavail * found.bsize, totalBytes: found.blocks * found.bsize };
	} catch {
		return null;
	}
};
