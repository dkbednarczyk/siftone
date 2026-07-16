import {
	type IImage,
	type IRelease,
	type IReleaseGroupMatch,
	MusicBrainzApi,
} from "musicbrainz-api";
import type {
	ArtistCredit,
	ReleaseEdition,
	ReleaseGroupCandidate,
} from "./matching";
import { HttpError } from "./retry";

export type MusicBrainzClient = Readonly<{
	searchReleaseGroups(
		query: string,
	): Promise<readonly ReleaseGroupCandidate[]>;
	browseReleaseEditions(
		releaseGroupId: string,
		offset: number,
		limit: number,
	): Promise<readonly ReleaseEdition[]>;
}>;

export type CoverArtArchiveClient = Readonly<{
	getReleaseCovers(releaseId: string): Promise<readonly IImage[]>;
}>;

export function createMusicBrainzClient({
	appName,
	appVersion,
	contact,
}: Readonly<{
	appName: string;
	appVersion: string;
	contact: string;
}>): MusicBrainzClient {
	const api = new MusicBrainzApi({
		appName,
		appVersion,
		appContactInfo: contact,
	});

	return {
		async searchReleaseGroups(query) {
			const result = await api.search("release-group", {
				query,
				limit: 10,
			});

			return result["release-groups"].map(mapReleaseGroup);
		},
		async browseReleaseEditions(releaseGroupId, offset, limit) {
			const result = await api.browse(
				"release",
				{ "release-group": releaseGroupId, offset, limit },
				["artist-credits"],
			);

			return result.releases.map(mapReleaseEdition);
		},
	};
}

export function createCoverArtArchiveClient({
	fetchCoverArt = fetch,
}: Readonly<{
	fetchCoverArt?: (input: string, init?: RequestInit) => Promise<Response>;
}> = {}): CoverArtArchiveClient {
	return {
		async getReleaseCovers(releaseId) {
			const response = await fetchCoverArt(
				`https://coverartarchive.org/release/${releaseId}`,
				{ headers: { accept: "application/json" } },
			);
			if (response.status === 404) {
				return [];
			}
			if (!response.ok) {
				throw new HttpError(
					response.status,
					response.headers.get("retry-after"),
				);
			}

			const covers = (await response.json()) as { images?: unknown };
			return Array.isArray(covers.images)
				? (covers.images as IImage[])
				: [];
		},
	};
}

function mapArtistCredit(
	artistCredit:
		| IReleaseGroupMatch["artist-credit"]
		| IRelease["artist-credit"],
): readonly ArtistCredit[] {
	return (artistCredit ?? []).map((credit) => ({
		name: credit.name,
		artistName: credit.artist.name,
		joinPhrase: credit.joinphrase,
	}));
}

function mapReleaseGroup(group: IReleaseGroupMatch): ReleaseGroupCandidate {
	return {
		id: group.id,
		title: group.title,
		artistCredit: mapArtistCredit(group["artist-credit"]),
		score: group.score,
	};
}

function mapReleaseEdition(release: IRelease): ReleaseEdition {
	return {
		id: release.id,
		status: release.status,
		date: release.date,
		hasFrontCoverArt: release["cover-art-archive"].front,
	};
}
