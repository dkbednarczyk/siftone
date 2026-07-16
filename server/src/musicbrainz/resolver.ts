import type { CoverArtArchiveClient, MusicBrainzClient } from "./clients";
import { type CoverFetch, downloadFrontCovers, selectBestCover } from "./cover";
import {
	MAX_BROWSED_EDITIONS,
	selectArtworkEditions,
	selectReleaseGroup,
} from "./matching";
import { isTransient, retryTransient } from "./retry";
import type { TaskScheduler } from "./scheduler";

export type ArtworkResolution =
	| Readonly<{ status: "disabled" }>
	| Readonly<{ status: "no_match" }>
	| Readonly<{ status: "no_eligible_edition" }>
	| Readonly<{ status: "no_qualifying_cover" }>
	| Readonly<{ status: "edition_cap_reached" }>
	| Readonly<{ status: "transient_failure" }>
	| Readonly<{
			status: "selected";
			releaseGroupId: string;
			releaseId: string;
			url: string;
			bytes: Uint8Array;
			width: number;
			height: number;
	  }>;

export async function resolveArtwork({
	artist,
	album,
	enabled,
	musicBrainz,
	coverArtArchive,
	musicBrainzScheduler,
	coverArtScheduler,
	fetchCover = fetch,
}: Readonly<{
	artist: string;
	album: string;
	enabled: boolean;
	musicBrainz: MusicBrainzClient;
	coverArtArchive: CoverArtArchiveClient;
	musicBrainzScheduler: TaskScheduler;
	coverArtScheduler: TaskScheduler;
	fetchCover?: CoverFetch;
}>): Promise<ArtworkResolution> {
	if (!enabled) {
		return { status: "disabled" };
	}

	try {
		const groups = await musicBrainzScheduler.run(() =>
			musicBrainz.searchReleaseGroups(
				`artist:"${escapeQuery(artist)}" AND releasegroup:"${escapeQuery(album)}"`,
			),
		);
		const group = selectReleaseGroup(groups, artist, album);
		if (group === undefined) {
			return { status: "no_match" };
		}

		const editions = [];
		for (let offset = 0; offset < MAX_BROWSED_EDITIONS; offset += 25) {
			const page = await musicBrainzScheduler.run(() =>
				musicBrainz.browseReleaseEditions(group.id, offset, 25),
			);
			editions.push(...page);
			if (page.length < 25) {
				break;
			}
		}
		const eligible = selectArtworkEditions(editions);
		if (eligible.length === 0) {
			return { status: "no_eligible_edition" };
		}

		const covers = [];
		let caaAttempts = 0;
		let transientFailure = false;
		let editionCapReached = false;
		for (const edition of eligible) {
			if (caaAttempts >= 5) {
				editionCapReached = true;
				break;
			}

			try {
				const images = await retryTransient({
					scheduler: coverArtScheduler,
					maxAttempts: 5 - caaAttempts,
					onAttempt: () => {
						caaAttempts += 1;
					},
					task: async () =>
						coverArtArchive.getReleaseCovers(edition.id),
				});
				const downloaded = await downloadFrontCovers(
					edition.id,
					images,
					fetchCover,
					coverArtScheduler,
				);
				covers.push(...downloaded.covers);
				transientFailure ||= downloaded.transientFailure;
			} catch (error) {
				transientFailure ||= isTransient(error);
			}
		}
		const selected = selectBestCover(covers);
		if (selected === undefined) {
			if (transientFailure) {
				return { status: "transient_failure" };
			}

			return editionCapReached
				? { status: "edition_cap_reached" }
				: { status: "no_qualifying_cover" };
		}

		return {
			status: "selected",
			releaseGroupId: group.id,
			releaseId: selected.releaseId,
			url: selected.url,
			bytes: selected.bytes,
			width: selected.width,
			height: selected.height,
		};
	} catch {
		return { status: "transient_failure" };
	}
}

function escapeQuery(value: string): string {
	return value.replaceAll(/([+\-!(){}[\]^"~*?:\\/]|&&|\|\|)/g, "\\$1");
}
