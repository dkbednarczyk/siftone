import { resolve } from "node:path";
import { Command, Option } from "commander";
import prettyMilliseconds from "pretty-ms";
import { createApp } from "./app";
import { loadServerConfig, type ServerConfig } from "./config";
import {
	createAutomaticArtworkResolver,
	resolvePublicationArtwork,
} from "./musicbrainz/publication";
import { preparePublication } from "./publication/prepare";
import { createDailyBackup, restoreBackup } from "./state/backup";
import {
	DATABASE_FILE,
	type ImportState,
	openImportState,
} from "./state/import-state";
import {
	reconcileImports,
	recoverInterruptedOperations,
} from "./state/reconcile";
import { observeSource } from "./state/source-observer";
import {
	type ReconciliationScheduler,
	startSourceWatcher,
} from "./state/watcher";

export type ServerCommandOptions = Readonly<{
	config?: string;
	backup?: string;
}>;

function pathOption(flags: string, name: "config" | "backup"): Option {
	return new Option(flags).argParser(
		(value: string, previous: string | undefined) => {
			if (value.startsWith("--") || value.trim().length === 0) {
				throw new Error(`--${name} requires a file path`);
			}

			if (previous !== undefined) {
				throw new Error(`--${name} may only be specified once`);
			}

			return value;
		},
	);
}

async function runServer(config: ServerConfig): Promise<void> {
	const automaticArtworkResolver = createAutomaticArtworkResolver({
		contact: config.musicBrainz.contact,
		appName: "siftone",
		appVersion: "0.0.0",
	});

	const automaticArtworkEnabled =
		typeof config.musicBrainz.contact === "string" &&
		config.musicBrainz.contact.trim().length > 0;

	let state: ImportState | undefined;
	let watcher: ReconciliationScheduler | undefined;

	let ready = false;

	const server = createApp(
		() => (ready && state?.isDegraded() ? "degraded" : "ok"),
		() => watcher,
	).listen({ hostname: "127.0.0.1", port: config.port });

	console.info(
		`Siftone server listening on http://localhost:${server.server?.port ?? config.port}`,
	);

	try {
		const importState = await openImportState({
			stateRoot: config.paths.stateRoot,
			generatedLibraryRoot: config.paths.generatedLibraryRoot,
			versionRoot: config.paths.versionRoot,
		});

		state = importState;

		importState.resetSourceObservationWindow();
		await createDailyBackup(importState, config.paths.backupRoot);

		// Recovery is intentionally separate from normal reconciliation: it must not
		// rescan every import or generated album before the source snapshot is prepared.
		await recoverInterruptedOperations({
			state: importState,
			generatedLibraryRoot: config.paths.generatedLibraryRoot,
			stagingRoot: config.paths.stagingRoot,
			cacheRoot: config.paths.cacheRoot,
			versionRoot: config.paths.versionRoot,
			versionRetentionHours: config.versionRetentionHours,
		});

		const startupObservation = await observeSource(config.paths.watchRoot);

		if (!startupObservation.complete) {
			importState.markReconciliationRequired(
				`Incomplete startup source observation: ${startupObservation.issues[0] ?? "unknown issue"}`,
			);
		} else {
			for (const container of startupObservation.containers) {
				if (
					container.manifestHash !== undefined &&
					container.outcome === "present"
				) {
					importState.observeSourceManifest({
						watchRoot: container.containerPath,
						manifestHash: container.manifestHash,
						minimumAgeMs:
							config.reconciliationIntervalSeconds * 1_000,
					});
				}
			}
			importState.markReconciliationRequired(
				"Source snapshot awaits interval-separated confirmation",
			);
		}

		const sourceWatcher = startSourceWatcher({
			intervalMs: config.reconciliationIntervalSeconds * 1_000,
			onReconcile: async () => {
				const observation = await observeSource(config.paths.watchRoot);
				if (!observation.complete) {
					importState.markReconciliationRequired(
						`Incomplete periodic source observation: ${observation.issues[0] ?? "unknown issue"}`,
					);
					return;
				}

				const confirmations = observation.containers.map((container) =>
					container.outcome === "present" &&
					container.manifestHash !== undefined
						? importState.observeSourceManifest({
								watchRoot: container.containerPath,
								manifestHash: container.manifestHash,
								minimumAgeMs:
									config.reconciliationIntervalSeconds *
									1_000,
							})
						: false,
				);
				const confirmed = confirmations.every(Boolean);
				if (!confirmed) {
					importState.markReconciliationRequired(
						"Source snapshot awaits interval-separated confirmation",
					);
					return;
				}

				const reconciliationStartedAt = performance.now();
				const next = await preparePublication(
					config.paths.watchRoot,
					config.paths.generatedLibraryRoot,
				);

				if (next.hasIssues) {
					importState.markReconciliationRequired(
						"Periodic source scan found invalid or incomplete candidates",
					);
				}

				const inputs = await resolvePublicationArtwork({
					state: importState,
					cacheRoot: config.paths.cacheRoot,
					inputs: next.plans,
					resolver: automaticArtworkResolver,
					enabled: automaticArtworkEnabled,
				});
				for (const input of inputs) {
					if (input.automaticArtwork !== undefined) {
						console.info(
							`Automatic artwork for ${input.albumArtist} — ${input.albumTitle}: ${input.automaticArtwork.status}`,
						);
					}
				}

				await reconcileImports({
					state: importState,
					generatedLibraryRoot: config.paths.generatedLibraryRoot,
					stagingRoot: config.paths.stagingRoot,
					cacheRoot: config.paths.cacheRoot,
					versionRoot: config.paths.versionRoot,
					versionRetentionHours: config.versionRetentionHours,
					watchRoot: config.paths.watchRoot,
					inputs,
					complete: true,
					incompleteSourceContainers: next.incompleteSourceContainers,
				});

				console.info(
					`Took ${prettyMilliseconds(
						Math.max(
							0,
							Math.round(
								performance.now() - reconciliationStartedAt,
							),
						),
						{ separateMilliseconds: true },
					)} to reconcile ${inputs.length} desired import(s) from periodic source scan.`,
				);
			},
			onFailure: (error) =>
				importState.markReconciliationRequired(
					`Periodic source scan failed: ${error.message}`,
				),
		});

		watcher = sourceWatcher;
		ready = true;
	} catch (error) {
		if (watcher !== undefined) {
			await watcher.close();
		}

		await server.stop();
		state?.close();

		throw error;
	}

	if (state === undefined || watcher === undefined) {
		await server.stop();

		throw new Error(
			"Siftone server startup did not initialize its runtime",
		);
	}

	const runningState = state;
	const runningWatcher = watcher;
	let stopping = false;

	async function shutdown(signal: string) {
		if (stopping) {
			return;
		}

		stopping = true;
		console.info(`Received ${signal}; stopping Siftone server.`);

		await runningWatcher.close();
		await server.stop();

		runningState.close();
	}

	process.once("SIGINT", () => void shutdown("SIGINT"));
	process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

export function createServerCommand(): Command {
	return new Command()
		.name("siftone")
		.description("Manage and serve a Siftone music library")
		.addOption(pathOption("--config <path>", "config"))
		.addOption(pathOption("--backup <path>", "backup"));
}

async function main(): Promise<void> {
	const command = createServerCommand();

	command.parse();

	const options = command.opts<ServerCommandOptions>();
	const config = await loadServerConfig({ configPath: options.config });

	console.info(`Loaded configuration from ${config.configPath}`);

	if (options.backup !== undefined) {
		await restoreBackup({
			backupPath: config.paths.backupRoot,
			databasePath: resolve(config.paths.stateRoot, DATABASE_FILE),
		});

		console.info(
			"Restored verified SQLite library state. Start Siftone normally.",
		);

		return;
	}

	await runServer(config);
}

if (import.meta.main) {
	await main();
}
