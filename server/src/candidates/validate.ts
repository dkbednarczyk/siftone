import { basename, dirname, extname, relative, sep } from "node:path";
import type { AudioTags } from "../metadata/tags";
import { errorMessage } from "../util/util";
import type { DiscoveredCandidate } from "./discover";

export type CandidateValidationIssueCode =
	| "TAG_READ_ERROR"
	| "MISSING_TITLE"
	| "MISSING_ARTIST"
	| "MISSING_ALBUM"
	| "MISSING_TRACK_NUMBER"
	| "INVALID_TRACK_NUMBER"
	| "INVALID_DISC_NUMBER"
	| "CONFLICTING_ALBUM"
	| "CONFLICTING_ALBUM_ARTIST"
	| "MISSING_ALBUM_ARTIST"
	| "DUPLICATE_DISC_TRACK";

export type CandidateValidationIssue = Readonly<{
	code: CandidateValidationIssueCode;
	message: string;
	path?: string;
}>;

export type CandidateValidationWarning = Readonly<{
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

export type ValidatedCandidate = Readonly<{
	root: string;
	album: string;
	albumArtist: string;
	tracks: readonly ValidatedTrack[];
	artworkPath?: string;
}>;

export type CandidateValidationResult =
	| Readonly<{
			valid: true;
			candidate: ValidatedCandidate;
			warnings?: readonly CandidateValidationWarning[];
	  }>
	| Readonly<{
			valid: false;
			root: string;
			issues: readonly CandidateValidationIssue[];
	  }>;

export type AudioTagReader = (path: string) => Promise<AudioTags>;

function requiredText(value: string | undefined): string | undefined {
	const text = value?.trim();
	return text === "" ? undefined : text;
}

function isPositiveInteger(value: number | undefined): value is number {
	return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

function issue(
	code: CandidateValidationIssueCode,
	message: string,
	path?: string,
): CandidateValidationIssue {
	return { code, message, path };
}

function normalizeArtworkName(value: string): string {
	return value
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.replace(/[^\p{L}\p{N}]+/gu, "")
		.toLowerCase();
}

type ArtworkSelection = Readonly<{
	path?: string;
	warning?: CandidateValidationWarning;
}>;

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
					normalizeArtworkName(basename(path, extname(path))) === "cover",
			),
		},
		{
			label: "album-name",
			matches: eligiblePaths.filter(
				(path) =>
					normalizeArtworkName(basename(path, extname(path))) === albumName,
			),
		},
	];

	for (const selection of selections) {
		const matches = selection.matches.toSorted((first, second) =>
			compareArtworkPaths(candidate.root, first, second),
		);

		const [path, ...ignoredPaths] = matches;
		if (path === undefined) {
			continue;
		}
		if (ignoredPaths.length === 0) {
			return { path };
		}

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

/**
 * Validates the embedded metadata required to create a deterministic album
 * layout. It reports candidate errors instead of throwing so a bad release
 * cannot stop discovery of other source folders.
 */
export async function validateCandidate(
	candidate: DiscoveredCandidate,
	readTags: AudioTagReader,
): Promise<CandidateValidationResult> {
	const issues: CandidateValidationIssue[] = [];
	const tracks: ValidatedTrack[] = [];
	const albums = new Set<string>();
	const artists = new Set<string>();
	const albumArtists = new Set<string | undefined>();
	const discTracks = new Set<string>();

	for (const path of candidate.audioPaths) {
		let tags: AudioTags;
		try {
			tags = await readTags(path);
		} catch (error) {
			issues.push(issue("TAG_READ_ERROR", errorMessage(error), path));

			continue;
		}

		const title = requiredText(tags.title);
		const artist = requiredText(tags.artist);
		const album = requiredText(tags.album);
		const albumArtist = requiredText(tags.albumArtist);

		if (title === undefined) {
			issues.push(issue("MISSING_TITLE", "TITLE is required", path));
		}
		if (artist === undefined) {
			issues.push(issue("MISSING_ARTIST", "ARTIST is required", path));
		}
		if (album === undefined) {
			issues.push(issue("MISSING_ALBUM", "ALBUM is required", path));
		}
		if (tags.trackNumber === undefined) {
			issues.push(
				issue("MISSING_TRACK_NUMBER", "TRACKNUMBER is required", path),
			);
		} else if (!isPositiveInteger(tags.trackNumber)) {
			issues.push(
				issue("INVALID_TRACK_NUMBER", "TRACKNUMBER must be positive", path),
			);
		}
		if (tags.discNumber !== undefined && !isPositiveInteger(tags.discNumber)) {
			issues.push(
				issue("INVALID_DISC_NUMBER", "DISCNUMBER must be positive", path),
			);
		}

		if (artist !== undefined) {
			artists.add(artist);
		}
		if (album !== undefined) {
			albums.add(album);
		}
		albumArtists.add(albumArtist);

		if (
			title === undefined ||
			artist === undefined ||
			album === undefined ||
			!isPositiveInteger(tags.trackNumber) ||
			(tags.discNumber !== undefined && !isPositiveInteger(tags.discNumber))
		) {
			continue;
		}

		const discNumber = tags.discNumber ?? 1;
		const discTrackKey = `${discNumber}:${tags.trackNumber}`;
		if (discTracks.has(discTrackKey)) {
			issues.push(
				issue(
					"DUPLICATE_DISC_TRACK",
					`Duplicate disc and track number ${discTrackKey}`,
					path,
				),
			);
			continue;
		}

		discTracks.add(discTrackKey);
		tracks.push({
			path,
			title,
			artist,
			trackNumber: tags.trackNumber,
			discNumber,
		});
	}

	if (albums.size > 1) {
		issues.push(issue("CONFLICTING_ALBUM", "Tracks must share one ALBUM"));
	}
	if (albumArtists.size > 1) {
		issues.push(
			issue(
				"CONFLICTING_ALBUM_ARTIST",
				"ALBUMARTIST must be present on every track or absent on every track",
			),
		);
	}
	if (albumArtists.has(undefined) && artists.size > 1) {
		issues.push(
			issue(
				"MISSING_ALBUM_ARTIST",
				"ALBUMARTIST is required when tracks have different ARTIST values",
			),
		);
	}

	if (issues.length > 0) {
		return { valid: false, root: candidate.root, issues };
	}

	const [album] = albums;
	const [configuredAlbumArtist] = albumArtists;
	const albumArtist = configuredAlbumArtist ?? artists.values().next().value;
	if (albumArtist === undefined) {
		return {
			valid: false,
			root: candidate.root,
			issues: [issue("MISSING_ARTIST", "ARTIST is required")],
		};
	}

	const artwork = selectArtworkPath(candidate, tracks, album);
	return {
		valid: true,
		candidate: {
			root: candidate.root,
			album,
			albumArtist,
			tracks,
			...(artwork.path === undefined ? {} : { artworkPath: artwork.path }),
		},
		...(artwork.warning === undefined ? {} : { warnings: [artwork.warning] }),
	};
}
