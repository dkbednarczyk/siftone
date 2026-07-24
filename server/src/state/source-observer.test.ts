import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeSource } from "./source-observer";

describe("source observer", () => {
	test("changes its manifest when nested supported media changes", async () => {
		const root = await mkdtemp(join(tmpdir(), "siftone-observer-"));
		try {
			const nested = join(root, "Album", "Disc 1");
			await mkdir(nested, { recursive: true });
			await writeFile(join(nested, "01.flac"), "first");
			const first = await observeSource(root);
			await writeFile(join(nested, "01.flac"), "replacement audio");
			const second = await observeSource(root);

			expect(first.complete).toBe(true);
			expect(second.complete).toBe(true);
			expect(second.manifestHash).not.toBe(first.manifestHash);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("changes its aggregate manifest when a source container is removed", async () => {
		const root = await mkdtemp(join(tmpdir(), "siftone-observer-"));
		try {
			const album = join(root, "Album");
			await mkdir(album);
			await writeFile(join(album, "01.flac"), "audio");
			const first = await observeSource(root);
			await rm(album, { force: true, recursive: true });
			const second = await observeSource(root);

			expect(first.manifestHash).not.toBe(second.manifestHash);
			expect(second.discovery.candidates).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
