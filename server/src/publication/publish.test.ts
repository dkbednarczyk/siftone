import { afterEach, describe, expect, test } from "bun:test";
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readlink,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	PublicationError,
	type PublicationHooks,
	type PublicationInput,
	publishPlans,
} from "./publish";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "siftone-publish-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function createInput(
	directory: string,
	album = "Album",
): Promise<PublicationInput> {
	const sourceRoot = join(directory, "source", album);
	const firstSource = join(sourceRoot, "01.flac");
	const secondSource = join(sourceRoot, "02.mp3");
	await mkdir(sourceRoot, { recursive: true });
	await writeFile(firstSource, "first");
	await writeFile(secondSource, "second");

	const generatedRoot = join(directory, "generated");
	return {
		root: sourceRoot,
		logicalReleaseKey: JSON.stringify([
			"artist",
			album.toLocaleLowerCase(),
		]),
		albumArtist: "Artist",
		albumTitle: album,
		entries: [
			{
				sourcePath: firstSource,
				destinationPath: join(
					generatedRoot,
					"Artist",
					album,
					"01 First.flac",
				),
			},
			{
				sourcePath: secondSource,
				destinationPath: join(
					generatedRoot,
					"Artist",
					album,
					"02 Second.mp3",
				),
			},
		],
	};
}

function publish(
	directory: string,
	inputs: readonly PublicationInput[],
	hooks: PublicationHooks = {},
) {
	return publishPlans({
		generatedLibraryRoot: join(directory, "generated"),
		stagingRoot: join(directory, "staging"),
		inputs,
		...hooks,
	});
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) =>
				rm(directory, { force: true, recursive: true }),
			),
	);
});

describe("publication", () => {
	test("stages and atomically creates absolute source symlinks", async () => {
		const directory = await makeTemporaryDirectory();
		const input = await createInput(directory);

		await expect(publish(directory, [input])).resolves.toEqual({
			createdAlbums: 1,
			unchangedAlbums: 0,
			createdSymlinks: 2,
		});

		const leaf = join(directory, "generated", "Artist", "Album");
		const target = await readlink(leaf);
		expect((await lstat(leaf)).isSymbolicLink()).toBe(true);
		expect(target.startsWith("/")).toBe(false);
		expect(
			(await lstat(resolve(dirname(leaf), target))).isDirectory(),
		).toBe(true);
		for (const entry of input.entries) {
			const status = await lstat(entry.destinationPath);
			expect(status.isSymbolicLink()).toBe(true);
			expect(await Bun.file(entry.destinationPath).text()).toBe(
				entry.sourcePath.endsWith("01.flac") ? "first" : "second",
			);
		}
		expect(await readdir(join(directory, "staging"))).toEqual([]);
	});

	test("replaces an owned public leaf while retaining its prior version", async () => {
		const directory = await makeTemporaryDirectory();
		const input = await createInput(directory);
		await publish(directory, [input]);
		const leaf = join(directory, "generated", "Artist", "Album");
		const firstVersion = resolve(dirname(leaf), await readlink(leaf));
		const replacement: PublicationInput = {
			...input,
			entries: input.entries.map((entry) => ({
				...entry,
				destinationPath: entry.destinationPath.replace(
					"First",
					"Replaced",
				),
			})),
		};

		await publish(directory, [replacement]);
		const secondVersion = resolve(dirname(leaf), await readlink(leaf));
		expect(secondVersion).not.toBe(firstVersion);
		expect((await lstat(firstVersion)).isDirectory()).toBe(true);
		expect(
			(await lstat(join(leaf, "01 Replaced.flac"))).isSymbolicLink(),
		).toBe(true);
	});

	test("uses a custom version root and rejects an external public leaf", async () => {
		const directory = await makeTemporaryDirectory();
		const input = await createInput(directory);
		const versionRoot = join(directory, "versions");
		await publishPlans({
			generatedLibraryRoot: join(directory, "generated"),
			stagingRoot: join(directory, "staging"),
			versionRoot,
			inputs: [input],
		});
		const leaf = join(directory, "generated", "Artist", "Album");
		expect(
			resolve(dirname(leaf), await readlink(leaf)).startsWith(
				versionRoot,
			),
		).toBe(true);
		await rm(leaf);
		await symlink("/tmp", leaf);
		await expect(publish(directory, [input])).rejects.toThrow(
			"Unmanaged generated-library entry",
		);
	});

	test("publishes local artwork as an absolute symlink", async () => {
		const directory = await makeTemporaryDirectory();
		const input = await createInput(directory);
		const sourcePath = join(input.root, "cover.JPEG");
		const destinationPath = join(
			directory,
			"generated",
			"Artist",
			"Album",
			"cover.jpg",
		);
		await writeFile(sourcePath, "cover");
		const withArtwork: PublicationInput = {
			...input,
			entries: [...input.entries, { sourcePath, destinationPath }],
		};

		await expect(publish(directory, [withArtwork])).resolves.toEqual({
			createdAlbums: 1,
			unchangedAlbums: 0,
			createdSymlinks: 3,
		});
		expect((await lstat(destinationPath)).isSymbolicLink()).toBe(true);
		expect(await readlink(destinationPath)).toBe(sourcePath);

		await expect(publish(directory, [withArtwork])).resolves.toEqual({
			createdAlbums: 0,
			unchangedAlbums: 1,
			createdSymlinks: 0,
		});
	});

	test("treats a complete exact generated album as idempotent", async () => {
		const directory = await makeTemporaryDirectory();
		const input = await createInput(directory);
		await publish(directory, [input]);

		await expect(publish(directory, [input])).resolves.toEqual({
			createdAlbums: 0,
			unchangedAlbums: 1,
			createdSymlinks: 0,
		});
	});

	test("rejects a mismatched album before publishing another candidate", async () => {
		const directory = await makeTemporaryDirectory();
		const firstInput = await createInput(directory, "First");
		const secondInput = await createInput(directory, "Second");
		const conflictingDestination = firstInput.entries[0].destinationPath;
		await mkdir(join(directory, "generated", "Artist", "First"), {
			recursive: true,
		});
		await writeFile(conflictingDestination, "unmanaged");

		await expect(
			publish(directory, [firstInput, secondInput]),
		).rejects.toEqual(expect.any(PublicationError));
		await expect(
			lstat(secondInput.entries[0].destinationPath),
		).rejects.toThrow("ENOENT");
	});

	test("rejects a partial existing album", async () => {
		const directory = await makeTemporaryDirectory();
		const input = await createInput(directory);
		await mkdir(join(directory, "generated", "Artist", "Album"), {
			recursive: true,
		});
		await symlink(
			input.entries[0].sourcePath,
			input.entries[0].destinationPath,
		);

		await expect(publish(directory, [input])).rejects.toThrow(
			"does not exactly match",
		);
		await expect(lstat(input.entries[1].destinationPath)).rejects.toThrow(
			"ENOENT",
		);
	});

	test("rejects an album destination that appears after staging", async () => {
		const directory = await makeTemporaryDirectory();
		const input = await createInput(directory);
		const albumPath = join(directory, "generated", "Artist", "Album");

		await expect(
			publish(directory, [input], {
				beforeCommit: async () => {
					await mkdir(albumPath, {
						recursive: true,
					});
				},
			}),
		).rejects.toThrow("appeared during publication");
		await expect(lstat(input.entries[0].destinationPath)).rejects.toThrow(
			"ENOENT",
		);
	});

	test("rejects an artist symlink instead of traversing it", async () => {
		const directory = await makeTemporaryDirectory();
		const input = await createInput(directory);
		const externalDirectory = join(directory, "external");
		await mkdir(join(directory, "generated"), { recursive: true });
		await mkdir(externalDirectory);
		await symlink(
			externalDirectory,
			join(directory, "generated", "Artist"),
		);

		await expect(publish(directory, [input])).rejects.toThrow(
			"Unmanaged generated-library entry",
		);
		await expect(lstat(join(externalDirectory, "Album"))).rejects.toThrow(
			"ENOENT",
		);
	});

	test("retains committed albums and resumes after a later commit fails", async () => {
		const directory = await makeTemporaryDirectory();
		const firstInput = await createInput(directory, "First");
		const secondInput = await createInput(directory, "Second");

		await expect(
			publish(directory, [firstInput, secondInput], {
				beforePublishAlbum: (albumPath) => {
					if (albumPath.endsWith("/Second")) {
						throw new Error("simulated commit failure");
					}
				},
			}),
		).rejects.toThrow("simulated commit failure");
		expect(
			(
				await lstat(firstInput.entries[0].destinationPath)
			).isSymbolicLink(),
		).toBe(true);
		await expect(
			lstat(secondInput.entries[0].destinationPath),
		).rejects.toThrow("ENOENT");
		expect(await readdir(join(directory, "staging"))).toEqual([]);

		await expect(
			publish(directory, [firstInput, secondInput]),
		).resolves.toEqual({
			createdAlbums: 1,
			unchangedAlbums: 1,
			createdSymlinks: 2,
		});
	});

	test("rejects duplicate candidates targeting one album", async () => {
		const directory = await makeTemporaryDirectory();
		const input = await createInput(directory);
		const duplicate: PublicationInput = {
			...input,
			root: `${input.root}-duplicate`,
			entries: input.entries,
		};

		await expect(publish(directory, [input, duplicate])).rejects.toThrow(
			"Multiple candidates target",
		);
		await expect(lstat(input.entries[0].destinationPath)).rejects.toThrow(
			"ENOENT",
		);
	});

	test("rejects a symbolic-link staging root", async () => {
		const directory = await makeTemporaryDirectory();
		const input = await createInput(directory);
		const externalDirectory = join(directory, "external");
		const stagingRoot = join(directory, "staging");
		await mkdir(externalDirectory);
		await symlink(externalDirectory, stagingRoot);

		await expect(
			publishPlans({
				generatedLibraryRoot: join(directory, "generated"),
				stagingRoot,
				inputs: [input],
			}),
		).rejects.toThrow("Staging root is not a real directory");
		await expect(lstat(input.entries[0].destinationPath)).rejects.toThrow(
			"ENOENT",
		);
	});

	test("rejects unmanaged generated entries", async () => {
		const directory = await makeTemporaryDirectory();
		const input = await createInput(directory);
		await mkdir(join(directory, "generated"), { recursive: true });
		await writeFile(
			join(directory, "generated", "unmanaged.txt"),
			"unmanaged",
		);

		await expect(publish(directory, [input])).rejects.toThrow(
			"Unmanaged generated-library entry",
		);
	});
});
