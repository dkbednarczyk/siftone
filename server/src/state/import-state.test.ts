import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalAbsolutePath, canonicalRelativePath } from "./canonical-path";
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
		"INSERT INTO published_destinations VALUES (?, ?, ?, 1)",
		[ids[3], ids[2], destinationPath],
	);
	return ids[2];
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
	test("validates transient relative paths and persisted absolute paths", () => {
		for (const path of [
			"/x",
			"./x",
			"x/",
			"a//b",
			"a/./b",
			"a/../b",
			"a\\b",
			".",
			"",
		])
			expect(() => canonicalRelativePath(path)).toThrow();
		expect(canonicalRelativePath("A/B.flac")).toBe("A/B.flac");
		for (const path of [
			"",
			"relative",
			"/trailing/",
			"/double//slash",
			"/dot/./segment",
			"/parent/../segment",
			"/back\\slash",
		]) {
			expect(() => canonicalAbsolutePath(path)).toThrow();
		}
		expect(canonicalAbsolutePath("/watch/Album/01.flac")).toBe(
			"/watch/Album/01.flac",
		);
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
				"INSERT INTO published_destinations VALUES (?, ?, 'Artist/Album', 1)",
				[randomUUID(), destinationImport.importId],
			),
		).toThrow();
		expect(() =>
			state.database.run(
				"INSERT INTO destination_entries VALUES (?, '02.flac', 'relative.flac', 42, 1, 'audio')",
				[ids[3]],
			),
		).toThrow();
		const targetImport = insertImport(state);
		expect(() =>
			state.database.run(
				"INSERT INTO operations VALUES (?, ?, ?, 'repair', 'planned', 'Artist/Album', ?, NULL, 1, 1)",
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
				"INSERT INTO operations VALUES (?, ?, ?, 'repair', 'planned', ?, 'operation', NULL, 1, 1)",
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
			"INSERT INTO operations VALUES (?, ?, ?, 'repair', 'planned', ?, ?, NULL, 1, 1)",
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
				"INSERT INTO operation_entries VALUES (?, '02.flac', 'relative.flac', 42, 1, 'audio')",
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
			"INSERT INTO destination_entries VALUES (?, '01.flac', ?, 42, 1, 'audio')",
			[ids[3], sourcePath],
		);
		state.database.run(
			"INSERT INTO operations VALUES (?, ?, ?, 'replace', 'planned', ?, ?, NULL, 1, 1)",
			[ids[4], ids[2], ids[1], destinationPath, stagingPath],
		);
		state.database.run(
			"INSERT INTO operation_entries VALUES (?, '01.flac', ?, 42, 1, 'audio')",
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

	test("enforces source/destination uniqueness and cascades", async () => {
		const paths = await fixture();
		const state = await openImportState({
			stateRoot: paths.state,
			generatedLibraryRoot: paths.generated,
		});
		const importId = seed(state);
		expect(() =>
			state.database.run(
				"INSERT INTO published_destinations VALUES (?, ?, ?, 1)",
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
			"INSERT INTO operations VALUES (?, ?, ?, 'repair', 'planned', ?, ?, NULL, 1, 1)",
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
				"INSERT INTO operations VALUES (?, ?, ?, 'repair', 'planned', ?, ?, NULL, 1, 1)",
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
