import { describe, expect, test } from "bun:test";
import {
	artistCreditName,
	MAX_BROWSED_EDITIONS,
	normalizeMetadata,
	type ReleaseEdition,
	type ReleaseGroupCandidate,
	selectArtworkEditions,
	selectReleaseGroup,
} from "./matching";

function releaseGroup(
	id: string,
	title: string,
	artist: string,
	score: number,
): ReleaseGroupCandidate {
	return {
		id,
		title,
		artistCredit: [{ artistName: artist }],
		score,
	};
}

function edition(
	id: string,
	status: string,
	date: string,
	hasFrontCoverArt = true,
): ReleaseEdition {
	return { id, status, date, hasFrontCoverArt };
}

describe("MusicBrainz metadata matching", () => {
	test("normalizes metadata and omitted final artist join phrases", () => {
		expect(normalizeMetadata("  DＡFT\tPUNK ")).toBe("daft punk");
		expect(
			artistCreditName([
				{ artistName: "Artist One", joinPhrase: " & " },
				{ artistName: "Artist Two" },
			]),
		).toBe("Artist One & Artist Two");
	});

	test("prefers an exact artist and title match over score", () => {
		const selected = selectReleaseGroup(
			[
				releaseGroup("high-score", "Different Album", "Artist", 100),
				releaseGroup("exact", "The Album", "The Artist", 95),
			],
			"the artist",
			"  the album ",
		);

		expect(selected?.id).toBe("exact");
	});

	test("uses the highest conservative fuzzy score and MBID tie-break", () => {
		const selected = selectReleaseGroup(
			[
				releaseGroup("z-id", "Album (Deluxe)", "Artist", 95),
				releaseGroup("a-id", "Album: Deluxe", "Artist", 95),
				releaseGroup("near", "Another Album", "Artist", 94),
			],
			"Artist",
			"Album",
		);

		expect(selected?.id).toBe("a-id");
	});

	test("rejects fuzzy matches below score 95", () => {
		expect(
			selectReleaseGroup(
				[releaseGroup("near", "Album (Deluxe)", "Artist", 94)],
				"Artist",
				"Album",
			),
		).toBeUndefined();
	});

	test("bounds and ranks editions with declared front art", () => {
		const editions = [
			edition("no-front", "Official", "1999-01-01", false),
			edition("later", "Official", "2001-01-01"),
			edition("promo", "Promotion", "1990-01-01"),
			edition("earlier-z", "Official", "2000-01-01"),
			edition("earlier-a", "Official", "2000-01-01"),
			edition("unknown-date", "Official", ""),
		];
		const extra = Array.from({ length: MAX_BROWSED_EDITIONS }, (_, index) =>
			edition(`after-${index}`, "Official", "2100-01-01"),
		);

		const selected = selectArtworkEditions([...editions, ...extra]);

		expect(selected.slice(0, 5).map((item) => item.id)).toEqual([
			"earlier-a",
			"earlier-z",
			"later",
			"after-0",
			"after-1",
		]);
		expect(selected).toHaveLength(MAX_BROWSED_EDITIONS - 1);
		expect(selected.at(-2)?.id).toBe("unknown-date");
		expect(selected.at(-1)?.id).toBe("promo");
		expect(selected.some((item) => item.id === "no-front")).toBe(false);
	});
});
