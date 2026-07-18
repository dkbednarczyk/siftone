import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	canonicalAbsolutePath,
	canonicalRelativePath,
	createAndResolveDirectory,
	isCanonicalAbsolutePath,
	isCanonicalRelativePath,
	isDescendant,
	isPathBelowRoot,
	isPathWithinRoot,
	isRealDirectory,
	isSameOrDescendant,
	resolveExistingDirectory,
	validateAbsolutePath,
} from "./path";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "siftone-path-utils-"));
	temporaryDirectories.push(directory);

	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) =>
				rm(directory, { force: true, recursive: true }),
			),
	);
});

describe("path containment", () => {
	test("distinguishes descendants from sibling prefixes", () => {
		expect(isSameOrDescendant("/music", "/music")).toBe(true);
		expect(isSameOrDescendant("/music", "/music/")).toBe(true);
		expect(isSameOrDescendant("/music", "/music/library")).toBe(true);
		expect(isSameOrDescendant("/music", "/music2")).toBe(false);
		expect(isDescendant("/music", "/music")).toBe(false);
		expect(isDescendant("/music", "/music/library")).toBe(true);
	});

	test("validates canonical paths before comparing persisted roots", () => {
		expect(isPathWithinRoot("/", "/")).toBe(true);
		expect(isPathBelowRoot("/", "/")).toBe(false);
		expect(isPathWithinRoot("/", "/music/album")).toBe(true);
		expect(isPathBelowRoot("/music", "/music/album")).toBe(true);
		expect(isPathBelowRoot("/music", "/music")).toBe(false);
		expect(() => isPathWithinRoot("/music", "/music/../other")).toThrow();
	});
});

describe("canonical path validation", () => {
	test("accepts only canonical POSIX paths", () => {
		for (const path of [
			"/x",
			"./x",
			"x/",
			"a//b",
			"a/./b",
			"a/../b",
			"a\\b",
			".",
			"",
		]) {
			expect(() => canonicalRelativePath(path)).toThrow();
		}

		expect(canonicalRelativePath("Album/01.flac")).toBe("Album/01.flac");

		for (const path of [
			"",
			"relative",
			"/trailing/",
			"/double//slash",
			"/dot/./segment",
			"/parent/../segment",
			"/back\\slash",
		]) {
			expect(() => canonicalAbsolutePath(path)).toThrow();
		}

		expect(canonicalAbsolutePath("/watch/Album/01.flac")).toBe(
			"/watch/Album/01.flac",
		);
		expect(isCanonicalRelativePath("Album/01.flac")).toBe(true);
		expect(isCanonicalAbsolutePath("/watch/Album/01.flac")).toBe(true);
		expect(isCanonicalRelativePath("Album/../01.flac")).toBe(false);
		expect(isCanonicalAbsolutePath("/watch//Album")).toBe(false);
	});

	test("normalizes absolute configured paths", () => {
		expect(validateAbsolutePath("/library/../music", "Path")).toBe(
			"/music",
		);
		expect(() => validateAbsolutePath("relative", "Path")).toThrow(
			"Path must be an absolute path",
		);
	});
});

describe("directory resolution", () => {
	test("canonicalizes directories through symlinked ancestors", async () => {
		const directory = await temporaryDirectory();
		const target = join(directory, "target");
		const alias = join(directory, "alias");
		const expected = join(target, "managed");

		await createAndResolveDirectory(target, "Target");
		await symlink(target, alias);

		expect(
			await createAndResolveDirectory(join(alias, "managed"), "Managed"),
		).toBe(await realpath(expected));
		expect(
			await resolveExistingDirectory(join(alias, "managed"), "Managed"),
		).toBe(await realpath(expected));
	});

	test("rejects files where a directory is required", async () => {
		const directory = await temporaryDirectory();
		const file = join(directory, "file");

		await writeFile(file, "not a directory");

		await expect(resolveExistingDirectory(file, "Managed")).rejects.toThrow(
			"Managed must be a directory",
		);
		await expect(
			createAndResolveDirectory(file, "Managed"),
		).rejects.toThrow();
		expect(await isRealDirectory(file)).toBe(false);
	});
});
