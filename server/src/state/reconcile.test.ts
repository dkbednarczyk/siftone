import { afterEach, describe, expect, test } from "bun:test";
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
import type { PublicationInput } from "../publication/publish";
import { openImportState } from "./import-state";
import { desiredFor } from "./publication-snapshot";
import { reconcileImports, recoverInterruptedOperations } from "./reconcile";

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

	test("recovery resumes a planned operation after a simulated crash", async () => {
		const paths = await fixture();
		const state = await openImportState({
			stateRoot: paths.stateRoot,
			generatedLibraryRoot: paths.generated,
		});
		// A normal call creates and completes the operation; recovery is idempotent afterwards.
		await reconcileImports({
			state,
			generatedLibraryRoot: paths.generated,
			stagingRoot: paths.staging,
			watchRoot: paths.watchRoot,
			inputs: [paths.input],
			complete: true,
		});
		await recoverInterruptedOperations({
			state,
			generatedLibraryRoot: paths.generated,
			stagingRoot: paths.staging,
		});
		expect((await lstat(paths.destination)).isSymbolicLink()).toBe(true);
		state.close();
	});
});
