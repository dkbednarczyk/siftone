import { lstat, mkdir, readlink, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	canonicalAbsolutePath,
	isMissingError,
	isPathBelowRoot,
	isRealDirectory,
	isSameOrDescendant,
} from "../path-utils";

export async function isMissing(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return false;
	} catch (error) {
		if (isMissingError(error)) {
			return true;
		}

		throw error;
	}
}

export async function ensurePublicationRoots(
	generatedLibraryRoot: string,
	stagingRoot: string,
	versionRoot: string,
): Promise<void> {
	for (const root of [generatedLibraryRoot, stagingRoot, versionRoot]) {
		if (!(await isRealDirectory(root))) {
			throw new Error(`Managed root must be a real directory: ${root}`);
		}
	}

	const [generated, staging, versions] = await Promise.all([
		stat(generatedLibraryRoot),
		stat(stagingRoot),
		stat(versionRoot),
	]);

	if (generated.dev !== staging.dev || generated.dev !== versions.dev) {
		throw new Error(
			"Staging, version, and generated roots must share a filesystem",
		);
	}
}

export async function ensureDestinationParent(
	generatedLibraryRoot: string,
	destination: string,
): Promise<void> {
	const parent = dirname(destination);

	if (!isSameOrDescendant(generatedLibraryRoot, parent)) {
		throw new Error("Destination escapes generated-library root");
	}

	await mkdir(parent, { recursive: true });

	if (!(await isRealDirectory(parent))) {
		throw new Error(`Destination parent is unsafe: ${parent}`);
	}
}

export function operationPaths(
	generatedLibraryRoot: string,
	stagingRoot: string,
	versionRoot: string,
	stagingPath: string,
	destinationPath: string,
	versionPath: string | null,
	operationId: string,
) {
	const destination = canonicalAbsolutePath(destinationPath);
	const staging = canonicalAbsolutePath(stagingPath);

	if (!isPathBelowRoot(generatedLibraryRoot, destination)) {
		throw new Error("Destination escapes generated-library root");
	}

	if (!isPathBelowRoot(stagingRoot, staging)) {
		throw new Error("Staging path escapes staging root");
	}

	const version =
		versionPath === null ? null : canonicalAbsolutePath(versionPath);

	if (version !== null && !isPathBelowRoot(versionRoot, version)) {
		throw new Error("Version path escapes version root");
	}

	return {
		destination,
		staging,
		version,
		temporaryLink: join(
			dirname(destination),
			`.siftone-link-${operationId}`,
		),
	};
}

export function relativeVersionTarget(
	destination: string,
	version: string,
): string {
	const target = relative(dirname(destination), version);

	if (target === "" || isAbsolute(target)) {
		throw new Error("Unsafe relative version target");
	}

	return target;
}

/** Validates pointer ownership without following an arbitrary public symlink. */
export async function isOwnedPublicLeaf(
	destination: string,
	version: string,
	versionRoot: string,
): Promise<boolean> {
	try {
		const status = await lstat(destination);
		if (!status.isSymbolicLink()) {
			return false;
		}

		const target = await readlink(destination);
		if (target !== relativeVersionTarget(destination, version)) {
			return false;
		}

		const resolved = canonicalAbsolutePath(
			resolve(dirname(destination), target),
		);

		if (resolved !== version || !isPathBelowRoot(versionRoot, resolved)) {
			return false;
		}

		return isRealDirectory(version);
	} catch {
		return false;
	}
}
