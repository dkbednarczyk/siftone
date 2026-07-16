import { describe, expect, test } from "bun:test";
import { operationPaths } from "./operation-paths";

describe("operation paths", () => {
	test("accepts strictly nested absolute destination and staging paths", () => {
		expect(
			operationPaths(
				"/generated",
				"/staging",
				"/staging/operation-1",
				"/generated/Artist/Album",
				"operation-1",
			),
		).toEqual({
			destination: "/generated/Artist/Album",
			staging: "/staging/operation-1",
			tombstone: "/generated/Artist/.siftone-tombstone-operation-1",
		});
	});

	test("rejects root-equal and escaping operation paths", () => {
		for (const [stagingPath, destinationPath] of [
			["/staging", "/generated/Artist/Album"],
			["/staging/operation-1", "/generated"],
			["/elsewhere/operation-1", "/generated/Artist/Album"],
			["/staging/operation-1", "/elsewhere/Album"],
			["/staging/../outside", "/generated/Artist/Album"],
			["/staging/operation-1", "/generated/../outside"],
		] as const) {
			expect(() =>
				operationPaths(
					"/generated",
					"/staging",
					stagingPath,
					destinationPath,
					"operation-1",
				),
			).toThrow();
		}
	});
});
