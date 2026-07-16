import { describe, expect, test } from "bun:test";
import type { AudioTagReader, AudioTags } from "../metadata/tags";
import { planPublication } from "../publication/plan";
import type { DiscoveredCandidate } from "./discover";
import { validateCandidate } from "./validate";

function candidate(...audioPaths: string[]): DiscoveredCandidate {
	return { root: "/source/Album", audioPaths, imagePaths: [] };
}

function tags(overrides: Partial<AudioTags> = {}): AudioTags {
	return {
		path: "/source/Album/01 Song.flac",
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

describe("candidate metadata validation", () => {
	test("derives a shared track artist and validates required tags", async () => {
		const first = "/source/Album/01 Song.flac";
		const second = "/source/Album/02 Song.flac";

		const result = await validateCandidate(
			candidate(first, second),
			reader({
				[first]: tags({ path: first }),
				[second]: tags({
					path: second,
					title: "Second",
					trackNumber: 2,
				}),
			}),
		);

		expect(result).toEqual({
			valid: true,
			candidate: {
				root: "/source/Album",
				album: "Album",
				albumArtist: "Artist",
				tracks: [
					{
						path: first,
						title: "Song",
						artist: "Artist",
						trackNumber: 1,
						discNumber: 1,
					},
					{
						path: second,
						title: "Second",
						artist: "Artist",
						trackNumber: 2,
						discNumber: 1,
					},
				],
			},
		});
	});

	test("selects an unambiguous local cover before an album-name image", async () => {
		const first = "/source/Album/01 Song.flac";
		const result = await validateCandidate(
			{
				...candidate(first),
				imagePaths: [
					"/source/Album/Album.png",
					"/source/Album/cover.JPEG",
				],
			},
			reader({ [first]: tags({ path: first }) }),
		);

		expect(result).toMatchObject({
			valid: true,
			candidate: { artworkPath: "/source/Album/cover.JPEG" },
		});
	});

	test("selects the first ranked cover and emits a warning for alternatives", async () => {
		const first = "/source/Album/01 Song.flac";
		const result = await validateCandidate(
			{
				...candidate(first),
				imagePaths: [
					"/source/Album/cover.png",
					"/source/Album/cover.jpg",
				],
			},
			reader({ [first]: tags({ path: first }) }),
		);

		expect(result).toMatchObject({
			valid: true,
			candidate: { artworkPath: "/source/Album/cover.jpg" },
			warnings: [
				{
					code: "MULTIPLE_ARTWORK_CANDIDATES",
					selectedPath: "/source/Album/cover.jpg",
					ignoredPaths: ["/source/Album/cover.png"],
				},
			],
		});
	});

	test("selects the shallowest cover from validated audio directories", async () => {
		const first = "/source/Album/Disc 1/01 Song.flac";
		const second = "/source/Album/Disc 2/01 Song.flac";
		const result = await validateCandidate(
			{
				...candidate(second, first),
				imagePaths: [
					"/source/Album/Other/cover.jpg",
					"/source/Album/Disc 2/cover.jpg",
					"/source/Album/Disc 1/cover.jpg",
				],
			},
			reader({
				[first]: tags({ path: first, discNumber: 1 }),
				[second]: tags({ path: second, discNumber: 2 }),
			}),
		);

		expect(result).toMatchObject({
			valid: true,
			candidate: {
				artworkPath: "/source/Album/Disc 1/cover.jpg",
			},
			warnings: [
				{
					selectedPath: "/source/Album/Disc 1/cover.jpg",
					ignoredPaths: ["/source/Album/Disc 2/cover.jpg"],
				},
			],
		});
		if (result.valid) {
			expect(planPublication(result.candidate, "/library")).toMatchObject(
				{
					valid: true,
				},
			);
		}
	});

	test("selects album-name artwork when no cover exists", async () => {
		const first = "/source/Album/Disc 1/01 Song.flac";
		const result = await validateCandidate(
			{
				...candidate(first),
				imagePaths: ["/source/Album/Disc 1/Album.png"],
			},
			reader({ [first]: tags({ path: first }) }),
		);

		expect(result).toMatchObject({
			valid: true,
			candidate: {
				artworkPath: "/source/Album/Disc 1/Album.png",
			},
		});
	});

	test("requires ALBUMARTIST when artists differ", async () => {
		const first = "/source/Album/01 Song.flac";
		const second = "/source/Album/02 Song.flac";

		const result = await validateCandidate(
			candidate(first, second),
			reader({
				[first]: tags({ path: first }),
				[second]: tags({
					path: second,
					artist: "Guest",
					trackNumber: 2,
				}),
			}),
		);

		expect(result).toMatchObject({
			valid: false,
			issues: [
				expect.objectContaining({
					code: "MISSING_ALBUM_ARTIST",
				}),
			],
		});
	});

	test("stops after reporting the first malformed file", async () => {
		const first = "/source/Album/01 Song.flac";
		const second = "/source/Album/02 Song.flac";
		const calls: string[] = [];
		const readTags = reader({
			[first]: tags({
				path: first,
				title: "",
				trackNumber: 0,
			}),
			[second]: tags({
				path: second,
				album: "Another Album",
				trackNumber: 1,
			}),
		});

		const result = await validateCandidate(
			candidate(first, second),
			async (path) => {
				calls.push(path);
				return readTags(path);
			},
		);

		expect(result).toEqual({
			valid: false,
			root: "/source/Album",
			issues: [
				{
					code: "MISSING_TITLE",
					message: "TITLE is required",
					path: first,
				},
				{
					code: "INVALID_TRACK_NUMBER",
					message: "TRACKNUMBER must be positive",
					path: first,
				},
			],
		});
		expect(calls).toEqual([first]);
	});

	test("stops after the first tag-read failure", async () => {
		const first = "/source/Album/01 Song.flac";
		const second = "/source/Album/02 Song.flac";
		const calls: string[] = [];

		const result = await validateCandidate(
			candidate(first, second),
			async (path) => {
				calls.push(path);
				throw new Error("Unreadable tags");
			},
		);

		expect(result).toEqual({
			valid: false,
			root: "/source/Album",
			issues: [
				{
					code: "TAG_READ_ERROR",
					message: "Unreadable tags",
					path: first,
				},
			],
		});
		expect(calls).toEqual([first]);
	});

	test("stops after a duplicate disc and track number", async () => {
		const first = "/source/Album/disc-1/01 Song.flac";
		const second = "/source/Album/disc-1/01 Duplicate.flac";
		const third = "/source/Album/disc-1/02 Unread.flac";
		const calls: string[] = [];
		const readTags = reader({
			[first]: tags({ path: first, discNumber: 1 }),
			[second]: tags({
				path: second,
				title: "Duplicate",
				discNumber: 1,
			}),
			[third]: tags({ path: third, title: "Unread", trackNumber: 2 }),
		});

		const result = await validateCandidate(
			candidate(first, second, third),
			async (path) => {
				calls.push(path);
				return readTags(path);
			},
		);

		expect(result).toMatchObject({
			valid: false,
			issues: [
				{
					code: "DUPLICATE_DISC_TRACK",
					path: second,
				},
			],
		});
		expect(calls).toEqual([first, second]);
	});
});
