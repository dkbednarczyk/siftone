import { mkdir, writeFile } from "node:fs/promises";
import {
	dirname,
	extname,
	isAbsolute,
	relative,
	resolve,
	sep,
} from "node:path";
import { Command } from "commander";
import packageMetadata from "../package.json" with { type: "json" };
import { loadServerConfig } from "./config";
import {
	createCoverArtArchiveClient,
	createMusicBrainzClient,
} from "./musicbrainz/clients";
import { coverAspectRatio } from "./musicbrainz/cover";
import { resolveArtwork } from "./musicbrainz/resolver";
import {
	createRateLimitedScheduler,
	createSerializedScheduler,
} from "./musicbrainz/scheduler";

function resolveCacheOutput(cacheRoot: string, output: string): string {
	const outputPath = resolve(cacheRoot, output);
	const difference = relative(cacheRoot, outputPath);
	const extension = extname(outputPath).toLocaleLowerCase();

	if (
		difference === "" ||
		difference === ".." ||
		difference.startsWith(`..${sep}`) ||
		isAbsolute(difference)
	) {
		throw new Error("--output must be a file path below paths.cache_root");
	}

	if (extension !== ".jpg" && extension !== ".jpeg") {
		throw new Error("--output must end in .jpg or .jpeg");
	}

	return outputPath;
}

async function main(): Promise<void> {
	const command = new Command()
		.name("musicbrainz-test")
		.description("Find and download a cover-art prototype for an album")
		.requiredOption(
			"--artist <album-artist>",
			"Album artist from embedded tags",
		)
		.requiredOption("--album <title>", "Album title from embedded tags")
		.option("--config <path>", "Path to the server TOML configuration")
		.option(
			"--output <relative-path>",
			"JPEG output path below paths.cache_root",
			"musicbrainz-test/cover.jpg",
		)
		.parse();
	const options = command.opts<{
		artist: string;
		album: string;
		config?: string;
		output: string;
	}>();
	const config = await loadServerConfig({ configPath: options.config });
	const contact = config.musicBrainz.contact;
	const result = await resolveArtwork({
		artist: options.artist,
		album: options.album,
		enabled: contact !== undefined,
		musicBrainz: createMusicBrainzClient({
			appName: packageMetadata.name,
			appVersion: packageMetadata.version,
			contact: contact ?? "",
		}),
		coverArtArchive: createCoverArtArchiveClient(),
		musicBrainzScheduler: createRateLimitedScheduler(),
		coverArtScheduler: createSerializedScheduler(),
	});

	if (result.status !== "selected") {
		console.info(
			`MusicBrainz artwork testing did not select artwork: ${result.status}`,
		);

		return;
	}

	const outputPath = resolveCacheOutput(
		config.paths.cacheRoot,
		options.output,
	);
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, result.bytes);

	console.info(`MusicBrainz release group: ${result.releaseGroupId}`);
	console.info(
		`Cover Art Archive source release: https://musicbrainz.org/release/${result.releaseId}`,
	);
	console.info(
		`Selected front cover: ${result.width}×${result.height}, ${result.bytes.byteLength} bytes, aspect ratio ${coverAspectRatio(result).toFixed(3)}`,
	);
	console.info(`Saved cover: ${outputPath}`);
}

await main();
