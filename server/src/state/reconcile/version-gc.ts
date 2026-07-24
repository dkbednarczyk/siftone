import { lstat, readdir, readlink, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isPathBelowRoot } from "../../util/path";
import type { ImportState } from "../import-state";
import { bigintRows } from "./database";

/** Removes only retired, state-owned versions after their explicit retention age. */
export async function collectRetiredVersions(
	state: ImportState,
	generatedLibraryRoot: string,
	versionRoot: string,
	retentionHours: number,
): Promise<void> {
	const cutoff =
		BigInt(Date.now() - retentionHours * 60 * 60 * 1000) * 1_000_000n;
	const retiredVersionsQuery = [
		"SELECT id, version_path FROM album_versions",
		"WHERE state = 'retired' AND retired_at_ns <= ?",
	].join(" ");
	const candidates = bigintRows<
		{ id: string; version_path: string },
		[bigint]
	>(state.database.query(retiredVersionsQuery), cutoff);
	const leaves = state.database
		.query<{ destination_path: string }, []>(
			"SELECT destination_path FROM imports WHERE destination_path IS NOT NULL",
		)
		.all();
	try {
		for (const artist of await readdir(generatedLibraryRoot, {
			withFileTypes: true,
		})) {
			if (artist.name === ".siftone") {
				continue;
			}
			if (!artist.isDirectory() || artist.isSymbolicLink()) {
				continue;
			}
			for (const album of await readdir(
				join(generatedLibraryRoot, artist.name),
				{ withFileTypes: true },
			)) {
				leaves.push({
					destination_path: join(
						generatedLibraryRoot,
						artist.name,
						album.name,
					),
				});
			}
		}
	} catch {
		state.recordScanIssue("Unable to inspect generated-library output");
		return;
	}

	for (const candidate of candidates) {
		if (!isPathBelowRoot(versionRoot, candidate.version_path)) {
			continue;
		}
		if (
			state.database
				.query<{ found: number }, [string]>(
					"SELECT EXISTS(SELECT 1 FROM imports WHERE current_version_id = ?) AS found",
				)
				.get(candidate.id)?.found === 1 ||
			state.database
				.query<{ found: number }, [string]>(
					"SELECT EXISTS(SELECT 1 FROM operations WHERE version_id = ?) AS found",
				)
				.get(candidate.id)?.found === 1
		) {
			continue;
		}

		let referenced = false;
		for (const leaf of leaves) {
			try {
				const status = await lstat(leaf.destination_path);
				if (
					status.isSymbolicLink() &&
					resolve(
						dirname(leaf.destination_path),
						await readlink(leaf.destination_path),
					) === candidate.version_path
				) {
					referenced = true;
					break;
				}
			} catch {
				// A missing or unsafe leaf prevents neither ownership validation nor broad cleanup.
			}
		}
		if (referenced) {
			continue;
		}

		try {
			const status = await lstat(candidate.version_path);
			if (!status.isDirectory() || status.isSymbolicLink()) {
				continue;
			}
			await rm(candidate.version_path, { recursive: true });
			state.database.run(
				"DELETE FROM album_versions WHERE id = ? AND state = 'retired'",
				[candidate.id],
			);
		} catch {
			state.recordScanIssue("Unable to remove a retired album version");
		}
	}
}
