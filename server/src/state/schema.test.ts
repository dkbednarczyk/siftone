import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { validateImportStateSchema } from "./import-state";
import { APPLICATION_ID, SCHEMA_SQL } from "./schema";

function columns(database: Database, table: string): string[] {
	return database
		.query<{ name: string }, []>(`PRAGMA table_info(${table})`)
		.all()
		.map((column) => column.name);
}

describe("library state schema", () => {
	test("keeps only current ownership and recovery state", () => {
		const database = new Database(":memory:");
		database.run(SCHEMA_SQL);

		try {
			const tables = database
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
				)
				.all()
				.map((table) => table.name);

			expect(tables).toEqual([
				"album_versions",
				"destination_entries",
				"imports",
				"operation_destination_claims",
				"operation_entries",
				"operations",
				"reconciliation_state",
				"source_containers",
				"source_files",
				"source_observations",
			]);
			expect(columns(database, "source_containers")).toEqual([
				"id",
				"root_path",
			]);
			expect(columns(database, "imports")).toEqual([
				"id",
				"container_id",
				"logical_release_key",
				"manifest_hash",
				"availability",
				"destination_path",
				"current_version_id",
			]);
			expect(columns(database, "source_files")).toEqual([
				"source_path",
				"import_id",
			]);
			expect(columns(database, "destination_entries")).toEqual([
				"import_id",
				"destination_name",
				"source_path",
				"size",
				"mtime_ns",
				"kind",
			]);
			expect(columns(database, "album_versions")).toEqual([
				"id",
				"origin_operation_id",
				"version_path",
				"state",
				"retired_at_ns",
			]);
			expect(columns(database, "operations")).toEqual([
				"id",
				"import_id",
				"kind",
				"phase",
				"target_destination_path",
				"staging_path",
				"version_id",
				"version_path",
				"error_message",
				"created_at_ns",
			]);
			expect(columns(database, "source_observations")).toEqual([
				"root_path",
				"confirmed_manifest_hash",
				"pending_manifest_hash",
				"pending_since_ns",
			]);
			expect(columns(database, "reconciliation_state")).toEqual([
				"id",
				"required",
				"last_full_scan_at_ns",
			]);
		} finally {
			database.close();
		}
	});

	test("rejects an old layout instead of migrating it", () => {
		const database = new Database(":memory:");
		database.run(`
			CREATE TABLE source_releases (id TEXT PRIMARY KEY);
			PRAGMA application_id = ${APPLICATION_ID};
		`);

		try {
			expect(() => validateImportStateSchema(database)).toThrow(
				"Incompatible SQLite library state",
			);
		} finally {
			database.close();
		}
	});
});
