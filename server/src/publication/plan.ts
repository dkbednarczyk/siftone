import { extname, join } from "node:path";
import type {
	ValidatedCandidate,
	ValidatedTrack,
} from "../candidates/validate";

export type PublicationPlanIssueCode =
	| "UNSAFE_PATH_SEGMENT"
	| "UNSUPPORTED_ARTWORK_FORMAT"
	| "OUTPUT_COLLISION";

export type PublicationPlanIssue = Readonly<{
	code: PublicationPlanIssueCode;
	message: string;
}>;

export type PlannedSymlink = Readonly<{
	sourcePath: string;
	destinationPath: string;
}>;

export type PublicationPlanResult =
	| Readonly<{ valid: true; entries: readonly PlannedSymlink[] }>
	| Readonly<{ valid: false; issues: readonly PublicationPlanIssue[] }>;

function compareTracks(first: ValidatedTrack, second: ValidatedTrack): number {
	if (first.discNumber !== second.discNumber) {
		return first.discNumber - second.discNumber;
	}

	if (first.trackNumber !== second.trackNumber) {
		return first.trackNumber - second.trackNumber;
	}

	if (first.path < second.path) {
		return -1;
	}

	if (first.path > second.path) {
		return 1;
	}

	return 0;
}

function sanitizePathSegment(value: string): string | undefined {
	const sanitized = value
		.replaceAll("/", " ")
		.replaceAll("\\", " ")
		.replaceAll("\0", " ")
		.replace(/\s+/gu, " ")
		.trim();

	if (sanitized === "" || sanitized === "." || sanitized === "..") {
		return undefined;
	}

	return sanitized;
}

/**
 * Creates a deterministic, side-effect-free symlink layout. Filesystem checks
 * and atomic publication belong to the later publication transaction.
 */
export function planPublication(
	candidate: ValidatedCandidate,
	generatedLibraryRoot: string,
	reservedDestinationPaths: readonly string[] = [],
): PublicationPlanResult {
	const albumArtist = sanitizePathSegment(candidate.albumArtist);
	const album = sanitizePathSegment(candidate.album);
	const issues: PublicationPlanIssue[] = [];

	if (albumArtist === undefined) {
		issues.push({
			code: "UNSAFE_PATH_SEGMENT",
			message: "Album artist cannot form a safe destination path segment",
		});
	}

	if (album === undefined) {
		issues.push({
			code: "UNSAFE_PATH_SEGMENT",
			message: "Album cannot form a safe destination path segment",
		});
	}

	if (albumArtist === undefined || album === undefined) {
		return { valid: false, issues };
	}

	const entries: PlannedSymlink[] = [];
	const destinations = new Set(reservedDestinationPaths);

	for (const [index, track] of candidate.tracks
		.toSorted(compareTracks)
		.entries()) {
		const title = sanitizePathSegment(track.title);
		if (title === undefined) {
			issues.push({
				code: "UNSAFE_PATH_SEGMENT",
				message: `Track ${track.path} cannot form a safe destination file name`,
			});

			continue;
		}

		const extension = extname(track.path).toLowerCase();
		const destinationPath = join(
			generatedLibraryRoot,
			albumArtist,
			album,
			`${String(index + 1).padStart(2, "0")} ${title}${extension}`,
		);

		if (destinations.has(destinationPath)) {
			issues.push({
				code: "OUTPUT_COLLISION",
				message: `Multiple tracks map to ${destinationPath}`,
			});

			continue;
		}

		destinations.add(destinationPath);
		entries.push({ sourcePath: track.path, destinationPath });
	}

	if (candidate.artworkPath !== undefined) {
		const extension = extname(candidate.artworkPath).toLowerCase();

		if (![".jpg", ".jpeg", ".png"].includes(extension)) {
			issues.push({
				code: "UNSUPPORTED_ARTWORK_FORMAT",
				message: `Artwork must be a JPEG or PNG: ${candidate.artworkPath}`,
			});
		} else {
			const coverExtension = extension === ".jpeg" ? ".jpg" : extension;
			const destinationPath = join(
				generatedLibraryRoot,
				albumArtist,
				album,
				`cover${coverExtension}`,
			);

			if (destinations.has(destinationPath)) {
				issues.push({
					code: "OUTPUT_COLLISION",
					message: `Artwork maps to ${destinationPath}, which is already planned`,
				});
			} else {
				destinations.add(destinationPath);
				entries.push({
					sourcePath: candidate.artworkPath,
					destinationPath,
				});
			}
		}
	}

	return issues.length === 0
		? { valid: true, entries }
		: { valid: false, issues };
}
