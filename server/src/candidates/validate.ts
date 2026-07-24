import { basename, dirname, extname, relative, sep } from "node:path";
import type { AudioTagReader, AudioTags } from "../metadata/tags";
import type { DiscoveredCandidate } from "./discover";

export type IssueCode =
	| "TAG_READ_ERROR"
	| "MISSING_TITLE"
	| "MISSING_ARTIST"
	| "MISSING_ALBUM"
	| "MISSING_TRACK_NUMBER"
	| "INVALID_TRACK_NUMBER"
	| "INVALID_DISC_NUMBER"
	| "CONFLICTING_ALBUM"
	| "CONFLICTING_ALBUM_ARTIST"
	| "DUPLICATE_DISC_TRACK";

export type ValidationIssue = Readonly<{
	code: IssueCode;
	message: string;
	path?: string;
}>;

export type ValidationWarning = Readonly<{
	code: "MULTIPLE_ARTWORK_CANDIDATES";
	message: string;
	selectedPath: string;
	ignoredPaths: readonly string[];
}>;

export type ValidatedTrack = Readonly<{
	path: string;
	title: string;
	artist: string;
	trackNumber: number;
	discNumber: number;
}>;

type PendingTrack = Readonly<{
	path: string;
	title: string;
	artist: string;
	trackNumber: number;
	discNumber?: number;
}>;

export type ValidatedCandidate = Readonly<{
	root: string;
	album: string;
	albumArtist: string;
	tracks: readonly ValidatedTrack[];
	artworkPath?: string;
}>;

export type ValidationResult =
	| Readonly<{
			valid: true;
			candidate: ValidatedCandidate;
			warnings?: readonly ValidationWarning[];
	  }>
	| Readonly<{
			valid: false;
			root: string;
			issues: readonly ValidationIssue[];
	  }>;

type ArtworkSelection = Readonly<{
	path?: string;
	warning?: ValidationWarning;
}>;

function requiredText(value: string | undefined): string | undefined {
	const text = value?.trim();

	return text === "" ? undefined : text;
}

function isPositiveInteger(value: number | undefined): value is number {
	return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

function issue(
	code: IssueCode,
	message: string,
	path?: string,
): ValidationIssue {
	return { code, message, path };
}

function normalizeArtworkName(value: string): string {
	return value
		.normalize("NFKD") // Decompose accents and compatibility characters
		.replace(/\p{M}/gu, "") // Remove combining marks such as accents
		.replace(/[^\p{L}\p{N}]+/gu, "") // Remove everything except Unicode letters/numbers
		.toLowerCase();
}

function compareArtworkPaths(
	root: string,
	first: string,
	second: string,
): number {
	const firstDepth = relative(root, first).split(sep).length;
	const secondDepth = relative(root, second).split(sep).length;

	if (firstDepth !== secondDepth) {
		return firstDepth - secondDepth;
	}

	if (first < second) {
		return -1;
	}

	if (first > second) {
		return 1;
	}

	return 0;
}

function selectArtworkPath(
	candidate: DiscoveredCandidate,
	tracks: readonly ValidatedTrack[],
	album: string,
): ArtworkSelection {
	const albumName = normalizeArtworkName(album);

	const eligibleDirectories = new Set([
		candidate.root,
		...tracks.map((track) => dirname(track.path)),
	]);

	const eligiblePaths = candidate.imagePaths.filter((path) =>
		eligibleDirectories.has(dirname(path)),
	);

	const selections = [
		{
			label: "cover",
			matches: eligiblePaths.filter(
				(path) =>
					normalizeArtworkName(basename(path, extname(path))) ===
					"cover",
			),
		},
		{
			label: "album-name",
			matches: eligiblePaths.filter(
				(path) =>
					normalizeArtworkName(basename(path, extname(path))) ===
					albumName,
			),
		},
	];

	for (const selection of selections) {
		const matches = selection.matches.toSorted((first, second) =>
			compareArtworkPaths(candidate.root, first, second),
		);

		const [path, ...ignoredPaths] = matches;

		// no matches
		if (path === undefined) {
			continue;
		}

		// one match
		if (ignoredPaths.length === 0) {
			return { path };
		}

		// multiple
		return {
			path,
			warning: {
				code: "MULTIPLE_ARTWORK_CANDIDATES",
				message: `Selected ${path} from ${selection.label} artwork candidates; ignored ${ignoredPaths.join(", ")}`,
				selectedPath: path,
				ignoredPaths,
			},
		};
	}

	return {};
}

function inferDiscNumber(root: string, path: string): number | undefined {
	const components = relative(root, path).split(sep);
	const directory = components[0];

	if (directory === undefined || components.length !== 2) {
		return undefined;
	}

	const match = /^(?:cd|disc)[ _-]?([1-9]\d*)$/iu.exec(directory);
	if (match === null) {
		return undefined;
	}

	const discNumber = Number(match[1]);

	return Number.isSafeInteger(discNumber) ? discNumber : undefined;
}

function hasDuplicateTrackNumbers(tracks: readonly PendingTrack[]): boolean {
	const trackNumbers = new Set<number>();

	for (const track of tracks) {
		if (trackNumbers.has(track.trackNumber)) {
			return true;
		}

		trackNumbers.add(track.trackNumber);
	}

	return false;
}

function resolveDiscNumbers(
	root: string,
	tracks: readonly PendingTrack[],
): ValidatedTrack[] {
	const needsDirectoryInference =
		tracks.every((track) => track.discNumber === undefined) &&
		hasDuplicateTrackNumbers(tracks);

	if (needsDirectoryInference) {
		const inferredDiscNumbers = tracks.map((track) =>
			inferDiscNumber(root, track.path),
		);

		if (inferredDiscNumbers.every(isPositiveInteger)) {
			return tracks.map((track, index) => ({
				...track,
				discNumber: inferredDiscNumbers[index],
			}));
		}
	}

	return tracks.map((track) => ({
		...track,
		discNumber: track.discNumber ?? 1,
	}));
}

/**
 * Validates the embedded metadata required to create a deterministic album
 * layout. It reports issues from the first invalid file instead of throwing so
 * a bad release cannot stop discovery of other source folders or spam logs.
 */
export async function validateCandidate(
	candidate: DiscoveredCandidate,
	readTags: AudioTagReader,
): Promise<ValidationResult> {
	const issues: ValidationIssue[] = [];
	const tracks: PendingTrack[] = [];

	let expectedAlbum: string | undefined;

	const albumArtists = new Set<string>();
	const artists = new Set<string>();

	for (const path of candidate.audioPaths) {
		let tags: AudioTags;
		try {
			tags = await readTags(path);
		} catch (error) {
			issues.push(
				issue(
					"TAG_READ_ERROR",
					error instanceof Error ? error.message : String(error),
					path,
				),
			);
			break;
		}

		const title = requiredText(tags.title);
		const artist = requiredText(tags.artist);
		const trackAlbum = requiredText(tags.album);
		const trackAlbumArtist = requiredText(tags.albumArtist);
		const fileIssues: ValidationIssue[] = [];

		if (title === undefined) {
			fileIssues.push(issue("MISSING_TITLE", "TITLE is required", path));
		}

		if (artist === undefined) {
			fileIssues.push(
				issue("MISSING_ARTIST", "ARTIST is required", path),
			);
		}

		if (trackAlbum === undefined) {
			fileIssues.push(issue("MISSING_ALBUM", "ALBUM is required", path));
		}

		if (tags.trackNumber === undefined) {
			fileIssues.push(
				issue("MISSING_TRACK_NUMBER", "TRACKNUMBER is required", path),
			);
		} else if (!isPositiveInteger(tags.trackNumber)) {
			fileIssues.push(
				issue(
					"INVALID_TRACK_NUMBER",
					"TRACKNUMBER must be positive",
					path,
				),
			);
		}

		if (
			tags.discNumber !== undefined &&
			!isPositiveInteger(tags.discNumber)
		) {
			fileIssues.push(
				issue(
					"INVALID_DISC_NUMBER",
					"DISCNUMBER must be positive",
					path,
				),
			);
		}

		if (fileIssues.length !== 0) {
			issues.push(...fileIssues);
			break;
		}

		if (
			title === undefined ||
			artist === undefined ||
			trackAlbum === undefined ||
			!isPositiveInteger(tags.trackNumber)
		) {
			throw new Error("Candidate validation invariant violated");
		}

		if (expectedAlbum !== undefined && expectedAlbum !== trackAlbum) {
			issues.push(
				issue("CONFLICTING_ALBUM", "Tracks must share one ALBUM", path),
			);

			break;
		}

		if (
			trackAlbumArtist !== undefined &&
			albumArtists.size > 0 &&
			!albumArtists.has(trackAlbumArtist)
		) {
			issues.push(
				issue(
					"CONFLICTING_ALBUM_ARTIST",
					"Tracks with the same ALBUM must share one ALBUMARTIST when present",
					path,
				),
			);

			break;
		}

		expectedAlbum = trackAlbum;
		if (trackAlbumArtist !== undefined) {
			albumArtists.add(trackAlbumArtist);
		}
		artists.add(artist);

		tracks.push({
			path,
			title,
			artist,
			trackNumber: tags.trackNumber,
			discNumber: tags.discNumber,
		});
	}

	if (issues.length > 0) {
		return { valid: false, root: candidate.root, issues };
	}

	if (expectedAlbum === undefined || tracks.length === 0) {
		return {
			valid: false,
			root: candidate.root,
			issues: [issue("MISSING_ALBUM", "ALBUM is required")],
		};
	}

	const resolvedTracks = resolveDiscNumbers(candidate.root, tracks);
	const discTracks = new Set<string>();

	for (const track of resolvedTracks) {
		const discTrackKey = `${track.discNumber}:${track.trackNumber}`;
		if (discTracks.has(discTrackKey)) {
			return {
				valid: false,
				root: candidate.root,
				issues: [
					issue(
						"DUPLICATE_DISC_TRACK",
						`Duplicate disc and track number ${discTrackKey}`,
						track.path,
					),
				],
			};
		}

		discTracks.add(discTrackKey);
	}

	const [explicitAlbumArtist] = albumArtists;
	const albumArtist =
		explicitAlbumArtist ??
		(artists.size === 1 ? tracks[0].artist : "Various Artists");
	const artwork = selectArtworkPath(candidate, resolvedTracks, expectedAlbum);
	return {
		valid: true,
		candidate: {
			root: candidate.root,
			album: expectedAlbum,
			albumArtist,
			tracks: resolvedTracks,
			...(artwork.path === undefined
				? {}
				: { artworkPath: artwork.path }),
		},
		...(artwork.warning === undefined
			? {}
			: { warnings: [artwork.warning] }),
	};
}
