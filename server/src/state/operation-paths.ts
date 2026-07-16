import { lstat, mkdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
	canonicalPathFromRelative,
	canonicalRelativePath,
} from "./canonical-path";

export class InvalidOperationState extends Error {}

export async function isMissing(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return false;
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ENOENT"
		)
			return true;
		throw error;
	}
}

export async function ensurePublicationRoots(
	generatedLibraryRoot: string,
	stagingRoot: string,
): Promise<void> {
	for (const root of [generatedLibraryRoot, stagingRoot]) {
		const status = await lstat(root);
		if (!status.isDirectory() || status.isSymbolicLink())
			throw new InvalidOperationState(
				`Managed root must be a real directory: ${root}`,
			);
	}
	const [generated, staging] = await Promise.all([
		stat(generatedLibraryRoot),
		stat(stagingRoot),
	]);
	if (generated.dev !== staging.dev)
		throw new InvalidOperationState(
			"Staging and generated roots must share a filesystem",
		);
}

export async function ensureDestinationParent(
	generatedLibraryRoot: string,
	destination: string,
): Promise<void> {
	const parent = dirname(destination);
	const relativeParent = relative(generatedLibraryRoot, parent);
	if (
		relativeParent !== "" &&
		(relativeParent.startsWith("..") || isAbsolute(relativeParent))
	)
		throw new InvalidOperationState(
			"Destination escapes generated-library root",
		);
	await mkdir(parent, { recursive: true });
	const status = await lstat(parent);
	if (!status.isDirectory() || status.isSymbolicLink())
		throw new InvalidOperationState(
			`Destination parent is unsafe: ${parent}`,
		);
}

export function operationPaths(
	generatedLibraryRoot: string,
	stagingRoot: string,
	stagingName: string,
	destinationPath: string,
	operationId: string,
) {
	canonicalRelativePath(stagingName);
	if (stagingName.includes("/"))
		throw new InvalidOperationState(
			"Staging name must be one path segment",
		);
	const canonicalDestination = canonicalRelativePath(destinationPath);
	const destination = join(
		generatedLibraryRoot,
		canonicalPathFromRelative(canonicalDestination),
	);
	const staging = join(stagingRoot, stagingName);
	const tombstone = join(
		dirname(destination),
		`.siftone-tombstone-${operationId}`,
	);
	return { destination, staging, tombstone };
}
