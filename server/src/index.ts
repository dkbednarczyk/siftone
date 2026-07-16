import { resolve } from "node:path";
import { Command, Option } from "commander";
import { createApp } from "./app";
import { loadServerConfig, type ServerConfig } from "./config";
import { runDryRun } from "./dry-run";
import {
	preparePublication,
	prepareSourceContainer,
} from "./publication/prepare";
import { restoreState } from "./restore";
import { createDailyBackup } from "./state/backup";
import { openImportState } from "./state/import-state";
import {
	reconcileImports,
	reconcileSourceContainer,
	recoverInterruptedOperations,
} from "./state/reconcile";
import { startSourceWatcher } from "./state/watcher";
import { formatDuration } from "./util/duration";

export type ServerCommandOptions = Readonly<{
	config?: string;
	backup?: string;
	dryRun: boolean;
}>;

function pathOption(
	flags: string,
	name: "config" | "backup",
	conflicts: string[] = [],
): Option {
	return new Option(flags)
		.conflicts(conflicts)
		.argParser((value: string, previous: string | undefined) => {
			if (value.startsWith("--") || value.trim().length === 0) {
				throw new Error(`--${name} requires a file path`);
			}

			if (previous !== undefined) {
				throw new Error(`--${name} may only be specified once`);
			}

			return value;
		});
}

/** Creates the sole root command for every Siftone server invocation. */
export function createServerCommand(): Command {
	return new Command()
		.name("siftone")
		.description("Manage and serve a Siftone music library")
		.addOption(pathOption("--config <path>", "config"))
		.addOption(pathOption("--backup <path>", "backup", ["dryRun"]))
		.addOption(
			new Option(
				"--dry-run",
				"Report publication candidates without changing state",
			)
				.default(false)
				.conflicts(["backup"]),
		);
}

async function runServer(config: ServerConfig): Promise<void> {
	let state: Awaited<ReturnType<typeof openImportState>> | undefined;
	let watcher: ReturnType<typeof startSourceWatcher> | undefined;
	let ready = false;
	const server = createApp(() =>
		ready && state?.isDegraded() === false ? "ok" : "degraded",
	).listen({ hostname: "127.0.0.1", port: config.port });

	console.info(
		`Siftone server listening on http://localhost:${server.server?.port ?? config.port}`,
	);

	try {
		const importState = await openImportState({
			stateRoot: config.paths.stateRoot,
			generatedLibraryRoot: config.paths.generatedLibraryRoot,
		});
		state = importState;
		await createDailyBackup(importState, config.paths.backupRoot);

		// Recovery is intentionally separate from normal reconciliation: it must not
		// rescan every import or generated album before the source snapshot is prepared.
		await recoverInterruptedOperations({
			state: importState,
			generatedLibraryRoot: config.paths.generatedLibraryRoot,
			stagingRoot: config.paths.stagingRoot,
		});

		const startupReconciliationStartedAt = performance.now();
		const prepared = await preparePublication(
			config.paths.watchRoot,
			config.paths.generatedLibraryRoot,
		);

		if (prepared.hasIssues) {
			console.warn(
				"Import preflight found invalid or partial candidates; affected removals are suppressed.",
			);
		}

		await reconcileImports({
			state: importState,
			generatedLibraryRoot: config.paths.generatedLibraryRoot,
			stagingRoot: config.paths.stagingRoot,
			watchRoot: config.paths.watchRoot,
			inputs: prepared.plans,
			complete: true,
			incompleteSourceContainers: prepared.incompleteSourceContainers,
		});

		console.info(
			`Took ${formatDuration(performance.now() - startupReconciliationStartedAt)} to reconcile ${prepared.plans.length} desired import(s) on startup.`,
		);

		const sourceWatcher = startSourceWatcher({
			watchRoot: config.paths.watchRoot,
			onContainer: async (container) => {
				const incrementalReconciliationStartedAt = performance.now();
				const targeted = await prepareSourceContainer(
					config.paths.watchRoot,
					config.paths.generatedLibraryRoot,
					container,
				);

				if (targeted.incomplete) {
					importState.markReconciliationRequired(
						`Incomplete watcher scan for ${container}`,
					);
				}

				await reconcileSourceContainer({
					state: importState,
					generatedLibraryRoot: config.paths.generatedLibraryRoot,
					stagingRoot: config.paths.stagingRoot,
					watchRoot: config.paths.watchRoot,
					containerPath: container,
					inputs: targeted.plans,
					incompleteSourceContainers: targeted.incomplete
						? [container]
						: [],
				});

				console.info(
					`Took ${formatDuration(performance.now() - incrementalReconciliationStartedAt)} to reconcile ${targeted.plans.length} desired import(s) for incremental update ${container}.`,
				);
			},
			onLoss: (error) =>
				importState.markReconciliationRequired(
					`Watcher lost events: ${error.message}`,
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

async function main(): Promise<void> {
	const command = createServerCommand();
	command.parse();

	const options = command.opts<ServerCommandOptions>();
	const config = await loadServerConfig({ configPath: options.config });
	console.info(`Loaded configuration from ${config.configPath}`);

	if (options.backup !== undefined) {
		await restoreState(config, resolve(process.cwd(), options.backup));
		return;
	}

	if (options.dryRun) {
		if (await runDryRun(config)) {
			process.exitCode = 1;
		}

		return;
	}

	await runServer(config);
}

if (import.meta.main) {
	await main();
}
