import { describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

	test("changes its manifest when ctime changes without changing media contents", async () => {
		const root = await mkdtemp(join(tmpdir(), "siftone-observer-"));
		try {
			const source = join(root, "Album", "01.flac");
			await mkdir(join(root, "Album"));
			await writeFile(source, "audio");
			const first = await observeSource(root);
			const before = await lstat(source, { bigint: true });

			await chmod(source, 0o600);
			const after = await lstat(source, { bigint: true });
			const second = await observeSource(root);

			expect(after.mtimeNs).toBe(before.mtimeNs);
			expect(after.ctimeNs).not.toBe(before.ctimeNs);
			expect(second.manifestHash).not.toBe(first.manifestHash);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
