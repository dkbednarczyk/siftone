import type { ServerConfig } from "./config";
import { preparePublication } from "./publication/prepare";

/** Returns whether the dry run found incomplete or invalid candidates. */
export async function runDryRun(config: ServerConfig): Promise<boolean> {
	const publication = await preparePublication(
		config.paths.watchRoot,
		config.paths.generatedLibraryRoot,
	);

	const output = JSON.stringify(
		{
			watchRoot: config.paths.watchRoot,
			generatedLibraryRoot: config.paths.generatedLibraryRoot,
			discoveryIssues: publication.discoveryIssues,
			candidates: publication.candidates,
		},
		null,
		2,
	);
	process.stdout.write(`${output}\n`);

	return publication.hasIssues;
}
