import { resolve } from "node:path";
import { Command, Option } from "commander";
import prettyMilliseconds from "pretty-ms";
import { createApp } from "./app";
import { loadServerConfig, type ServerConfig } from "./config";
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
	unpublishUnavailableImports,
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
	let state: ImportState | undefined;
	let watcher: ReconciliationScheduler | undefined;

	let ready = false;

	const server = createApp(
		() => (ready && state?.isDegraded() ? "degraded" : "ok"),
		() => {
			const activeWatcher = watcher;
			if (activeWatcher === undefined) {
				return undefined;
			}

			return {
				status: () => ({
					...activeWatcher.status(),
					reason: state?.reconciliationReason(config.paths.watchRoot),
				}),
				request: () => ({
					...activeWatcher.request(),
					reason: state?.reconciliationReason(config.paths.watchRoot),
				}),
			};
		},
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
			versionRoot: config.paths.versionRoot,
			versionRetentionHours: config.versionRetentionHours,
		});

		console.info(`Observing source library at ${config.paths.watchRoot}.`);
		const startupObservation = await observeSource(config.paths.watchRoot);
		let bypassInitialConfirmation = false;
		let requestStartupReconciliation = false;

		if (!startupObservation.complete) {
			console.info(
				"Initial source observation is incomplete; reconciliation will retry at the next interval.",
			);
			importState.recordScanIssue(
				startupObservation.issues[0] ??
					"Initial source observation is incomplete",
			);
		} else {
			importState.clearScanIssue();
			await unpublishUnavailableImports({
				state: importState,
				generatedLibraryRoot: config.paths.generatedLibraryRoot,
				stagingRoot: config.paths.stagingRoot,
				versionRoot: config.paths.versionRoot,
				incompleteSourceContainers:
					startupObservation.incompleteSourceContainers,
			});
			const startupManifest = importState.observeSourceManifest({
				watchRoot: config.paths.watchRoot,
				manifestHash: startupObservation.manifestHash,
				minimumAgeMs: config.reconciliationIntervalSeconds * 1_000,
			});
			bypassInitialConfirmation = importState.isTabulaRasa;
			if (bypassInitialConfirmation) {
				console.info(
					"No existing library state; starting the first complete library build immediately.",
				);
			} else if (
				startupManifest.confirmed &&
				startupManifest.unchanged &&
				importState.isManifestReconciled(
					config.paths.watchRoot,
					startupObservation.manifestHash,
				)
			) {
				console.info(
					"Source snapshot is unchanged; no reconciliation work is pending.",
				);
			} else {
				if (startupManifest.confirmed) {
					requestStartupReconciliation = true;
					console.info(
						"Initial source snapshot is confirmed but has not been reconciled; reconciling now.",
					);
				} else {
					console.info(
						`Initial source snapshot recorded; waiting ${config.reconciliationIntervalSeconds} seconds to confirm it before importing.`,
					);
				}
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
					importState.recordScanIssue(
						observation.issues[0] ??
							"Source observation is incomplete",
					);
					return;
				}
				importState.clearScanIssue();

				await unpublishUnavailableImports({
					state: importState,
					generatedLibraryRoot: config.paths.generatedLibraryRoot,
					stagingRoot: config.paths.stagingRoot,
					versionRoot: config.paths.versionRoot,
					incompleteSourceContainers:
						observation.incompleteSourceContainers,
				});

				const sourceManifest = importState.observeSourceManifest({
					watchRoot: config.paths.watchRoot,
					manifestHash: observation.manifestHash,
					minimumAgeMs: config.reconciliationIntervalSeconds * 1_000,
				});
				if (!sourceManifest.confirmed && !bypassInitialConfirmation) {
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
					importState.isManifestReconciled(
						config.paths.watchRoot,
						observation.manifestHash,
					) &&
					!(await hasPublishedOutputDrift({
						state: importState,
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
					observation.discovery,
				);

				if (next.hasIssues) {
					importState.recordScanIssue(
						next.discoveryIssues[0] === undefined
							? "Source preparation has unresolved candidate issues"
							: `${next.discoveryIssues[0].path}: ${next.discoveryIssues[0].message}`,
					);
				}

				console.info(
					`Prepared ${next.plans.length} desired import(s); reconciling generated output.`,
				);

				await reconcileImports({
					state: importState,
					generatedLibraryRoot: config.paths.generatedLibraryRoot,
					stagingRoot: config.paths.stagingRoot,
					versionRoot: config.paths.versionRoot,
					versionRetentionHours: config.versionRetentionHours,
					watchRoot: config.paths.watchRoot,
					inputs: next.plans,
					complete: true,
					incompleteSourceContainers: next.incompleteSourceContainers,
					onProgress: console.info,
				});
				if (!next.hasIssues) {
					importState.markManifestReconciled(
						config.paths.watchRoot,
						observation.manifestHash,
					);
				}

				console.info(
					`Took ${prettyMilliseconds(
						Math.max(
							0,
							Math.round(
								performance.now() - reconciliationStartedAt,
							),
						),
						{ separateMilliseconds: true },
					)} to reconcile ${next.plans.length} desired import(s) from complete source scan.`,
				);
			},
			onFailure: (error) =>
				importState.recordScanIssue(
					`Reconciliation failed: ${error.message}`,
				),
		});

		watcher = sourceWatcher;
		if (bypassInitialConfirmation || requestStartupReconciliation) {
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
			backupPath: options.backup,
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
