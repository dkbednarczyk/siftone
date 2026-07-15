import { basename, dirname, extname, join, relative } from "node:path";
import type { DiscoveredCandidate } from "../candidates/discover";
import {
	type CandidateDiscoveryIssue,
	discoverCandidate,
	discoverCandidates,
} from "../candidates/discover";
import {
	type AudioTagReader,
	type CandidateValidationIssue,
	type CandidateValidationWarning,
	validateCandidate,
} from "../candidates/validate";
import { readAudioTags } from "../metadata/tags";
import {
	type PlannedSymlink,
	type PublicationPlanIssue,
	planPublication,
} from "./plan";
import type { PublicationInput } from "./publish";

export type PreparedCandidate =
	| Readonly<{
			root: string;
			status: "invalid";
			issues: readonly CandidateValidationIssue[];
	  }>
	| Readonly<{
			root: string;
			status: "unplannable";
			issues: readonly PublicationPlanIssue[];
	  }>
	| Readonly<{
			root: string;
			status: "suppressed";
			reason: "PREFER_FLAC";
	  }>
	| Readonly<{
			root: string;
			status: "planned";
			entries: readonly PlannedSymlink[];
			warnings?: readonly CandidateValidationWarning[];
	  }>;

export type PreparedPublication = Readonly<{
	discoveryIssues: readonly CandidateDiscoveryIssue[];
	candidates: readonly PreparedCandidate[];
	plans: readonly PublicationInput[];
	incompleteSourceContainers: readonly string[];
	hasIssues: boolean;
}>;

export type PublicationContender = PublicationInput;

export type UnresolvedPublicationCollision = Readonly<{
	destination: string;
	contenders: readonly PublicationContender[];
}>;

export type CollisionArbitration = Readonly<{
	plans: readonly PublicationContender[];
	suppressed: readonly PublicationContender[];
	unresolved: readonly UnresolvedPublicationCollision[];
}>;

function compareText(first: string, second: string): number {
	return first.localeCompare(second);
}

function normalizeLogicalReleasePart(value: string): string {
	return value
		.normalize("NFKC")
		.trim()
		.replace(/\s+/gu, " ")
		.toLocaleLowerCase();
}

function logicalReleaseKey(albumArtist: string, album: string): string {
	return `${normalizeLogicalReleasePart(albumArtist)}\u0000${normalizeLogicalReleasePart(album)}`;
}

function contenderKey(
	contender: Readonly<{ root: string; entries: readonly PlannedSymlink[] }>,
): string {
	return `${contender.root}\u0000${dirname(contender.entries[0]?.destinationPath ?? "")}`;
}

function trackSet(contender: PublicationContender): string[] | undefined {
	const tracks = contender.entries
		.filter((entry) =>
			[".flac", ".mp3"].includes(extname(entry.sourcePath).toLowerCase()),
		)
		.map((entry) => {
			const name = basename(entry.destinationPath);
			return name.slice(0, name.length - extname(name).length);
		})
		.toSorted(compareText);
	return tracks.length === 0 ? undefined : tracks;
}

function pureFormat(
	contender: PublicationContender,
): "flac" | "mp3" | undefined {
	const extensions = contender.entries
		.filter((entry) =>
			[".flac", ".mp3"].includes(extname(entry.sourcePath).toLowerCase()),
		)
		.map((entry) => extname(entry.sourcePath).toLowerCase());
	if (extensions.length === 0 || new Set(extensions).size !== 1)
		return undefined;
	return extensions[0] === ".flac" ? "flac" : "mp3";
}

function sameTrackSet(
	first: PublicationContender,
	second: PublicationContender,
): boolean {
	const firstTracks = trackSet(first);
	const secondTracks = trackSet(second);
	return (
		firstTracks !== undefined &&
		secondTracks !== undefined &&
		firstTracks.length === secondTracks.length &&
		firstTracks.every((track, index) => track === secondTracks[index])
	);
}

/**
 * Arbitrates independently planned contenders for one generated album. FLAC
 * wins only when it is the single pure-FLAC contender over identical pure-MP3
 * track sets; every other collision remains unresolved.
 */
export function arbitratePublicationContenders(
	contenders: readonly PublicationContender[],
): CollisionArbitration {
	const byDestination = new Map<string, PublicationContender[]>();
	for (const contender of contenders) {
		const destination = dirname(contender.entries[0]?.destinationPath ?? "");
		const group = byDestination.get(destination) ?? [];
		group.push(contender);
		byDestination.set(destination, group);
	}
	const plans: PublicationContender[] = [];
	const suppressed: PublicationContender[] = [];
	const unresolved: UnresolvedPublicationCollision[] = [];
	for (const [destination, group] of byDestination) {
		if (group.length === 1) {
			plans.push(group[0]);
			continue;
		}
		const flac = group.filter((contender) => pureFormat(contender) === "flac");
		const mp3 = group.filter((contender) => pureFormat(contender) === "mp3");
		if (
			flac.length === 1 &&
			mp3.length === group.length - 1 &&
			mp3.every((contender) => sameTrackSet(flac[0], contender))
		) {
			plans.push(flac[0]);
			suppressed.push(...mp3);
			continue;
		}
		unresolved.push({
			destination,
			contenders: group.toSorted((first, second) =>
				first.root.localeCompare(second.root),
			),
		});
	}
	return { plans, suppressed, unresolved };
}

async function splitTagGroups(
	candidate: DiscoveredCandidate,
): Promise<
	readonly { candidate: DiscoveredCandidate; reader: AudioTagReader }[]
> {
	const tags = new Map<string, Awaited<ReturnType<AudioTagReader>> | unknown>();
	const groups = new Map<string, string[]>();
	for (const path of candidate.audioPaths) {
		try {
			const value = await readAudioTags(path);
			tags.set(path, value);
			const album = value.album?.trim() ?? "";
			const artist = value.albumArtist?.trim() || value.artist?.trim() || "";
			const key =
				album === "" || artist === ""
					? `invalid:${path}`
					: `${artist}\u0000${album}`;
			const paths = groups.get(key) ?? [];
			paths.push(path);
			groups.set(key, paths);
		} catch (error) {
			tags.set(path, error);
			groups.set(`invalid:${path}`, [path]);
		}
	}
	const reader: AudioTagReader = async (path) => {
		const value = tags.get(path);
		if (value instanceof Error) throw value;
		if (value === undefined) throw new Error(`Missing cached tags for ${path}`);
		return value as Awaited<ReturnType<AudioTagReader>>;
	};
	return [...groups.values()].map((audioPaths) => ({
		candidate: { ...candidate, audioPaths },
		reader,
	}));
}

function sourceContainerForIssue(
	watchRoot: string,
	path: string,
): string | undefined {
	const inside = relative(watchRoot, path);
	if (inside === "" || inside.startsWith("..") || inside.startsWith("/")) {
		return undefined;
	}
	const [container] = inside.split("/");
	return container === undefined || container === ""
		? undefined
		: join(watchRoot, container);
}

/** Reads, validates, arbitrates, and plans every candidate without source writes. */
export async function preparePublication(
	watchRoot: string,
	generatedLibraryRoot: string,
): Promise<PreparedPublication> {
	const discovery = await discoverCandidates(watchRoot);
	const candidates: PreparedCandidate[] = [];
	const contenders: PublicationContender[] = [];
	const incompleteContainers = new Set<string>();

	for (const issue of discovery.issues) {
		const container = sourceContainerForIssue(watchRoot, issue.path);
		if (container !== undefined) incompleteContainers.add(container);
	}

	for (const container of discovery.candidates) {
		for (const { candidate, reader } of await splitTagGroups(container)) {
			const validation = await validateCandidate(candidate, reader);

			if (!validation.valid) {
				incompleteContainers.add(container.root);
				candidates.push({
					root: candidate.root,
					status: "invalid",
					issues: validation.issues,
				});

				continue;
			}

			const publication = planPublication(
				validation.candidate,
				generatedLibraryRoot,
			);

			if (!publication.valid) {
				incompleteContainers.add(container.root);
				candidates.push({
					root: candidate.root,
					status: "unplannable",
					issues: publication.issues,
				});

				continue;
			}

			contenders.push({
				root: candidate.root,
				logicalReleaseKey: logicalReleaseKey(
					validation.candidate.albumArtist,
					validation.candidate.album,
				),
				albumArtist: validation.candidate.albumArtist,
				albumTitle: validation.candidate.album,
				entries: publication.entries,
			});

			candidates.push({
				root: candidate.root,
				status: "planned",
				entries: publication.entries,
				warnings: validation.warnings,
			});
		}
	}

	const arbitration = arbitratePublicationContenders(contenders);
	const suppressed = new Set(
		arbitration.suppressed.map((contender) => contenderKey(contender)),
	);

	const unresolved = new Set(
		arbitration.unresolved.flatMap((collision) =>
			collision.contenders.map((contender) => contenderKey(contender)),
		),
	);

	for (const collision of arbitration.unresolved) {
		for (const contender of collision.contenders) {
			incompleteContainers.add(contender.root);
		}
	}

	const finalCandidates = candidates.map((candidate) => {
		if (candidate.status !== "planned") {
			return candidate;
		}
		
		const key = contenderKey(candidate);
		if (suppressed.has(key)) {
			return {
				root: candidate.root,
				status: "suppressed" as const,
				reason: "PREFER_FLAC" as const,
			};
		}
		
		if (unresolved.has(key)) {
			return {
				root: candidate.root,
				status: "unplannable" as const,
				issues: [
					{
						code: "OUTPUT_COLLISION" as const,
						message: "Competing publication requires review",
					},
				],
			};
		}

		return candidate;
	});

	const hasIssues =
		discovery.issues.length > 0 ||
		finalCandidates.some((candidate) =>
			["invalid", "unplannable"].includes(candidate.status),
		);

	return {
		discoveryIssues: discovery.issues,
		candidates: finalCandidates,
		plans: arbitration.plans,
		incompleteSourceContainers: [...incompleteContainers].toSorted(compareText),
		hasIssues,
	};
}

/** Prepares one immediate watch-root container for incremental watcher work. */
export async function prepareSourceContainer(
	watchRoot: string,
	generatedLibraryRoot: string,
	container: string,
): Promise<
	Readonly<{ plans: readonly PublicationInput[]; incomplete: boolean }>
> {
	if (container === "" || container.includes("/") || container.includes("\\")) {
		throw new Error(`Invalid source container: ${container}`);
	}

	const discovery = await discoverCandidate(join(watchRoot, container));
	if (discovery.candidate === undefined) {
		return { plans: [], incomplete: discovery.issues.length > 0 };
	}

	const contenders: PublicationContender[] = [];
	let incomplete = discovery.issues.length > 0;
	for (const { candidate, reader } of await splitTagGroups(
		discovery.candidate,
	)) {
		const validation = await validateCandidate(candidate, reader);
		if (!validation.valid) {
			incomplete = true;
			continue;
		}

		const publication = planPublication(
			validation.candidate,
			generatedLibraryRoot,
		);

		if (!publication.valid) {
			incomplete = true;
			continue;
		}
		
		contenders.push({
			root: candidate.root,
			logicalReleaseKey: logicalReleaseKey(
				validation.candidate.albumArtist,
				validation.candidate.album,
			),
			albumArtist: validation.candidate.albumArtist,
			albumTitle: validation.candidate.album,
			entries: publication.entries,
		});
	}

	const arbitration = arbitratePublicationContenders(contenders);
	
	return {
		plans: arbitration.plans,
		incomplete: incomplete || arbitration.unresolved.length > 0,
	};
}
