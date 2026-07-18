import { resolve } from "node:path";
import { Command, Option } from "commander";
import prettyMilliseconds from "pretty-ms";
import { createApp } from "./app";
import { loadServerConfig, type ServerConfig } from "./config";
import {
	AUTOMATIC_ARTWORK_RESOLVER_VERSION,
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
	hasPublishedOutputDrift,
	reconcileImports,
	recoverInterruptedOperations,
} from "./state/reconcile";
import { collectRetiredVersions } from "./state/reconcile/version-gc";
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
		console.info("Initializing library state.");
		const importState = await openImportState({
			stateRoot: config.paths.stateRoot,
			generatedLibraryRoot: config.paths.generatedLibraryRoot,
			versionRoot: config.paths.versionRoot,
			onProgress: console.info,
		});

		state = importState;

		importState.resetSourceObservationWindow();
		await createDailyBackup(importState, config.paths.backupRoot);

		console.info("Checking for interrupted publication operations.");
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

		console.info(`Observing source library at ${config.paths.watchRoot}.`);
		const startupObservation = await observeSource(config.paths.watchRoot);
		let bypassInitialConfirmation = false;

		if (!startupObservation.complete) {
			console.info(
				"Initial source observation is incomplete; reconciliation will retry at the next interval.",
			);
			importState.markReconciliationRequired(
				`Incomplete startup source observation: ${startupObservation.issues[0] ?? "unknown issue"}`,
			);
		} else {
			const startupManifest = importState.observeSourceManifest({
				watchRoot: config.paths.watchRoot,
				manifestHash: startupObservation.manifestHash,
				minimumAgeMs: config.reconciliationIntervalSeconds * 1_000,
			});
			bypassInitialConfirmation = importState.isTabulaRasa;
			if (bypassInitialConfirmation) {
				importState.markReconciliationRequired(
					"Initial library import is starting without interval-separated confirmation",
				);
				console.info(
					"No existing library state; starting the first complete library build immediately.",
				);
			} else if (
				startupManifest.confirmed &&
				startupManifest.unchanged &&
				!importState.isReconciliationRequired() &&
				!importState.hasPendingAutomaticArtwork(
					automaticArtworkEnabled,
					AUTOMATIC_ARTWORK_RESOLVER_VERSION,
				)
			) {
				console.info(
					"Source snapshot is unchanged; no reconciliation work is pending.",
				);
			} else {
				importState.markReconciliationRequired(
					"Source snapshot awaits interval-separated confirmation",
				);
				console.info(
					`Initial source snapshot recorded; waiting ${config.reconciliationIntervalSeconds} seconds to confirm it before importing.`,
				);
			}
		}

		let reusableObservation = bypassInitialConfirmation
			? startupObservation
			: undefined;
		const sourceWatcher = startSourceWatcher({
			intervalMs: config.reconciliationIntervalSeconds * 1_000,
			onReconcile: async () => {
				const observation =
					reusableObservation ??
					(await observeSource(config.paths.watchRoot));
				reusableObservation = undefined;
				if (!observation.complete) {
					importState.markReconciliationRequired(
						`Incomplete periodic source observation: ${observation.issues[0] ?? "unknown issue"}`,
					);
					return;
				}

				const sourceManifest = importState.observeSourceManifest({
					watchRoot: config.paths.watchRoot,
					manifestHash: observation.manifestHash,
					minimumAgeMs: config.reconciliationIntervalSeconds * 1_000,
				});
				if (!sourceManifest.confirmed && !bypassInitialConfirmation) {
					importState.markReconciliationRequired(
						"Source snapshot awaits interval-separated confirmation",
					);
					console.info(
						"Source snapshot changed; waiting for the next interval to confirm it before importing.",
					);
					return;
				}

				const startingFirstBuild = bypassInitialConfirmation;
				if (startingFirstBuild) {
					importState.observeSourceManifest({
						watchRoot: config.paths.watchRoot,
						manifestHash: observation.manifestHash,
						minimumAgeMs: 0,
					});
					bypassInitialConfirmation = false;
					console.info(
						"Starting the first complete library build without interval-separated confirmation.",
					);
				}

				if (
					!startingFirstBuild &&
					sourceManifest.unchanged &&
					!importState.isReconciliationRequired() &&
					!importState.hasPendingAutomaticArtwork(
						automaticArtworkEnabled,
						AUTOMATIC_ARTWORK_RESOLVER_VERSION,
					) &&
					!(await hasPublishedOutputDrift({
						state: importState,
						cacheRoot: config.paths.cacheRoot,
						versionRoot: config.paths.versionRoot,
					}))
				) {
					console.info(
						"Source snapshot is unchanged; skipping publication preparation.",
					);
					await collectRetiredVersions(
						importState,
						config.paths.generatedLibraryRoot,
						config.paths.versionRoot,
						config.versionRetentionHours,
					);

					return;
				}

				if (!startingFirstBuild) {
					console.info(
						"Source snapshot confirmed; preparing publication plans.",
					);
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

				console.info(
					`Prepared ${next.plans.length} desired import(s); resolving artwork and reconciling generated output.`,
				);
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
					onProgress: console.info,
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
					)} to reconcile ${inputs.length} desired import(s) from complete source scan.`,
				);
			},
			onFailure: (error) =>
				importState.markReconciliationRequired(
					`Periodic source scan failed: ${error.message}`,
				),
		});

		watcher = sourceWatcher;
		if (bypassInitialConfirmation) {
			sourceWatcher.request();
		}
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
