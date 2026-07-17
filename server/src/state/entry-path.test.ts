import { describe, expect, test } from "bun:test";
import { entryPath } from "./entry-path";
import { manifestHash } from "./publication-snapshot";

const cacheEntry = {
	origin: "cache" as const,
	cacheSha256: "a".repeat(64),
	cacheRelativePath: "artwork/sha256/aa/object.jpg",
	destinationName: "cover.jpg",
	kind: "artwork" as const,
};

describe("entryPath", () => {
	test("resolves cache objects strictly below cacheRoot", () => {
		expect(entryPath(cacheEntry, "/cache")).toBe(
			"/cache/artwork/sha256/aa/object.jpg",
		);
	});

	test("rejects cache paths that are absolute or traverse", () => {
		for (const cacheRelativePath of [
			"/outside/object.jpg",
			"../object.jpg",
		]) {
			expect(() =>
				entryPath({ ...cacheEntry, cacheRelativePath }, "/cache"),
			).toThrow();
		}
	});

	test("normalizes source and cache entry order in manifest hashes", () => {
		const sourceEntry = {
			origin: "source" as const,
			sourcePath: "/source/01.flac",
			relativeSourcePath: "01.flac",
			destinationName: "01.flac",
			size: 1n,
			mtimeNs: 1n,
			kind: "audio" as const,
		};
		const artworkEntry = {
			...cacheEntry,
			destinationName: "00 cover.jpg",
		};

		expect(manifestHash([sourceEntry, artworkEntry])).toBe(
			manifestHash([artworkEntry, sourceEntry]),
		);
	});
});
