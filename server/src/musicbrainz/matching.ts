export const MAX_BROWSED_EDITIONS = 100;

export type ArtistCredit = Readonly<{
	name?: string;
	artistName: string;
	joinPhrase?: string;
}>;

export type ReleaseGroupCandidate = Readonly<{
	id: string;
	title: string;
	artistCredit: readonly ArtistCredit[];
	score: number;
}>;

export type ReleaseEdition = Readonly<{
	id: string;
	status: string;
	date: string;
	hasFrontCoverArt: boolean;
}>;

export function normalizeMetadata(value: string): string {
	return value
		.normalize("NFKC")
		.trim()
		.replaceAll(/\s+/g, " ")
		.toLocaleLowerCase();
}

export function artistCreditName(
	artistCredit: readonly ArtistCredit[],
): string {
	return artistCredit
		.map(
			(credit) =>
				`${credit.name ?? credit.artistName}${credit.joinPhrase ?? ""}`,
		)
		.join("");
}

export function selectReleaseGroup(
	candidates: readonly ReleaseGroupCandidate[],
	albumArtist: string,
	albumTitle: string,
): ReleaseGroupCandidate | undefined {
	const normalizedArtist = normalizeMetadata(albumArtist);
	const normalizedTitle = normalizeMetadata(albumTitle);
	const exact = candidates.filter(
		(candidate) =>
			normalizeMetadata(candidate.title) === normalizedTitle &&
			normalizeMetadata(artistCreditName(candidate.artistCredit)) ===
				normalizedArtist,
	);

	if (exact.length > 0) {
		return [...exact].sort(compareReleaseGroupCandidates)[0];
	}

	return [...candidates]
		.filter((candidate) => candidate.score >= 95)
		.sort(compareReleaseGroupCandidates)[0];
}

export function selectArtworkEditions(
	editions: readonly ReleaseEdition[],
): readonly ReleaseEdition[] {
	return editions
		.slice(0, MAX_BROWSED_EDITIONS)
		.filter((edition) => edition.hasFrontCoverArt)
		.toSorted(compareEditions);
}

function compareReleaseGroupCandidates(
	first: ReleaseGroupCandidate,
	second: ReleaseGroupCandidate,
): number {
	const scoreDifference = second.score - first.score;
	if (scoreDifference !== 0) {
		return scoreDifference;
	}

	return first.id.localeCompare(second.id);
}

function compareEditions(
	first: ReleaseEdition,
	second: ReleaseEdition,
): number {
	const officialDifference =
		Number(second.status === "Official") -
		Number(first.status === "Official");
	if (officialDifference !== 0) {
		return officialDifference;
	}

	const firstDate = validDate(first.date);
	const secondDate = validDate(second.date);
	if (firstDate !== undefined && secondDate !== undefined) {
		const dateDifference = firstDate.localeCompare(secondDate);
		if (dateDifference !== 0) {
			return dateDifference;
		}
	} else if (firstDate !== undefined) {
		return -1;
	} else if (secondDate !== undefined) {
		return 1;
	}

	return first.id.localeCompare(second.id);
}

function validDate(value: string): string | undefined {
	return /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(value) ? value : undefined;
}
