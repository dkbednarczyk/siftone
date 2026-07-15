import { isAbsolute, sep } from "node:path";

/** Canonical paths persisted in SQLite are POSIX-relative, even on Windows. */
export function canonicalRelativePath(value: string): string {
	if (typeof value !== "string" || value === "" || isAbsolute(value))
		throw new Error("Path must be a non-empty relative path");
	if (value.includes("\\") || (sep !== "/" && value.includes(sep)))
		throw new Error("Canonical relative paths must use '/' only");
	const segments = value.split("/");
	if (
		segments.some(
			(segment) => segment === "" || segment === "." || segment === "..",
		)
	)
		throw new Error(
			"Canonical relative paths cannot contain empty, '.' or '..' segments",
		);
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

export function canonicalPathFromRelative(value: string): string {
	return canonicalRelativePath(value).replaceAll("/", sep);
}
