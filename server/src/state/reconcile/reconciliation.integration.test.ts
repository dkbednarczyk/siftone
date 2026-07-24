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
				expect(
					(
						await lstat(
							join(generatedLibraryRoot, "Artist", "Album"),
						)
					).isSymbolicLink(),
				).toBe(true);
				expect(await readlink(destinationPath)).toBe(sourcePath);

				await reconcile([]);
				expect((await lstat(destinationPath)).isSymbolicLink()).toBe(
					true,
				);

				await reconcile([]);
				await expect(lstat(destinationPath)).rejects.toThrow("ENOENT");
			} finally {
				state.close();
			}
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
});
