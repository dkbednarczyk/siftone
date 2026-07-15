import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalRelativePath } from "./canonical-path";
import { DATABASE_FILE, openImportState } from "./import-state";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "siftone-v2-"));
	roots.push(root);
	const state = join(root, "state");
	const generated = join(root, "generated");
	await Promise.all([mkdir(state), mkdir(generated)]);
	return { root, state, generated };
}
const ids = [
	"11111111-1111-4111-8111-111111111111",
	"22222222-2222-4222-8222-222222222222",
	"33333333-3333-4333-8333-333333333333",
	"44444444-4444-4444-8444-444444444444",
	"55555555-5555-4555-8555-555555555555",
];

function seed(state: Awaited<ReturnType<typeof openImportState>>) {
	state.database.run(
		"INSERT INTO source_containers VALUES (?, 'Album', 'present', NULL, 1)",
		[ids[0]],
	);
	state.database.run(
		"INSERT INTO source_releases (id, container_id, logical_release_key, album_artist, album_title) VALUES (?, ?, 'key', 'Artist', 'Album')",
		[ids[1], ids[0]],
	);
	state.database.run(
		"INSERT INTO source_files VALUES ('Album/01.flac', ?, '01.flac', ?, ?, 'audio')",
		[ids[1], 42n, 1234567890123456789n],
	);
	state.database.run("INSERT INTO imports VALUES (?, ?, ?, 1, 1)", [
		ids[2],
		ids[1],
		"a".repeat(64),
	]);
	state.database.run(
		"INSERT INTO published_destinations VALUES (?, ?, 'Artist/Album', 1)",
		[ids[3], ids[2]],
	);
	return ids[2];
}

describe("library state v2", () => {
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
				safeIntegers(value: boolean): { get(): { mtime_ns: bigint } | null };
			}
		)
			.safeIntegers(true)
			.get();
		expect(value?.mtime_ns).toBe(1234567890123456789n);
		expect(state.isDegraded()).toBe(true);
		state.close();
	});
	test("rejects noncanonical paths", () => {
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
	});
	test("keeps frozen published and operation snapshots after source removal", async () => {
		const paths = await fixture();
		const state = await openImportState({
			stateRoot: paths.state,
			generatedLibraryRoot: paths.generated,
		});
		seed(state);
		state.database.run(
			"INSERT INTO destination_entries VALUES (?, '01.flac', 'Album/01.flac', 42, 1, 'audio')",
			[ids[3]],
		);
		state.database.run(
			"INSERT INTO operations VALUES (?, ?, ?, 'replace', 'planned', 'Artist/Album', 'op', NULL, 1, 1)",
			[ids[4], ids[2], ids[1]],
		);
		state.database.run(
			"INSERT INTO operation_entries VALUES (?, '01.flac', 'Album/01.flac', 42, 1, 'audio')",
			[ids[4]],
		);
		expect(() =>
			state.database.run(
				"DELETE FROM source_files WHERE source_path = 'Album/01.flac'",
			),
		).not.toThrow();
		expect(
			state.database.run(
				"DELETE FROM destination_entries WHERE source_path = 'Album/01.flac'",
			).changes,
		).toBe(1);
		expect(
			state.database.run(
				"DELETE FROM operation_entries WHERE source_path = 'Album/01.flac'",
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
				"INSERT INTO published_destinations VALUES (?, ?, 'Artist/Album', 1)",
				["55555555-5555-4555-8555-555555555555", importId],
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
	test("prevents unresolved operation ownership conflicts", async () => {
		const paths = await fixture();
		const state = await openImportState({
			stateRoot: paths.state,
			generatedLibraryRoot: paths.generated,
		});
		const importId = seed(state);
		state.database.run(
			"INSERT INTO operations VALUES (?, ?, ?, 'repair', 'planned', 'Artist/Album', 'operation-a', NULL, 1, 1)",
			["55555555-5555-4555-8555-555555555555", importId, ids[1]],
		);
		expect(() =>
			state.database.run(
				"INSERT INTO operations VALUES (?, ?, ?, 'repair', 'planned', 'Artist/Other', 'operation-b', NULL, 1, 1)",
				["66666666-6666-4666-8666-666666666666", importId, ids[1]],
			),
		).toThrow();
		state.database.run(
			"INSERT INTO operation_destination_claims VALUES (?, 'Artist/Album')",
			["55555555-5555-4555-8555-555555555555"],
		);
		expect(() =>
			state.database.run(
				"INSERT INTO operation_destination_claims VALUES (?, 'Artist/Album')",
				["77777777-7777-4777-8777-777777777777"],
			),
		).toThrow();
		state.close();
	});
	test("does not recognize prior database filename as v2", async () => {
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
