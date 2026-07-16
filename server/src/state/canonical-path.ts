import { sep } from "node:path";

/** Validates a canonical POSIX-relative path used only for transient values. */
export function canonicalRelativePath(value: string): string {
	if (typeof value !== "string" || value === "" || value.startsWith("/")) {
		throw new Error("Path must be a non-empty relative path");
	}

	if (value.includes("\\") || (sep !== "/" && value.includes(sep))) {
		throw new Error("Canonical relative paths must use '/' only");
	}

	const segments = value.split("/");
	if (
		segments.some(
			(segment) => segment === "" || segment === "." || segment === "..",
		)
	) {
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

	if (value.includes("\\") || (sep !== "/" && value.includes(sep))) {
		throw new Error("Canonical absolute paths must use '/' only");
	}

	if (value === "/") {
		return value;
	}

	const segments = value.slice(1).split("/");
	if (
		segments.some(
			(segment) => segment === "" || segment === "." || segment === "..",
		)
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

export function isPathWithinRoot(root: string, path: string): boolean {
	const canonicalRoot = canonicalAbsolutePath(root);
	const canonicalPath = canonicalAbsolutePath(path);

	return (
		canonicalRoot === "/" ||
		canonicalPath === canonicalRoot ||
		canonicalPath.startsWith(`${canonicalRoot}/`)
	);
}

export function isPathBelowRoot(root: string, path: string): boolean {
	const canonicalRoot = canonicalAbsolutePath(root);
	const canonicalPath = canonicalAbsolutePath(path);

	return canonicalPath !== canonicalRoot && isPathWithinRoot(root, path);
}
