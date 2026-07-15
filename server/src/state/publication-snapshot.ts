import { createHash } from "node:crypto";
import { lstat, readdir, readlink } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import type { PublicationInput } from "../publication/publish";
import { canonicalRelativePath } from "./canonical-path";
import type { Desired, Entry } from "./reconcile-types";

const SOURCE_STAT_CONCURRENCY = 32;

function kindFor(path: string): "audio" | "artwork" {
	return [".flac", ".mp3"].includes(extname(path).toLowerCase())
		? "audio"
		: "artwork";
}

export function manifestHash(entries: readonly Entry[]): string {
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

export async function mapBounded<T, R>(
	values: readonly T[],
	mapper: (value: T) => Promise<R>,
): Promise<R[]> {
	const result = new Array<R>(values.length);
	let cursor = 0;
	const workers: Promise<void>[] = [];
	for (
		let worker = 0;
		worker < Math.min(SOURCE_STAT_CONCURRENCY, values.length);
		worker++
	) {
		workers.push(
			(async (): Promise<void> => {
				while (true) {
					const index = cursor++;
					if (index >= values.length) return;
					result[index] = await mapper(values[index]);
				}
			})(),
		);
	}
	await Promise.all(workers);
	return result;
}

export async function desiredFor(
	watchRoot: string,
	generatedLibraryRoot: string,
	input: PublicationInput,
): Promise<Desired> {
	const destination = dirname(input.entries[0]?.destinationPath ?? "");
	const destinationPath = canonicalRelativePath(
		relative(generatedLibraryRoot, destination).replaceAll("\\", "/"),
	);
	const containerPath = canonicalRelativePath(
		relative(watchRoot, input.root).replaceAll("\\", "/"),
	);
	const entries = await mapBounded(input.entries, async (entry) => {
		const relativeSourcePath = canonicalRelativePath(
			relative(input.root, entry.sourcePath).replaceAll("\\", "/"),
		);
		const sourcePath = canonicalRelativePath(
			relative(watchRoot, entry.sourcePath).replaceAll("\\", "/"),
		);
		const destinationName = basename(entry.destinationPath);
		if (
			destinationName.includes("/") ||
			destinationName.includes("\\") ||
			dirname(entry.destinationPath) !== destination
		)
			throw new Error(`Unsafe publication entry: ${entry.sourcePath}`);
		const status = await lstat(entry.sourcePath, { bigint: true });
		if (!status.isFile() || status.isSymbolicLink())
			throw new Error(`Source is not a real file: ${entry.sourcePath}`);
		return {
			sourcePath,
			relativeSourcePath,
			destinationName,
			size: status.size,
			mtimeNs: status.mtimeNs,
			kind: kindFor(entry.sourcePath),
		};
	});
	entries.sort((a, b) => a.destinationName.localeCompare(b.destinationName));
	if (
		entries.length === 0 ||
		new Set(entries.map((entry) => entry.destinationName)).size !==
			entries.length
	)
		throw new Error(`Invalid publication entries for ${input.root}`);
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
	entries: readonly Entry[],
): Promise<boolean> {
	try {
		const [destinationStatus, artistStatus] = await Promise.all([
			lstat(destination),
			lstat(dirname(destination)),
		]);
		if (
			destinationStatus.isSymbolicLink() ||
			!destinationStatus.isDirectory() ||
			artistStatus.isSymbolicLink() ||
			!artistStatus.isDirectory()
		)
			return false;
	} catch {
		return false;
	}
	const expected = new Map(
		entries.map((entry) => [entry.destinationName, entry.sourcePath]),
	);
	const output = await readdir(destination, { withFileTypes: true });
	if (output.length !== expected.size) return false;
	for (const entry of output) {
		const target = expected.get(entry.name);
		if (
			!entry.isSymbolicLink() ||
			target === undefined ||
			(await readlink(join(destination, entry.name))) !== target
		)
			return false;
	}
	return true;
}
