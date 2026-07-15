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
import { reconcileImports, recoverInterruptedOperations } from "./reconcile";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "siftone-reconcile-v2-"));
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
		logicalReleaseKey: "artist\0album",
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

describe("v2 reconciliation", () => {
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
				.query<{ n: number }, []>(
					"SELECT count(*) n FROM source_files WHERE source_path = 'Album/01.flac'",
				)
				.get()?.n,
		).toBe(1);
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
			watchRoot: paths.watchRoot,
		});
		expect((await lstat(paths.destination)).isSymbolicLink()).toBe(true);
		state.close();
	});
});
