import { join } from "node:path";
import {
	canonicalAbsolutePath,
	canonicalRelativePath,
	isPathBelowRoot,
} from "../util/path";
import type { Entry } from "./reconcile/types";

/** Resolves an entry target without allowing cache objects to escape cacheRoot. */
export function entryPath(entry: Entry, cacheRoot: string): string {
	if (entry.origin === "source") {
		return canonicalAbsolutePath(entry.sourcePath);
	}

	const root = canonicalAbsolutePath(cacheRoot);
	const relativePath = canonicalRelativePath(entry.cacheRelativePath);
	const path = canonicalAbsolutePath(join(root, relativePath));

	if (!isPathBelowRoot(root, path)) {
		throw new Error(`Cache object escapes its cache root: ${relativePath}`);
	}

	return path;
}
