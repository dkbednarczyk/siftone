import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import type { IImage } from "musicbrainz-api";
import type { CoverArtArchiveClient, MusicBrainzClient } from "./clients";
import { resolveArtwork } from "./resolver";
import { createSerializedScheduler } from "./scheduler";

const JPEG_BYTES = new Uint8Array(
	Buffer.from(
		"/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/Aaf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Ap//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IX//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z",
		"base64",
	),
);

function jpegResponse(): Response {
	const bytes = new Uint8Array(JPEG_BYTES);
	for (let index = 0; index < bytes.length - 8; index += 1) {
		if (bytes[index] === 0xff && bytes[index + 1] === 0xc0) {
			bytes[index + 5] = 1;
			bytes[index + 6] = 244;
			bytes[index + 7] = 1;
			bytes[index + 8] = 244;
			break;
		}
	}
	return new Response(bytes, { headers: { "content-type": "image/jpeg" } });
}

function scheduler() {
	return createSerializedScheduler();
}

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
			musicBrainzScheduler: scheduler(),
			coverArtScheduler: scheduler(),
		});

		expect(result).toEqual({ status: "disabled" });
		expect(fixture.calls).toEqual([]);
	});

	test("reports no match without browsing editions", async () => {
		const calls: string[] = [];
		const result = await resolveArtwork({
			artist: "Artist",
			album: "Album",
			enabled: true,
			musicBrainz: {
				async searchReleaseGroups() {
					calls.push("search");
					return [];
				},
				async browseReleaseEditions() {
					calls.push("browse");
					return [];
				},
			},
			coverArtArchive: {
				async getReleaseCovers() {
					return [];
				},
			},
			musicBrainzScheduler: scheduler(),
			coverArtScheduler: scheduler(),
		});
		expect(result).toEqual({ status: "no_match" });
		expect(calls).toEqual(["search"]);
	});

	test("selects artwork through the complete escaped-query workflow", async () => {
		let query = "";
		const offsets: number[] = [];
		const image = {
			id: "front",
			approved: true,
			types: ["Front"],
			thumbnails: { "1200": "https://coverartarchive.org/front.jpg" },
		} as IImage;
		const result = await resolveArtwork({
			artist: 'Artist "One"',
			album: "Album: One",
			enabled: true,
			musicBrainz: {
				async searchReleaseGroups(value) {
					query = value;
					return [
						{
							id: "group",
							title: "Album: One",
							artistCredit: [{ artistName: 'Artist "One"' }],
							score: 100,
						},
					];
				},
				async browseReleaseEditions(_group, offset) {
					offsets.push(offset);
					if (offset === 0) {
						return Array.from({ length: 25 }, (_, index) => ({
							id: `ineligible-${index}`,
							status: "Official",
							date: "2000-01-01",
							hasFrontCoverArt: false,
						}));
					}

					return [
						{
							id: "release",
							status: "Official",
							date: "2000-01-01",
							hasFrontCoverArt: true,
						},
					];
				},
			},
			coverArtArchive: {
				async getReleaseCovers() {
					return [image];
				},
			},
			musicBrainzScheduler: scheduler(),
			coverArtScheduler: scheduler(),
			fetchCover: async () => jpegResponse(),
		});
		expect(offsets).toEqual([0, 25]);
		expect(query).toContain('Artist \\"One\\"');
		expect(query).toContain("Album\\: One");
		expect(result).toMatchObject({
			status: "selected",
			releaseGroupId: "group",
			releaseId: "release",
			width: 500,
			height: 500,
		});
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
			musicBrainzScheduler: scheduler(),
			coverArtScheduler: scheduler(),
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
			musicBrainzScheduler: scheduler(),
			coverArtScheduler: scheduler(),
		});

		expect(result).toEqual({ status: "no_eligible_edition" });
		expect(fixture.calls).toEqual(["search", "browse"]);
	});
});
