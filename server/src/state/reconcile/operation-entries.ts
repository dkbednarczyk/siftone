import {
	canonicalAbsolutePath,
	canonicalRelativePath,
	isPathWithinRoot,
} from "../../util/path";
import type { ImportState } from "../import-state";
import { bigintRows } from "./database";
import type { Entry } from "./types";

type StoredEntry = Readonly<{
	destination_name: string;
	source_path: string;
	root_path: string;
	size: bigint;
	mtime_ns: bigint;
	kind: "audio" | "artwork";
}>;

function storedEntriesToEntries(rows: readonly StoredEntry[]): Entry[] {
	return rows.map((row) => {
		const sourcePath = canonicalAbsolutePath(row.source_path);
		const rootPath = canonicalAbsolutePath(row.root_path);

		if (
			!isPathWithinRoot(rootPath, sourcePath) ||
			sourcePath === rootPath
		) {
			throw new Error(
				`Stored source file escapes its container: ${sourcePath}`,
			);
		}

		const relativeSourcePath = canonicalRelativePath(
			sourcePath.slice(rootPath === "/" ? 1 : rootPath.length + 1),
		);

		return {
			origin: "source",
			sourcePath,
			relativeSourcePath,
			destinationName: row.destination_name,
			size: row.size,
			mtimeNs: row.mtime_ns,
			kind: row.kind,
		};
	});
}

export function operationEntries(
	state: ImportState,
	operationId: string,
): Entry[] {
	const rows = bigintRows<StoredEntry, [string]>(
		state.database.query<StoredEntry, [string]>(`
		SELECT oe.destination_name, oe.source_path, sc.root_path, oe.size, oe.mtime_ns, oe.kind
		FROM operation_entries oe
		JOIN operations o ON o.id = oe.operation_id
		JOIN source_files sf ON sf.source_path = oe.source_path AND sf.import_id = o.import_id
		JOIN imports i ON i.id = sf.import_id
		JOIN source_containers sc ON sc.id = i.container_id
		WHERE oe.operation_id = ? ORDER BY oe.destination_name
	`),
		operationId,
	);

	return storedEntriesToEntries(rows);
}

export function destinationEntries(
	state: ImportState,
	importId: string,
): Entry[] {
	const rows = bigintRows<StoredEntry, [string]>(
		state.database.query<StoredEntry, [string]>(`
		SELECT de.destination_name, de.source_path, sc.root_path, de.size, de.mtime_ns, de.kind
		FROM destination_entries de
		JOIN source_files sf ON sf.source_path = de.source_path AND sf.import_id = de.import_id
		JOIN imports i ON i.id = sf.import_id
		JOIN source_containers sc ON sc.id = i.container_id
		WHERE de.import_id = ? ORDER BY de.destination_name
	`),
		importId,
	);

	return storedEntriesToEntries(rows);
}

type CurrentImport = Readonly<{
	import_id: string;
	root_path: string;
	logical_release_key: string;
	destination_path: string;
	availability: "present" | "missing";
}>;

export function currentImports(
	state: ImportState,
	observed?: readonly string[],
): CurrentImport[] {
	if (observed === undefined) {
		return state.database
			.query<CurrentImport, []>(`
				SELECT i.id AS import_id, sc.root_path, i.logical_release_key, i.destination_path, i.availability
				FROM imports i
				JOIN source_containers sc ON sc.id = i.container_id
				WHERE i.destination_path IS NOT NULL AND i.current_version_id IS NOT NULL
			`)
			.all();
	}

	return state.database
		.query<CurrentImport, [string]>(`
			SELECT i.id AS import_id, sc.root_path, i.logical_release_key, i.destination_path, i.availability
			FROM json_each(?) observed
			JOIN source_containers sc ON sc.root_path = observed.value
			JOIN imports i ON i.container_id = sc.id
			WHERE i.destination_path IS NOT NULL AND i.current_version_id IS NOT NULL
		`)
		.all(JSON.stringify(observed));
}
