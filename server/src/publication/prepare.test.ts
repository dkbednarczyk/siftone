import { describe, expect, test } from "bun:test";
import { validateCandidate } from "../candidates/validate";
import type { AudioTagReader, AudioTags } from "../metadata/tags";
import {
	arbitratePublicationContenders,
	type PublicationContender,
	splitTagGroups,
} from "./prepare";

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

describe("publication collision arbitration", () => {
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

	test("groups same-title tracks before resolving a missing album artist", async () => {
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
		const validations = await Promise.all(
			groups.map(({ candidate, reader: readTags }) =>
				validateCandidate(candidate, readTags),
			),
		);
		expect(validations).toMatchObject([
			{ valid: true, candidate: { albumArtist: "Various Artists" } },
		]);
	});

	test("groups partially tagged tracks with a consistent ALBUMARTIST", async () => {
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
		const validations = await Promise.all(
			groups.map(({ candidate, reader: readTags }) =>
				validateCandidate(candidate, readTags),
			),
		);
		expect(validations).toMatchObject([
			{ valid: true, candidate: { albumArtist: "Album Artist" } },
		]);
	});

	test("groups conflicting explicit ALBUMARTIST values for validation rejection", async () => {
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
		const validations = await Promise.all(
			groups.map(({ candidate, reader: readTags }) =>
				validateCandidate(candidate, readTags),
			),
		);
		expect(validations).toMatchObject([
			{
				valid: false,
				issues: [
					expect.objectContaining({
						code: "CONFLICTING_ALBUM_ARTIST",
					}),
				],
			},
		]);
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
		const validations = await Promise.all(
			groups.map(({ candidate, reader: readTags }) =>
				validateCandidate(candidate, readTags),
			),
		);
		expect(validations).toMatchObject([
			{ valid: true, candidate: { album: "Album One" } },
			{ valid: true, candidate: { album: "Album Two" } },
		]);
	});
});
