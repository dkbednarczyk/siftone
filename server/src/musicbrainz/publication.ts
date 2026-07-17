import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	ArtworkCacheObject,
	AutomaticArtwork,
	PublicationInput,
} from "../publication/publish";

export type {
	ArtworkCacheObject,
	AutomaticArtwork,
} from "../publication/publish";

import type { ImportState } from "../state/import-state";
import { bigintRow } from "../state/reconcile/database";
import {
	type CoverArtArchiveClient,
	createCoverArtArchiveClient,
	createMusicBrainzClient,
	type MusicBrainzClient,
} from "./clients";
import { type ArtworkResolution, resolveArtwork } from "./resolver";
import {
	createRateLimitedScheduler,
	createSerializedScheduler,
	type TaskScheduler,
} from "./scheduler";

export const AUTOMATIC_ARTWORK_RESOLVER_VERSION = "musicbrainz-caa-v1";

export type AutomaticArtworkResolver = Readonly<{
	resolve(
		input: Pick<PublicationInput, "albumArtist" | "albumTitle">,
	): Promise<ArtworkResolution>;
}>;

type StoredAutomaticArtwork = Readonly<{
	metadata_fingerprint: string;
	resolver_version: string;
	status: ArtworkResolution["status"];
	cache_sha256: string | null;
	relative_path: string | null;
	byte_size: number | null;
	width: number | null;
	height: number | null;
	release_group_mbid: string | null;
	release_mbid: string | null;
	source_url: string | null;
	failure_detail: string | null;
	attempt_count: bigint;
	attempted_at_ns: bigint;
	next_attempt_at_ns: bigint | null;
}>;

function normalizedMetadataPart(value: string): string {
	return value
		.normalize("NFKC")
		.trim()
		.replace(/\s+/gu, " ")
		.toLocaleLowerCase();
}

export function artworkMetadataFingerprint(
	input: Pick<PublicationInput, "albumArtist" | "albumTitle">,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				normalizedMetadataPart(input.albumArtist),
				normalizedMetadataPart(input.albumTitle),
			]),
		)
		.digest("hex");
}

function hasLocalArtwork(input: PublicationInput): boolean {
	return input.entries.some((entry) =>
		/\.(jpe?g|png)$/iu.test(entry.sourcePath),
	);
}

function storedArtwork(
	row: StoredAutomaticArtwork,
	metadataFingerprint: string,
	enabled: boolean,
	nowNs: bigint,
): AutomaticArtwork | undefined {
	if (
		row.metadata_fingerprint !== metadataFingerprint ||
		row.resolver_version !== AUTOMATIC_ARTWORK_RESOLVER_VERSION ||
		(row.status === "disabled" && enabled) ||
		(row.status === "transient_failure" &&
			row.next_attempt_at_ns !== null &&
			row.next_attempt_at_ns <= nowNs)
	) {
		return undefined;
	}

	if (row.status === "selected") {
		if (
			row.cache_sha256 === null ||
			row.relative_path === null ||
			row.byte_size === null ||
			row.width === null ||
			row.height === null
		) {
			throw new Error(
				"Selected automatic artwork is missing its cache object",
			);
		}

		return {
			metadataFingerprint,
			resolverVersion: AUTOMATIC_ARTWORK_RESOLVER_VERSION,
			status: row.status,
			cacheObject: {
				sha256: row.cache_sha256,
				relativePath: row.relative_path,
				byteSize: row.byte_size,
				width: row.width,
				height: row.height,
			},
			releaseGroupId: row.release_group_mbid ?? undefined,
			releaseId: row.release_mbid ?? undefined,
			sourceUrl: row.source_url ?? undefined,
			failureDetail: row.failure_detail ?? undefined,
			attemptCount: Number(row.attempt_count),
			attemptedAtNs: row.attempted_at_ns,
			nextAttemptAtNs: row.next_attempt_at_ns ?? undefined,
		};
	}

	return {
		metadataFingerprint,
		resolverVersion: AUTOMATIC_ARTWORK_RESOLVER_VERSION,
		status: row.status,
		failureDetail: row.failure_detail ?? undefined,
		attemptCount: Number(row.attempt_count),
		attemptedAtNs: row.attempted_at_ns,
		nextAttemptAtNs: row.next_attempt_at_ns ?? undefined,
	};
}

async function installArtworkObject(
	resolution: Extract<ArtworkResolution, { status: "selected" }>,
	cacheRoot: string,
): Promise<ArtworkCacheObject> {
	if (
		resolution.bytes.byteLength > 5 * 1024 * 1024 ||
		resolution.width < 500 ||
		resolution.height < 500
	) {
		throw new Error("Selected artwork does not meet cache requirements");
	}

	const sha256 = createHash("sha256").update(resolution.bytes).digest("hex");
	const relativePath = `artwork/sha256/${sha256.slice(0, 2)}/${sha256}.jpg`;
	const directory = join(cacheRoot, "artwork", "sha256", sha256.slice(0, 2));
	const destination = join(cacheRoot, relativePath);

	await mkdir(directory, { recursive: true });
	try {
		const existing = await lstat(destination);
		if (!existing.isFile() || existing.isSymbolicLink()) {
			throw new Error(
				`Artwork cache object is not a real file: ${destination}`,
			);
		}
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!("code" in error) ||
			error.code !== "ENOENT"
		) {
			throw error;
		}

		const temporary = join(directory, `.${sha256}.${randomUUID()}.tmp`);
		try {
			await writeFile(temporary, resolution.bytes, { flag: "wx" });
			await rename(temporary, destination);
		} catch (renameError) {
			if (
				!(renameError instanceof Error) ||
				!("code" in renameError) ||
				renameError.code !== "EEXIST"
			) {
				throw renameError;
			}
		} finally {
			await rm(temporary, { force: true });
		}
	}

	return {
		sha256,
		relativePath,
		byteSize: resolution.bytes.byteLength,
		width: resolution.width,
		height: resolution.height,
	};
}

function retryAtNs(attemptCount: number, nowNs: bigint): bigint {
	const delaySeconds = 2 ** Math.min(attemptCount, 16);
	return nowNs + BigInt(delaySeconds) * 1_000_000_000n;
}

async function resolveFreshArtwork({
	input,
	resolver,
	cacheRoot,
	attemptCount,
	nowNs,
}: Readonly<{
	input: PublicationInput;
	resolver: AutomaticArtworkResolver;
	cacheRoot: string;
	attemptCount: number;
	nowNs: bigint;
}>): Promise<AutomaticArtwork> {
	let attempts = 0;
	let resolution: ArtworkResolution;
	do {
		resolution = await resolver.resolve(input);
		attempts += 1;
	} while (resolution.status === "transient_failure" && attempts < 3);

	const totalAttempts = attemptCount + attempts;
	if (resolution.status === "selected") {
		return {
			metadataFingerprint: artworkMetadataFingerprint(input),
			resolverVersion: AUTOMATIC_ARTWORK_RESOLVER_VERSION,
			status: resolution.status,
			cacheObject: await installArtworkObject(resolution, cacheRoot),
			releaseGroupId: resolution.releaseGroupId,
			releaseId: resolution.releaseId,
			sourceUrl: resolution.url,
			attemptCount: totalAttempts,
			attemptedAtNs: nowNs,
		};
	}

	return {
		metadataFingerprint: artworkMetadataFingerprint(input),
		resolverVersion: AUTOMATIC_ARTWORK_RESOLVER_VERSION,
		status: resolution.status,
		attemptCount: totalAttempts,
		attemptedAtNs: nowNs,
		...(resolution.status === "transient_failure"
			? { nextAttemptAtNs: retryAtNs(totalAttempts, nowNs) }
			: {}),
	};
}

function failureDetail(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(
		0,
		1_000,
	);
}

function existingArtwork(
	state: ImportState,
	input: PublicationInput,
): StoredAutomaticArtwork | undefined {
	return (
		bigintRow(
			state.database.query<StoredAutomaticArtwork, [string, string]>(
				`SELECT aa.metadata_fingerprint, aa.resolver_version, aa.status, aa.cache_sha256,
				aco.relative_path, aco.byte_size, aco.width, aco.height,
				aa.release_group_mbid, aa.release_mbid, aa.source_url, aa.failure_detail,
				aa.attempt_count, aa.attempted_at_ns, aa.next_attempt_at_ns
			FROM automatic_artwork aa
			JOIN source_releases sr ON sr.id = aa.source_release_id
			LEFT JOIN artwork_cache_objects aco ON aco.sha256 = aa.cache_sha256
			WHERE sr.container_id = (SELECT id FROM source_containers WHERE root_path = ?)
			AND sr.logical_release_key = ?`,
			),
			input.root,
			input.logicalReleaseKey,
		) ?? undefined
	);
}

/** Resolves only already-arbitrated artless winners and preserves their order. */
export async function resolvePublicationArtwork({
	state,
	cacheRoot,
	inputs,
	resolver,
	enabled,
	nowNs = () => BigInt(Date.now()) * 1_000_000n,
}: Readonly<{
	state: ImportState;
	cacheRoot: string;
	inputs: readonly PublicationInput[];
	resolver: AutomaticArtworkResolver;
	enabled: boolean;
	nowNs?: () => bigint;
}>): Promise<PublicationInput[]> {
	return Promise.all(
		inputs.map(async (input) => {
			if (hasLocalArtwork(input)) {
				return input;
			}

			const fingerprint = artworkMetadataFingerprint(input);
			const existing = existingArtwork(state, input);
			const timestamp = nowNs();
			const current =
				existing === undefined
					? undefined
					: storedArtwork(existing, fingerprint, enabled, timestamp);
			if (current !== undefined) {
				return { ...input, automaticArtwork: current };
			}

			try {
				const automaticArtwork = await resolveFreshArtwork({
					input,
					resolver,
					cacheRoot,
					attemptCount: Number(existing?.attempt_count ?? 0n),
					nowNs: timestamp,
				});

				return { ...input, automaticArtwork };
			} catch (error) {
				const attemptCount = Number(existing?.attempt_count ?? 0n) + 1;

				return {
					...input,
					automaticArtwork: {
						metadataFingerprint: fingerprint,
						resolverVersion: AUTOMATIC_ARTWORK_RESOLVER_VERSION,
						status: "transient_failure",
						failureDetail: failureDetail(error),
						attemptCount,
						attemptedAtNs: timestamp,
						nextAttemptAtNs: retryAtNs(attemptCount, timestamp),
					},
				};
			}
		}),
	);
}

export function createAutomaticArtworkResolver({
	contact,
	appName,
	appVersion,
	musicBrainz,
	coverArtArchive = createCoverArtArchiveClient(),
	musicBrainzScheduler = createRateLimitedScheduler(),
	coverArtScheduler = createSerializedScheduler(),
}: Readonly<{
	contact?: string;
	appName: string;
	appVersion: string;
	musicBrainz?: MusicBrainzClient;
	coverArtArchive?: CoverArtArchiveClient;
	musicBrainzScheduler?: TaskScheduler;
	coverArtScheduler?: TaskScheduler;
}>): AutomaticArtworkResolver {
	const enabled = typeof contact === "string" && contact.trim().length > 0;
	const musicBrainzClient =
		musicBrainz ??
		(enabled && contact !== undefined
			? createMusicBrainzClient({ appName, appVersion, contact })
			: undefined);

	return {
		resolve(input) {
			if (!enabled || musicBrainzClient === undefined) {
				return Promise.resolve({ status: "disabled" });
			}

			return resolveArtwork({
				artist: input.albumArtist,
				album: input.albumTitle,
				enabled,
				musicBrainz: musicBrainzClient,
				coverArtArchive,
				musicBrainzScheduler,
				coverArtScheduler,
			});
		},
	};
}
