import type { Dirent, Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { errorMessage, mapBounded } from "../util/util";

const DISCOVERY_CONCURRENCY = 8;

const SUPPORTED_AUDIO_EXTENSIONS = new Set([".flac", ".mp3"]);
const SUPPORTED_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_ENTRIES = 10_000;

export type CandidateDiscoveryLimits = Readonly<{
	maxDepth?: number;
	maxEntries?: number;
}>;

export type CandidateDiscoveryIssue = Readonly<{
	path: string;
	message: string;
}>;

export type DiscoveredCandidate = Readonly<{
	root: string;
	audioPaths: readonly string[];
	imagePaths: readonly string[];
}>;

export type CandidateDiscoveryResult = Readonly<{
	candidates: readonly DiscoveredCandidate[];
	issues: readonly CandidateDiscoveryIssue[];
}>;

type DiscoveryBudget = {
	entries: number;
	limitReported: boolean;
};

function comparePaths(first: string, second: string): number {
	if (first < second) {
		return -1;
	}

	if (first > second) {
		return 1;
	}

	return 0;
}

function isSupportedAudioFile(path: string): boolean {
	return SUPPORTED_AUDIO_EXTENSIONS.has(extname(path).toLowerCase());
}

function isSupportedImageFile(path: string): boolean {
	return SUPPORTED_IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

function resolveLimit(value: number | undefined, fallback: number): number {
	const limit = value ?? fallback;

	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw new RangeError("Discovery limits must be positive safe integers");
	}

	return limit;
}

function resolveLimits(
	limits: CandidateDiscoveryLimits,
): Required<CandidateDiscoveryLimits> {
	return {
		maxDepth: resolveLimit(limits.maxDepth, DEFAULT_MAX_DEPTH),
		maxEntries: resolveLimit(limits.maxEntries, DEFAULT_MAX_ENTRIES),
	};
}

async function discoverSourcePaths(
	directory: string,
	depth: number,
	limits: Required<CandidateDiscoveryLimits>,
	budget: DiscoveryBudget,
	issues: CandidateDiscoveryIssue[],
): Promise<Readonly<{ audioPaths: string[]; imagePaths: string[] }>> {
	let entries: Dirent[];

	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		issues.push({ path: directory, message: errorMessage(error) });

		return { audioPaths: [], imagePaths: [] };
	}

	const audioPaths: string[] = [];
	const imagePaths: string[] = [];

	const sortedEntries = entries.sort((lhs, rhs) =>
		comparePaths(lhs.name, rhs.name),
	);

	for (const entry of sortedEntries) {
		if (budget.entries >= limits.maxEntries) {
			if (!budget.limitReported) {
				issues.push({
					path: directory,
					message: `Discovery entry limit (${limits.maxEntries}) reached; remaining paths were not scanned`,
				});

				budget.limitReported = true;
			}

			break;
		}

		budget.entries += 1;

		const path = join(directory, entry.name);
		let kind: "directory" | "file" | undefined;
		if (entry.isSymbolicLink()) {
			continue;
		}

		if (entry.isDirectory()) {
			kind = "directory";
		} else if (entry.isFile()) {
			kind = "file";
		} else {
			let status: Stats;

			try {
				status = await lstat(path);
			} catch (error) {
				issues.push({ path, message: errorMessage(error) });
				continue;
			}

			if (status.isSymbolicLink()) {
				continue;
			}

			if (status.isDirectory()) {
				kind = "directory";
			} else if (status.isFile()) {
				kind = "file";
			}
		}

		if (kind === "directory") {
			if (depth + 1 >= limits.maxDepth) {
				issues.push({
					path,
					message: `Discovery depth limit (${limits.maxDepth}) reached; not scanning`,
				});
				continue;
			}

			const nested = await discoverSourcePaths(
				path,
				depth + 1,
				limits,
				budget,
				issues,
			);

			audioPaths.push(...nested.audioPaths);
			imagePaths.push(...nested.imagePaths);
		} else if (kind === "file") {
			if (isSupportedAudioFile(path)) {
				audioPaths.push(path);
			} else if (isSupportedImageFile(path)) {
				imagePaths.push(path);
			}
		}
	}

	return { audioPaths, imagePaths };
}

/** Discovers one known immediate source container without reading siblings. */
export async function discoverCandidate(
	root: string,
	limits: CandidateDiscoveryLimits = {},
): Promise<{
	candidate?: DiscoveredCandidate;
	issues: CandidateDiscoveryIssue[];
}> {
	const resolvedLimits = resolveLimits(limits);

	const issues: CandidateDiscoveryIssue[] = [];
	let status: Stats;

	try {
		status = await lstat(root);
	} catch (error) {
		return { issues: [{ path: root, message: errorMessage(error) }] };
	}

	if (status.isSymbolicLink() || !status.isDirectory()) {
		return {
			issues: [
				{
					path: root,
					message: "Source candidate root is not a real directory",
				},
			],
		};
	}

	const paths = await discoverSourcePaths(
		root,
		0,
		resolvedLimits,
		{ entries: 0, limitReported: false },
		issues,
	);

	return paths.audioPaths.length === 0
		? { issues }
		: {
				candidate: {
					root,
					audioPaths: paths.audioPaths.sort(comparePaths),
					imagePaths: paths.imagePaths.sort(comparePaths),
				},
				issues,
			};
}

/**
 * Discovers immediate watch-root children that contain supported source audio.
 * The source tree is only read and symbolic links are never traversed.
 */
export async function discoverCandidates(
	watchRoot: string,
	limits: CandidateDiscoveryLimits = {},
): Promise<CandidateDiscoveryResult> {
	const resolvedLimits = resolveLimits(limits);

	const entries = await readdir(watchRoot, { withFileTypes: true });

	const roots = entries
		.toSorted((first, second) => comparePaths(first.name, second.name))
		.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
		.map((entry) => join(watchRoot, entry.name));

	const results = await mapBounded(
		roots,
		(root) => discoverCandidate(root, resolvedLimits),
		DISCOVERY_CONCURRENCY,
	);

	const candidates: DiscoveredCandidate[] = [];
	const issues: CandidateDiscoveryIssue[] = [];
	for (const result of results) {
		issues.push(...result.issues);

		if (result.candidate !== undefined) {
			candidates.push(result.candidate);
		}
	}

	return { candidates, issues };
}
