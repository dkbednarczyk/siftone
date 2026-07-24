import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join, relative } from "node:path";
import {
	type CandidateDiscoveryResult,
	discoverCandidates,
} from "../candidates/discover";

export type SourceObservation = Readonly<{
	discovery: CandidateDiscoveryResult;
	complete: boolean;
	manifestHash: string;
	issues: readonly string[];
	incompleteSourceContainers: readonly string[];
}>;

function sourceContainerForIssue(
	watchRoot: string,
	path: string,
): string | undefined {
	const [container] = relative(watchRoot, path).split("/");

	return container === undefined || container === "" || container === ".."
		? undefined
		: join(watchRoot, container);
}

async function hashDiscovery(
	discovery: CandidateDiscoveryResult,
): Promise<string> {
	const hash = createHash("sha256");

	for (const candidate of discovery.candidates) {
		hash.update(`container\0${candidate.root}\0`);

		for (const path of [...candidate.audioPaths, ...candidate.imagePaths]) {
			const metadata = await lstat(path, { bigint: true });
			if (!metadata.isFile() || metadata.isSymbolicLink()) {
				throw new Error(
					`Discovered source is no longer a real file: ${path}`,
				);
			}

			hash.update(
				`${path}\0${metadata.size}\0${metadata.mtimeNs}\0${metadata.ctimeNs}\0`,
			);
		}
	}

	return hash.digest("hex");
}

/**
 * Observes source media using the same bounded traversal later used for
 * publication preparation. A confirmed observation can therefore be prepared
 * without walking the source tree a second time.
 */
export async function observeSource(
	watchRoot: string,
): Promise<SourceObservation> {
	const discovery = await discoverCandidates(watchRoot);
	const issues = discovery.issues.map(
		(issue) => `${issue.path}: ${issue.message}`,
	);
	const incompleteSourceContainers = new Set(
		discovery.issues.flatMap((issue) => {
			const container = sourceContainerForIssue(watchRoot, issue.path);

			return container === undefined ? [] : [container];
		}),
	);
	// Candidate-level limits do not invalidate healthy containers in this scan.
	let complete = true;
	let manifestHash = createHash("sha256").digest("hex");

	try {
		manifestHash = await hashDiscovery(discovery);
	} catch (error) {
		issues.push(error instanceof Error ? error.message : String(error));
		complete = false;
	}

	return {
		discovery,
		complete,
		manifestHash,
		issues,
		incompleteSourceContainers: [...incompleteSourceContainers].toSorted(),
	};
}
