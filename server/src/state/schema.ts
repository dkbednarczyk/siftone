export const DATABASE_FILE = "library-state.sqlite";
export const APPLICATION_ID = 1397577798;

// SQLite has no regex CHECK. This deliberately verbose predicate is kept next to
// the schema; canonicalAbsolutePath applies the identical rule at the boundary.
const CANONICAL_ABSOLUTE_PATH_CHECK = `
	? <> '' AND instr(?, '\\') = 0 AND ? GLOB '/*' AND
	(? = '/' OR (
		? NOT GLOB '*/' AND instr(?, '//') = 0 AND instr(?, '/./') = 0 AND instr(?, '/../') = 0 AND
		? NOT GLOB '*/.' AND ? NOT GLOB '*/..'
	))`;

const CANONICAL_NAME_CHECK = `
	? <> '' AND instr(?, '\\') = 0 AND ? NOT GLOB '/*' AND
	? NOT IN ('.', '..') AND ? NOT GLOB '../*' AND ? NOT GLOB './*' AND
	? NOT GLOB '*/' AND instr(?, '//') = 0 AND instr(?, '/./') = 0 AND instr(?, '/../') = 0 AND
	? NOT GLOB '*/.' AND ? NOT GLOB '*/..'`;

function absolutePathCheck(column: string): string {
	return CANONICAL_ABSOLUTE_PATH_CHECK.replaceAll("?", column);
}

function nameCheck(column: string): string {
	return CANONICAL_NAME_CHECK.replaceAll("?", column);
}

function sha256Check(column: string): string {
	return `length(${column}) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*'`;
}

const UUID_CHECK = `id GLOB '[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]-[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]-4[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]-[89ABab][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]-[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'`;

export const SCHEMA_SQL = `
	CREATE TABLE source_containers (
		id TEXT PRIMARY KEY CHECK (${UUID_CHECK}),
		root_path TEXT NOT NULL COLLATE BINARY UNIQUE CHECK (${absolutePathCheck("root_path")}),
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
		source_path TEXT PRIMARY KEY COLLATE BINARY CHECK (${absolutePathCheck("source_path")}),
		source_release_id TEXT NOT NULL REFERENCES source_releases(id) ON DELETE CASCADE,
		size INTEGER NOT NULL CHECK (size >= 0),
		mtime_ns INTEGER NOT NULL,
		kind TEXT NOT NULL CHECK (kind IN ('audio', 'artwork'))
	) STRICT, WITHOUT ROWID;
	CREATE INDEX source_files_release_idx ON source_files(source_release_id);
	CREATE TABLE source_observations (
		root_path TEXT PRIMARY KEY COLLATE BINARY CHECK (${absolutePathCheck("root_path")} ),
		confirmed_manifest_hash TEXT CHECK (confirmed_manifest_hash IS NULL OR length(confirmed_manifest_hash) = 64),
		pending_manifest_hash TEXT CHECK (pending_manifest_hash IS NULL OR length(pending_manifest_hash) = 64),
		pending_since_ns INTEGER,
		outcome TEXT NOT NULL DEFAULT 'present' CHECK (outcome IN ('present', 'missing', 'inaccessible', 'unsupported')),
		warning TEXT,
		missing_since_ns INTEGER,
		updated_at_ns INTEGER NOT NULL,
		CHECK ((pending_manifest_hash IS NULL) = (pending_since_ns IS NULL))
	) STRICT, WITHOUT ROWID;
	CREATE TABLE imports (
		id TEXT PRIMARY KEY CHECK (${UUID_CHECK}),
		source_release_id TEXT NOT NULL UNIQUE REFERENCES source_releases(id) ON DELETE CASCADE,
		manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
		created_at_ns INTEGER NOT NULL,
		updated_at_ns INTEGER NOT NULL
	) STRICT;
	CREATE TABLE artwork_cache_objects (
		sha256 TEXT PRIMARY KEY COLLATE BINARY CHECK (${sha256Check("sha256")}),
		relative_path TEXT NOT NULL COLLATE BINARY UNIQUE CHECK (${nameCheck("relative_path")}),
		byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
		width INTEGER NOT NULL CHECK (width > 0),
		height INTEGER NOT NULL CHECK (height > 0),
		media_type TEXT NOT NULL CHECK (media_type = 'image/jpeg'),
		created_at_ns INTEGER NOT NULL
	) STRICT, WITHOUT ROWID;
	CREATE TABLE automatic_artwork (
		source_release_id TEXT PRIMARY KEY REFERENCES source_releases(id) ON DELETE CASCADE,
		metadata_fingerprint TEXT NOT NULL CHECK (metadata_fingerprint <> ''),
		resolver_version TEXT NOT NULL CHECK (resolver_version <> ''),
		status TEXT NOT NULL CHECK (status IN ('disabled', 'no_match', 'no_eligible_edition', 'no_qualifying_cover', 'edition_cap_reached', 'transient_failure', 'selected')),
		cache_sha256 TEXT COLLATE BINARY REFERENCES artwork_cache_objects(sha256),
		release_group_mbid TEXT CHECK (release_group_mbid IS NULL OR release_group_mbid <> ''),
		release_mbid TEXT CHECK (release_mbid IS NULL OR release_mbid <> ''),
		source_url TEXT CHECK (source_url IS NULL OR source_url <> ''),
		failure_detail TEXT CHECK (failure_detail IS NULL OR failure_detail <> ''),
		attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
		attempted_at_ns INTEGER NOT NULL,
		next_attempt_at_ns INTEGER,
		CHECK ((status = 'selected' AND cache_sha256 IS NOT NULL) OR (status <> 'selected' AND cache_sha256 IS NULL))
	) STRICT, WITHOUT ROWID;
	CREATE INDEX automatic_artwork_cache_sha_idx ON automatic_artwork(cache_sha256) WHERE cache_sha256 IS NOT NULL;
	CREATE TABLE album_versions (
		id TEXT PRIMARY KEY CHECK (${UUID_CHECK}),
		import_id TEXT REFERENCES imports(id) ON DELETE SET NULL,
		origin_operation_id TEXT NOT NULL UNIQUE CHECK (${UUID_CHECK}),
		version_path TEXT NOT NULL COLLATE BINARY UNIQUE CHECK (${absolutePathCheck("version_path")}),
		state TEXT NOT NULL CHECK (state IN ('pending', 'current', 'retired')),
		published_at_ns INTEGER,
		retired_at_ns INTEGER,
		CHECK ((state = 'pending' AND published_at_ns IS NULL AND retired_at_ns IS NULL) OR (state = 'current' AND published_at_ns IS NOT NULL AND retired_at_ns IS NULL) OR (state = 'retired' AND published_at_ns IS NOT NULL AND retired_at_ns IS NOT NULL))
	) STRICT;
	CREATE INDEX album_versions_retired_idx ON album_versions(retired_at_ns) WHERE state = 'retired';
	CREATE TABLE published_destinations (
		id TEXT PRIMARY KEY CHECK (${UUID_CHECK}),
		import_id TEXT NOT NULL UNIQUE REFERENCES imports(id) ON DELETE CASCADE,
		version_id TEXT UNIQUE REFERENCES album_versions(id),
		destination_path TEXT NOT NULL COLLATE BINARY UNIQUE CHECK (${absolutePathCheck("destination_path")}),
		published_at_ns INTEGER NOT NULL
	) STRICT;
	CREATE TABLE destination_entries (
		destination_id TEXT NOT NULL REFERENCES published_destinations(id) ON DELETE CASCADE,
		destination_name TEXT NOT NULL COLLATE BINARY CHECK (${nameCheck("destination_name")} AND instr(destination_name, '/') = 0),
		origin TEXT NOT NULL CHECK (origin IN ('source', 'cache')),
		source_path TEXT COLLATE BINARY CHECK (source_path IS NULL OR ${absolutePathCheck("source_path")}),
		cache_sha256 TEXT COLLATE BINARY REFERENCES artwork_cache_objects(sha256),
		size INTEGER CHECK (size IS NULL OR size >= 0),
		mtime_ns INTEGER,
		kind TEXT NOT NULL CHECK (kind IN ('audio', 'artwork')),
		CHECK ((origin = 'source' AND source_path IS NOT NULL AND cache_sha256 IS NULL AND size IS NOT NULL AND mtime_ns IS NOT NULL) OR (origin = 'cache' AND source_path IS NULL AND cache_sha256 IS NOT NULL AND size IS NULL AND mtime_ns IS NULL AND kind = 'artwork')),
		PRIMARY KEY (destination_id, destination_name)
	) STRICT, WITHOUT ROWID;
	CREATE INDEX destination_entries_cache_sha_idx ON destination_entries(cache_sha256) WHERE cache_sha256 IS NOT NULL;
	CREATE TABLE operations (
		id TEXT PRIMARY KEY CHECK (${UUID_CHECK}),
		import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
		source_release_id TEXT NOT NULL REFERENCES source_releases(id) ON DELETE CASCADE,
		kind TEXT NOT NULL CHECK (kind IN ('add', 'replace', 'delete', 'repair')),
		phase TEXT NOT NULL CHECK (phase IN ('planned', 'staged', 'versioned', 'swapped', 'attention_required')),
		target_destination_path TEXT NOT NULL COLLATE BINARY CHECK (${absolutePathCheck("target_destination_path")}),
		staging_path TEXT NOT NULL COLLATE BINARY CHECK (${absolutePathCheck("staging_path")}),
		version_id TEXT REFERENCES album_versions(id),
		version_path TEXT COLLATE BINARY CHECK (version_path IS NULL OR ${absolutePathCheck("version_path")}),
		error_message TEXT,
		created_at_ns INTEGER NOT NULL,
		updated_at_ns INTEGER NOT NULL,
		UNIQUE (import_id),
		UNIQUE (source_release_id)
	) STRICT;
	CREATE TABLE operation_destination_claims (
		operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
		destination_path TEXT NOT NULL COLLATE BINARY UNIQUE CHECK (${absolutePathCheck("destination_path")}),
		PRIMARY KEY (operation_id, destination_path)
	) STRICT, WITHOUT ROWID;
	CREATE TABLE operation_entries (
		operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
		destination_name TEXT NOT NULL COLLATE BINARY CHECK (${nameCheck("destination_name")} AND instr(destination_name, '/') = 0),
		origin TEXT NOT NULL CHECK (origin IN ('source', 'cache')),
		source_path TEXT COLLATE BINARY CHECK (source_path IS NULL OR ${absolutePathCheck("source_path")}),
		cache_sha256 TEXT COLLATE BINARY REFERENCES artwork_cache_objects(sha256),
		size INTEGER CHECK (size IS NULL OR size >= 0),
		mtime_ns INTEGER,
		kind TEXT NOT NULL CHECK (kind IN ('audio', 'artwork')),
		CHECK ((origin = 'source' AND source_path IS NOT NULL AND cache_sha256 IS NULL AND size IS NOT NULL AND mtime_ns IS NOT NULL) OR (origin = 'cache' AND source_path IS NULL AND cache_sha256 IS NOT NULL AND size IS NULL AND mtime_ns IS NULL AND kind = 'artwork')),
		PRIMARY KEY (operation_id, destination_name)
	) STRICT, WITHOUT ROWID;
	CREATE INDEX operation_entries_cache_sha_idx ON operation_entries(cache_sha256) WHERE cache_sha256 IS NOT NULL;
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
	CREATE INDEX reviews_import_idx ON reviews(import_id) WHERE import_id IS NOT NULL;
	CREATE INDEX reviews_operation_idx ON reviews(operation_id) WHERE operation_id IS NOT NULL;
	CREATE TABLE reconciliation_state (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		required INTEGER NOT NULL CHECK (required IN (0, 1)),
		last_full_scan_at_ns INTEGER,
		last_error TEXT,
		updated_at_ns INTEGER NOT NULL
	) STRICT;
	INSERT INTO reconciliation_state VALUES (1, 1, NULL, NULL, 0);
	PRAGMA application_id = ${APPLICATION_ID};
`;
