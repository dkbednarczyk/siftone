import {
	canonicalAbsolutePath,
	canonicalRelativePath,
	isPathWithinRoot,
} from "../canonical-path";
import type { ImportState } from "../import-state";
import { bigintRows } from "./database";
import type { SourceEntry } from "./types";

type StoredEntry = {
	destination_name: string;
	source_path: string;
	root_path: string;
	size: bigint;
	mtime_ns: bigint;
	kind: "audio" | "artwork";
};

function storedEntriesToEntries(rows: readonly StoredEntry[]): SourceEntry[] {
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
): SourceEntry[] {
	const rows = bigintRows<StoredEntry, [string]>(
		state.database.query<StoredEntry, [string]>(`
		SELECT oe.destination_name, oe.source_path, sc.root_path, oe.size, oe.mtime_ns, oe.kind
		FROM operation_entries oe
		JOIN source_files sf ON sf.source_path = oe.source_path
		JOIN source_releases sr ON sr.id = sf.source_release_id
		JOIN source_containers sc ON sc.id = sr.container_id
		WHERE oe.operation_id = ? AND oe.origin = 'source' ORDER BY oe.destination_name
	`),
		operationId,
	);

	return storedEntriesToEntries(rows);
}

export function priorDestination(
	state: ImportState,
	importId: string,
): string | null {
	return (
		state.database
			.query<{ destination_path: string }, [string]>(
				"SELECT destination_path FROM published_destinations WHERE import_id = ?",
			)
			.get(importId)?.destination_path ?? null
	);
}

export function destinationEntries(
	state: ImportState,
	importId: string,
): SourceEntry[] {
	const rows = bigintRows<StoredEntry, [string]>(
		state.database.query<StoredEntry, [string]>(`
		SELECT de.destination_name, de.source_path, sc.root_path, de.size, de.mtime_ns, de.kind
		FROM destination_entries de
		JOIN published_destinations pd ON pd.id = de.destination_id
		JOIN source_files sf ON sf.source_path = de.source_path
		JOIN source_releases sr ON sr.id = sf.source_release_id
		JOIN source_containers sc ON sc.id = sr.container_id
		WHERE pd.import_id = ? AND de.origin = 'source' ORDER BY de.destination_name
	`),
		importId,
	);

	return storedEntriesToEntries(rows);
}

type CurrentImport = Readonly<{
	import_id: string;
	release_id: string;
	root_path: string;
	logical_release_key: string;
	destination_path: string;
	release_availability: "present" | "missing" | "inaccessible";
}>;

export function currentImports(
	state: ImportState,
	observed?: readonly string[],
): CurrentImport[] {
	if (observed === undefined) {
		return state.database
			.query<CurrentImport, []>(`
				SELECT i.id AS import_id, sr.id AS release_id, sc.root_path, sr.logical_release_key, pd.destination_path, sr.availability AS release_availability
				FROM imports i
				JOIN source_releases sr ON sr.id = i.source_release_id
				JOIN source_containers sc ON sc.id = sr.container_id
				JOIN published_destinations pd ON pd.import_id = i.id
			`)
			.all();
	}

	return state.database
		.query<CurrentImport, [string]>(`
			SELECT i.id AS import_id, sr.id AS release_id, sc.root_path, sr.logical_release_key, pd.destination_path, sr.availability AS release_availability
			FROM json_each(?) observed
			JOIN source_containers sc ON sc.root_path = observed.value
			JOIN source_releases sr ON sr.container_id = sc.id
			JOIN imports i ON i.source_release_id = sr.id
			JOIN published_destinations pd ON pd.import_id = i.id
		`)
		.all(JSON.stringify(observed));
}
