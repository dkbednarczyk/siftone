import { describe, expect, test } from "bun:test";
import {
	arbitratePublicationContenders,
	type PublicationContender,
} from "./prepare";

function contender(
	root: string,
	extension: "flac" | "mp3",
	title = "Song",
): PublicationContender {
	return {
		root,
		logicalReleaseKey: "artist\u0000album",
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
			unresolved: [expect.objectContaining({ contenders: [flac, mp3] })],
		});
	});
});
