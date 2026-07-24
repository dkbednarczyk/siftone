import { createHash } from "node:crypto";
import { lstat, readdir, readlink } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import type { PublicationInput } from "../publication/plan";
import {
	canonicalAbsolutePath,
	canonicalRelativePath,
	isPathBelowRoot,
	isPathWithinRoot,
} from "../util/path";
import type { Desired, Entry } from "./reconcile/types";

function audioOrArtwork(path: string): "audio" | "artwork" {
	return [".flac", ".mp3"].includes(extname(path).toLowerCase())
		? "audio"
		: "artwork";
}

function manifestEntry(entry: Entry): readonly string[] {
	return [
		entry.origin,
		entry.relativeSourcePath,
		entry.destinationName,
		entry.size.toString(),
		entry.mtimeNs.toString(),
		entry.ctimeNs.toString(),
		entry.kind,
	];
}

export function manifestHash(entries: readonly Entry[]): string {
	const manifest = entries
		.toSorted((lhs, rhs) =>
			lhs.destinationName.localeCompare(rhs.destinationName),
		)
		.map(manifestEntry);

	return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
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

	const entries: Entry[] = [];

	for (const entry of input.entries) {
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
			throw new Error(`Unsafe publication entry: ${entry.sourcePath}`);
		}

		const status = await lstat(entry.sourcePath, { bigint: true });

		if (!status.isFile() || status.isSymbolicLink()) {
			throw new Error(`Source is not a real file: ${entry.sourcePath}`);
		}

		entries.push({
			origin: "source",
			sourcePath,
			relativeSourcePath,
			destinationName,
			size: status.size,
			mtimeNs: status.mtimeNs,
			ctimeNs: status.ctimeNs,
			kind: audioOrArtwork(entry.sourcePath),
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
