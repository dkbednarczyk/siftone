import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, normalize, relative, sep } from "node:path";

export type PathErrorFactory = (message: string) => Error;

function invalidPathError(message: string): Error {
	return new Error(message);
}

function usesInvalidSlash(value: string): boolean {
	return value.includes("\\") || (sep !== "/" && value.includes(sep));
}

/** Validates a canonical POSIX-relative path used only for transient values. */
export function canonicalRelativePath(value: string): string {
	if (typeof value !== "string" || value === "" || value.startsWith("/")) {
		throw new Error("Path must be a non-empty relative path");
	}

	if (usesInvalidSlash(value)) {
		throw new Error("Canonical relative paths must use '/' only");
	}

	if (value.split("/").some((segment) => ["", ".", ".."].includes(segment))) {
		throw new Error(
			"Canonical relative paths cannot contain empty, '.' or '..' segments",
		);
	}

	return value;
}

export function isCanonicalRelativePath(value: string): boolean {
	try {
		canonicalRelativePath(value);

		return true;
	} catch {
		return false;
	}
}

/** Validates canonical POSIX absolute paths persisted in SQLite. */
export function canonicalAbsolutePath(value: string): string {
	if (typeof value !== "string" || value === "" || !value.startsWith("/")) {
		throw new Error("Path must be a non-empty absolute path");
	}

	if (usesInvalidSlash(value)) {
		throw new Error("Canonical absolute paths must use '/' only");
	}

	if (value === "/") {
		return value;
	}

	if (
		value
			.slice(1)
			.split("/")
			.some((segment) => ["", ".", ".."].includes(segment))
	) {
		throw new Error(
			"Canonical absolute paths cannot contain empty, '.' or '..' segments",
		);
	}

	return value;
}

export function isCanonicalAbsolutePath(value: string): boolean {
	try {
		canonicalAbsolutePath(value);

		return true;
	} catch {
		return false;
	}
}

function relativeToParent(
	parent: string,
	candidate: string,
): string | undefined {
	const difference = relative(parent, candidate);

	if (
		difference === ".." ||
		difference.startsWith(`..${sep}`) ||
		isAbsolute(difference)
	) {
		return undefined;
	}

	return difference;
}

/** Returns whether candidate is the same path as or below parent. */
export function isSameOrDescendant(parent: string, candidate: string): boolean {
	return relativeToParent(parent, candidate) !== undefined;
}

export function isDescendant(parent: string, candidate: string): boolean {
	const difference = relativeToParent(parent, candidate);

	return difference !== undefined && difference !== "";
}

export function isPathWithinRoot(root: string, path: string): boolean {
	return isSameOrDescendant(
		canonicalAbsolutePath(root),
		canonicalAbsolutePath(path),
	);
}

export function isPathBelowRoot(root: string, path: string): boolean {
	return isDescendant(
		canonicalAbsolutePath(root),
		canonicalAbsolutePath(path),
	);
}

export function validateAbsolutePath(
	value: string,
	description: string,
	createError: PathErrorFactory = invalidPathError,
): string {
	if (value.trim() === "") {
		throw createError(`${description} must be a non-empty absolute path`);
	}

	if (!isAbsolute(value)) {
		throw createError(`${description} must be an absolute path`);
	}

	return normalize(value);
}

export async function resolveExistingDirectory(
	value: string,
	description: string,
	createError: PathErrorFactory = invalidPathError,
): Promise<string> {
	const path = validateAbsolutePath(value, description, createError);
	const canonicalPath = await realpath(path);
	const status = await stat(canonicalPath);

	if (!status.isDirectory()) {
		throw createError(`${description} must be a directory`);
	}

	return canonicalPath;
}

export async function createAndResolveDirectory(
	value: string,
	description: string,
	createError: PathErrorFactory = invalidPathError,
): Promise<string> {
	const path = validateAbsolutePath(value, description, createError);
	await mkdir(path, { recursive: true });

	return realpath(path);
}

export async function isRealDirectory(path: string): Promise<boolean> {
	const status = await lstat(path);

	return status.isDirectory() && !status.isSymbolicLink();
}

export function isMissingError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}
