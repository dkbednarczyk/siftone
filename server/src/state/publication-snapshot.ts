import { createHash } from "node:crypto";
import { lstat, readdir, readlink } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import {
	canonicalAbsolutePath,
	canonicalRelativePath,
	isPathBelowRoot,
	isPathWithinRoot,
} from "../path-utils";
import type { PublicationInput } from "../publication/publish";
import { mapBounded } from "../util/util";
import { entryPath } from "./entry-path";
import type { Desired, Entry } from "./reconcile/types";

const SOURCE_STAT_CONCURRENCY = 8;

function kindFor(path: string): "audio" | "artwork" {
	return [".flac", ".mp3"].includes(extname(path).toLowerCase())
		? "audio"
		: "artwork";
}

export function manifestHash(entries: readonly Entry[]): string {
	return createHash("sha256")
		.update(
			JSON.stringify(
				entries
					.toSorted((first, second) =>
						first.destinationName.localeCompare(
							second.destinationName,
						),
					)
					.map((entry) =>
						entry.origin === "source"
							? [
									entry.origin,
									entry.relativeSourcePath,
									entry.destinationName,
									entry.size.toString(),
									entry.mtimeNs.toString(),
									entry.kind,
								]
							: [
									entry.origin,
									entry.cacheSha256,
									entry.cacheRelativePath,
									entry.destinationName,
									entry.kind,
								],
					),
			),
		)
		.digest("hex");
}

export async function desiredFor(
	watchRoot: string,
	generatedLibraryRoot: string,
	input: PublicationInput,
): Promise<Desired> {
	const destination = canonicalAbsolutePath(
		dirname(input.entries[0]?.destinationPath ?? ""),
	);

	const containerPath = canonicalAbsolutePath(input.root);

	if (!isPathBelowRoot(generatedLibraryRoot, destination)) {
		throw new Error(
			`Generated destination escapes its root: ${destination}`,
		);
	}

	if (!isPathBelowRoot(watchRoot, containerPath)) {
		throw new Error(
			`Source container escapes its watch root: ${input.root}`,
		);
	}

	const entries: Entry[] = await mapBounded(
		input.entries,
		async (entry) => {
			const sourcePath = canonicalAbsolutePath(entry.sourcePath);
			if (!isPathWithinRoot(containerPath, sourcePath)) {
				throw new Error(
					`Source file escapes its container: ${entry.sourcePath}`,
				);
			}

			const relativeSourcePath = canonicalRelativePath(
				relative(containerPath, sourcePath).replaceAll("\\", "/"),
			);

			const destinationName = basename(entry.destinationPath);
			if (
				destinationName.includes("/") ||
				destinationName.includes("\\") ||
				dirname(entry.destinationPath) !== destination
			) {
				throw new Error(
					`Unsafe publication entry: ${entry.sourcePath}`,
				);
			}

			const status = await lstat(entry.sourcePath, { bigint: true });

			if (!status.isFile() || status.isSymbolicLink()) {
				throw new Error(
					`Source is not a real file: ${entry.sourcePath}`,
				);
			}

			return {
				origin: "source",
				sourcePath,
				relativeSourcePath,
				destinationName,
				size: status.size,
				mtimeNs: status.mtimeNs,
				kind: kindFor(entry.sourcePath),
			};
		},
		SOURCE_STAT_CONCURRENCY,
	);

	if (input.automaticArtwork?.status === "selected") {
		const cacheObject = input.automaticArtwork.cacheObject;
		if (cacheObject === undefined) {
			throw new Error(
				"Selected automatic artwork is missing its cache object",
			);
		}

		entries.push({
			origin: "cache",
			cacheSha256: cacheObject.sha256,
			cacheRelativePath: cacheObject.relativePath,
			destinationName: "cover.jpg",
			kind: "artwork",
		});
	}

	entries.sort((a, b) => a.destinationName.localeCompare(b.destinationName));

	if (
		entries.length === 0 ||
		new Set(entries.map((entry) => entry.destinationName)).size !==
			entries.length
	) {
		throw new Error(`Invalid publication entries for ${input.root}`);
	}

	return {
		input,
		containerPath,
		destination,
		destinationPath: destination,
		entries,
		manifestHash: manifestHash(entries),
	};
}

export async function entriesMatch(
	destination: string,
	entries: readonly Entry[],
	cacheRoot: string,
): Promise<boolean> {
	try {
		const destinationStatus = await lstat(destination);
		if (
			destinationStatus.isSymbolicLink() ||
			!destinationStatus.isDirectory()
		) {
			return false;
		}
	} catch {
		return false;
	}

	const expected = new Map(
		entries.map((entry) => [
			entry.destinationName,
			entryPath(entry, cacheRoot),
		]),
	);

	const output = await readdir(destination, { withFileTypes: true });

	if (output.length !== expected.size) {
		return false;
	}

	for (const entry of output) {
		const target = expected.get(entry.name);

		if (
			!entry.isSymbolicLink() ||
			target === undefined ||
			(await readlink(join(destination, entry.name))) !== target
		) {
			return false;
		}

		try {
			const targetStatus = await lstat(target);
			if (!targetStatus.isFile() || targetStatus.isSymbolicLink()) {
				return false;
			}
		} catch {
			return false;
		}
	}

	return true;
}
