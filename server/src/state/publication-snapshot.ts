import { createHash } from "node:crypto";
import { lstat, readdir, readlink } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import type { PublicationInput } from "../publication/publish";
import { mapBounded } from "../util/util";
import {
	canonicalAbsolutePath,
	canonicalRelativePath,
	isPathBelowRoot,
	isPathWithinRoot,
} from "./canonical-path";
import type { Desired, SourceEntry } from "./reconcile/types";

const SOURCE_STAT_CONCURRENCY = 8;

function kindFor(path: string): "audio" | "artwork" {
	return [".flac", ".mp3"].includes(extname(path).toLowerCase())
		? "audio"
		: "artwork";
}

export function manifestHash(entries: readonly SourceEntry[]): string {
	return createHash("sha256")
		.update(
			JSON.stringify(
				entries.map((entry) => [
					entry.relativeSourcePath,
					entry.destinationName,
					entry.size.toString(),
					entry.mtimeNs.toString(),
					entry.kind,
				]),
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

	const destinationPath = destination;
	const containerPath = canonicalAbsolutePath(input.root);

	if (!isPathBelowRoot(generatedLibraryRoot, destinationPath)) {
		throw new Error(
			`Generated destination escapes its root: ${destination}`,
		);
	}

	if (!isPathBelowRoot(watchRoot, containerPath)) {
		throw new Error(
			`Source container escapes its watch root: ${input.root}`,
		);
	}

	const entries: SourceEntry[] = await mapBounded(
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
		destinationPath,
		entries,
		manifestHash: manifestHash(entries),
	};
}

export async function entriesMatch(
	destination: string,
	entries: readonly SourceEntry[],
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
		entries.map((entry) => [entry.destinationName, entry.sourcePath]),
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
	}

	return true;
}
