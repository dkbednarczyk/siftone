import { afterEach, describe, expect, test } from "bun:test";
import {
	lstat,
	mkdir,
	mkdtemp,
	readlink,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { PublicationInput } from "../../publication/publish";
import { openImportState } from "../import-state";
import { desiredFor } from "../publication-snapshot";
import { reconcileImports, recoverInterruptedOperations } from "./index";
import { createOperation } from "./operation-store";
import { collectRetiredVersions } from "./version-gc";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots
			.splice(0)
			.map((root) => rm(root, { recursive: true, force: true })),
	);
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "siftone-reconcile-"));
	roots.push(root);
	const watchRoot = join(root, "watch");
	const sourceRoot = join(watchRoot, "Album");
	const generated = join(root, "generated");
	const staging = join(root, "staging");
	const stateRoot = join(root, "state");
	await Promise.all([
		mkdir(sourceRoot, { recursive: true }),
		mkdir(generated),
		mkdir(staging),
		mkdir(stateRoot),
	]);
	const source = join(sourceRoot, "01.flac");
	await writeFile(source, "audio");
	const destination = join(generated, "Artist", "Album", "01.flac");
	const input: PublicationInput = {
		root: sourceRoot,
		logicalReleaseKey: '["artist","album"]',
		albumArtist: "Artist",
		albumTitle: "Album",
		entries: [{ sourcePath: source, destinationPath: destination }],
	};
	return {
		watchRoot,
		sourceRoot,
		generated,
		staging,
		stateRoot,
		source,
		destination,
		input,
	};
}

describe("reconciliation", () => {
	test("rejects publication roots as persisted container or destination paths", async () => {
		const paths = await fixture();
		await expect(
			desiredFor(paths.watchRoot, paths.generated, {
				...paths.input,
				root: paths.watchRoot,
			}),
		).rejects.toThrow("Source container escapes its watch root");
		await expect(
			desiredFor(paths.watchRoot, paths.generated, {
				...paths.input,
				entries: [
					{
						sourcePath: paths.source,
						destinationPath: join(paths.generated, "01.flac"),
					},
				],
			}),
		).rejects.toThrow("Generated destination escapes its root");
	});

	test("publishes an indexed manifest and treats unchanged fingerprints as no work", async () => {
		const paths = await fixture();
		const state = await openImportState({
			stateRoot: paths.stateRoot,
			generatedLibraryRoot: paths.generated,
		});
		await reconcileImports({
			state,
			generatedLibraryRoot: paths.generated,
			stagingRoot: paths.staging,
			watchRoot: paths.watchRoot,
			inputs: [paths.input],
			complete: true,
		});
		expect((await lstat(paths.destination)).isSymbolicLink()).toBe(true);
		expect(await readlink(paths.destination)).toBe(paths.source);
		expect(
			state.database
				.query<{ source_path: string }, []>(
					"SELECT source_path FROM source_files",
				)
				.get()?.source_path,
		).toBe(paths.source);
		const storedPaths = state.database
			.query<{ path: string }, []>(`
				SELECT root_path AS path FROM source_containers
				UNION ALL SELECT source_path FROM source_files
				UNION ALL SELECT destination_path FROM published_destinations
				UNION ALL SELECT source_path FROM destination_entries
			`)
			.all()
			.map((row) => row.path);
		expect(storedPaths.every((path) => path.startsWith("/"))).toBe(true);
		const changesBeforeUnchangedReconcile = state.database
			.query<{ changes: number }, []>("SELECT total_changes() AS changes")
			.get()?.changes;
		await reconcileImports({
			state,
			generatedLibraryRoot: paths.generated,
			stagingRoot: paths.staging,
			watchRoot: paths.watchRoot,
			inputs: [paths.input],
			complete: false,
		});
		expect(
			state.database
				.query<{ changes: number }, []>(
					"SELECT total_changes() AS changes",
				)
				.get()?.changes,
		).toBe(changesBeforeUnchangedReconcile);
		expect(
			state.database
				.query<{ n: number }, []>("SELECT count(*) n FROM operations")
				.get()?.n,
		).toBe(0);
		state.database.run(
			"UPDATE source_containers SET availability = 'missing', missing_since_ns = 1",
		);
		state.database.run(
			"UPDATE source_releases SET availability = 'missing', missing_since_ns = 1",
		);
		await reconcileImports({
			state,
			generatedLibraryRoot: paths.generated,
			stagingRoot: paths.staging,
			watchRoot: paths.watchRoot,
			inputs: [paths.input],
			complete: false,
		});
		expect(
			state.database
				.query<{ availability: string }, []>(
					"SELECT availability FROM source_containers",
				)
				.get()?.availability,
		).toBe("present");
		expect(
			state.database
				.query<{ availability: string }, []>(
					"SELECT availability FROM source_releases",
				)
				.get()?.availability,
		).toBe("present");
		state.close();
	});
	test("replaces an album by atomically switching its public leaf to a retained version", async () => {
		const paths = await fixture();
		const state = await openImportState({
			stateRoot: paths.stateRoot,
			generatedLibraryRoot: paths.generated,
		});
		await reconcileImports({
			state,
			generatedLibraryRoot: paths.generated,
			stagingRoot: paths.staging,
			watchRoot: paths.watchRoot,
			inputs: [paths.input],
			complete: true,
		});
		const leaf = join(paths.generated, "Artist", "Album");
		const firstTarget = await readlink(leaf);
		await writeFile(paths.source, "replacement audio");
		await reconcileImports({
			state,
			generatedLibraryRoot: paths.generated,
			stagingRoot: paths.staging,
			watchRoot: paths.watchRoot,
			inputs: [paths.input],
			complete: true,
		});
		const secondTarget = await readlink(leaf);
		expect(secondTarget).not.toBe(firstTarget);
		expect((await lstat(leaf)).isSymbolicLink()).toBe(true);
		expect((await lstat(join(leaf, "01.flac"))).isSymbolicLink()).toBe(
			true,
		);
		state.close();
	});

	test("deletes a missing source release after two complete scans", async () => {
		const paths = await fixture();
		const state = await openImportState({
			stateRoot: paths.stateRoot,
			generatedLibraryRoot: paths.generated,
		});
		await reconcileImports({
			state,
			generatedLibraryRoot: paths.generated,
			stagingRoot: paths.staging,
			watchRoot: paths.watchRoot,
			inputs: [paths.input],
			complete: true,
		});
		await reconcileImports({
			state,
			generatedLibraryRoot: paths.generated,
			stagingRoot: paths.staging,
			watchRoot: paths.watchRoot,
			inputs: [],
			complete: true,
		});

		await expect(lstat(paths.destination)).resolves.toBeDefined();
		await reconcileImports({
			state,
			generatedLibraryRoot: paths.generated,
			stagingRoot: paths.staging,
			watchRoot: paths.watchRoot,
			inputs: [],
			complete: true,
		});
		await expect(lstat(paths.destination)).rejects.toThrow();
		expect(
			state.database
				.query<{ n: number }, []>("SELECT count(*) AS n FROM imports")
				.get()?.n,
		).toBe(0);
		state.close();
	});

	test("publishes independent albums under one artist concurrently", async () => {
		const paths = await fixture();
		const secondSourceRoot = join(paths.watchRoot, "Second Album");
		const secondSource = join(secondSourceRoot, "01.flac");
		const secondDestination = join(
			paths.generated,
			"Artist",
			"Second Album",
			"01.flac",
		);
		await mkdir(secondSourceRoot, { recursive: true });
		await writeFile(secondSource, "second audio");
		const secondInput: PublicationInput = {
			root: secondSourceRoot,
			logicalReleaseKey: '["artist","second album"]',
			albumArtist: "Artist",
			albumTitle: "Second Album",
			entries: [
				{
					sourcePath: secondSource,
					destinationPath: secondDestination,
				},
			],
		};
		const state = await openImportState({
			stateRoot: paths.stateRoot,
			generatedLibraryRoot: paths.generated,
		});
		await reconcileImports({
			state,
			generatedLibraryRoot: paths.generated,
			stagingRoot: paths.staging,
			watchRoot: paths.watchRoot,
			inputs: [paths.input, secondInput],
			complete: true,
		});
		for (const destination of [paths.destination, secondDestination]) {
			expect((await lstat(destination)).isSymbolicLink()).toBe(true);
		}
		expect(
			state.database
				.query<{ n: number }, []>("SELECT count(*) n FROM operations")
				.get()?.n,
		).toBe(0);
		await recoverInterruptedOperations({
			state,
			generatedLibraryRoot: paths.generated,
			stagingRoot: paths.staging,
		});
		expect(
			state.database
				.query<{ n: number }, []>("SELECT count(*) n FROM operations")
				.get()?.n,
		).toBe(0);
		state.close();
	});

	test("collects only expired unreferenced retired versions", async () => {
		for (const keepPublicReference of [false, true]) {
			const paths = await fixture();
			const state = await openImportState({
				stateRoot: paths.stateRoot,
				generatedLibraryRoot: paths.generated,
			});
			const versionRoot = join(paths.generated, ".siftone", "versions");
			await reconcileImports({
				state,
				generatedLibraryRoot: paths.generated,
				stagingRoot: paths.staging,
				watchRoot: paths.watchRoot,
				inputs: [paths.input],
				complete: true,
			});
			const leaf = join(paths.generated, "Artist", "Album");
			const retiredVersion = resolve(dirname(leaf), await readlink(leaf));
			await writeFile(paths.source, "replacement audio");
			await reconcileImports({
				state,
				generatedLibraryRoot: paths.generated,
				stagingRoot: paths.staging,
				watchRoot: paths.watchRoot,
				inputs: [paths.input],
				complete: true,
			});
			if (keepPublicReference) {
				await rm(leaf);
				await symlink(relative(dirname(leaf), retiredVersion), leaf);
			}

			await collectRetiredVersions(
				state,
				paths.generated,
				versionRoot,
				0,
			);
			if (keepPublicReference) {
				expect((await lstat(retiredVersion)).isDirectory()).toBe(true);
			} else {
				await expect(lstat(retiredVersion)).rejects.toThrow();
			}
			expect(
				state.database
					.query<{ n: number }, []>(
						"SELECT count(*) AS n FROM album_versions WHERE state = 'retired'",
					)
					.get()?.n,
			).toBe(keepPublicReference ? 1 : 0);
			state.close();
		}
	});

	test("recovers publication operations from every durable checkpoint", async () => {
		for (const phase of [
			"planned",
			"staged",
			"versioned",
			"swapped",
		] as const) {
			const paths = await fixture();
			const state = await openImportState({
				stateRoot: paths.stateRoot,
				generatedLibraryRoot: paths.generated,
			});
			const desired = await desiredFor(
				paths.watchRoot,
				paths.generated,
				paths.input,
			);
			const operation = createOperation(
				state,
				null,
				desired,
				paths.staging,
				join(paths.generated, ".siftone", "versions"),
				"add",
				null,
			);
			const version = operation.version_path;
			if (version === null) {
				throw new Error("Publication operation needs a version path");
			}
			if (phase !== "planned") {
				await mkdir(operation.staging_path, { recursive: true });
				await symlink(
					paths.source,
					join(operation.staging_path, "01.flac"),
				);
				state.database.run(
					"UPDATE operations SET phase = 'staged' WHERE id = ?",
					[operation.id],
				);
			}
			if (phase === "versioned" || phase === "swapped") {
				await mkdir(dirname(version), { recursive: true });
				await rename(operation.staging_path, version);
				state.database.run(
					"UPDATE operations SET phase = 'versioned' WHERE id = ?",
					[operation.id],
				);
			}
			if (phase === "swapped") {
				await mkdir(dirname(operation.target_destination_path), {
					recursive: true,
				});
				await symlink(
					relative(
						dirname(operation.target_destination_path),
						version,
					),
					operation.target_destination_path,
				);
				state.database.run(
					"UPDATE operations SET phase = 'swapped' WHERE id = ?",
					[operation.id],
				);
			}

			await recoverInterruptedOperations({
				state,
				generatedLibraryRoot: paths.generated,
				stagingRoot: paths.staging,
			});
			expect((await lstat(paths.destination)).isSymbolicLink()).toBe(
				true,
			);
			expect(
				state.database
					.query<{ n: number }, []>(
						"SELECT count(*) AS n FROM operations",
					)
					.get()?.n,
			).toBe(0);
			expect(
				state.database
					.query<{ phase: string }, []>(
						"SELECT state AS phase FROM album_versions",
					)
					.get()?.phase,
			).toBe("current");
			state.close();
		}
	});
});
