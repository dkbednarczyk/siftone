import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readlink,
	rename,
	rm,
	symlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { mapBounded } from "../util/util";
import type { PlannedSymlink } from "./plan";

const SOURCE_VERIFICATION_CONCURRENCY = 32;
const ALBUM_STAGING_CONCURRENCY = 4;
const ENTRY_IO_CONCURRENCY = 8;

export type PublicationInput = Readonly<{
	root: string;
	/** Stable tag-derived identity, never a sanitized output path. */
	logicalReleaseKey: string;
	albumArtist: string;
	albumTitle: string;
	entries: readonly PlannedSymlink[];
}>;

export type PublicationResult = Readonly<{
	createdAlbums: number;
	unchangedAlbums: number;
	createdSymlinks: number;
}>;

export type PublicationHooks = Readonly<{
	/** Test-only coordination point after staging and before commits. */
	beforeCommit?: () => void | Promise<void>;
	/** Test-only coordination point before each individual album commit. */
	beforePublishAlbum?: (albumPath: string) => void | Promise<void>;
}>;

type AlbumPlan = Readonly<{
	path: string;
	artistPath: string;
	entries: readonly PlannedSymlink[];
}>;

export class PublicationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PublicationError";
	}
}

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}

function isWithin(parentPath: string, childPath: string): boolean {
	const difference = relative(parentPath, childPath);
	return (
		difference !== "" &&
		difference !== ".." &&
		!difference.startsWith(`..${sep}`) &&
		!isAbsolute(difference)
	);
}

async function pathStatus(path: string) {
	try {
		return await lstat(path);
	} catch (error) {
		if (isMissing(error)) {
			return undefined;
		}
		throw error;
	}
}

function createAlbumPlans(
	generatedLibraryRoot: string,
	inputs: readonly PublicationInput[],
): readonly AlbumPlan[] {
	const albums = new Map<string, AlbumPlan>();
	const destinations = new Set<string>();

	for (const input of inputs) {
		if (input.entries.length === 0) {
			throw new PublicationError(
				`Candidate ${input.root} has no planned entries`,
			);
		}

		const albumPath = dirname(input.entries[0].destinationPath);
		const artistPath = dirname(albumPath);
		if (!isWithin(generatedLibraryRoot, albumPath)) {
			throw new PublicationError(
				`Candidate ${input.root} escapes the generated-library root`,
			);
		}

		const segments = relative(generatedLibraryRoot, albumPath).split(sep);
		if (
			segments.length !== 2 ||
			segments.some((segment) => segment.length === 0)
		) {
			throw new PublicationError(
				`Candidate ${input.root} does not target an artist/album directory`,
			);
		}

		if (albums.has(albumPath)) {
			throw new PublicationError(
				`Multiple candidates target ${albumPath}`,
			);
		}

		for (const entry of input.entries) {
			if (
				dirname(entry.destinationPath) !== albumPath ||
				!isAbsolute(entry.sourcePath) ||
				!isWithin(albumPath, entry.destinationPath) ||
				destinations.has(entry.destinationPath)
			) {
				throw new PublicationError(
					`Candidate ${input.root} has an unsafe or duplicate planned destination`,
				);
			}
			destinations.add(entry.destinationPath);
		}

		albums.set(albumPath, {
			path: albumPath,
			artistPath,
			entries: input.entries,
		});
	}

	return [...albums.values()].toSorted((first, second) =>
		first.path.localeCompare(second.path),
	);
}

async function verifySourceFiles(albums: readonly AlbumPlan[]): Promise<void> {
	const entries = albums.flatMap((album) => album.entries);
	await mapBounded(
		entries,
		async (entry) => {
			const status = await pathStatus(entry.sourcePath);
			if (
				status === undefined ||
				status.isSymbolicLink() ||
				!status.isFile()
			) {
				throw new PublicationError(
					`Planned source is not a real source file: ${entry.sourcePath}`,
				);
			}
		},
		SOURCE_VERIFICATION_CONCURRENCY,
	);
}

async function verifyExactAlbum(album: AlbumPlan): Promise<boolean> {
	const expectedEntries = new Map(
		album.entries.map((entry) => [basename(entry.destinationPath), entry]),
	);
	const entries = await readdir(album.path, { withFileTypes: true });
	if (entries.length !== expectedEntries.size) {
		return false;
	}

	const matches = await mapBounded(
		entries,
		async (entry) => {
			const expected = expectedEntries.get(entry.name);
			if (expected === undefined) {
				return false;
			}

			const path = join(album.path, entry.name);
			const status = await lstat(path);
			return (
				status.isSymbolicLink() &&
				(await readlink(path)) === expected.sourcePath
			);
		},
		ENTRY_IO_CONCURRENCY,
	);

	return matches.every(Boolean);
}

async function inspectGeneratedLibrary(
	generatedLibraryRoot: string,
	albums: readonly AlbumPlan[],
): Promise<Set<string>> {
	const albumPaths = new Map(albums.map((album) => [album.path, album]));
	const expectedArtists = new Map<string, Set<string>>();
	for (const album of albums) {
		const existing =
			expectedArtists.get(album.artistPath) ?? new Set<string>();
		existing.add(album.path);
		expectedArtists.set(album.artistPath, existing);
	}

	const rootStatus = await pathStatus(generatedLibraryRoot);
	if (rootStatus === undefined) {
		return new Set<string>();
	}
	if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
		throw new PublicationError(
			`Generated-library root is not a directory: ${generatedLibraryRoot}`,
		);
	}

	const unchanged = new Set<string>();
	for (const artistEntry of await readdir(generatedLibraryRoot, {
		withFileTypes: true,
	})) {
		const artistPath = join(generatedLibraryRoot, artistEntry.name);
		const expectedAlbums = expectedArtists.get(artistPath);
		if (
			expectedAlbums === undefined ||
			artistEntry.isSymbolicLink() ||
			!artistEntry.isDirectory()
		) {
			throw new PublicationError(
				`Unmanaged generated-library entry: ${artistPath}`,
			);
		}

		for (const albumEntry of await readdir(artistPath, {
			withFileTypes: true,
		})) {
			const albumPath = join(artistPath, albumEntry.name);
			const album = albumPaths.get(albumPath);
			if (
				album === undefined ||
				albumEntry.isSymbolicLink() ||
				!albumEntry.isDirectory()
			) {
				throw new PublicationError(
					`Unmanaged generated-library entry: ${albumPath}`,
				);
			}
			if (!(await verifyExactAlbum(album))) {
				throw new PublicationError(
					`Existing generated album does not exactly match its plan: ${albumPath}`,
				);
			}
			unchanged.add(albumPath);
		}
	}

	return unchanged;
}

async function ensureRealDirectory(
	path: string,
	description: string,
): Promise<Awaited<ReturnType<typeof lstat>>> {
	const status = await lstat(path);
	if (status.isSymbolicLink() || !status.isDirectory()) {
		throw new PublicationError(
			`${description} is not a real directory: ${path}`,
		);
	}
	return status;
}

async function ensureSafeArtistDirectory(artistPath: string): Promise<void> {
	await ensureRealDirectory(artistPath, "Generated artist path");
}

async function ensureDestinationIsMissing(
	destinationPath: string,
): Promise<void> {
	if ((await pathStatus(destinationPath)) !== undefined) {
		throw new PublicationError(
			`Generated album appeared during publication: ${destinationPath}`,
		);
	}
}

async function createStagedAlbum(
	stagingPath: string,
	album: AlbumPlan,
): Promise<void> {
	await mkdir(stagingPath);
	await mapBounded(
		album.entries,
		async (entry) => {
			const sourceStatus = await pathStatus(entry.sourcePath);
			if (
				sourceStatus === undefined ||
				sourceStatus.isSymbolicLink() ||
				!sourceStatus.isFile()
			) {
				throw new PublicationError(
					`Planned source changed before publication: ${entry.sourcePath}`,
				);
			}
			await symlink(
				entry.sourcePath,
				join(stagingPath, basename(entry.destinationPath)),
			);
		},
		ENTRY_IO_CONCURRENCY,
	);
}

/**
 * Publishes complete planned albums without ever replacing or adopting an
 * existing generated entry. Exact prior output is treated as an idempotent
 * success; every other pre-existing entry aborts before new albums are made.
 */
export async function publishPlans({
	generatedLibraryRoot,
	stagingRoot,
	inputs,
	beforeCommit,
	beforePublishAlbum,
}: Readonly<{
	generatedLibraryRoot: string;
	stagingRoot: string;
	inputs: readonly PublicationInput[];
}> &
	PublicationHooks): Promise<PublicationResult> {
	const albums = createAlbumPlans(generatedLibraryRoot, inputs);
	await verifySourceFiles(albums);
	const unchanged = await inspectGeneratedLibrary(
		generatedLibraryRoot,
		albums,
	);
	const pending = albums.filter((album) => !unchanged.has(album.path));
	if (pending.length === 0) {
		return {
			createdAlbums: 0,
			unchangedAlbums: unchanged.size,
			createdSymlinks: 0,
		};
	}

	await mkdir(generatedLibraryRoot, { recursive: true });
	await mkdir(stagingRoot, { recursive: true });
	const [generatedStatus, stagingStatus] = await Promise.all([
		ensureRealDirectory(generatedLibraryRoot, "Generated-library root"),
		ensureRealDirectory(stagingRoot, "Staging root"),
	]);
	if (generatedStatus.dev !== stagingStatus.dev) {
		throw new PublicationError(
			"Staging and generated-library roots must be on the same filesystem",
		);
	}

	let operationPath: string | undefined;
	try {
		const stagingOperationPath = await mkdtemp(
			join(stagingRoot, "publication-"),
		);
		operationPath = stagingOperationPath;
		await mapBounded(
			pending.map((album, index) => ({ album, index })),
			({ album, index }) =>
				createStagedAlbum(
					join(stagingOperationPath, String(index)),
					album,
				),
			ALBUM_STAGING_CONCURRENCY,
		);

		await beforeCommit?.();
		// Commits remain serial: partial success is deliberate and hooks observe order.
		await mapBounded(
			pending.map((album, index) => ({ album, index })),
			async ({ album, index }) => {
				await beforePublishAlbum?.(album.path);
				await mkdir(album.artistPath, { recursive: true });
				await ensureSafeArtistDirectory(album.artistPath);
				await ensureDestinationIsMissing(album.path);
				await rename(
					join(stagingOperationPath, String(index)),
					album.path,
				);
			},
			1,
		);
	} finally {
		if (operationPath !== undefined) {
			await rm(operationPath, {
				force: true,
				recursive: true,
			});
		}
	}

	return {
		createdAlbums: pending.length,
		unchangedAlbums: unchanged.size,
		createdSymlinks: pending.reduce(
			(total, album) => total + album.entries.length,
			0,
		),
	};
}
