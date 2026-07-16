import { expect, test } from "bun:test";
import { createCoverArtArchiveClient } from "./clients";

test("CAA client maps 404 and malformed responses to no covers", async () => {
	const missing = createCoverArtArchiveClient({
		fetchCoverArt: async () => new Response(null, { status: 404 }),
	});
	const malformed = createCoverArtArchiveClient({
		fetchCoverArt: async () => Response.json({ images: "not-an-array" }),
	});

	expect(await missing.getReleaseCovers("release")).toEqual([]);
	expect(await malformed.getReleaseCovers("release")).toEqual([]);
});

test("CAA client preserves transient response status and Retry-After", async () => {
	const client = createCoverArtArchiveClient({
		fetchCoverArt: async () =>
			new Response(null, {
				status: 429,
				headers: { "retry-after": "2" },
			}),
	});

	await expect(client.getReleaseCovers("release")).rejects.toEqual(
		expect.objectContaining({ status: 429, retryAfter: "2" }),
	);
});
