import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AudioTagReader, AudioTags } from "../metadata/tags";
import { observeSource } from "../state/source-observer";
import {
	arbitratePublicationContenders,
	type PublicationContender,
	preparePublication,
	splitTagGroups,
} from "./prepare";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) =>
				rm(directory, { force: true, recursive: true }),
			),
	);
});

async function taggedFlac(root: string): Promise<string> {
	const path = join(root, "01 Song.flac");
	await mkdir(root, { recursive: true });
	await execFileAsync("ffmpeg", [
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		"anullsrc=r=44100:cl=mono",
		"-t",
		"0.1",
		"-c:a",
		"flac",
		path,
	]);
	await execFileAsync("metaflac", [
		"--set-tag=TITLE=Song",
		"--set-tag=ARTIST=Artist",
		"--set-tag=ALBUM=Album",
		"--set-tag=TRACKNUMBER=1",
		path,
	]);
	return path;
}

async function preparedFixture(): Promise<
	Readonly<{
		watchRoot: string;
		generatedRoot: string;
		albumRoot: string;
		track: string;
	}>
> {
	const root = await mkdtemp(join(tmpdir(), "siftone-prepare-"));
	temporaryDirectories.push(root);
	const watchRoot = join(root, "watch");
	const albumRoot = join(watchRoot, "Album");
	const track = await taggedFlac(albumRoot);
	return {
		watchRoot,
		generatedRoot: join(root, "generated"),
		albumRoot,
		track,
	};
}

function tags(path: string, overrides: Partial<AudioTags> = {}): AudioTags {
	return {
		path,
		title: "Song",
		artist: "Artist",
		album: "Album",
		trackNumber: 1,
		...overrides,
	};
}

function reader(values: Record<string, AudioTags>): AudioTagReader {
	return async (path) => {
		const value = values[path];
		if (value === undefined) {
			throw new Error(`No test metadata for ${path}`);
		}

		return value;
	};
}

function contender(
	root: string,
	extension: "flac" | "mp3",
	title = "Song",
): PublicationContender {
	return {
		root,
		logicalReleaseKey: '["artist","album"]',
		albumArtist: "Artist",
		albumTitle: "Album",
		entries: [
			{
				sourcePath: `${root}/01 ${title}.${extension}`,
				destinationPath: `/library/Artist/Album/01 ${title}.${extension}`,
			},
		],
	};
}

describe("publication preparation", () => {
	test("prepares a real tagged album through discovery, validation, and planning", async () => {
		const fixture = await preparedFixture();
		const observation = await observeSource(fixture.watchRoot);
		const progress: string[] = [];
		expect(observation.complete).toBe(true);
		const result = await preparePublication(
			fixture.watchRoot,
			fixture.generatedRoot,
			observation.discovery,
			(message) => progress.push(message),
		);

		expect(result).toMatchObject({
			hasIssues: false,
			incompleteSourceContainers: [],
			candidates: [{ root: fixture.albumRoot, status: "planned" }],
			plans: [
				{
					root: fixture.albumRoot,
					entries: [
						{
							sourcePath: fixture.track,
							destinationPath: join(
								fixture.generatedRoot,
								"Artist",
								"Album",
								"01 Song.flac",
							),
						},
					],
				},
			],
		});
		expect(progress).toEqual([
			"Preparing 1 source container(s) for publication.",
			"Prepared 1 of 1 source container(s).",
			"Publication preparation complete: 1 planned release(s), 0 invalid or unplannable release(s), 0 FLAC-preferred release(s), 0 discovery issue(s).",
		]);
	});

	test("marks depth-pruned containers as incomplete", async () => {
		const fixture = await preparedFixture();
		await taggedFlac(
			join(fixture.albumRoot, "a", "b", "c", "d", "e", "f", "g", "h"),
		);
		const result = await preparePublication(
			fixture.watchRoot,
			fixture.generatedRoot,
		);
		expect(result.hasIssues).toBe(true);
		expect(result.incompleteSourceContainers).toEqual([fixture.albumRoot]);
	});

	test("prefers a pure FLAC contender over an identical pure MP3 track set", () => {
		const flac = contender("/source/flac", "flac");
		const mp3 = contender("/source/mp3", "mp3");
		expect(arbitratePublicationContenders([mp3, flac])).toEqual({
			plans: [flac],
			suppressed: [mp3],
			unresolved: [],
		});
	});

	test("reports an unresolved collision without creating an ownerless review", () => {
		const flac = contender("/source/flac", "flac", "Song");
		const mp3 = contender("/source/mp3", "mp3", "Different Song");
		expect(arbitratePublicationContenders([flac, mp3])).toEqual({
			plans: [],
			suppressed: [],
			unresolved: [
				expect.objectContaining({
					contenders: [flac, mp3],
				}),
			],
		});
	});

	test("groups same-title tracks into one logical release", async () => {
		const first = "/source/Album/01 Song.flac";
		const second = "/source/Album/02 Song.flac";
		const groups = await splitTagGroups(
			{
				root: "/source/Album",
				audioPaths: [first, second],
				imagePaths: [],
			},
			reader({
				[first]: tags(first),
				[second]: tags(second, {
					artist: "Guest",
					trackNumber: 2,
				}),
			}),
		);

		expect(groups).toHaveLength(1);
	});

	test("groups tracks when ALBUMARTIST is present on only one track", async () => {
		const first = "/source/Album/01 Song.flac";
		const second = "/source/Album/02 Song.flac";
		const groups = await splitTagGroups(
			{
				root: "/source/Album",
				audioPaths: [first, second],
				imagePaths: [],
			},
			reader({
				[first]: tags(first),
				[second]: tags(second, {
					artist: "Guest",
					albumArtist: "Album Artist",
					trackNumber: 2,
				}),
			}),
		);

		expect(groups).toHaveLength(1);
	});

	test("groups tracks despite conflicting ALBUMARTIST values", async () => {
		const first = "/source/Album/01 Song.flac";
		const second = "/source/Album/02 Song.flac";
		const groups = await splitTagGroups(
			{
				root: "/source/Album",
				audioPaths: [first, second],
				imagePaths: [],
			},
			reader({
				[first]: tags(first, { albumArtist: "Artist One" }),
				[second]: tags(second, {
					albumArtist: "Artist Two",
					trackNumber: 2,
				}),
			}),
		);

		expect(groups).toHaveLength(1);
	});

	test("keeps different exact album titles in separate groups", async () => {
		const first = "/source/Album/01 Song.flac";
		const second = "/source/Album/02 Song.flac";
		const groups = await splitTagGroups(
			{
				root: "/source/Album",
				audioPaths: [first, second],
				imagePaths: [],
			},
			reader({
				[first]: tags(first, { album: "Album One" }),
				[second]: tags(second, {
					album: "Album Two",
					trackNumber: 2,
				}),
			}),
		);

		expect(groups).toHaveLength(2);
	});
});
