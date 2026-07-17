import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { mapBounded } from "../util/util";

const MAX_DEPTH = 8;
const MAX_ENTRIES = 10_000;
const OBSERVATION_CONCURRENCY = 8;
const MEDIA_EXTENSIONS = new Set([".flac", ".mp3", ".jpg", ".jpeg", ".png"]);

export type ContainerObservation = Readonly<{
	containerPath: string;
	outcome: "present" | "inaccessible" | "unsupported";
	manifestHash?: string;
	warning?: string;
}>;

export type SourceObservation = Readonly<{
	containers: readonly ContainerObservation[];
	complete: boolean;
	manifestHash: string;
	issues: readonly string[];
}>;

function supported(path: string): boolean {
	return MEDIA_EXTENSIONS.has(extname(path).toLowerCase());
}

async function observeContainer(
	containerPath: string,
): Promise<ContainerObservation> {
	const hash = createHash("sha256");
	let entries = 0;
	let unsupported: string | undefined;

	async function visit(directory: string, depth: number): Promise<void> {
		let children: Dirent[];
		try {
			children = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			throw new Error(
				error instanceof Error ? error.message : String(error),
			);
		}

		for (const child of children.toSorted((left, right) =>
			left.name.localeCompare(right.name),
		)) {
			entries += 1;
			if (entries > MAX_ENTRIES) {
				unsupported = `Discovery entry limit (${MAX_ENTRIES}) reached`;
				return;
			}

			const path = join(directory, child.name);
			if (child.isSymbolicLink()) {
				continue;
			}

			if (child.isDirectory()) {
				hash.update(`directory\0${relative(containerPath, path)}\0`);
				if (depth + 1 >= MAX_DEPTH) {
					unsupported = `Discovery depth limit (${MAX_DEPTH}) reached`;
					return;
				}
				await visit(path, depth + 1);
				if (unsupported !== undefined) {
					return;
				}
				continue;
			}

			if (!child.isFile() && !(await lstat(path)).isFile()) {
				continue;
			}

			if (supported(path)) {
				const metadata = await lstat(path, { bigint: true });
				hash.update(
					`${relative(containerPath, path)}\0${metadata.size}\0${metadata.mtimeNs}\0`,
				);
			}
		}
	}

	try {
		await visit(containerPath, 0);
	} catch (error) {
		return {
			containerPath,
			outcome: "inaccessible",
			warning: error instanceof Error ? error.message : String(error),
		};
	}

	if (unsupported !== undefined) {
		return { containerPath, outcome: "unsupported", warning: unsupported };
	}

	return {
		containerPath,
		outcome: "present",
		manifestHash: hash.digest("hex"),
	};
}

/** Observes every immediate real candidate without installing filesystem watches. */
export async function observeSource(
	watchRoot: string,
): Promise<SourceObservation> {
	const entries = await readdir(watchRoot, { withFileTypes: true });
	const paths = entries
		.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
		.toSorted((left, right) => left.name.localeCompare(right.name))
		.map((entry) => join(watchRoot, entry.name));

	const containers = await mapBounded(
		paths,
		observeContainer,
		OBSERVATION_CONCURRENCY,
	);
	const issues = containers
		.filter((container) => container.outcome !== "present")
		.map(
			(container) =>
				`${container.containerPath}: ${container.warning ?? container.outcome}`,
		);
	const hash = createHash("sha256");
	for (const container of containers) {
		hash.update(
			`${container.containerPath}\0${container.outcome}\0${container.manifestHash ?? ""}\0`,
		);
	}

	return {
		containers,
		complete: issues.length === 0,
		manifestHash: hash.digest("hex"),
		issues,
	};
}
