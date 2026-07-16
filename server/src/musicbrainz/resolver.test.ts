import { describe, expect, test } from "bun:test";
import type { CoverArtArchiveClient, MusicBrainzClient } from "./clients";
import { resolveArtwork } from "./resolver";
import { createSerializedScheduler } from "./scheduler";

const scheduler = createSerializedScheduler();

function clients(): Readonly<{
	musicBrainz: MusicBrainzClient;
	coverArtArchive: CoverArtArchiveClient;
	calls: string[];
}> {
	const calls: string[] = [];

	return {
		calls,
		musicBrainz: {
			async searchReleaseGroups() {
				calls.push("search");
				return [
					{
						id: "group",
						title: "Album",
						artistCredit: [{ artistName: "Artist" }],
						score: 100,
					},
				];
			},
			async browseReleaseEditions() {
				calls.push("browse");
				return [];
			},
		},
		coverArtArchive: {
			async getReleaseCovers() {
				calls.push("caa");
				return [];
			},
		},
	};
}

describe("automatic artwork resolver", () => {
	test("does not make requests while disabled", async () => {
		const fixture = clients();
		const result = await resolveArtwork({
			artist: "Artist",
			album: "Album",
			enabled: false,
			...fixture,
			musicBrainzScheduler: scheduler,
			coverArtScheduler: scheduler,
		});

		expect(result).toEqual({ status: "disabled" });
		expect(fixture.calls).toEqual([]);
	});

	test("caps CAA metadata requests at five eligible editions", async () => {
		let caaCalls = 0;
		const result = await resolveArtwork({
			artist: "Artist",
			album: "Album",
			enabled: true,
			musicBrainz: {
				async searchReleaseGroups() {
					return [
						{
							id: "group",
							title: "Album",
							artistCredit: [{ artistName: "Artist" }],
							score: 100,
						},
					];
				},
				async browseReleaseEditions() {
					return Array.from({ length: 6 }, (_, index) => ({
						id: `release-${index}`,
						status: "Official",
						date: "2000-01-01",
						hasFrontCoverArt: true,
					}));
				},
			},
			coverArtArchive: {
				async getReleaseCovers() {
					caaCalls += 1;
					return [];
				},
			},
			musicBrainzScheduler: scheduler,
			coverArtScheduler: scheduler,
		});

		expect(result).toEqual({ status: "edition_cap_reached" });
		expect(caaCalls).toBe(5);
	});

	test("reports no eligible edition without calling CAA", async () => {
		const fixture = clients();
		const result = await resolveArtwork({
			artist: "Artist",
			album: "Album",
			enabled: true,
			...fixture,
			musicBrainzScheduler: scheduler,
			coverArtScheduler: scheduler,
		});

		expect(result).toEqual({ status: "no_eligible_edition" });
		expect(fixture.calls).toEqual(["search", "browse"]);
	});
});
