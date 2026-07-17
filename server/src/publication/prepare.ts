import { basename, dirname, extname, join, relative } from "node:path";
import type { DiscoveredCandidate } from "../candidates/discover";
import {
	type CandidateDiscoveryIssue,
	discoverCandidate,
	discoverCandidates,
} from "../candidates/discover";
import {
	type ValidationIssue,
	type ValidationWarning,
	validateCandidate,
} from "../candidates/validate";
import {
	type AudioTagReader,
	type AudioTags,
	readAudioTags,
} from "../metadata/tags";
import { isDescendant } from "../path-utils";
import { mapBounded } from "../util/util";
import {
	type PlannedSymlink,
	type PublicationPlanIssue,
	planPublication,
} from "./plan";
import type { PublicationInput } from "./publish";

const PREPARATION_CONCURRENCY = 4;
const TAG_READER_CONCURRENCY = 8;

export type PreparedCandidate =
	| Readonly<{
			root: string;
			status: "invalid";
			issues: readonly ValidationIssue[];
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
			warnings?: readonly ValidationWarning[];
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

type CachedTagRead =
	| Readonly<{ ok: true; tags: AudioTags }>
	| Readonly<{ ok: false; error: unknown }>;

function createCachedTagReader(
	cache: ReadonlyMap<string, CachedTagRead>,
): AudioTagReader {
	return (path) => {
		const cached = cache.get(path);
		if (cached === undefined) {
			return Promise.reject(new Error(`Missing cached tags for ${path}`));
		}

		return cached.ok
			? Promise.resolve(cached.tags)
			: Promise.reject(cached.error);
	};
}

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
	return JSON.stringify([
		normalizeLogicalReleasePart(albumArtist),
		normalizeLogicalReleasePart(album),
	]);
}

function contenderDestination(
	contender: Readonly<{ entries: readonly PlannedSymlink[] }>,
): string {
	return dirname(contender.entries[0]?.destinationPath ?? "");
}

function addContender(
	contenders: Map<string, Set<string>>,
	contender: Readonly<{ root: string; entries: readonly PlannedSymlink[] }>,
): void {
	const destinations = contenders.get(contender.root) ?? new Set<string>();
	destinations.add(contenderDestination(contender));
	contenders.set(contender.root, destinations);
}

function hasContender(
	contenders: ReadonlyMap<string, ReadonlySet<string>>,
	contender: Readonly<{ root: string; entries: readonly PlannedSymlink[] }>,
): boolean {
	return (
		contenders.get(contender.root)?.has(contenderDestination(contender)) ??
		false
	);
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

	if (extensions.length === 0 || new Set(extensions).size !== 1) {
		return undefined;
	}

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
		const destination = contenderDestination(contender);

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

		const flac = group.filter(
			(contender) => pureFormat(contender) === "flac",
		);
		const mp3 = group.filter(
			(contender) => pureFormat(contender) === "mp3",
		);

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

export async function splitTagGroups(
	candidate: DiscoveredCandidate,
	readTags: AudioTagReader = readAudioTags,
): Promise<
	readonly { candidate: DiscoveredCandidate; reader: AudioTagReader }[]
> {
	const tags = new Map<string, CachedTagRead>();
	const groups: string[][] = [];
	const groupedPaths = new Map<string, string[]>();
	const reads = await mapBounded(
		candidate.audioPaths,
		async (path) => {
			try {
				return {
					path,
					result: { ok: true, tags: await readTags(path) },
				} as const;
			} catch (error) {
				return { path, result: { ok: false, error } } as const;
			}
		},
		TAG_READER_CONCURRENCY,
	);
	for (const { path, result } of reads) {
		tags.set(path, result);

		if (!result.ok) {
			groups.push([path]);

			continue;
		}

		const album = result.tags.album?.trim() ?? "";

		if (album === "") {
			groups.push([path]);
			continue;
		}

		const paths = groupedPaths.get(album);
		if (paths === undefined) {
			const newPaths = [path];

			groupedPaths.set(album, newPaths);
			groups.push(newPaths);

			continue;
		}

		paths.push(path);
	}

	const reader = createCachedTagReader(tags);

	return groups.map((audioPaths) => ({
		candidate: { ...candidate, audioPaths },
		reader,
	}));
}

type PreparedContainer = Readonly<{
	candidates: readonly PreparedCandidate[];
	contenders: readonly PublicationContender[];
	incomplete: boolean;
}>;

async function prepareContainer(
	container: DiscoveredCandidate,
	generatedLibraryRoot: string,
): Promise<PreparedContainer> {
	const candidates: PreparedCandidate[] = [];
	const contenders: PublicationContender[] = [];
	let incomplete = false;

	for (const { candidate, reader } of await splitTagGroups(container)) {
		const validation = await validateCandidate(candidate, reader);

		if (!validation.valid) {
			incomplete = true;

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
			incomplete = true;

			candidates.push({
				root: candidate.root,
				status: "unplannable",
				issues: publication.issues,
			});

			continue;
		}

		const contender: PublicationContender = {
			root: candidate.root,
			logicalReleaseKey: logicalReleaseKey(
				validation.candidate.albumArtist,
				validation.candidate.album,
			),
			albumArtist: validation.candidate.albumArtist,
			albumTitle: validation.candidate.album,
			entries: publication.entries,
		};

		contenders.push(contender);

		candidates.push({
			root: candidate.root,
			status: "planned",
			entries: publication.entries,
			warnings: validation.warnings,
		});
	}

	return { candidates, contenders, incomplete };
}

function sourceContainerForIssue(
	watchRoot: string,
	path: string,
): string | undefined {
	if (!isDescendant(watchRoot, path)) {
		return undefined;
	}

	const [container] = relative(watchRoot, path).split("/");

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

		if (container !== undefined) {
			incompleteContainers.add(container);
		}
	}

	const preparedContainers = await mapBounded(
		discovery.candidates,
		(container) => prepareContainer(container, generatedLibraryRoot),
		PREPARATION_CONCURRENCY,
	);

	for (const [index, prepared] of preparedContainers.entries()) {
		candidates.push(...prepared.candidates);
		contenders.push(...prepared.contenders);

		if (prepared.incomplete) {
			incompleteContainers.add(discovery.candidates[index].root);
		}
	}

	const arbitration = arbitratePublicationContenders(contenders);
	const suppressed = new Map<string, Set<string>>();
	for (const contender of arbitration.suppressed) {
		addContender(suppressed, contender);
	}

	const unresolved = new Map<string, Set<string>>();
	for (const collision of arbitration.unresolved) {
		for (const contender of collision.contenders) {
			addContender(unresolved, contender);
		}
	}

	for (const collision of arbitration.unresolved) {
		for (const contender of collision.contenders) {
			incompleteContainers.add(contender.root);
		}
	}

	const finalCandidates = candidates.map((candidate) => {
		if (candidate.status !== "planned") {
			return candidate;
		}

		if (hasContender(suppressed, candidate)) {
			return {
				root: candidate.root,
				status: "suppressed" as const,
				reason: "PREFER_FLAC" as const,
			};
		}

		if (hasContender(unresolved, candidate)) {
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
		incompleteSourceContainers: [...incompleteContainers].toSorted(
			compareText,
		),
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
	if (
		container === "" ||
		container.includes("/") ||
		container.includes("\\")
	) {
		throw new Error(`Invalid source container: ${container}`);
	}

	const discovery = await discoverCandidate(join(watchRoot, container));
	if (discovery.candidate === undefined) {
		return { plans: [], incomplete: discovery.issues.length > 0 };
	}

	const prepared = await prepareContainer(
		discovery.candidate,
		generatedLibraryRoot,
	);

	const arbitration = arbitratePublicationContenders(prepared.contenders);

	return {
		plans: arbitration.plans,
		incomplete:
			discovery.issues.length > 0 ||
			prepared.incomplete ||
			arbitration.unresolved.length > 0,
	};
}
