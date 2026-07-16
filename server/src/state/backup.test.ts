import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDailyBackup, restoreBackup } from "./backup";
import { DATABASE_FILE, openImportState } from "./import-state";

const directories: string[] = [];

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "siftone-backup-"));
	directories.push(root);
	const stateRoot = join(root, "state");
	const generated = join(root, "generated");
	const backupRoot = join(root, "backups");
	await Promise.all([mkdir(stateRoot), mkdir(generated), mkdir(backupRoot)]);
	return { stateRoot, generated, backupRoot };
}

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) =>
				rm(directory, { recursive: true, force: true }),
			),
	);
});

describe("SQLite library-state backups", () => {
	test("creates one verified UTC backup per day and retains seven newest", async () => {
		const paths = await fixture();
		const state = await openImportState({
			stateRoot: paths.stateRoot,
			generatedLibraryRoot: paths.generated,
		});
		for (let day = 0; day < 8; day += 1) {
			await createDailyBackup(
				state,
				paths.backupRoot,
				new Date(Date.UTC(2026, 0, day + 1)),
			);
		}
		expect((await readdir(paths.backupRoot)).toSorted()).toEqual([
			"library-state-2026-01-02.sqlite",
			"library-state-2026-01-03.sqlite",
			"library-state-2026-01-04.sqlite",
			"library-state-2026-01-05.sqlite",
			"library-state-2026-01-06.sqlite",
			"library-state-2026-01-07.sqlite",
			"library-state-2026-01-08.sqlite",
		]);
		state.close();
	});

	test("restores only a compatible snapshot", async () => {
		const paths = await fixture();
		const state = await openImportState({
			stateRoot: paths.stateRoot,
			generatedLibraryRoot: paths.generated,
		});
		state.database.run(
			"INSERT INTO source_containers VALUES (?, 'Album', 'present', NULL, 1)",
			["11111111-1111-4111-8111-111111111111"],
		);
		const backupPath = await createDailyBackup(
			state,
			paths.backupRoot,
			new Date("2026-01-01T00:00:00.000Z"),
		);
		state.close();
		const databasePath = join(paths.stateRoot, DATABASE_FILE);
		const database = new Database(databasePath);
		database.run("DELETE FROM source_containers");
		database.close();
		await restoreBackup({
			backupPath: backupPath as string,
			databasePath,
		});
		const restored = new Database(databasePath);
		expect(
			restored
				.query<{ count: number }, []>(
					"SELECT COUNT(*) AS count FROM source_containers",
				)
				.get(),
		).toEqual({ count: 1 });
		restored.close();
	});
});
