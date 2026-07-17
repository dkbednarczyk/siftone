import { imageSize } from "image-size";
import type { IImage } from "musicbrainz-api";
import { HttpError, isTransient, retryTransient } from "./retry";
import type { TaskScheduler } from "./scheduler";

export const MAX_COVER_BYTES = 5 * 1024 * 1024;
const SQUARE_ASPECT_RATIO = 0.95;
const SQUARE_RESOLUTION_THRESHOLD = 0.7;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const MINIMUM_COVER_DIMENSION = 500;

export type FrontCoverRequest = Readonly<{
	releaseId: string;
	imageId: string;
	urls: readonly string[];
}>;

export type DownloadedCover = Readonly<{
	releaseId: string;
	imageId: string;
	url: string;
	bytes: Uint8Array;
	width: number;
	height: number;
}>;

export type CoverFetch = (
	input: string,
	init?: RequestInit,
) => Promise<Response>;

export type ReleaseCoverSet = Readonly<{
	releaseId: string;
	images: readonly IImage[];
}>;

export type CoverDownloadResult = Readonly<{
	covers: readonly DownloadedCover[];
	transientFailure: boolean;
}>;

function toHttps(url: string): string | undefined {
	try {
		const parsed = new URL(url);

		if (parsed.protocol === "http:") {
			parsed.protocol = "https:";
		}

		return parsed.toString();
	} catch {
		return undefined;
	}
}

function thumbnailUrls(image: IImage): readonly string[] {
	const urls = [image.thumbnails["1200"], image.thumbnails["500"]]
		.filter((url): url is string => url !== undefined)
		.map(toHttps)
		.filter((url): url is string => url !== undefined);

	return [...new Set(urls)];
}

/** Returns only front-type artwork, using the largest safe archive thumbnail. */
export function frontCoverRequests(
	releaseId: string,
	images: readonly IImage[],
): readonly FrontCoverRequest[] {
	return images.flatMap((image) => {
		if (!image.approved || !image.types.includes("Front")) {
			return [];
		}

		const urls = thumbnailUrls(image);
		if (urls.length === 0) {
			return [];
		}

		return [{ releaseId, imageId: image.id, urls }];
	});
}

async function readBoundedBytes(
	response: Response,
): Promise<Uint8Array | undefined> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_COVER_BYTES) {
		return undefined;
	}

	if (response.body === null) {
		return undefined;
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let byteLength = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}

			byteLength += value.byteLength;
			if (byteLength > MAX_COVER_BYTES) {
				await reader.cancel();
				return undefined;
			}

			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return bytes;
}

async function downloadThumbnail(
	url: string,
	fetchCover: CoverFetch,
	scheduler?: TaskScheduler,
): Promise<
	Readonly<{
		cover?: Omit<DownloadedCover, "releaseId" | "imageId">;
		transientFailure: boolean;
	}>
> {
	try {
		const request = () =>
			fetchCover(url, {
				signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
			});
		const response =
			scheduler === undefined
				? await request()
				: await retryTransient({ scheduler, task: request });
		if (!response.ok) {
			return {
				transientFailure: isTransient(new HttpError(response.status)),
			};
		}
		if (
			!response.headers
				.get("content-type")
				?.toLowerCase()
				.startsWith("image/jpeg")
		) {
			return { transientFailure: false };
		}

		const bytes = await readBoundedBytes(response);
		if (bytes === undefined) {
			return { transientFailure: false };
		}

		const dimensions = imageSize(bytes);
		if (
			dimensions.type !== "jpg" ||
			dimensions.width === undefined ||
			dimensions.height === undefined ||
			dimensions.width < MINIMUM_COVER_DIMENSION ||
			dimensions.height < MINIMUM_COVER_DIMENSION
		) {
			return { transientFailure: false };
		}

		return {
			cover: {
				url,
				bytes,
				width: dimensions.width,
				height: dimensions.height,
			},
			transientFailure: false,
		};
	} catch (error) {
		return { transientFailure: isTransient(error) };
	}
}

async function downloadCover(
	request: FrontCoverRequest,
	fetchCover: CoverFetch,
	scheduler?: TaskScheduler,
): Promise<CoverDownloadResult> {
	let transientFailure = false;

	for (const url of request.urls) {
		const thumbnail = await downloadThumbnail(url, fetchCover, scheduler);
		transientFailure ||= thumbnail.transientFailure;
		if (thumbnail.cover !== undefined) {
			return {
				covers: [
					{
						releaseId: request.releaseId,
						imageId: request.imageId,
						...thumbnail.cover,
					},
				],
				transientFailure,
			};
		}
	}

	return { covers: [], transientFailure };
}

/** Downloads only front-type archive thumbnails, with a strict size limit. */
export async function downloadFrontCovers(
	releaseId: string,
	images: readonly IImage[],
	fetchCover: CoverFetch = fetch,
	scheduler?: TaskScheduler,
): Promise<CoverDownloadResult> {
	const downloaded: DownloadedCover[] = [];
	let transientFailure = false;

	for (const request of frontCoverRequests(releaseId, images)) {
		const result = await downloadCover(request, fetchCover, scheduler);
		downloaded.push(...result.covers);
		transientFailure ||= result.transientFailure;
	}

	return { covers: downloaded, transientFailure };
}

/** Downloads front art from multiple release editions with bounded concurrency. */
export async function downloadReleaseFrontCovers(
	releaseCoverSets: readonly ReleaseCoverSet[],
	fetchCover: CoverFetch = fetch,
): Promise<CoverDownloadResult> {
	const downloaded: DownloadedCover[] = [];
	let transientFailure = false;

	for (const release of releaseCoverSets) {
		const result = await downloadFrontCovers(
			release.releaseId,
			release.images,
			fetchCover,
		);
		downloaded.push(...result.covers);
		transientFailure ||= result.transientFailure;
	}

	return { covers: downloaded, transientFailure };
}

function area(cover: DownloadedCover): number {
	return cover.width * cover.height;
}

function aspectRatio(cover: Pick<DownloadedCover, "width" | "height">): number {
	return (
		Math.min(cover.width, cover.height) /
		Math.max(cover.width, cover.height)
	);
}

function comparePreferredCovers(
	first: DownloadedCover,
	second: DownloadedCover,
): number {
	const aspectDifference = aspectRatio(second) - aspectRatio(first);
	if (aspectDifference !== 0) {
		return aspectDifference;
	}

	const areaDifference = area(second) - area(first);
	if (areaDifference !== 0) {
		return areaDifference;
	}

	return first.url.localeCompare(second.url);
}

function compareHighestResolution(
	first: DownloadedCover,
	second: DownloadedCover,
): number {
	const areaDifference = area(second) - area(first);
	if (areaDifference !== 0) {
		return areaDifference;
	}

	const aspectDifference = aspectRatio(second) - aspectRatio(first);
	if (aspectDifference !== 0) {
		return aspectDifference;
	}

	return first.url.localeCompare(second.url);
}

/**
 * Favors square artwork only when it has at least 70% of the best resolution.
 * Otherwise, resolution wins; URL order breaks equivalent-quality ties.
 */
export function selectBestCover(
	covers: readonly DownloadedCover[],
): DownloadedCover | undefined {
	const maximumArea = Math.max(...covers.map(area));
	if (!Number.isFinite(maximumArea)) {
		return undefined;
	}

	const squareCandidates = covers.filter(
		(cover) =>
			aspectRatio(cover) >= SQUARE_ASPECT_RATIO &&
			area(cover) >= maximumArea * SQUARE_RESOLUTION_THRESHOLD,
	);

	if (squareCandidates.length > 0) {
		return [...squareCandidates].sort(comparePreferredCovers)[0];
	}

	return [...covers].sort(compareHighestResolution)[0];
}

export function coverAspectRatio(
	cover: Pick<DownloadedCover, "width" | "height">,
): number {
	return aspectRatio(cover);
}
