import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCandidate, discoverCandidates } from "./discover";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) =>
				rm(directory, { recursive: true, force: true }),
			),
	);
});

async function makeWatchRoot(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "siftone-discovery-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function writeSourceFile(
	path: string,
	contents = "audio",
): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, contents);
}

describe("candidate discovery", () => {
	test("uses immediate real child directories as candidate roots", async () => {
		const watchRoot = await makeWatchRoot();
		const album = join(watchRoot, "Album");
		const nestedAlbum = join(album, "Disc 1");
		await writeSourceFile(join(nestedAlbum, "01 Intro.flac"));
		await writeSourceFile(join(watchRoot, "loose.mp3"));

		const result = await discoverCandidates(watchRoot);

		expect(result).toEqual({
			candidates: [
				{
					root: album,
					audioPaths: [join(nestedAlbum, "01 Intro.flac")],
					imagePaths: [],
				},
			],
			issues: [],
		});
	});

	test("rejects a symbolic-link root for targeted discovery", async () => {
		const watchRoot = await makeWatchRoot();
		const source = join(watchRoot, "Source");
		const symlinkRoot = join(watchRoot, "Linked");
		await writeSourceFile(join(source, "01.flac"));
		await symlink(source, symlinkRoot);

		await expect(discoverCandidate(symlinkRoot)).resolves.toEqual({
			issues: [
				{
					path: symlinkRoot,
					message: "Source candidate root is not a real directory",
				},
			],
		});
	});

	test("discovers a release whose root contains only disc folders", async () => {
		const watchRoot = await makeWatchRoot();
		const album = join(watchRoot, "Minecraft Volume Beta");
		const firstTrack = join(album, "Disc 1", "01 Ki.flac");
		const secondTrack = join(album, "Disc 2", "01 Taswell.flac");
		const firstCover = join(album, "Disc 1", "cover.jpg");
		const secondCover = join(album, "Disc 2", "cover.jpg");
		await writeSourceFile(firstTrack);
		await writeSourceFile(secondTrack);
		await writeSourceFile(firstCover);
		await writeSourceFile(secondCover);

		await expect(discoverCandidates(watchRoot)).resolves.toEqual({
			candidates: [
				{
					root: album,
					audioPaths: [firstTrack, secondTrack],
					imagePaths: [firstCover, secondCover],
				},
			],
			issues: [],
		});
	});

	test("finds supported audio case-insensitively and ignores unrelated files", async () => {
		const watchRoot = await makeWatchRoot();
		const album = join(watchRoot, "Album");
		await writeSourceFile(join(album, "01 Song.FLAC"));
		await writeSourceFile(join(album, "02 Song.Mp3"));
		await writeSourceFile(join(album, "cover.jpg"));
		await writeSourceFile(join(album, "notes.txt"));

		const result = await discoverCandidates(watchRoot);

		expect(result.candidates).toEqual([
			{
				root: album,
				audioPaths: [
					join(album, "01 Song.FLAC"),
					join(album, "02 Song.Mp3"),
				],
				imagePaths: [join(album, "cover.jpg")],
			},
		]);
		expect(result.issues).toEqual([]);
	});

	test("finds real JPG and PNG images but ignores other formats and symlinks", async () => {
		const watchRoot = await makeWatchRoot();
		const album = join(watchRoot, "Album");
		const jpg = join(album, "front.JPEG");
		const png = join(album, "art", "cover.PNG");
		await writeSourceFile(join(album, "01 Song.flac"));
		await writeSourceFile(jpg);
		await writeSourceFile(png);
		await writeSourceFile(join(album, "back.webp"));
		await symlink(jpg, join(album, "linked.jpg"));

		await expect(discoverCandidates(watchRoot)).resolves.toEqual({
			candidates: [
				{
					root: album,
					audioPaths: [join(album, "01 Song.flac")],
					imagePaths: [png, jpg],
				},
			],
			issues: [],
		});
	});

	test("accepts audio at the depth boundary and reports pruned deeper paths", async () => {
		const watchRoot = await makeWatchRoot();
		const boundaryAlbum = join(watchRoot, "Boundary");
		const beyondAlbum = join(watchRoot, "Beyond");
		const boundaryTrack = join(boundaryAlbum, "Disc", "01 Song.flac");
		await writeSourceFile(boundaryTrack);
		await writeSourceFile(
			join(beyondAlbum, "Disc", "Bonus", "01 Song.flac"),
		);

		const result = await discoverCandidates(watchRoot, {
			maxDepth: 2,
		});

		expect(result.candidates).toEqual([
			{
				root: boundaryAlbum,
				audioPaths: [boundaryTrack],
				imagePaths: [],
			},
		]);
		expect(result.issues).toEqual([
			expect.objectContaining({
				path: join(beyondAlbum, "Disc", "Bonus"),
				message: expect.stringContaining("depth limit (2)"),
			}),
		]);
	});

	test("reports entry-budget exhaustion without dropping discovered audio", async () => {
		const watchRoot = await makeWatchRoot();
		const album = join(watchRoot, "Album");
		const firstTrack = join(album, "01 First.flac");
		await writeSourceFile(firstTrack);
		await writeSourceFile(join(album, "02 Second.flac"));

		const result = await discoverCandidates(watchRoot, {
			maxEntries: 1,
		});

		expect(result.candidates).toEqual([
			{
				root: album,
				audioPaths: [firstTrack],
				imagePaths: [],
			},
		]);
		expect(result.issues).toEqual([
			expect.objectContaining({
				path: album,
				message: expect.stringContaining("entry limit (1)"),
			}),
		]);
	});

	test("does not traverse source symlinks", async () => {
		const watchRoot = await makeWatchRoot();
		const album = join(watchRoot, "Album");
		const linkedAlbum = join(watchRoot, "Linked Album");
		const external = join(watchRoot, "External");
		await writeSourceFile(join(album, "01 Song.flac"));
		await writeSourceFile(join(external, "02 Linked.flac"));
		await symlink(
			join(external, "02 Linked.flac"),
			join(album, "linked.mp3"),
		);
		await symlink(external, join(album, "linked-directory"));
		await symlink(external, linkedAlbum);

		const result = await discoverCandidates(watchRoot);

		expect(result).toEqual({
			candidates: [
				{
					root: album,
					audioPaths: [join(album, "01 Song.flac")],
					imagePaths: [],
				},
				{
					root: external,
					audioPaths: [join(external, "02 Linked.flac")],
					imagePaths: [],
				},
			],
			issues: [],
		});
	});

	test("excludes empty candidates and returns stable ordering", async () => {
		const watchRoot = await makeWatchRoot();
		const firstAlbum = join(watchRoot, "A Album");
		const lastAlbum = join(watchRoot, "Z Album");
		await mkdir(join(watchRoot, "Empty"));
		await writeSourceFile(join(lastAlbum, "02 Song.mp3"));
		await writeSourceFile(join(lastAlbum, "01 Song.mp3"));
		await writeSourceFile(join(firstAlbum, "01 Song.flac"));

		const result = await discoverCandidates(watchRoot);

		expect(result.candidates).toEqual([
			{
				root: firstAlbum,
				audioPaths: [join(firstAlbum, "01 Song.flac")],
				imagePaths: [],
			},
			{
				root: lastAlbum,
				audioPaths: [
					join(lastAlbum, "01 Song.mp3"),
					join(lastAlbum, "02 Song.mp3"),
				],
				imagePaths: [],
			},
		]);
	});

	test("rejects invalid traversal limits", async () => {
		await expect(
			discoverCandidates("/unused", { maxDepth: 0 }),
		).rejects.toThrow(RangeError);
		await expect(
			discoverCandidates("/unused", { maxEntries: 1.5 }),
		).rejects.toThrow(RangeError);
	});

	test("propagates watch-root read errors", async () => {
		const watchRoot = await makeWatchRoot();
		let caughtError: unknown;

		try {
			await discoverCandidates(join(watchRoot, "missing"));
		} catch (error) {
			caughtError = error;
		}

		expect(caughtError).toMatchObject({ code: "ENOENT" });
	});

	test("only reads source files", async () => {
		const watchRoot = await makeWatchRoot();
		const sourceFile = join(watchRoot, "Album", "01 Song.flac");
		await writeSourceFile(sourceFile, "original audio bytes");

		await discoverCandidates(watchRoot);

		expect(await readFile(sourceFile, "utf8")).toBe("original audio bytes");
	});
});
