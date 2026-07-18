import { createHash } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ArtworkCacheObject } from "../publication/publish";
import {
	canonicalAbsolutePath,
	canonicalRelativePath,
	isMissingError,
	isPathBelowRoot,
} from "../util/path";
import type { ImportState } from "./import-state";

type StoredArtworkCacheObject = Readonly<{
	sha256: string;
	relative_path: string;
	byte_size: number;
}>;

type StoredArtworkCacheObjectMetadata = StoredArtworkCacheObject &
	Readonly<{
		width: number;
		height: number;
	}>;

/** Resolves a stored cache path without allowing it to escape cacheRoot. */
export function artworkCachePath(
	cacheRoot: string,
	relativePath: string,
): string {
	const root = canonicalAbsolutePath(cacheRoot);
	const path = canonicalAbsolutePath(
		join(root, canonicalRelativePath(relativePath)),
	);

	if (!isPathBelowRoot(root, path)) {
		throw new Error(
			`Artwork cache object escapes its cache root: ${relativePath}`,
		);
	}

	return path;
}

export async function isValidArtworkCacheObject(
	cacheRoot: string,
	cacheObject: ArtworkCacheObject,
): Promise<boolean> {
	if (
		cacheObject.byteSize < 0 ||
		cacheObject.byteSize > 5 * 1024 * 1024 ||
		cacheObject.sha256.length !== 64
	) {
		return false;
	}

	let path: string;
	try {
		path = artworkCachePath(cacheRoot, cacheObject.relativePath);
	} catch {
		return false;
	}

	try {
		const status = await lstat(path);
		if (
			!status.isFile() ||
			status.isSymbolicLink() ||
			status.size !== cacheObject.byteSize
		) {
			return false;
		}

		const bytes = await readFile(path);

		return (
			createHash("sha256")
				.update(Uint8Array.from(bytes))
				.digest("hex") === cacheObject.sha256
		);
	} catch (error) {
		if (isMissingError(error)) {
			return false;
		}

		throw error;
	}
}

export async function isStoredArtworkCacheObjectValid(
	state: ImportState,
	cacheRoot: string,
	sha256: string,
): Promise<boolean> {
	const object = state.database
		.query<StoredArtworkCacheObjectMetadata, [string]>(
			"SELECT sha256, relative_path, byte_size, width, height FROM artwork_cache_objects WHERE sha256 = ?",
		)
		.get(sha256);
	if (object === null) {
		return false;
	}

	return isValidArtworkCacheObject(cacheRoot, {
		sha256: object.sha256,
		relativePath: object.relative_path,
		byteSize: object.byte_size,
		width: object.width,
		height: object.height,
	});
}

/**
 * Removes cache objects with no durable automatic-artwork, operation, or
 * published-destination reference. Files are removed before their rows so a
 * failed filesystem operation never leaves SQLite claiming a missing object.
 */
export async function sweepArtworkCacheObjects(
	state: ImportState,
	cacheRoot: string,
	onWarning?: (message: string) => void,
): Promise<number> {
	const unreferenced = state.database
		.query<StoredArtworkCacheObject, []>(`
			SELECT aco.sha256, aco.relative_path, aco.byte_size
			FROM artwork_cache_objects aco
			WHERE NOT EXISTS (
				SELECT 1 FROM automatic_artwork aa WHERE aa.cache_sha256 = aco.sha256
			) AND NOT EXISTS (
				SELECT 1 FROM destination_entries de WHERE de.cache_sha256 = aco.sha256
			) AND NOT EXISTS (
				SELECT 1 FROM operation_entries oe WHERE oe.cache_sha256 = aco.sha256
			)
			ORDER BY aco.sha256
		`)
		.all();
	let removed = 0;

	for (const object of unreferenced) {
		let path: string;
		try {
			path = artworkCachePath(cacheRoot, object.relative_path);
		} catch (error) {
			onWarning?.(
				`Retaining unsafe artwork cache path for ${object.sha256}: ${error instanceof Error ? error.message : String(error)}`,
			);

			continue;
		}

		try {
			await rm(path, { force: true });
		} catch (error) {
			onWarning?.(
				`Unable to remove unreferenced artwork cache object ${object.sha256}: ${error instanceof Error ? error.message : String(error)}`,
			);

			continue;
		}

		const deleted = state.database.run(
			`DELETE FROM artwork_cache_objects
			WHERE sha256 = ?
			AND NOT EXISTS (SELECT 1 FROM automatic_artwork WHERE cache_sha256 = ?)
			AND NOT EXISTS (SELECT 1 FROM destination_entries WHERE cache_sha256 = ?)
			AND NOT EXISTS (SELECT 1 FROM operation_entries WHERE cache_sha256 = ?)`,
			[object.sha256, object.sha256, object.sha256, object.sha256],
		);
		if (deleted.changes === 1) {
			removed += 1;
		}
	}

	return removed;
}
