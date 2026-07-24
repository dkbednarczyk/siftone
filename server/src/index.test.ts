import { describe, expect, test } from "bun:test";
import {
	access,
	mkdir,
	mkdtemp,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerCommand, type ServerCommandOptions } from "./index";
import { createDailyBackup } from "./state/backup";
import { DATABASE_FILE, openImportState } from "./state/import-state";

function parseArguments(argv: string[]): ServerCommandOptions {
	const command = createServerCommand()
		.configureOutput({ writeErr: () => {}, writeOut: () => {} })
		.exitOverride();
	command.parse(argv, { from: "user" });
	return command.opts<ServerCommandOptions>();
}

async function readUntil(
	stream: ReadableStream<Uint8Array> | null,
	expected: string,
	timeoutMs: number,
): Promise<string> {
	if (stream === null) {
		throw new Error("Expected child process stdout");
	}

	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let output = "";
	const deadline = Date.now() + timeoutMs;

	try {
		while (Date.now() < deadline) {
			const remainingMs = deadline - Date.now();
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const result = await Promise.race([
				reader.read(),
				new Promise<never>((_resolve, reject) => {
					timeout = setTimeout(
						() =>
							reject(
								new Error(
									`Timed out waiting for: ${expected}\n${output}`,
								),
							),
						remainingMs,
					);
				}),
			]);
			clearTimeout(timeout);

			if (result.done) {
				break;
			}

			output += decoder.decode(result.value, { stream: true });
			if (output.includes(expected)) {
				return output;
			}
		}
	} finally {
		reader.releaseLock();
	}

	throw new Error(`Timed out waiting for: ${expected}\n${output}`);
}

describe("server command", () => {
	test("parses the config option in both Commander forms", () => {
		expect(parseArguments(["--config", "settings/server.toml"])).toEqual({
			config: "settings/server.toml",
		});
		expect(parseArguments(["--config=settings/server.toml"])).toEqual({
			config: "settings/server.toml",
		});
	});

	test("selects restore mode from root options", () => {
		expect(parseArguments(["--backup", "backups/imports.sqlite"])).toEqual({
			backup: "backups/imports.sqlite",
		});
	});

	test("restores the snapshot supplied by the backup option", async () => {
		const root = await mkdtemp(join(tmpdir(), "siftone-restore-"));
		const watchRoot = join(root, "watch");
		const generatedLibraryRoot = join(root, "generated");
		const stagingRoot = join(root, "staging");
		const stateRoot = join(root, "state");
		const backupRoot = join(root, "backups");
		const configPath = join(root, "config.toml");

		try {
			await Promise.all([
				mkdir(watchRoot),
				mkdir(generatedLibraryRoot),
				mkdir(stateRoot),
			]);
			const state = await openImportState({
				stateRoot,
				generatedLibraryRoot,
			});
			const backupPath = await createDailyBackup(state, backupRoot);
			state.close();

			if (backupPath === undefined) {
				throw new Error("Expected a new backup snapshot");
			}

			await writeFile(
				configPath,
				`[paths]\nwatch_root = ${JSON.stringify(watchRoot)}\ngenerated_library_root = ${JSON.stringify(generatedLibraryRoot)}\nstaging_root = ${JSON.stringify(stagingRoot)}\nstate_root = ${JSON.stringify(stateRoot)}\nbackup_root = ${JSON.stringify(backupRoot)}\n`,
			);
			const child = Bun.spawn(
				[
					process.execPath,
					join(import.meta.dir, "index.ts"),
					"--config",
					configPath,
					"--backup",
					backupPath,
				],
				{ stderr: "pipe", stdout: "pipe" },
			);

			expect(await child.exited).toBe(0);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("rejects invalid, duplicate, conflicting, and unknown options", () => {
		expect(() => parseArguments(["--config"])).toThrow(
			"option '--config <path>' argument missing",
		);
		expect(() => parseArguments(["--config", ""])).toThrow(
			"--config requires a file path",
		);
		expect(() =>
			parseArguments(["--config", "one.toml", "--config", "two.toml"]),
		).toThrow("--config may only be specified once");
		expect(() => parseArguments(["--verbose"])).toThrow("unknown option");
	});

	test("starts a first empty library scan without waiting for confirmation", async () => {
		const root = await mkdtemp(join(tmpdir(), "siftone-startup-"));
		const watchRoot = join(root, "watch");
		const generatedLibraryRoot = join(root, "generated");
		const stagingRoot = join(root, "staging");
		const stateRoot = join(root, "state");
		const backupRoot = join(root, "backups");
		await mkdir(watchRoot);

		const listener = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(),
		});
		const port = listener.port;
		listener.stop(true);

		const configPath = join(root, "config.toml");
		let child: ReturnType<typeof Bun.spawn> | undefined;

		try {
			await writeFile(
				configPath,
				`[server]\nport = ${port}\nreconciliation_interval_seconds = 300\n\n[paths]\nwatch_root = ${JSON.stringify(watchRoot)}\ngenerated_library_root = ${JSON.stringify(generatedLibraryRoot)}\nstaging_root = ${JSON.stringify(stagingRoot)}\nstate_root = ${JSON.stringify(stateRoot)}\nbackup_root = ${JSON.stringify(backupRoot)}\n`,
			);

			child = Bun.spawn(
				[
					process.execPath,
					join(import.meta.dir, "index.ts"),
					"--config",
					configPath,
				],
				{ stderr: "pipe", stdout: "pipe" },
			);
			const output = await readUntil(
				child.stdout,
				"to reconcile 0 desired import(s)",
				2_000,
			);
			expect(output).toContain(
				"No existing library state; starting the first complete library build immediately.",
			);
		} finally {
			if (child?.exitCode === null) {
				child.kill();
				await child.exited;
			}

			await rm(root, { force: true, recursive: true });
		}
	});

	test("waits for confirmation when an empty database has completed a scan", async () => {
		const root = await mkdtemp(join(tmpdir(), "siftone-startup-"));
		const watchRoot = join(root, "watch");
		const generatedLibraryRoot = join(root, "generated");
		const stagingRoot = join(root, "staging");
		const stateRoot = join(root, "state");
		const backupRoot = join(root, "backups");
		await Promise.all([
			mkdir(watchRoot),
			mkdir(generatedLibraryRoot),
			mkdir(stateRoot),
		]);
		const state = await openImportState({
			stateRoot,
			generatedLibraryRoot,
		});
		state.database.run(
			"UPDATE reconciliation_state SET last_reconciled_manifest_hash = '0000000000000000000000000000000000000000000000000000000000000000', last_full_scan_at_ns = 1 WHERE id = 1",
		);
		state.close();

		const listener = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(),
		});
		const port = listener.port;
		listener.stop(true);

		const configPath = join(root, "config.toml");
		let child: ReturnType<typeof Bun.spawn> | undefined;

		try {
			await writeFile(
				configPath,
				`[server]\nport = ${port}\nreconciliation_interval_seconds = 300\n\n[paths]\nwatch_root = ${JSON.stringify(watchRoot)}\ngenerated_library_root = ${JSON.stringify(generatedLibraryRoot)}\nstaging_root = ${JSON.stringify(stagingRoot)}\nstate_root = ${JSON.stringify(stateRoot)}\nbackup_root = ${JSON.stringify(backupRoot)}\n`,
			);

			child = Bun.spawn(
				[
					process.execPath,
					join(import.meta.dir, "index.ts"),
					"--config",
					configPath,
				],
				{ stderr: "pipe", stdout: "pipe" },
			);
			const output = await readUntil(
				child.stdout,
				"waiting 300 seconds to confirm it before importing",
				2_000,
			);
			expect(output).not.toContain(
				"No existing library state; starting the first complete library build immediately.",
			);
		} finally {
			if (child?.exitCode === null) {
				child.kill();
				await child.exited;
			}

			await rm(root, { force: true, recursive: true });
		}
	});

	test("skips the next unchanged observation after the first library build", async () => {
		const root = await mkdtemp(join(tmpdir(), "siftone-startup-"));
		const watchRoot = join(root, "watch");
		const generatedLibraryRoot = join(root, "generated");
		const stagingRoot = join(root, "staging");
		const stateRoot = join(root, "state");
		const backupRoot = join(root, "backups");
		await mkdir(watchRoot);

		const listener = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(),
		});
		const port = listener.port;
		listener.stop(true);

		const configPath = join(root, "config.toml");
		let child: ReturnType<typeof Bun.spawn> | undefined;

		try {
			await writeFile(
				configPath,
				`[server]\nport = ${port}\nreconciliation_interval_seconds = 1\n\n[paths]\nwatch_root = ${JSON.stringify(watchRoot)}\ngenerated_library_root = ${JSON.stringify(generatedLibraryRoot)}\nstaging_root = ${JSON.stringify(stagingRoot)}\nstate_root = ${JSON.stringify(stateRoot)}\nbackup_root = ${JSON.stringify(backupRoot)}\n`,
			);

			child = Bun.spawn(
				[
					process.execPath,
					join(import.meta.dir, "index.ts"),
					"--config",
					configPath,
				],
				{ stderr: "pipe", stdout: "pipe" },
			);
			const output = await readUntil(
				child.stdout,
				"Source snapshot is unchanged; skipping publication preparation.",
				2_000,
			);
			expect(output).toContain(
				"Starting the first complete library build without interval-separated confirmation.",
			);
			expect(output).toContain("to reconcile 0 desired import(s)");
		} finally {
			if (child?.exitCode === null) {
				child.kill();
				await child.exited;
			}

			await rm(root, { force: true, recursive: true });
		}
	});

	test("does not open import state when the HTTP port is unavailable", async () => {
		const root = await mkdtemp(join(tmpdir(), "siftone-startup-"));
		const watchRoot = join(root, "watch");
		const generatedLibraryRoot = join(root, "generated");
		const stagingRoot = join(root, "staging");
		const stateRoot = join(root, "state");
		const backupRoot = join(root, "backups");
		await mkdir(watchRoot);

		const listener = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(),
		});
		const configPath = join(root, "config.toml");
		let child: ReturnType<typeof Bun.spawn> | undefined;

		try {
			await writeFile(
				configPath,
				`[server]\nport = ${listener.port}\n\n[paths]\nwatch_root = ${JSON.stringify(watchRoot)}\ngenerated_library_root = ${JSON.stringify(generatedLibraryRoot)}\nstaging_root = ${JSON.stringify(stagingRoot)}\nstate_root = ${JSON.stringify(stateRoot)}\nbackup_root = ${JSON.stringify(backupRoot)}\n`,
			);

			child = Bun.spawn(
				[
					process.execPath,
					join(import.meta.dir, "index.ts"),
					"--config",
					configPath,
				],
				{ stderr: "pipe", stdout: "pipe" },
			);

			expect(await child.exited).not.toBe(0);
			const databaseExists = await access(
				join(stateRoot, DATABASE_FILE),
			).then(
				() => true,
				() => false,
			);
			expect(databaseExists).toBeFalse();
			expect(await readdir(backupRoot)).toEqual([]);
		} finally {
			if (child?.exitCode === null) {
				child.kill();
				await child.exited;
			}

			listener.stop(true);
			await rm(root, { force: true, recursive: true });
		}
	});
});
