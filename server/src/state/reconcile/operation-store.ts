import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AutomaticArtwork } from "../../publication/publish";
import type { ImportState } from "../import-state";
import { immediate, nowNs } from "./database";
import type { Desired, OperationRow, SourceEntry } from "./types";

export type Existing = {
	import_id: string;
	release_id: string;
	destination_path: string | null;
	version_id: string | null;
	version_path: string | null;
	manifest_hash: string;
	container_availability: "present" | "missing" | "inaccessible";
	release_availability: "present" | "missing" | "inaccessible";
};

export function existingFor(
	state: ImportState,
	containerPath: string,
	logicalKey: string,
): Existing | null {
	return state.database
		.query<Existing, [string, string]>(`
		SELECT i.id AS import_id, sr.id AS release_id, pd.destination_path, pd.version_id, av.version_path, i.manifest_hash, sc.availability AS container_availability, sr.availability AS release_availability
		FROM source_releases sr JOIN source_containers sc ON sc.id = sr.container_id
		LEFT JOIN imports i ON i.source_release_id = sr.id
		LEFT JOIN published_destinations pd ON pd.import_id = i.id
		LEFT JOIN album_versions av ON av.id = pd.version_id
		WHERE sc.root_path = ? AND sr.logical_release_key = ?
	`)
		.get(containerPath, logicalKey);
}

function insertOrUpdateSourceFiles(
	state: ImportState,
	releaseId: string,
	entries: readonly SourceEntry[],
): void {
	for (const entry of entries) {
		state.database.run(
			`
		INSERT INTO source_files (source_path, source_release_id, size, mtime_ns, kind)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(source_path) DO UPDATE SET source_release_id = excluded.source_release_id, size = excluded.size, mtime_ns = excluded.mtime_ns, kind = excluded.kind
	`,
			[
				entry.sourcePath,
				releaseId,
				entry.size,
				entry.mtimeNs,
				entry.kind,
			],
		);
	}
}

export function persistAutomaticArtwork(
	state: ImportState,
	releaseId: string,
	artwork: AutomaticArtwork | undefined,
	timestamp = nowNs(),
): void {
	if (artwork === undefined) {
		return;
	}

	const cacheObject = artwork.cacheObject;
	if (artwork.status === "selected" && cacheObject === undefined) {
		throw new Error(
			"Selected automatic artwork is missing its cache object",
		);
	}
	if (artwork.status !== "selected" && cacheObject !== undefined) {
		throw new Error(
			"Non-selected automatic artwork cannot have a cache object",
		);
	}

	if (cacheObject !== undefined) {
		state.database.run(
			"INSERT INTO artwork_cache_objects (sha256, relative_path, byte_size, width, height, media_type, created_at_ns) VALUES (?, ?, ?, ?, ?, 'image/jpeg', ?) ON CONFLICT(sha256) DO NOTHING",
			[
				cacheObject.sha256,
				cacheObject.relativePath,
				cacheObject.byteSize,
				cacheObject.width,
				cacheObject.height,
				timestamp,
			],
		);
	}

	state.database.run(
		`INSERT INTO automatic_artwork (
			source_release_id, metadata_fingerprint, resolver_version, status,
			cache_sha256, release_group_mbid, release_mbid, source_url,
			failure_detail, attempt_count, attempted_at_ns, next_attempt_at_ns
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(source_release_id) DO UPDATE SET
			metadata_fingerprint = excluded.metadata_fingerprint,
			resolver_version = excluded.resolver_version,
			status = excluded.status,
			cache_sha256 = excluded.cache_sha256,
			release_group_mbid = excluded.release_group_mbid,
			release_mbid = excluded.release_mbid,
			source_url = excluded.source_url,
			failure_detail = excluded.failure_detail,
			attempt_count = excluded.attempt_count,
			attempted_at_ns = excluded.attempted_at_ns,
			next_attempt_at_ns = excluded.next_attempt_at_ns`,
		[
			releaseId,
			artwork.metadataFingerprint,
			artwork.resolverVersion,
			artwork.status,
			cacheObject?.sha256 ?? null,
			artwork.releaseGroupId ?? null,
			artwork.releaseId ?? null,
			artwork.sourceUrl ?? null,
			artwork.failureDetail ?? null,
			artwork.attemptCount,
			artwork.attemptedAtNs,
			artwork.nextAttemptAtNs ?? null,
		],
	);
}

export function createOperation(
	state: ImportState,
	existing: Existing | null,
	desired: Desired | undefined,
	stagingRoot: string,
	versionRoot: string,
	kind: OperationRow["kind"],
	oldDestination: string | null,
): OperationRow {
	if (existing === null && desired === undefined) {
		throw new Error("New operation requires desired source data");
	}

	const newDesired = desired;
	const id = randomUUID();

	const releaseId = existing?.release_id ?? randomUUID();
	const importId = existing?.import_id ?? randomUUID();

	const target = desired?.destinationPath ?? oldDestination;

	if (target === null || target === undefined) {
		throw new Error("Operation needs a destination claim");
	}

	const timestamp = nowNs();
	const versionId = kind === "delete" ? null : randomUUID();
	const versionPath =
		versionId === null ? null : join(versionRoot, `operation-${id}`);
	immediate(state, () => {
		if (existing === null) {
			if (newDesired === undefined) {
				throw new Error("New operation requires desired source data");
			}

			let container = state.database
				.query<{ id: string }, [string]>(
					"SELECT id FROM source_containers WHERE root_path = ?",
				)
				.get(newDesired.containerPath);

			if (container === null) {
				container = { id: randomUUID() };
				state.database.run(
					"INSERT INTO source_containers (id, root_path, availability, missing_since_ns, updated_at_ns) VALUES (?, ?, 'present', NULL, ?)",
					[container.id, newDesired.containerPath, timestamp],
				);
			}

			state.database.run(
				"INSERT INTO source_releases (id, container_id, logical_release_key, album_artist, album_title) VALUES (?, ?, ?, ?, ?)",
				[
					releaseId,
					container.id,
					newDesired.input.logicalReleaseKey,
					newDesired.input.albumArtist,
					newDesired.input.albumTitle,
				],
			);

			state.database.run(
				"INSERT INTO imports (id, source_release_id, manifest_hash, created_at_ns, updated_at_ns) VALUES (?, ?, ?, ?, ?)",
				[
					importId,
					releaseId,
					newDesired.manifestHash,
					timestamp,
					timestamp,
				],
			);
		} else if (desired !== undefined) {
			state.database.run(
				"UPDATE source_containers SET availability = 'present', missing_since_ns = NULL, updated_at_ns = ? WHERE id = (SELECT container_id FROM source_releases WHERE id = ?)",
				[timestamp, releaseId],
			);

			state.database.run(
				"UPDATE source_releases SET album_artist = ?, album_title = ?, availability = 'present', missing_since_ns = NULL, updated_at_ns = ? WHERE id = ?",
				[
					desired.input.albumArtist,
					desired.input.albumTitle,
					timestamp,
					releaseId,
				],
			);
		}

		if (desired !== undefined) {
			persistAutomaticArtwork(
				state,
				releaseId,
				desired.input.automaticArtwork,
				timestamp,
			);

			insertOrUpdateSourceFiles(
				state,
				releaseId,
				desired.entries.filter(
					(entry): entry is SourceEntry => entry.origin === "source",
				),
			);
		}

		if (versionId !== null && versionPath !== null) {
			state.database.run(
				"INSERT INTO album_versions (id, import_id, origin_operation_id, version_path, state, published_at_ns, retired_at_ns) VALUES (?, ?, ?, ?, 'pending', NULL, NULL)",
				[versionId, importId, id, versionPath],
			);
		}

		state.database.run(
			"INSERT INTO operations (id, import_id, source_release_id, kind, phase, target_destination_path, staging_path, version_id, version_path, error_message, created_at_ns, updated_at_ns) VALUES (?, ?, ?, ?, 'planned', ?, ?, ?, ?, NULL, ?, ?)",
			[
				id,
				importId,
				releaseId,
				kind,
				target,
				join(stagingRoot, `operation-${id}`),
				versionId,
				versionPath,
				timestamp,
				timestamp,
			],
		);

		for (const path of new Set(
			[target, oldDestination].filter(
				(value): value is string => value !== null,
			),
		)) {
			state.database.run(
				"INSERT INTO operation_destination_claims (operation_id, destination_path) VALUES (?, ?)",
				[id, path],
			);
		}

		if (desired !== undefined) {
			for (const entry of desired.entries) {
				if (entry.origin === "source") {
					state.database.run(
						"INSERT INTO operation_entries (operation_id, destination_name, origin, source_path, cache_sha256, size, mtime_ns, kind) VALUES (?, ?, 'source', ?, NULL, ?, ?, ?)",
						[
							id,
							entry.destinationName,
							entry.sourcePath,
							entry.size,
							entry.mtimeNs,
							entry.kind,
						],
					);
				} else {
					state.database.run(
						"INSERT INTO operation_entries (operation_id, destination_name, origin, source_path, cache_sha256, size, mtime_ns, kind) VALUES (?, ?, 'cache', NULL, ?, NULL, NULL, 'artwork')",
						[id, entry.destinationName, entry.cacheSha256],
					);
				}
			}
		}
	});

	return {
		id,
		import_id: importId,
		source_release_id: releaseId,
		kind,
		phase: "planned",
		target_destination_path: target,
		staging_path: join(stagingRoot, `operation-${id}`),
		version_id: versionId,
		version_path: versionPath,
	};
}
