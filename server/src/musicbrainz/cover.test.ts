import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import type { IImage } from "musicbrainz-api";
import {
	type DownloadedCover,
	downloadFrontCovers,
	downloadReleaseFrontCovers,
	frontCoverRequests,
	MAX_COVER_BYTES,
	selectBestCover,
} from "./cover";

const JPEG_BYTES = new Uint8Array(
	Buffer.from(
		"/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/Aaf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/Aaf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Ap//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IX//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z",
		"base64",
	),
);

function jpegBytes(width = 1, height = 1): Uint8Array {
	const bytes = new Uint8Array(JPEG_BYTES);

	for (let index = 0; index < bytes.length - 8; index += 1) {
		if (bytes[index] === 0xff && bytes[index + 1] === 0xc0) {
			bytes[index + 5] = height >> 8;
			bytes[index + 6] = height & 0xff;
			bytes[index + 7] = width >> 8;
			bytes[index + 8] = width & 0xff;

			return bytes;
		}
	}

	throw new Error("JPEG test fixture has no baseline frame marker");
}

function jpegResponse(width = 500, height = 500): Response {
	const bytes = new Uint8Array(jpegBytes(width, height));

	return new Response(bytes.buffer, {
		headers: { "content-type": "image/jpeg" },
	});
}

function image(
	id: string,
	types: IImage["types"],
	thumbnails: Partial<IImage["thumbnails"]>,
): IImage {
	return {
		id,
		types,
		front: types.includes("Front"),
		back: types.includes("Back"),
		edit: 1,
		image: `https://coverartarchive.org/release/test/${id}.jpg`,
		comment: "",
		approved: true,
		thumbnails: {
			large: "",
			small: "",
			"250": "",
			...thumbnails,
		},
	};
}

function cover(
	width: number,
	height: number,
	byteLength = 1_000,
): DownloadedCover {
	return {
		releaseId: "release-id",
		imageId: `${width}x${height}`,
		url: "https://coverartarchive.org/release/test/cover-1200.jpg",
		bytes: new Uint8Array(byteLength),
		width,
		height,
	};
}

describe("MusicBrainz cover-art prototype", () => {
	test("only downloads front-type artwork", async () => {
		const requestedUrls: string[] = [];
		const images = [
			image("front", ["Front"], {
				"1200": "http://coverartarchive.org/front-1200.jpg",
			}),
			image("back", ["Back"], {
				"1200": "http://coverartarchive.org/back-1200.jpg",
			}),
			{
				...image("unapproved", ["Front"], {
					"1200": "http://coverartarchive.org/unapproved-1200.jpg",
				}),
				approved: false,
			},
		];

		await downloadFrontCovers("release-id", images, async (url) => {
			requestedUrls.push(url);
			return new Response(new Uint8Array([0]), {
				headers: { "content-type": "image/jpeg" },
			});
		});

		expect(requestedUrls).toEqual([
			"https://coverartarchive.org/front-1200.jpg",
		]);
	});

	test("uses the largest available thumbnail before downloading", () => {
		expect(
			frontCoverRequests("release-id", [
				image("large", ["Front"], {
					"1200": "http://coverartarchive.org/large-1200.jpg",
					"500": "http://coverartarchive.org/large-500.jpg",
				}),
				image("medium", ["Front"], {
					"500": "http://coverartarchive.org/medium-500.jpg",
				}),
				image("small", ["Front"], {
					"250": "http://coverartarchive.org/small-250.jpg",
				}),
			]),
		).toEqual([
			{
				releaseId: "release-id",
				imageId: "large",
				urls: [
					"https://coverartarchive.org/large-1200.jpg",
					"https://coverartarchive.org/large-500.jpg",
				],
			},
			{
				releaseId: "release-id",
				imageId: "medium",
				urls: ["https://coverartarchive.org/medium-500.jpg"],
			},
		]);
	});

	test("falls back from an unavailable 1200-pixel thumbnail", async () => {
		const requestedUrls: string[] = [];
		const covers = await downloadFrontCovers(
			"release-id",
			[
				image("front", ["Front"], {
					"1200": "https://coverartarchive.org/front-1200.jpg",
					"500": "https://coverartarchive.org/front-500.jpg",
				}),
			],
			async (url) => {
				requestedUrls.push(url);
				return url.endsWith("-1200.jpg")
					? new Response(null, { status: 404 })
					: jpegResponse();
			},
		);

		expect(requestedUrls).toEqual([
			"https://coverartarchive.org/front-1200.jpg",
			"https://coverartarchive.org/front-500.jpg",
		]);
		expect(covers.covers[0]?.url).toBe(
			"https://coverartarchive.org/front-500.jpg",
		);
	});

	test("falls back when a larger thumbnail exceeds the byte limit", async () => {
		const requestedUrls: string[] = [];
		const covers = await downloadFrontCovers(
			"release-id",
			[
				image("front", ["Front"], {
					"1200": "https://coverartarchive.org/front-1200.jpg",
					"500": "https://coverartarchive.org/front-500.jpg",
				}),
			],
			async (url) => {
				requestedUrls.push(url);
				return url.endsWith("-1200.jpg")
					? new Response(JPEG_BYTES, {
							headers: {
								"content-length": String(MAX_COVER_BYTES + 1),
								"content-type": "image/jpeg",
							},
						})
					: jpegResponse();
			},
		);

		expect(requestedUrls).toEqual([
			"https://coverartarchive.org/front-1200.jpg",
			"https://coverartarchive.org/front-500.jpg",
		]);
		expect(covers.covers[0]?.url).toBe(
			"https://coverartarchive.org/front-500.jpg",
		);
	});

	test("rejects a cover below either minimum dimension", async () => {
		const covers = await downloadFrontCovers(
			"release-id",
			[
				image("front", ["Front"], {
					"1200": "https://coverartarchive.org/front-1200.jpg",
					"500": "https://coverartarchive.org/front-500.jpg",
				}),
			],
			async (url) =>
				url.endsWith("-1200.jpg")
					? jpegResponse(499, 500)
					: jpegResponse(500, 499),
		);

		expect(covers).toEqual({ covers: [], transientFailure: false });
	});

	test("prefers similarly sized square artwork", () => {
		const square = cover(1_000, 1_000);
		const rectangular = cover(1_200, 900);

		expect(selectBestCover([rectangular, square])).toBe(square);
	});

	test("does not prefer a much smaller square cover", () => {
		const square = cover(400, 400);
		const rectangular = cover(1_200, 1_000);

		expect(selectBestCover([square, rectangular])).toBe(rectangular);
	});

	test("compares front artwork across release editions", () => {
		const firstEdition = {
			...cover(1_200, 900),
			releaseId: "first-release",
		};
		const secondEdition = {
			...cover(1_000, 1_000),
			releaseId: "second-release",
		};

		expect(selectBestCover([firstEdition, secondEdition])).toBe(
			secondEdition,
		);
	});

	test("compares only front artwork across release cover responses", async () => {
		const requestedUrls: string[] = [];
		const covers = await downloadReleaseFrontCovers(
			[
				{
					releaseId: "first-release",
					images: [
						image("back", ["Back"], {
							"1200": "https://coverartarchive.org/back-1200.jpg",
						}),
						image("front", ["Front"], {
							"1200": "https://coverartarchive.org/first-front-1200.jpg",
						}),
					],
				},
				{
					releaseId: "second-release",
					images: [
						image("front", ["Front"], {
							"1200": "https://coverartarchive.org/second-front-1200.jpg",
						}),
					],
				},
			],
			async (url) => {
				requestedUrls.push(url);
				return url.includes("first-front")
					? jpegResponse(1_200, 900)
					: jpegResponse(1_000, 1_000);
			},
		);

		expect(requestedUrls).toEqual([
			"https://coverartarchive.org/first-front-1200.jpg",
			"https://coverartarchive.org/second-front-1200.jpg",
		]);
		expect(selectBestCover(covers.covers)?.releaseId).toBe(
			"second-release",
		);
	});

	test("reports transient image failures while continuing other artwork", async () => {
		const result = await downloadFrontCovers(
			"release-id",
			[
				image("unavailable", ["Front"], {
					"1200": "https://coverartarchive.org/unavailable-1200.jpg",
				}),
				image("available", ["Front"], {
					"1200": "https://coverartarchive.org/available-1200.jpg",
				}),
			],
			async (url) =>
				url.includes("unavailable")
					? new Response(null, { status: 503 })
					: jpegResponse(),
		);

		expect(result.transientFailure).toBe(true);
		expect(result.covers).toHaveLength(1);
	});

	test("rejects a streaming image that exceeds the byte limit", async () => {
		const result = await downloadFrontCovers(
			"release-id",
			[
				image("large", ["Front"], {
					"1200": "https://coverartarchive.org/large-1200.jpg",
				}),
			],
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(
								new Uint8Array(MAX_COVER_BYTES + 1),
							);
							controller.close();
						},
					}),
					{ headers: { "content-type": "image/jpeg" } },
				),
		);

		expect(result).toEqual({ covers: [], transientFailure: false });
	});
});
