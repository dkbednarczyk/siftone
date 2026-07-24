import { describe, expect, test } from "bun:test";
import {
	lstat,
	mkdir,
	mkdtemp,
	readlink,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublicationInput } from "../../publication/plan";
import { openImportState } from "../import-state";
import { reconcileImports } from "./index";

describe("journaled reconciliation", () => {
	test("publishes then removes a missing release after two complete scans", async () => {
		const root = await mkdtemp(join(tmpdir(), "siftone-reconcile-"));
		const watchRoot = join(root, "watch");
		const generatedLibraryRoot = join(root, "generated");
		const stagingRoot = join(root, "staging");
		const versionRoot = join(root, "versions");
		const stateRoot = join(root, "state");
		const sourceRoot = join(watchRoot, "Album Source");
		const sourcePath = join(sourceRoot, "01.flac");
		const destinationPath = join(
			generatedLibraryRoot,
			"Artist",
			"Album",
			"01 Song.flac",
		);

		try {
			await Promise.all([
				mkdir(sourceRoot, { recursive: true }),
				mkdir(generatedLibraryRoot),
				mkdir(stagingRoot),
				mkdir(versionRoot),
				mkdir(stateRoot),
			]);
			await writeFile(sourcePath, "audio");
			const state = await openImportState({
				stateRoot,
				generatedLibraryRoot,
				versionRoot,
			});
			const input: PublicationInput = {
				root: sourceRoot,
				logicalReleaseKey: '["artist","album"]',
				albumArtist: "Artist",
				albumTitle: "Album",
				entries: [{ sourcePath, destinationPath }],
			};
			const reconcile = (inputs: readonly PublicationInput[]) =>
				reconcileImports({
					state,
					generatedLibraryRoot,
					stagingRoot,
					versionRoot,
					watchRoot,
					inputs,
					complete: true,
				});

			try {
				await reconcile([input]);
				const imported = state.database
					.query<
						{
							id: string;
							availability: string;
							destination_path: string;
							current_version_id: string;
						},
						[]
					>(
						"SELECT id, availability, destination_path, current_version_id FROM imports",
					)
					.get();
				if (imported === null) {
					throw new Error("Published import was not recorded");
				}

				expect(imported.availability).toBe("present");
				expect(imported.destination_path).toBe(
					join(generatedLibraryRoot, "Artist", "Album"),
				);
				expect(imported.current_version_id).toBeString();
				expect(
					state.database
						.query<{ count: number }, [string]>(
							"SELECT COUNT(*) AS count FROM source_files WHERE import_id = ?",
						)
						.get(imported.id),
				).toEqual({ count: 1 });
				expect(
					state.database
						.query<{ count: number }, [string]>(
							"SELECT COUNT(*) AS count FROM destination_entries WHERE import_id = ?",
						)
						.get(imported.id),
				).toEqual({ count: 1 });
				expect(
					(
						await lstat(
							join(generatedLibraryRoot, "Artist", "Album"),
						)
					).isSymbolicLink(),
				).toBe(true);
				expect(await readlink(destinationPath)).toBe(sourcePath);

				await reconcile([]);
				expect(
					state.database
						.query<{ availability: string }, [string]>(
							"SELECT availability FROM imports WHERE id = ?",
						)
						.get(imported.id),
				).toEqual({ availability: "missing" });
				expect((await lstat(destinationPath)).isSymbolicLink()).toBe(
					true,
				);

				await reconcile([]);
				await expect(lstat(destinationPath)).rejects.toThrow("ENOENT");
				expect(
					state.database
						.query<{ count: number }, []>(
							"SELECT COUNT(*) AS count FROM imports",
						)
						.get(),
				).toEqual({ count: 0 });
				expect(
					state.database
						.query<{ count: number }, []>(
							"SELECT COUNT(*) AS count FROM album_versions WHERE state = 'retired' AND retired_at_ns IS NOT NULL",
						)
						.get(),
				).toEqual({ count: 1 });
			} finally {
				state.close();
			}
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("records an unsafe destination as an attention-required operation", async () => {
		const root = await mkdtemp(join(tmpdir(), "siftone-reconcile-"));
		const watchRoot = join(root, "watch");
		const generatedLibraryRoot = join(root, "generated");
		const stagingRoot = join(root, "staging");
		const versionRoot = join(root, "versions");
		const stateRoot = join(root, "state");
		const sourceRoot = join(watchRoot, "Album Source");
		const sourcePath = join(sourceRoot, "01.flac");
		const destinationPath = join(
			generatedLibraryRoot,
			"Artist",
			"Album",
			"01 Song.flac",
		);

		try {
			await Promise.all([
				mkdir(sourceRoot, { recursive: true }),
				mkdir(generatedLibraryRoot),
				mkdir(stagingRoot),
				mkdir(versionRoot),
				mkdir(stateRoot),
			]);
			await writeFile(sourcePath, "audio");
			const state = await openImportState({
				stateRoot,
				generatedLibraryRoot,
				versionRoot,
			});
			await mkdir(join(generatedLibraryRoot, "Artist", "Album"), {
				recursive: true,
			});

			try {
				await expect(
					reconcileImports({
						state,
						generatedLibraryRoot,
						stagingRoot,
						versionRoot,
						watchRoot,
						inputs: [
							{
								root: sourceRoot,
								logicalReleaseKey: '["artist","album"]',
								albumArtist: "Artist",
								albumTitle: "Album",
								entries: [{ sourcePath, destinationPath }],
							},
						],
						complete: true,
					}),
				).rejects.toThrow("Destination exists");
				expect(
					state.database
						.query<{ phase: string; error_message: string }, []>(
							"SELECT phase, error_message FROM operations",
						)
						.get(),
				).toEqual({
					phase: "attention_required",
					error_message: `Destination exists: ${join(generatedLibraryRoot, "Artist", "Album")}`,
				});
				expect(state.isDegraded()).toBe(true);
				expect(
					state.database
						.query<{ name: string }, []>(
							"SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'reviews'",
						)
						.get(),
				).toBeNull();
			} finally {
				state.close();
			}
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
});
