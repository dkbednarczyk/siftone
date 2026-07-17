import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { readAudioTags } from "./tags";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "siftone-tags-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function run(command: string, args: readonly string[]): Promise<void> {
	await execFileAsync(command, args);
}

async function createSilentAudio(
	path: string,
	codec: "flac" | "libmp3lame",
): Promise<void> {
	await run("ffmpeg", [
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
		codec,
		path,
	]);
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

describe("embedded audio metadata", () => {
	test("reads and does not modify FLAC tags", async () => {
		const directory = await makeTemporaryDirectory();
		const path = join(directory, "track.flac");
		await createSilentAudio(path, "flac");
		await run("metaflac", [
			"--remove-all-tags",
			"--set-tag=TITLE=  FLAC Title  ",
			"--set-tag=ARTIST=FLAC Artist",
			"--set-tag=ALBUM=FLAC Album",
			"--set-tag=ALBUMARTIST=FLAC Album Artist",
			"--set-tag=TRACKNUMBER=3",
			"--set-tag=DISCNUMBER=2",
			path,
		]);
		const before = await readFile(path);

		expect(await readAudioTags(path)).toEqual({
			path,
			title: "FLAC Title",
			artist: "FLAC Artist",
			album: "FLAC Album",
			albumArtist: "FLAC Album Artist",
			trackNumber: 3,
			discNumber: 2,
		});
		expect(await readFile(path)).toEqual(before);
	});

	test("reads MP3 tags", async () => {
		const directory = await makeTemporaryDirectory();
		const path = join(directory, "track.mp3");
		await createSilentAudio(path, "libmp3lame");
		await run("eyeD3", [
			"--no-config",
			"--quiet",
			"--title",
			"MP3 Title",
			"--artist",
			"MP3 Artist",
			"--album",
			"MP3 Album",
			"--album-artist",
			"MP3 Album Artist",
			"--track",
			"4",
			"--disc-num",
			"3",
			path,
		]);

		expect(await readAudioTags(path)).toEqual({
			path,
			title: "MP3 Title",
			artist: "MP3 Artist",
			album: "MP3 Album",
			albumArtist: "MP3 Album Artist",
			trackNumber: 4,
			discNumber: 3,
		});
	});
});
