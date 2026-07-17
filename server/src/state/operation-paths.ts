import { lstat, mkdir, readlink, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { canonicalAbsolutePath, isPathBelowRoot } from "./canonical-path";

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
		) {
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
		const status = await lstat(root);

		if (!status.isDirectory() || status.isSymbolicLink()) {
			throw new InvalidOperationState(
				`Managed root must be a real directory: ${root}`,
			);
		}
	}

	const [generated, staging, versions] = await Promise.all([
		stat(generatedLibraryRoot),
		stat(stagingRoot),
		stat(versionRoot),
	]);

	if (generated.dev !== staging.dev || generated.dev !== versions.dev) {
		throw new InvalidOperationState(
			"Staging, version, and generated roots must share a filesystem",
		);
	}
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
	) {
		throw new InvalidOperationState(
			"Destination escapes generated-library root",
		);
	}

	await mkdir(parent, { recursive: true });
	const status = await lstat(parent);

	if (!status.isDirectory() || status.isSymbolicLink()) {
		throw new InvalidOperationState(
			`Destination parent is unsafe: ${parent}`,
		);
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
		throw new InvalidOperationState(
			"Destination escapes generated-library root",
		);
	}

	if (!isPathBelowRoot(stagingRoot, staging)) {
		throw new InvalidOperationState("Staging path escapes staging root");
	}

	const version =
		versionPath === null ? null : canonicalAbsolutePath(versionPath);
	if (version !== null && !isPathBelowRoot(versionRoot, version)) {
		throw new InvalidOperationState("Version path escapes version root");
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
		throw new InvalidOperationState("Unsafe relative version target");
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

		const versionStatus = await lstat(version);
		return versionStatus.isDirectory() && !versionStatus.isSymbolicLink();
	} catch {
		return false;
	}
}
