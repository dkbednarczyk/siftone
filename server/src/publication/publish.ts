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
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { isDescendant, isMissingError, isRealDirectory } from "../util/path";
import type { PlannedSymlink } from "./plan";

export type AutomaticArtworkStatus =
	| "disabled"
	| "no_match"
	| "no_eligible_edition"
	| "no_qualifying_cover"
	| "edition_cap_reached"
	| "transient_failure"
	| "selected";

export type ArtworkCacheObject = Readonly<{
	sha256: string;
	relativePath: string;
	byteSize: number;
	width: number;
	height: number;
}>;

export type AutomaticArtwork = Readonly<{
	metadataFingerprint: string;
	resolverVersion: string;
	status: AutomaticArtworkStatus;
	cacheObject?: ArtworkCacheObject;
	releaseGroupId?: string;
	releaseId?: string;
	sourceUrl?: string;
	failureDetail?: string;
	attemptCount: number;
	attemptedAtNs: bigint;
	nextAttemptAtNs?: bigint;
}>;

export type PublicationInput = Readonly<{
	root: string;
	logicalReleaseKey: string;
	albumArtist: string;
	albumTitle: string;
	entries: readonly PlannedSymlink[];
	automaticArtwork?: AutomaticArtwork;
}>;
export type PublicationResult = Readonly<{
	createdAlbums: number;
	unchangedAlbums: number;
	createdSymlinks: number;
}>;
export type PublicationHooks = Readonly<{
	beforeCommit?: () => void | Promise<void>;
	beforePublishAlbum?: (albumPath: string) => void | Promise<void>;
}>;
type AlbumPlan = Readonly<{
	path: string;
	artistPath: string;
	entries: readonly PlannedSymlink[];
}>;
export class PublicationError extends Error {}

async function status(path: string) {
	try {
		return await lstat(path);
	} catch (error) {
		if (isMissingError(error)) {
			return undefined;
		}
		throw error;
	}
}
function plans(root: string, inputs: readonly PublicationInput[]): AlbumPlan[] {
	const output = new Map<string, AlbumPlan>();
	for (const input of inputs) {
		const path = dirname(input.entries[0]?.destinationPath ?? "");
		const artistPath = dirname(path);
		if (
			input.entries.length === 0 ||
			!isDescendant(root, path) ||
			relative(root, path).split(sep).length !== 2
		) {
			throw new PublicationError(`Unsafe album plan: ${input.root}`);
		}
		if (output.has(path)) {
			throw new PublicationError(`Multiple candidates target ${path}`);
		}
		for (const entry of input.entries) {
			if (
				!isAbsolute(entry.sourcePath) ||
				dirname(entry.destinationPath) !== path ||
				!isDescendant(path, entry.destinationPath)
			) {
				throw new PublicationError(
					`Unsafe planned destination: ${entry.destinationPath}`,
				);
			}
		}
		output.set(path, { path, artistPath, entries: input.entries });
	}
	return [...output.values()].toSorted((a, b) =>
		a.path.localeCompare(b.path),
	);
}
async function exactEntries(
	path: string,
	entries: readonly PlannedSymlink[],
): Promise<boolean> {
	try {
		const expected = new Map(
			entries.map((entry) => [
				basename(entry.destinationPath),
				entry.sourcePath,
			]),
		);
		const output = await readdir(path, { withFileTypes: true });
		if (output.length !== expected.size) {
			return false;
		}
		for (const entry of output) {
			if (
				!entry.isSymbolicLink() ||
				expected.get(entry.name) !==
					(await readlink(join(path, entry.name)))
			) {
				return false;
			}
		}

		return true;
	} catch {
		return false;
	}
}
async function ownedLeaf(
	leaf: string,
	versionRoot: string,
): Promise<string | undefined> {
	try {
		const leafStatus = await lstat(leaf);
		if (!leafStatus.isSymbolicLink()) {
			return undefined;
		}
		const target = await readlink(leaf);
		const version = resolve(dirname(leaf), target);
		if (!isDescendant(versionRoot, version)) {
			return undefined;
		}
		const versionStatus = await lstat(version);
		return versionStatus.isDirectory() && !versionStatus.isSymbolicLink()
			? version
			: undefined;
	} catch {
		return undefined;
	}
}
async function inspectRoot(
	root: string,
	albums: readonly AlbumPlan[],
): Promise<void> {
	const byArtist = new Map<string, Set<string>>();
	for (const album of albums) {
		const expected = byArtist.get(album.artistPath) ?? new Set<string>();
		expected.add(album.path);
		byArtist.set(album.artistPath, expected);
	}
	for (const artist of await readdir(root, { withFileTypes: true })) {
		if (artist.name === ".siftone") {
			continue;
		}
		const artistPath = join(root, artist.name);
		const expected = byArtist.get(artistPath);
		if (
			expected === undefined ||
			!artist.isDirectory() ||
			artist.isSymbolicLink()
		) {
			throw new PublicationError(
				`Unmanaged generated-library entry: ${artistPath}`,
			);
		}
		for (const album of await readdir(artistPath, {
			withFileTypes: true,
		})) {
			if (!expected.has(join(artistPath, album.name))) {
				throw new PublicationError(
					`Unmanaged generated-library entry: ${join(artistPath, album.name)}`,
				);
			}
		}
	}
}
async function stageAlbum(path: string, album: AlbumPlan): Promise<void> {
	await mkdir(path);
	for (const entry of album.entries) {
		const source = await lstat(entry.sourcePath);
		if (!source.isFile() || source.isSymbolicLink()) {
			throw new PublicationError(
				`Planned source is not a real file: ${entry.sourcePath}`,
			);
		}
		await symlink(
			entry.sourcePath,
			join(path, basename(entry.destinationPath)),
		);
	}
}

/** A standalone publisher with the same immutable-version/public-leaf swap protocol as reconciliation. */
export async function publishPlans({
	generatedLibraryRoot,
	stagingRoot,
	versionRoot = join(generatedLibraryRoot, ".siftone", "versions"),
	inputs,
	beforeCommit,
	beforePublishAlbum,
}: Readonly<{
	generatedLibraryRoot: string;
	stagingRoot: string;
	versionRoot?: string;
	inputs: readonly PublicationInput[];
}> &
	PublicationHooks): Promise<PublicationResult> {
	const albums = plans(generatedLibraryRoot, inputs);
	await Promise.all([
		mkdir(generatedLibraryRoot, { recursive: true }),
		mkdir(stagingRoot, { recursive: true }),
		mkdir(versionRoot, { recursive: true }),
	]);
	for (const [path, description] of [
		[generatedLibraryRoot, "Generated-library root"],
		[stagingRoot, "Staging root"],
		[versionRoot, "Version root"],
	] as const) {
		if (!(await isRealDirectory(path))) {
			throw new PublicationError(
				`${description} is not a real directory`,
			);
		}
	}
	await inspectRoot(generatedLibraryRoot, albums);
	const unchanged = new Set<string>();
	for (const album of albums) {
		const existing = await status(album.path);
		if (existing === undefined) {
			continue;
		}
		const version = await ownedLeaf(album.path, versionRoot);
		if (version === undefined) {
			if (existing.isDirectory() && !existing.isSymbolicLink()) {
				throw new PublicationError(
					`Existing generated album does not exactly match its plan: ${album.path}`,
				);
			}
			throw new PublicationError(
				`Unmanaged generated-library entry: ${album.path}`,
			);
		}
		if (await exactEntries(version, album.entries)) {
			unchanged.add(album.path);
		}
	}
	const pending = albums.filter((album) => !unchanged.has(album.path));
	if (pending.length === 0) {
		return {
			createdAlbums: 0,
			unchangedAlbums: unchanged.size,
			createdSymlinks: 0,
		};
	}
	const operation = await mkdtemp(join(stagingRoot, "publication-"));
	try {
		for (const [index, album] of pending.entries()) {
			await stageAlbum(join(operation, String(index)), album);
		}
		await beforeCommit?.();
		for (const [index, album] of pending.entries()) {
			await beforePublishAlbum?.(album.path);
			await mkdir(album.artistPath, { recursive: true });
			if (!(await isRealDirectory(album.artistPath))) {
				throw new PublicationError(
					`Generated artist path is unsafe: ${album.artistPath}`,
				);
			}
			const version = join(
				versionRoot,
				`${basename(operation)}-${index}`,
			);
			await rename(join(operation, String(index)), version);
			const temporary = join(
				dirname(album.path),
				`.siftone-link-${basename(operation)}-${index}`,
			);
			await symlink(relative(dirname(album.path), version), temporary);
			const existing = await status(album.path);
			if (
				existing !== undefined &&
				(await ownedLeaf(album.path, versionRoot)) === undefined
			) {
				throw new PublicationError(
					`Generated album appeared during publication: ${album.path}`,
				);
			}
			await rename(temporary, album.path);
		}
	} finally {
		await rm(operation, { recursive: true, force: true });
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
