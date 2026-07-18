import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sweepArtworkCacheObjects } from "./artwork-cache";
import { openImportState } from "./import-state";

const roots: string[] = [];

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "siftone-artwork-cache-"));
	roots.push(root);
	const stateRoot = join(root, "state");
	const generated = join(root, "generated");
	const cacheRoot = join(root, "cache");
	await Promise.all([mkdir(stateRoot), mkdir(generated), mkdir(cacheRoot)]);

	return {
		cacheRoot,
		state: await openImportState({
			stateRoot,
			generatedLibraryRoot: generated,
		}),
	};
}

async function insertObject(
	state: Awaited<ReturnType<typeof openImportState>>,
	cacheRoot: string,
	contents: string,
): Promise<{ sha256: string; path: string }> {
	const sha256 = createHash("sha256").update(contents).digest("hex");
	const relativePath = `artwork/sha256/${sha256.slice(0, 2)}/${sha256}.jpg`;
	const path = join(cacheRoot, relativePath);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, contents);
	state.database.run(
		"INSERT INTO artwork_cache_objects (sha256, relative_path, byte_size, width, height, media_type, created_at_ns) VALUES (?, ?, ?, 500, 500, 'image/jpeg', 1)",
		[sha256, relativePath, Buffer.byteLength(contents)],
	);

	return { sha256, path };
}

function insertRelease(
	state: Awaited<ReturnType<typeof openImportState>>,
	index: number,
): { releaseId: string; importId: string } {
	const containerId = "00000000-0000-4000-8000-000000000001";
	const releaseId = `00000000-0000-4000-8000-00000000000${index}`;
	const importId = `10000000-0000-4000-8000-00000000000${index}`;
	if (index === 2) {
		state.database.run(
			"INSERT INTO source_containers (id, root_path, availability, missing_since_ns, updated_at_ns) VALUES (?, '/watch/album', 'present', NULL, 1)",
			[containerId],
		);
	}
	state.database.run(
		"INSERT INTO source_releases (id, container_id, logical_release_key, album_artist, album_title) VALUES (?, ?, ?, 'Artist', 'Album')",
		[releaseId, containerId, `release-${index}`],
	);
	state.database.run(
		"INSERT INTO imports (id, source_release_id, manifest_hash, created_at_ns, updated_at_ns) VALUES (?, ?, ?, 1, 1)",
		[importId, releaseId, "a".repeat(64)],
	);

	return { releaseId, importId };
}

afterEach(async () => {
	await Promise.all(
		roots
			.splice(0)
			.map((root) => rm(root, { recursive: true, force: true })),
	);
});

test("sweeps only unreferenced cache objects and tolerates missing files", async () => {
	const { state, cacheRoot } = await fixture();
	const orphan = await insertObject(state, cacheRoot, "orphan");
	const missing = await insertObject(state, cacheRoot, "missing");
	const automatic = await insertObject(state, cacheRoot, "automatic");
	const destination = await insertObject(state, cacheRoot, "destination");
	const operation = await insertObject(state, cacheRoot, "operation");
	await rm(missing.path);

	const automaticRelease = insertRelease(state, 2);
	state.database.run(
		"INSERT INTO automatic_artwork (source_release_id, metadata_fingerprint, resolver_version, status, cache_sha256, attempt_count, attempted_at_ns) VALUES (?, 'fingerprint', 'resolver', 'selected', ?, 1, 1)",
		[automaticRelease.releaseId, automatic.sha256],
	);
	const destinationRelease = insertRelease(state, 3);
	const versionId = "20000000-0000-4000-8000-000000000003";
	const destinationId = "30000000-0000-4000-8000-000000000003";
	state.database.run(
		"INSERT INTO album_versions (id, import_id, origin_operation_id, version_path, state, published_at_ns, retired_at_ns) VALUES (?, ?, '40000000-0000-4000-8000-000000000003', '/generated/.siftone/versions/three', 'current', 1, NULL)",
		[versionId, destinationRelease.importId],
	);
	state.database.run(
		"INSERT INTO published_destinations (id, import_id, version_id, destination_path, published_at_ns) VALUES (?, ?, ?, '/generated/Artist/Three', 1)",
		[destinationId, destinationRelease.importId, versionId],
	);
	state.database.run(
		"INSERT INTO destination_entries (destination_id, destination_name, origin, source_path, cache_sha256, size, mtime_ns, kind) VALUES (?, 'cover.jpg', 'cache', NULL, ?, NULL, NULL, 'artwork')",
		[destinationId, destination.sha256],
	);
	const operationRelease = insertRelease(state, 4);
	const operationId = "50000000-0000-4000-8000-000000000004";
	state.database.run(
		"INSERT INTO operations (id, import_id, source_release_id, kind, phase, target_destination_path, staging_path, version_id, version_path, error_message, created_at_ns, updated_at_ns) VALUES (?, ?, ?, 'repair', 'planned', '/generated/Artist/Four', '/staging/four', NULL, NULL, NULL, 1, 1)",
		[operationId, operationRelease.importId, operationRelease.releaseId],
	);
	state.database.run(
		"INSERT INTO operation_entries (operation_id, destination_name, origin, source_path, cache_sha256, size, mtime_ns, kind) VALUES (?, 'cover.jpg', 'cache', NULL, ?, NULL, NULL, 'artwork')",
		[operationId, operation.sha256],
	);

	const removed = await sweepArtworkCacheObjects(state, cacheRoot);
	expect(removed).toBe(2);
	for (const object of [automatic, destination, operation]) {
		expect((await lstat(object.path)).isFile()).toBe(true);
	}
	await expect(lstat(orphan.path)).rejects.toThrow();
	expect(
		state.database
			.query<{ count: number }, []>(
				"SELECT count(*) AS count FROM artwork_cache_objects",
			)
			.get()?.count,
	).toBe(3);
	state.close();
});
