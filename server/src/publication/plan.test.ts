import { describe, expect, test } from "bun:test";
import { planPublication } from "./plan";

describe("publication planning", () => {
	test("flattens discs into deterministic, sanitized destination paths", () => {
		const result = planPublication(
			{
				root: "/source/Album",
				albumArtist: "Artist/Name",
				album: "Album",
				tracks: [
					{
						path: "/source/Album/disc-2/01 Second.FLAC",
						title: "Second",
						artist: "Artist",
						discNumber: 2,
						trackNumber: 1,
					},
					{
						path: "/source/Album/disc-1/02 First.mp3",
						title: "First\\Track",
						artist: "Artist",
						discNumber: 1,
						trackNumber: 2,
					},
				],
			},
			"/library",
		);

		expect(result).toEqual({
			valid: true,
			entries: [
				{
					sourcePath: "/source/Album/disc-1/02 First.mp3",
					destinationPath: "/library/Artist Name/Album/01 First Track.mp3",
				},
				{
					sourcePath: "/source/Album/disc-2/01 Second.FLAC",
					destinationPath: "/library/Artist Name/Album/02 Second.flac",
				},
			],
		});
	});

	test("normalizes local artwork destinations to JPG or PNG", () => {
		const jpg = planPublication(
			{
				root: "/source/Album",
				albumArtist: "Artist",
				album: "Album",
				artworkPath: "/source/Album/Cover.JPEG",
				tracks: [],
			},
			"/library",
		);
		const png = planPublication(
			{
				root: "/source/Album",
				albumArtist: "Artist",
				album: "Album",
				artworkPath: "/source/Album/Cover.PNG",
				tracks: [],
			},
			"/library",
		);

		expect(jpg).toEqual({
			valid: true,
			entries: [
				{
					sourcePath: "/source/Album/Cover.JPEG",
					destinationPath: "/library/Artist/Album/cover.jpg",
				},
			],
		});
		expect(png).toEqual({
			valid: true,
			entries: [
				{
					sourcePath: "/source/Album/Cover.PNG",
					destinationPath: "/library/Artist/Album/cover.png",
				},
			],
		});
	});

	test("rejects unsupported artwork and reserved cover destinations", () => {
		const unsupported = planPublication(
			{
				root: "/source/Album",
				albumArtist: "Artist",
				album: "Album",
				artworkPath: "/source/Album/cover.webp",
				tracks: [],
			},
			"/library",
		);
		const collision = planPublication(
			{
				root: "/source/Album",
				albumArtist: "Artist",
				album: "Album",
				artworkPath: "/source/Album/cover.jpg",
				tracks: [],
			},
			"/library",
			["/library/Artist/Album/cover.jpg"],
		);

		expect(unsupported).toMatchObject({
			valid: false,
			issues: [{ code: "UNSUPPORTED_ARTWORK_FORMAT" }],
		});
		expect(collision).toMatchObject({
			valid: false,
			issues: [{ code: "OUTPUT_COLLISION" }],
		});
	});

	test("rejects unsafe segments and already-reserved destinations", () => {
		const unsafe = planPublication(
			{
				root: "/source/Album",
				albumArtist: "..",
				album: "Album",
				tracks: [],
			},
			"/library",
		);
		const collision = planPublication(
			{
				root: "/source/Album",
				albumArtist: "Artist",
				album: "Album",
				tracks: [
					{
						path: "/source/Album/01 Song.flac",
						title: "Song",
						artist: "Artist",
						discNumber: 1,
						trackNumber: 1,
					},
				],
			},
			"/library",
			["/library/Artist/Album/01 Song.flac"],
		);

		expect(unsafe).toMatchObject({
			valid: false,
			issues: [{ code: "UNSAFE_PATH_SEGMENT" }],
		});
		expect(collision).toMatchObject({
			valid: false,
			issues: [{ code: "OUTPUT_COLLISION" }],
		});
	});
});
