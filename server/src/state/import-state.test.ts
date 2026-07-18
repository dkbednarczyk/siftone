import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATABASE_FILE, openImportState } from "./import-state";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "siftone-state-"));
	roots.push(root);
	const state = join(root, "state");
	const generated = join(root, "generated");
	await Promise.all([mkdir(state), mkdir(generated)]);
	return { root, state, generated };
}
const containerPath = "/watch/Album";
const sourcePath = "/watch/Album/01.flac";
const destinationPath = "/generated/Artist/Album";
const stagingPath = "/staging/op";
const cacheSha256 = "b".repeat(64);
const metadataFingerprint = "c".repeat(64);

const ids = [
	"11111111-1111-4111-8111-111111111111",
	"22222222-2222-4222-8222-222222222222",
	"33333333-3333-4333-8333-333333333333",
	"44444444-4444-4444-8444-444444444444",
	"55555555-5555-4555-8555-555555555555",
];

function seed(state: Awaited<ReturnType<typeof openImportState>>) {
	state.database.run(
		"INSERT INTO source_containers VALUES (?, ?, 'present', NULL, 1)",
		[ids[0], containerPath],
	);
	state.database.run(
		"INSERT INTO source_releases (id, container_id, logical_release_key, album_artist, album_title) VALUES (?, ?, 'key', 'Artist', 'Album')",
		[ids[1], ids[0]],
	);
	state.database.run(
		"INSERT INTO source_files VALUES (?, ?, ?, ?, 'audio')",
		[sourcePath, ids[1], 42n, 1234567890123456789n],
	);
	state.database.run("INSERT INTO imports VALUES (?, ?, ?, 1, 1)", [
		ids[2],
		ids[1],
		"a".repeat(64),
	]);
	state.database.run(
		"INSERT INTO published_destinations (id, import_id, destination_path, published_at_ns) VALUES (?, ?, ?, 1)",
		[ids[3], ids[2], destinationPath],
	);
	return ids[2];
}

function insertCacheObject(
	state: Awaited<ReturnType<typeof openImportState>>,
	sha256 = cacheSha256,
) {
	state.database.run(
		"INSERT INTO artwork_cache_objects (sha256, relative_path, byte_size, width, height, media_type, created_at_ns) VALUES (?, ?, 42, 500, 500, 'image/jpeg', 1)",
		[sha256, `artwork/sha256/${sha256.slice(0, 2)}/${sha256}.jpg`],
	);

	return sha256;
}

function insertAutomaticArtwork(
	state: Awaited<ReturnType<typeof openImportState>>,
	releaseId: string,
	status: string,
	cacheSha: string | null,
) {
	state.database.run(
		"INSERT INTO automatic_artwork (source_release_id, metadata_fingerprint, resolver_version, status, cache_sha256, release_group_mbid, release_mbid, source_url, failure_detail, attempt_count, attempted_at_ns, next_attempt_at_ns) VALUES (?, ?, 'resolver-v1', ?, ?, NULL, NULL, NULL, NULL, 0, 1, NULL)",
		[releaseId, metadataFingerprint, status, cacheSha],
	);
}

function insertImport(state: Awaited<ReturnType<typeof openImportState>>) {
	const releaseId = randomUUID();
	const importId = randomUUID();
	state.database.run(
		"INSERT INTO source_releases (id, container_id, logical_release_key, album_artist, album_title) VALUES (?, ?, ?, 'Artist', 'Album')",
		[releaseId, ids[0], randomUUID()],
	);
	state.database.run("INSERT INTO imports VALUES (?, ?, ?, 1, 1)", [
		importId,
		releaseId,
		"a".repeat(64),
	]);

	return { releaseId, importId };
}

describe("library state", () => {
	test("uses strict WAL FK schema and bigint SQLite reads", async () => {
		const paths = await fixture();
		const state = await openImportState({
			stateRoot: paths.state,
			generatedLibraryRoot: paths.generated,
		});
		expect(
			state.database
				.query<{ journal_mode: string }, []>("PRAGMA journal_mode")
				.get(),
		).toEqual({ journal_mode: "wal" });
		expect(
			state.database
				.query<{ quick_check: string }, []>("PRAGMA quick_check")
				.get(),
		).toEqual({ quick_check: "ok" });
		expect(
			state.database
				.query<{ table: string }, []>("PRAGMA foreign_key_check")
				.all(),
		).toEqual([]);
		expect(
			state.database
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('artwork_cache_objects', 'automatic_artwork') ORDER BY name",
				)
				.all()
				.map((row) => row.name),
		).toEqual(["artwork_cache_objects", "automatic_artwork"]);
		const destinationColumns = state.database
			.query<{ name: string }, []>(
				"PRAGMA table_info(destination_entries)",
			)
			.all()
			.map((column) => column.name);
		const operationColumns = state.database
			.query<{ name: string }, []>("PRAGMA table_info(operation_entries)")
			.all()
			.map((column) => column.name);
		for (const columns of [destinationColumns, operationColumns]) {
			expect(columns).toContain("origin");
			expect(columns).toContain("cache_sha256");
		}
		seed(state);
		const value = (
			state.database.query<{ mtime_ns: bigint }, []>(
				"SELECT mtime_ns FROM source_files",
			) as unknown as {
				safeIntegers(value: boolean): {
					get(): { mtime_ns: bigint } | null;
				};
			}
		)
			.safeIntegers(true)
			.get();
		expect(value?.mtime_ns).toBe(1234567890123456789n);
		expect(state.isDegraded()).toBe(true);
		state.close();
	});
	test("reports creation of a new library state database", async () => {
		const paths = await fixture();
		const progress: string[] = [];
		const databasePath = join(paths.state, DATABASE_FILE);
		const state = await openImportState({
			stateRoot: paths.state,
			generatedLibraryRoot: paths.generated,
			onProgress: (message) => progress.push(message),
		});
		state.close();

		expect(progress).toEqual([
			`Creating library state database at ${databasePath}.`,
			"Library state database is ready.",
		]);

		progress.length = 0;
		const reopened = await openImportState({
			stateRoot: paths.state,
			generatedLibraryRoot: paths.generated,
			onProgress: (message) => progress.push(message),
		});
		reopened.close();

		expect(progress).toEqual([]);
	});
	test("identifies tabula rasa state until the first full scan", async () => {
		const paths = await fixture();
		const state = await openImportState({
			stateRoot: paths.state,
			generatedLibraryRoot: paths.generated,
		});
		expect(state.isTabulaRasa).toBe(true);
		state.close();

		const reopened = await openImportState({
			stateRoot: paths.state,
			generatedLibraryRoot: paths.generated,
		});
		expect(reopened.isTabulaRasa).toBe(true);
		reopened.database.run(
			"UPDATE reconciliation_state SET last_full_scan_at_ns = 1 WHERE id = 1",
		);
		reopened.close();

		const afterFirstScan = await openImportState({
			stateRoot: paths.state,
			generatedLibraryRoot: paths.generated,
		});
		expect(afterFirstScan.isTabulaRasa).toBe(false);
		afterFirstScan.close();
	});
	test("distinguishes new and unchanged confirmed source manifests", async () => {
		const paths = await fixture();
		const state = await openImportState({
			stateRoot: paths.state,
			generatedLibraryRoot: paths.generated,
		});
		const firstManifest = "a".repeat(64);
		const secondManifest = "b".repeat(64);

		expect(
			state.observeSourceManifest({
				watchRoot: containerPath,
				manifestHash: firstManifest,
				minimumAgeMs: 0,
			}),
		).toEqual({ confirmed: false, unchanged: false });
		expect(
			state.observeSourceManifest({
				watchRoot: containerPath,
				manifestHash: firstManifest,
				minimumAgeMs: 0,
			}),
		).toEqual({ confirmed: true, unchanged: false });
		expect(
			state.observeSourceManifest({
				watchRoot: containerPath,
				manifestHash: firstManifest,
				minimumAgeMs: 0,
			}),
		).toEqual({ confirmed: true, unchanged: true });
		expect(
			state.observeSourceManifest({
				watchRoot: containerPath,
				manifestHash: secondManifest,
				minimumAgeMs: 0,
			}),
		).toEqual({ confirmed: false, unchanged: false });
		state.close();
	});
	test("reports pending reconciliation and due artwork work", async () => {
		const paths = await fixture();
		const state = await openImportState({
			stateRoot: paths.state,
			generatedLibraryRoot: paths.generated,
		});
		state.database.run(
			"UPDATE reconciliation_state SET required = 0 WHERE id = 1",
		);
		expect(state.isReconciliationRequired()).toBe(false);
		state.markReconciliationRequired();
		expect(state.isReconciliationRequired()).toBe(true);
		state.database.run(
			"UPDATE reconciliation_state SET required = 0 WHERE id = 1",
		);
		seed(state);
		state.database.run(
			"INSERT INTO operations VALUES (?, ?, ?, 'repair', 'planned', ?, ?, NULL, NULL, NULL, 1, 1)",
			[ids[4], ids[2], ids[1], destinationPath, stagingPath],
		);
		expect(state.isReconciliationRequired()).toBe(true);
		state.database.run("DELETE FROM operations WHERE id = ?", [ids[4]]);
		insertAutomaticArtwork(state, ids[1], "transient_failure", null);
		state.database.run(
			"UPDATE automatic_artwork SET next_attempt_at_ns = 1 WHERE source_release_id = ?",
			[ids[1]],
		);
		expect(state.hasPendingAutomaticArtwork(false, "resolver-v1")).toBe(
			true,
		);
		state.database.run(
			"UPDATE automatic_artwork SET status = 'disabled', next_attempt_at_ns = NULL WHERE source_release_id = ?",
			[ids[1]],
		);
		expect(state.hasPendingAutomaticArtwork(false, "resolver-v1")).toBe(
			false,
		);
		expect(state.hasPendingAutomaticArtwork(true, "resolver-v1")).toBe(
			true,
		);
		state.database.run(
			"UPDATE automatic_artwork SET status = 'no_match', resolver_version = 'old-resolver' WHERE source_release_id = ?",
			[ids[1]],
		);
		expect(state.hasPendingAutomaticArtwork(false, "resolver-v1")).toBe(
			true,
		);
		state.close();
	});
	test("rejects relative values in every persisted filesystem path column", async () => {
		const paths = await fixture();
		const state = await openImportState({
			stateRoot: paths.state,
			generatedLibraryRoot: paths.generated,
		});
		expect(() =>
			state.database.run(
				"INSERT INTO source_containers VALUES (?, 'Album', 'present', NULL, 1)",
				[ids[0]],
			),
		).toThrow();
		seed(state);
		expect(() =>
			state.database.run(
				"INSERT INTO source_files VALUES ('relative.flac', ?, 42, 1, 'audio')",
				[ids[1]],
			),
		).toThrow();
		const destinationImport = insertImport(state);
		expect(() =>
			state.database.run(
				"INSERT INTO published_destinations (id, import_id, destination_path, published_at_ns) VALUES (?, ?, 'Artist/Album', 1)",
				[randomUUID(), destinationImport.importId],
			),
		).toThrow();
		expect(() =>
			state.database.run(
				"INSERT INTO destination_entries (destination_id, destination_name, origin, source_path, cache_sha256, size, mtime_ns, kind) VALUES (?, '02.flac', 'source', 'relative.flac', NULL, 42, 1, 'audio')",
				[ids[3]],
			),
		).toThrow();
		const targetImport = insertImport(state);
		expect(() =>
			state.database.run(
				"INSERT INTO operations VALUES (?, ?, ?, 'repair', 'planned', 'Artist/Album', ?, NULL, NULL, NULL, 1, 1)",
				[
					randomUUID(),
					targetImport.importId,
					targetImport.releaseId,
					stagingPath,
				],
			),
		).toThrow();
		const stagingImport = insertImport(state);
		expect(() =>
			state.database.run(
				"INSERT INTO operations VALUES (?, ?, ?, 'repair', 'planned', ?, 'operation', NULL, NULL, NULL, 1, 1)",
				[
					randomUUID(),
					stagingImport.importId,
					stagingImport.releaseId,
					destinationPath,
				],
			),
		).toThrow();
		const operationImport = insertImport(state);
		const operationId = randomUUID();
		state.database.run(
			"INSERT INTO operations VALUES (?, ?, ?, 'repair', 'planned', ?, ?, NULL, NULL, NULL, 1, 1)",
			[
				operationId,
				operationImport.importId,
				operationImport.releaseId,
				destinationPath,
				stagingPath,
			],
		);
		expect(() =>
			state.database.run(
				"INSERT INTO operation_destination_claims VALUES (?, 'Artist/Album')",
				[operationId],
			),
		).toThrow();
		expect(() =>
			state.database.run(
				"INSERT INTO operation_entries (operation_id, destination_name, origin, source_path, cache_sha256, size, mtime_ns, kind) VALUES (?, '02.flac', 'source', 'relative.flac', NULL, 42, 1, 'audio')",
				[operationId],
			),
		).toThrow();
		const sourceFileColumns = state.database
			.query<{ name: string }, []>("PRAGMA table_info(source_files)")
			.all()
			.map((column) => column.name);
		expect(sourceFileColumns).not.toContain("relative_path");
		const operationColumns = state.database
			.query<{ name: string }, []>("PRAGMA table_info(operations)")
			.all()
			.map((column) => column.name);
		expect(operationColumns).not.toContain("staging_name");
		state.close();
	});

	test("keeps frozen published and operation snapshots after source removal", async () => {
		const paths = await fixture();
		const state = await openImportState({
			stateRoot: paths.state,
			generatedLibraryRoot: paths.generated,
		});
		seed(state);
		state.database.run(
			"INSERT INTO destination_entries (destination_id, destination_name, origin, source_path, cache_sha256, size, mtime_ns, kind) VALUES (?, '01.flac', 'source', ?, NULL, 42, 1, 'audio')",
			[ids[3], sourcePath],
		);
		state.database.run(
			"INSERT INTO operations VALUES (?, ?, ?, 'replace', 'planned', ?, ?, NULL, NULL, NULL, 1, 1)",
			[ids[4], ids[2], ids[1], destinationPath, stagingPath],
		);
		state.database.run(
			"INSERT INTO operation_entries (operation_id, destination_name, origin, source_path, cache_sha256, size, mtime_ns, kind) VALUES (?, '01.flac', 'source', ?, NULL, 42, 1, 'audio')",
			[ids[4], sourcePath],
		);
		expect(() =>
			state.database.run(
				"DELETE FROM source_files WHERE source_path = '/watch/Album/01.flac'",
			),
		).not.toThrow();
		expect(
			state.database.run(
				"DELETE FROM destination_entries WHERE source_path = '/watch/Album/01.flac'",
			).changes,
		).toBe(1);
		expect(
			state.database.run(
				"DELETE FROM operation_entries WHERE source_path = '/watch/Album/01.flac'",
			).changes,
		).toBe(1);
		state.close();
	});

	test("constrains cache objects and automatic artwork outcomes", async () => {
		const paths = await fixture();
		const state = await openImportState({
			stateRoot: paths.state,
			generatedLibraryRoot: paths.generated,
		});
		seed(state);
		insertCacheObject(state);

		for (const status of [
			"disabled",
			"no_match",
			"no_eligible_edition",
			"no_qualifying_cover",
			"edition_cap_reached",
			"transient_failure",
			"selected",
		]) {
			const { releaseId } = insertImport(state);
			insertAutomaticArtwork(
				state,
				releaseId,
				status,
				status === "selected" ? cacheSha256 : null,
			);
		}
		expect(
			state.database
				.query<{ count: number }, []>(
					"SELECT COUNT(*) AS count FROM automatic_artwork",
				)
				.get()?.count,
		).toBe(7);

		for (const [
			sha256,
			relativePath,
			byteSize,
			width,
			height,
			mediaType,
		] of [
			[
				"A".repeat(64),
				"artwork/invalid-uppercase.jpg",
				1,
				500,
				500,
				"image/jpeg",
			],
			[
				"a".repeat(63),
				"artwork/invalid-short.jpg",
				1,
				500,
				500,
				"image/jpeg",
			],
			[
				"d".repeat(64),
				"/artwork/absolute.jpg",
				1,
				500,
				500,
				"image/jpeg",
			],
			[
				"e".repeat(64),
				"artwork/negative.jpg",
				-1,
				500,
				500,
				"image/jpeg",
			],
			["f".repeat(64), "artwork/zero-width.jpg", 1, 0, 500, "image/jpeg"],
			[
				"1".repeat(64),
				"artwork/zero-height.jpg",
				1,
				500,
				0,
				"image/jpeg",
			],
			["2".repeat(64), "artwork/png.jpg", 1, 500, 500, "image/png"],
		] as const) {
			expect(() =>
				state.database.run(
					"INSERT INTO artwork_cache_objects (sha256, relative_path, byte_size, width, height, media_type, created_at_ns) VALUES (?, ?, ?, ?, ?, ?, 1)",
					[sha256, relativePath, byteSize, width, height, mediaType],
				),
			).toThrow();
		}

		const invalid = insertImport(state);
		expect(() =>
			insertAutomaticArtwork(state, invalid.releaseId, "unknown", null),
		).toThrow();
		expect(() =>
			insertAutomaticArtwork(state, invalid.releaseId, "selected", null),
		).toThrow();
		expect(() =>
			insertAutomaticArtwork(
				state,
				invalid.releaseId,
				"no_match",
				cacheSha256,
			),
		).toThrow();
		expect(() =>
			insertAutomaticArtwork(
				state,
				invalid.releaseId,
				"selected",
				"a".repeat(64),
			),
		).toThrow();
		state.close();
	});

	test("enforces explicit mutually exclusive source and cache entry origins", async () => {
		const paths = await fixture();
		const state = await openImportState({
			stateRoot: paths.state,
			generatedLibraryRoot: paths.generated,
		});
		seed(state);
		insertCacheObject(state);
		state.database.run(
			"INSERT INTO operations VALUES (?, ?, ?, 'repair', 'planned', ?, ?, NULL, NULL, NULL, 1, 1)",
			[ids[4], ids[2], ids[1], destinationPath, stagingPath],
		);

		const invalidInserts = [
			() =>
				state.database.run(
					"INSERT INTO destination_entries (destination_id, destination_name, origin, source_path, cache_sha256, size, mtime_ns, kind) VALUES (?, 'mixed.jpg', 'cache', ?, ?, NULL, NULL, 'artwork')",
					[ids[3], sourcePath, cacheSha256],
				),
			() =>
				state.database.run(
					"INSERT INTO destination_entries (destination_id, destination_name, origin, source_path, cache_sha256, size, mtime_ns, kind) VALUES (?, 'missing.flac', 'source', NULL, NULL, 42, 1, 'audio')",
					[ids[3]],
				),
			() =>
				state.database.run(
					"INSERT INTO destination_entries (destination_id, destination_name, origin, source_path, cache_sha256, size, mtime_ns, kind) VALUES (?, 'wrong-kind.jpg', 'cache', NULL, ?, NULL, NULL, 'audio')",
					[ids[3], cacheSha256],
				),
			() =>
				state.database.run(
					"INSERT INTO operation_entries (operation_id, destination_name, origin, source_path, cache_sha256, size, mtime_ns, kind) VALUES (?, 'mixed.jpg', 'cache', ?, ?, NULL, NULL, 'artwork')",
					[ids[4], sourcePath, cacheSha256],
				),
			() =>
				state.database.run(
					"INSERT INTO operation_entries (operation_id, destination_name, origin, source_path, cache_sha256, size, mtime_ns, kind) VALUES (?, 'missing.flac', 'source', NULL, NULL, 42, 1, 'audio')",
					[ids[4]],
				),
			() =>
				state.database.run(
					"INSERT INTO operation_entries (operation_id, destination_name, origin, source_path, cache_sha256, size, mtime_ns, kind) VALUES (?, 'wrong-kind.jpg', 'cache', NULL, ?, NULL, NULL, 'audio')",
					[ids[4], cacheSha256],
				),
		];
		for (const insert of invalidInserts) {
			expect(insert).toThrow();
		}
		state.close();
	});

	test("protects cache objects referenced by outcomes and frozen entries", async () => {
		const paths = await fixture();
		const state = await openImportState({
			stateRoot: paths.state,
			generatedLibraryRoot: paths.generated,
		});
		seed(state);
		insertCacheObject(state);
		insertAutomaticArtwork(state, ids[1], "selected", cacheSha256);
		state.database.run(
			"INSERT INTO destination_entries (destination_id, destination_name, origin, source_path, cache_sha256, size, mtime_ns, kind) VALUES (?, 'cover.jpg', 'cache', NULL, ?, NULL, NULL, 'artwork')",
			[ids[3], cacheSha256],
		);
		state.database.run(
			"INSERT INTO operations VALUES (?, ?, ?, 'repair', 'planned', ?, ?, NULL, NULL, NULL, 1, 1)",
			[ids[4], ids[2], ids[1], destinationPath, stagingPath],
		);
		state.database.run(
			"INSERT INTO operation_entries (operation_id, destination_name, origin, source_path, cache_sha256, size, mtime_ns, kind) VALUES (?, 'cover.jpg', 'cache', NULL, ?, NULL, NULL, 'artwork')",
			[ids[4], cacheSha256],
		);
		expect(() =>
			state.database.run(
				"DELETE FROM artwork_cache_objects WHERE sha256 = ?",
				[cacheSha256],
			),
		).toThrow();

		state.database.run(
			"DELETE FROM automatic_artwork WHERE source_release_id = ?",
			[ids[1]],
		);
		state.database.run(
			"DELETE FROM destination_entries WHERE destination_id = ?",
			[ids[3]],
		);
		state.database.run(
			"DELETE FROM operation_entries WHERE operation_id = ?",
			[ids[4]],
		);
		expect(
			state.database.run(
				"DELETE FROM artwork_cache_objects WHERE sha256 = ?",
				[cacheSha256],
			).changes,
		).toBe(1);
		state.close();
	});

	test("indexes cache references and rejects an old schema", async () => {
		const paths = await fixture();
		const state = await openImportState({
			stateRoot: paths.state,
			generatedLibraryRoot: paths.generated,
		});
		const details = state.database
			.query<{ detail: string }, [string]>(
				"EXPLAIN QUERY PLAN DELETE FROM artwork_cache_objects WHERE sha256 = ?",
			)
			.all(cacheSha256)
			.map((row) => row.detail);
		for (const table of [
			"automatic_artwork",
			"destination_entries",
			"operation_entries",
		]) {
			expect(
				details.some((detail) => detail.includes(`SCAN ${table}`)),
			).toBe(false);
		}
		state.close();
		await Promise.all([
			rm(join(paths.state, DATABASE_FILE), { force: true }),
			rm(join(paths.state, `${DATABASE_FILE}-wal`), { force: true }),
			rm(join(paths.state, `${DATABASE_FILE}-shm`), { force: true }),
		]);

		const oldDatabase = new Database(join(paths.state, DATABASE_FILE));
		oldDatabase.run("PRAGMA application_id = 1397577798");
		oldDatabase.run("CREATE TABLE source_containers (id TEXT PRIMARY KEY)");
		oldDatabase.close();
		await expect(
			openImportState({
				stateRoot: paths.state,
				generatedLibraryRoot: paths.generated,
			}),
		).rejects.toThrow("Incompatible SQLite library state");
	});

	test("enforces source/destination uniqueness and cascades", async () => {
		const paths = await fixture();
		const state = await openImportState({
			stateRoot: paths.state,
			generatedLibraryRoot: paths.generated,
		});
		const importId = seed(state);
		expect(() =>
			state.database.run(
				"INSERT INTO published_destinations (id, import_id, destination_path, published_at_ns) VALUES (?, ?, ?, 1)",
				[
					"55555555-5555-4555-8555-555555555555",
					importId,
					destinationPath,
				],
			),
		).toThrow();
		state.database.run("DELETE FROM imports WHERE id = ?", [importId]);
		expect(
			state.database
				.query<{ n: number }, []>(
					"SELECT count(*) n FROM published_destinations",
				)
				.get()?.n,
		).toBe(0);
		state.close();
	});
	test("indexes review foreign keys for parent cleanup", async () => {
		const paths = await fixture();
		const state = await openImportState({
			stateRoot: paths.state,
			generatedLibraryRoot: paths.generated,
		});
		const importId = seed(state);
		for (const [query, id] of [
			["EXPLAIN QUERY PLAN DELETE FROM imports WHERE id = ?", importId],
			["EXPLAIN QUERY PLAN DELETE FROM operations WHERE id = ?", ids[4]],
		] as const) {
			const details = state.database
				.query<{ detail: string }, [string]>(query)
				.all(id)
				.map((row) => row.detail);
			expect(
				details.some((detail) => detail.includes("SCAN reviews")),
			).toBe(false);
		}
		state.close();
	});

	test("starts targeted reconciliation from observed containers", async () => {
		const paths = await fixture();
		const state = await openImportState({
			stateRoot: paths.state,
			generatedLibraryRoot: paths.generated,
		});
		seed(state);
		const details = state.database
			.query<{ detail: string }, [string]>(`
				EXPLAIN QUERY PLAN
				SELECT i.id
				FROM json_each(?) observed
				JOIN source_containers sc ON sc.root_path = observed.value
				JOIN source_releases sr ON sr.container_id = sc.id
				JOIN imports i ON i.source_release_id = sr.id
			`)
			.all(JSON.stringify([containerPath]))
			.map((row) => row.detail);
		expect(
			details.some((detail) => detail.includes("SEARCH sc USING INDEX")),
		).toBe(true);
		expect(details.some((detail) => detail.includes("SCAN imports"))).toBe(
			false,
		);
		state.close();
	});

	test("prevents unresolved operation ownership conflicts", async () => {
		const paths = await fixture();
		const state = await openImportState({
			stateRoot: paths.state,
			generatedLibraryRoot: paths.generated,
		});
		const importId = seed(state);
		state.database.run(
			"INSERT INTO operations VALUES (?, ?, ?, 'repair', 'planned', ?, ?, NULL, NULL, NULL, 1, 1)",
			[
				"55555555-5555-4555-8555-555555555555",
				importId,
				ids[1],
				destinationPath,
				stagingPath,
			],
		);
		expect(() =>
			state.database.run(
				"INSERT INTO operations VALUES (?, ?, ?, 'repair', 'planned', ?, ?, NULL, NULL, NULL, 1, 1)",
				[
					"66666666-6666-4666-8666-666666666666",
					importId,
					ids[1],
					"/generated/Artist/Other",
					"/staging/operation-b",
				],
			),
		).toThrow();
		state.database.run(
			"INSERT INTO operation_destination_claims VALUES (?, ?)",
			["55555555-5555-4555-8555-555555555555", destinationPath],
		);
		expect(() =>
			state.database.run(
				"INSERT INTO operation_destination_claims VALUES (?, ?)",
				["77777777-7777-4777-8777-777777777777", destinationPath],
			),
		).toThrow();
		state.close();
	});
	test("uses the configured library-state filename", async () => {
		const paths = await fixture();
		new Database(join(paths.state, "imports.sqlite")).close();
		const state = await openImportState({
			stateRoot: paths.state,
			generatedLibraryRoot: paths.generated,
		});
		expect(state.databasePath).toEndWith(DATABASE_FILE);
		state.close();
	});
});
