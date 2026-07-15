export const DATABASE_FILE = "library-state-v2.sqlite";
export const APPLICATION_ID = 1397577798;
export const SCHEMA_VERSION = 2;

// SQLite has no regex CHECK. This deliberately verbose predicate is kept next to
// the schema; canonicalRelativePath applies the identical rule at the boundary.
const CANONICAL_PATH_CHECK = `
	? <> '' AND instr(?, '\\') = 0 AND ? NOT GLOB '/*' AND
	? NOT IN ('.', '..') AND ? NOT GLOB '../*' AND ? NOT GLOB './*' AND
	? NOT GLOB '*/' AND instr(?, '//') = 0 AND instr(?, '/./') = 0 AND instr(?, '/../') = 0 AND
	? NOT GLOB '*/.' AND ? NOT GLOB '*/..'`;

function pathCheck(column: string): string {
	return CANONICAL_PATH_CHECK.replaceAll("?", column);
}

const UUID_CHECK = `id GLOB '[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]-[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]-4[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]-[89ABab][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]-[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'`;

/** The complete, destructive v2 state format. Do not add migrations here. */
export const BENCHMARK_SQL = {
	insertContainer:
		"INSERT INTO source_containers VALUES (?, ?, 'present', NULL, 1)",
	insertRelease:
		"INSERT INTO source_releases (id, container_id, logical_release_key, album_artist, album_title) VALUES (?, ?, ?, 'Artist', 'Album')",
	insertSourceFile: "INSERT INTO source_files VALUES (?, ?, ?, ?, ?, 'audio')",
	insertImport: "INSERT INTO imports VALUES (?, ?, ?, 1, 1)",
	insertDestination: "INSERT INTO published_destinations VALUES (?, ?, ?, 1)",
	lookupSource:
		"SELECT source_release_id FROM source_files WHERE source_path = ?",
	replaceManifest: "DELETE FROM source_files WHERE source_release_id = ?",
	unresolvedOperation: "SELECT id FROM operations WHERE import_id = ?",
	targetedReconciliation:
		"SELECT i.id FROM imports i JOIN source_releases sr ON sr.id = i.source_release_id JOIN source_containers sc ON sc.id = sr.container_id WHERE sc.root_path = ?",
	explainSource:
		"EXPLAIN QUERY PLAN SELECT source_release_id FROM source_files WHERE source_path = 'Release-1/00.flac'",
	explainOperation:
		"EXPLAIN QUERY PLAN SELECT id FROM operations WHERE import_id = '00000000-0000-4003-8000-000000000000'",
	explainReconciliation:
		"EXPLAIN QUERY PLAN SELECT i.id FROM imports i JOIN source_releases sr ON sr.id = i.source_release_id JOIN source_containers sc ON sc.id = sr.container_id WHERE sc.root_path = 'Release-1'",
} as const;

export const SCHEMA_SQL = `
	CREATE TABLE source_containers (
		id TEXT PRIMARY KEY CHECK (${UUID_CHECK}),
		root_path TEXT NOT NULL COLLATE BINARY UNIQUE CHECK (${pathCheck("root_path")}),
		availability TEXT NOT NULL DEFAULT 'present' CHECK (availability IN ('present', 'missing', 'inaccessible')),
		missing_since_ns INTEGER,
		updated_at_ns INTEGER NOT NULL
	) STRICT;
	CREATE TABLE source_releases (
		id TEXT PRIMARY KEY CHECK (${UUID_CHECK}),
		container_id TEXT NOT NULL REFERENCES source_containers(id) ON DELETE CASCADE,
		logical_release_key TEXT NOT NULL COLLATE BINARY CHECK (logical_release_key <> ''),
		album_artist TEXT NOT NULL CHECK (album_artist <> ''),
		album_title TEXT NOT NULL CHECK (album_title <> ''),
		availability TEXT NOT NULL DEFAULT 'present' CHECK (availability IN ('present', 'missing', 'inaccessible')),
		missing_since_ns INTEGER,
		updated_at_ns INTEGER NOT NULL DEFAULT 0,
		UNIQUE (container_id, logical_release_key)
	) STRICT;
	CREATE TABLE source_files (
		source_path TEXT PRIMARY KEY COLLATE BINARY CHECK (${pathCheck("source_path")}),
		source_release_id TEXT NOT NULL REFERENCES source_releases(id) ON DELETE CASCADE,
		relative_path TEXT NOT NULL COLLATE BINARY CHECK (${pathCheck("relative_path")}),
		size INTEGER NOT NULL CHECK (size >= 0),
		mtime_ns INTEGER NOT NULL,
		kind TEXT NOT NULL CHECK (kind IN ('audio', 'artwork')),
		UNIQUE (source_release_id, relative_path)
	) STRICT, WITHOUT ROWID;
	CREATE INDEX source_files_release_idx ON source_files(source_release_id);
	CREATE TABLE imports (
		id TEXT PRIMARY KEY CHECK (${UUID_CHECK}),
		source_release_id TEXT NOT NULL UNIQUE REFERENCES source_releases(id) ON DELETE CASCADE,
		manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
		created_at_ns INTEGER NOT NULL,
		updated_at_ns INTEGER NOT NULL
	) STRICT;
	CREATE TABLE published_destinations (
		id TEXT PRIMARY KEY CHECK (${UUID_CHECK}),
		import_id TEXT NOT NULL UNIQUE REFERENCES imports(id) ON DELETE CASCADE,
		destination_path TEXT NOT NULL COLLATE BINARY UNIQUE CHECK (${pathCheck("destination_path")}),
		published_at_ns INTEGER NOT NULL
	) STRICT;
	CREATE TABLE destination_entries (
		destination_id TEXT NOT NULL REFERENCES published_destinations(id) ON DELETE CASCADE,
		destination_name TEXT NOT NULL COLLATE BINARY CHECK (${pathCheck("destination_name")} AND instr(destination_name, '/') = 0),
		source_path TEXT NOT NULL COLLATE BINARY CHECK (${pathCheck("source_path")}),
		size INTEGER NOT NULL CHECK (size >= 0),
		mtime_ns INTEGER NOT NULL,
		kind TEXT NOT NULL CHECK (kind IN ('audio', 'artwork')),
		PRIMARY KEY (destination_id, destination_name)
	) STRICT, WITHOUT ROWID;
	CREATE TABLE operations (
		id TEXT PRIMARY KEY CHECK (${UUID_CHECK}),
		import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
		source_release_id TEXT NOT NULL REFERENCES source_releases(id) ON DELETE CASCADE,
		kind TEXT NOT NULL CHECK (kind IN ('add', 'replace', 'delete', 'repair')),
		phase TEXT NOT NULL CHECK (phase IN ('planned', 'staged', 'tombstoned', 'published', 'attention_required')),
		target_destination_path TEXT NOT NULL COLLATE BINARY CHECK (${pathCheck("target_destination_path")}),
		staging_name TEXT NOT NULL CHECK (${pathCheck("staging_name")} AND instr(staging_name, '/') = 0),
		error_message TEXT,
		created_at_ns INTEGER NOT NULL,
		updated_at_ns INTEGER NOT NULL,
		UNIQUE (import_id),
		UNIQUE (source_release_id)
	) STRICT;
	CREATE TABLE operation_destination_claims (
		operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
		destination_path TEXT NOT NULL COLLATE BINARY UNIQUE CHECK (${pathCheck("destination_path")}),
		PRIMARY KEY (operation_id, destination_path)
	) STRICT, WITHOUT ROWID;
	CREATE TABLE operation_entries (
		operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
		destination_name TEXT NOT NULL COLLATE BINARY CHECK (${pathCheck("destination_name")} AND instr(destination_name, '/') = 0),
		source_path TEXT NOT NULL COLLATE BINARY CHECK (${pathCheck("source_path")}),
		size INTEGER NOT NULL CHECK (size >= 0),
		mtime_ns INTEGER NOT NULL,
		kind TEXT NOT NULL CHECK (kind IN ('audio', 'artwork')),
		PRIMARY KEY (operation_id, destination_name)
	) STRICT, WITHOUT ROWID;
	CREATE TABLE reviews (
		id TEXT PRIMARY KEY CHECK (${UUID_CHECK}),
		import_id TEXT REFERENCES imports(id) ON DELETE CASCADE,
		operation_id TEXT REFERENCES operations(id) ON DELETE CASCADE,
		kind TEXT NOT NULL CHECK (kind IN ('attention_required', 'unmanaged_output')),
		details_json TEXT NOT NULL,
		created_at_ns INTEGER NOT NULL,
		CHECK ((kind = 'unmanaged_output' AND import_id IS NULL AND operation_id IS NULL) OR (kind = 'attention_required' AND ((import_id IS NOT NULL) <> (operation_id IS NOT NULL))) )
	) STRICT;
	CREATE INDEX reviews_attention_idx ON reviews(kind) WHERE kind = 'attention_required';
	CREATE TABLE reconciliation_state (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		required INTEGER NOT NULL CHECK (required IN (0, 1)),
		last_full_scan_at_ns INTEGER,
		last_error TEXT,
		updated_at_ns INTEGER NOT NULL
	) STRICT;
	INSERT INTO reconciliation_state VALUES (1, 1, NULL, NULL, 0);
	PRAGMA application_id = ${APPLICATION_ID};
	PRAGMA user_version = ${SCHEMA_VERSION};
`;
