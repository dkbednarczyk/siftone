import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PublicationInput } from "../publication/publish";
import { openImportState } from "../state/import-state";
import {
	type AutomaticArtworkResolver,
	artworkMetadataFingerprint,
	createAutomaticArtworkResolver,
	resolvePublicationArtwork,
} from "./publication";

const roots: string[] = [];

function input(root: string, hasLocalArtwork = false): PublicationInput {
	return {
		root,
		logicalReleaseKey: JSON.stringify([root, "Album"]),
		albumArtist: "Artist",
		albumTitle: "Album",
		entries: [
			{
				sourcePath: join(root, "01.flac"),
				destinationPath: "/library/Artist/Album/01.flac",
			},
			...(hasLocalArtwork
				? [
						{
							sourcePath: join(root, "cover.jpg"),
							destinationPath: "/library/Artist/Album/cover.jpg",
						},
					]
				: []),
		],
	};
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "siftone-artwork-publication-"));
	roots.push(root);
	const generatedLibraryRoot = join(root, "generated");
	const stateRoot = join(root, "state");
	const cacheRoot = join(root, "cache");
	await Promise.all([
		mkdir(stateRoot),
		mkdir(generatedLibraryRoot),
		mkdir(cacheRoot),
	]);
	const state = await openImportState({ stateRoot, generatedLibraryRoot });

	return { root, state, cacheRoot };
}

function seedOutcome(
	state: Awaited<ReturnType<typeof openImportState>>,
	input: PublicationInput,
	status: "disabled" | "no_match" | "transient_failure",
	nextAttemptAtNs: bigint | null = null,
): void {
	const containerId = "00000000-0000-4000-8000-000000000001";
	const releaseId = "00000000-0000-4000-8000-000000000002";
	state.database.run(
		"INSERT INTO source_containers (id, root_path, availability, missing_since_ns, updated_at_ns) VALUES (?, ?, 'present', NULL, 1)",
		[containerId, input.root],
	);
	state.database.run(
		"INSERT INTO source_releases (id, container_id, logical_release_key, album_artist, album_title) VALUES (?, ?, ?, ?, ?)",
		[
			releaseId,
			containerId,
			input.logicalReleaseKey,
			input.albumArtist,
			input.albumTitle,
		],
	);
	state.database.run(
		"INSERT INTO automatic_artwork (source_release_id, metadata_fingerprint, resolver_version, status, cache_sha256, release_group_mbid, release_mbid, source_url, failure_detail, attempt_count, attempted_at_ns, next_attempt_at_ns) VALUES (?, ?, 'musicbrainz-caa-v1', ?, NULL, NULL, NULL, NULL, NULL, 2, 7, ?)",
		[releaseId, artworkMetadataFingerprint(input), status, nextAttemptAtNs],
	);
}

async function seedSelectedOutcome(
	paths: Awaited<ReturnType<typeof fixture>>,
	input: PublicationInput,
	expectedBytes: Uint8Array,
	storedBytes = expectedBytes,
): Promise<{ sha256: string; path: string }> {
	const sha256 = createHash("sha256").update(expectedBytes).digest("hex");
	const relativePath = `artwork/sha256/${sha256.slice(0, 2)}/${sha256}.jpg`;
	const path = join(paths.cacheRoot, relativePath);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, storedBytes);
	seedOutcome(paths.state, input, "no_match");
	paths.state.database.run(
		"INSERT INTO artwork_cache_objects (sha256, relative_path, byte_size, width, height, media_type, created_at_ns) VALUES (?, ?, ?, 500, 500, 'image/jpeg', 1)",
		[sha256, relativePath, expectedBytes.byteLength],
	);
	paths.state.database.run(
		"UPDATE automatic_artwork SET status = 'selected', cache_sha256 = ? WHERE source_release_id = ?",
		[sha256, "00000000-0000-4000-8000-000000000002"],
	);

	return { sha256, path };
}

afterEach(async () => {
	await Promise.all(
		roots
			.splice(0)
			.map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe("automatic artwork publication integration", () => {
	test("resolves only artless already-arbitrated winners concurrently and preserves their order", async () => {
		const paths = await fixture();
		const first = input(join(paths.root, "winner-one"));
		const local = input(join(paths.root, "winner-local"), true);
		const second = input(join(paths.root, "winner-two"));
		const started: string[] = [];
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const resolver: AutomaticArtworkResolver = {
			async resolve(value) {
				started.push(value.albumArtist);
				await gate;

				return { status: "no_match" };
			},
		};

		const resolving = resolvePublicationArtwork({
			state: paths.state,
			cacheRoot: paths.cacheRoot,
			inputs: [first, local, second],
			resolver,
			enabled: true,
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(started).toEqual(["Artist", "Artist"]);
		if (release === undefined) {
			throw new Error("Resolver gate is required");
		}
		release();
		const resolved = await resolving;

		expect(resolved.map((value) => value.root)).toEqual([
			first.root,
			local.root,
			second.root,
		]);
		expect(resolved[0].automaticArtwork?.status).toBe("no_match");
		expect(resolved[1].automaticArtwork).toBeUndefined();
		expect(resolved[2].automaticArtwork?.status).toBe("no_match");
		paths.state.close();
	});

	test("retries transient resolution three times and persists an exponential retry time", async () => {
		const paths = await fixture();
		let calls = 0;
		const result = await resolvePublicationArtwork({
			state: paths.state,
			cacheRoot: paths.cacheRoot,
			inputs: [input(join(paths.root, "winner"))],
			resolver: {
				async resolve() {
					calls += 1;

					return { status: "transient_failure" };
				},
			},
			enabled: true,
			nowNs: () => 1_000n,
		});

		expect(calls).toBe(3);
		expect(result[0].automaticArtwork).toMatchObject({
			status: "transient_failure",
			attemptCount: 3,
			nextAttemptAtNs: 8_000_001_000n,
		});
		paths.state.close();
	});

	test("reuses terminal and not-yet-due outcomes, then retries changed or due outcomes", async () => {
		const paths = await fixture();
		const release = input(join(paths.root, "winner"));
		seedOutcome(paths.state, release, "no_match");
		let calls = 0;
		const resolver: AutomaticArtworkResolver = {
			async resolve() {
				calls += 1;

				return { status: "no_match" };
			},
		};
		const terminal = await resolvePublicationArtwork({
			state: paths.state,
			cacheRoot: paths.cacheRoot,
			inputs: [release],
			resolver,
			enabled: true,
			nowNs: () => 10n,
		});
		expect(terminal[0].automaticArtwork?.attemptedAtNs).toBe(7n);
		expect(calls).toBe(0);

		const changed = await resolvePublicationArtwork({
			state: paths.state,
			cacheRoot: paths.cacheRoot,
			inputs: [{ ...release, albumTitle: "Changed" }],
			resolver,
			enabled: true,
			nowNs: () => 11n,
		});
		expect(changed[0].automaticArtwork?.status).toBe("no_match");
		expect(calls).toBe(1);

		paths.state.database.run(
			"UPDATE automatic_artwork SET status = 'transient_failure', next_attempt_at_ns = 20 WHERE source_release_id = ?",
			["00000000-0000-4000-8000-000000000002"],
		);
		await resolvePublicationArtwork({
			state: paths.state,
			cacheRoot: paths.cacheRoot,
			inputs: [release],
			resolver,
			enabled: true,
			nowNs: () => 19n,
		});
		expect(calls).toBe(1);
		await resolvePublicationArtwork({
			state: paths.state,
			cacheRoot: paths.cacheRoot,
			inputs: [release],
			resolver,
			enabled: true,
			nowNs: () => 20n,
		});
		expect(calls).toBe(2);
		paths.state.close();
	});

	test("reuses disabled outcomes until a contact becomes available", async () => {
		const paths = await fixture();
		const release = input(join(paths.root, "winner"));
		seedOutcome(paths.state, release, "disabled");
		let calls = 0;
		const resolver: AutomaticArtworkResolver = {
			async resolve() {
				calls += 1;

				return { status: "no_match" };
			},
		};
		await resolvePublicationArtwork({
			state: paths.state,
			cacheRoot: paths.cacheRoot,
			inputs: [release],
			resolver,
			enabled: false,
			nowNs: () => 10n,
		});
		expect(calls).toBe(0);
		await resolvePublicationArtwork({
			state: paths.state,
			cacheRoot: paths.cacheRoot,
			inputs: [release],
			resolver,
			enabled: true,
			nowNs: () => 11n,
		});
		expect(calls).toBe(1);
		paths.state.close();
	});

	test("makes no client calls without a nonblank contact and keeps failures nonblocking", async () => {
		let clientCalls = 0;
		const resolver = createAutomaticArtworkResolver({
			appName: "siftone",
			appVersion: "test",
			contact: undefined,
			musicBrainz: {
				async searchReleaseGroups() {
					clientCalls += 1;

					return [];
				},
				async browseReleaseEditions() {
					clientCalls += 1;

					return [];
				},
			},
		});
		expect(await resolver.resolve(input("/source/disabled"))).toEqual({
			status: "disabled",
		});
		const blankContactResolver = createAutomaticArtworkResolver({
			appName: "siftone",
			appVersion: "test",
			contact: " \t ",
			musicBrainz: {
				async searchReleaseGroups() {
					clientCalls += 1;

					return [];
				},
				async browseReleaseEditions() {
					clientCalls += 1;

					return [];
				},
			},
		});
		expect(
			await blankContactResolver.resolve(input("/source/disabled")),
		).toEqual({ status: "disabled" });
		expect(clientCalls).toBe(0);

		const paths = await fixture();
		const result = await resolvePublicationArtwork({
			state: paths.state,
			cacheRoot: paths.cacheRoot,
			inputs: [input(join(paths.root, "winner"))],
			resolver: {
				async resolve() {
					throw new Error("offline");
				},
			},
			enabled: true,
			nowNs: () => 1n,
		});
		expect(result[0].automaticArtwork).toMatchObject({
			status: "transient_failure",
			failureDetail: "offline",
			nextAttemptAtNs: 2_000_000_001n,
		});
		paths.state.close();
	});

	test("re-resolves and atomically replaces missing or hash-invalid selected cache objects", async () => {
		for (const storedBytes of [
			undefined,
			new Uint8Array([9, 9, 9]),
		] as const) {
			const paths = await fixture();
			const release = input(join(paths.root, "winner"));
			const expectedBytes = new Uint8Array([1, 2, 3]);
			const seeded = await seedSelectedOutcome(
				paths,
				release,
				expectedBytes,
				storedBytes,
			);
			if (storedBytes === undefined) {
				await rm(seeded.path);
			}
			let calls = 0;
			const resolved = await resolvePublicationArtwork({
				state: paths.state,
				cacheRoot: paths.cacheRoot,
				inputs: [release],
				resolver: {
					async resolve() {
						calls += 1;

						return {
							status: "selected",
							releaseGroupId: "group",
							releaseId: "release",
							url: "https://example.test/cover.jpg",
							bytes: expectedBytes,
							width: 500,
							height: 500,
						};
					},
				},
				enabled: true,
			});
			expect(calls).toBe(1);
			const cacheObject = resolved[0].automaticArtwork?.cacheObject;
			if (cacheObject === undefined) {
				throw new Error("Resolved artwork cache object is required");
			}
			expect(
				await readFile(join(paths.cacheRoot, cacheObject.relativePath)),
			).toEqual(Buffer.from(expectedBytes));
			paths.state.close();
		}
	});

	test("keeps damaged-cache resolution failures nonblocking", async () => {
		const paths = await fixture();
		const release = input(join(paths.root, "winner"));
		const seeded = await seedSelectedOutcome(
			paths,
			release,
			new Uint8Array([1, 2, 3]),
			new Uint8Array([9, 9, 9]),
		);
		expect(await readFile(seeded.path)).not.toEqual(Buffer.from([1, 2, 3]));
		const resolved = await resolvePublicationArtwork({
			state: paths.state,
			cacheRoot: paths.cacheRoot,
			inputs: [release],
			resolver: {
				async resolve() {
					throw new Error("offline");
				},
			},
			enabled: true,
			nowNs: () => 1n,
		});
		expect(resolved[0].automaticArtwork).toMatchObject({
			status: "transient_failure",
			failureDetail: "offline",
		});
		paths.state.close();
	});

	test("installs selected artwork by its content hash before returning it for reconciliation", async () => {
		const paths = await fixture();
		const bytes = new Uint8Array([1, 2, 3, 4]);
		const result = await resolvePublicationArtwork({
			state: paths.state,
			cacheRoot: paths.cacheRoot,
			inputs: [input(join(paths.root, "winner"))],
			resolver: {
				async resolve() {
					return {
						status: "selected",
						releaseGroupId: "group",
						releaseId: "release",
						url: "https://example.test/cover.jpg",
						bytes,
						width: 500,
						height: 500,
					};
				},
			},
			enabled: true,
		});
		const artwork = result[0].automaticArtwork;
		if (artwork?.cacheObject === undefined) {
			throw new Error("Selected artwork cache object is required");
		}

		expect(artwork.metadataFingerprint).toBe(
			artworkMetadataFingerprint(result[0]),
		);
		expect(
			await lstat(
				join(paths.cacheRoot, artwork.cacheObject.relativePath),
			),
		).toMatchObject({ size: 4 });
		paths.state.close();
	});
});
