import { parseFile } from "music-metadata";

export type AudioTags = Readonly<{
	path: string;
	title?: string;
	artist?: string;
	album?: string;
	albumArtist?: string;
	trackNumber?: number;
	discNumber?: number;
}>;

export type AudioTagReader = (path: string) => Promise<AudioTags>;

function optionalText(value: string | undefined): string | undefined {
	const text = value?.trim();
	return text === "" ? undefined : text;
}

/** Reads embedded tags only; no source file is modified. */
export async function readAudioTags(path: string): Promise<AudioTags> {
	const metadata = await parseFile(path, { skipCovers: true });

	return {
		path,
		title: optionalText(metadata.common.title),
		artist: optionalText(metadata.common.artist),
		album: optionalText(metadata.common.album),
		albumArtist: optionalText(metadata.common.albumartist),
		trackNumber: metadata.common.track.no ?? undefined,
		discNumber: metadata.common.disk.no ?? undefined,
	};
}
