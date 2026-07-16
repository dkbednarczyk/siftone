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
import { DATABASE_FILE } from "./state/import-state";

function parseArguments(argv: string[]): ServerCommandOptions {
	const command = createServerCommand()
		.configureOutput({ writeErr: () => {}, writeOut: () => {} })
		.exitOverride();
	command.parse(argv, { from: "user" });
	return command.opts<ServerCommandOptions>();
}

describe("server command", () => {
	test("parses the config option in both Commander forms", () => {
		expect(parseArguments(["--config", "settings/server.toml"])).toEqual({
			config: "settings/server.toml",
			dryRun: false,
		});
		expect(parseArguments(["--config=settings/server.toml"])).toEqual({
			config: "settings/server.toml",
			dryRun: false,
		});
	});

	test("selects dry-run and restore modes from root options", () => {
		expect(parseArguments(["--dry-run"])).toEqual({ dryRun: true });
		expect(parseArguments(["--backup", "backups/imports.sqlite"])).toEqual({
			backup: "backups/imports.sqlite",
			dryRun: false,
		});
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
		expect(() =>
			parseArguments(["--backup", "snapshot", "--dry-run"]),
		).toThrow("cannot be used");
		expect(() => parseArguments(["--verbose"])).toThrow("unknown option");
	});

	test("does not open import state when the HTTP port is unavailable", async () => {
		const root = await mkdtemp(join(tmpdir(), "siftone-startup-"));
		const watchRoot = join(root, "watch");
		const generatedLibraryRoot = join(root, "generated");
		const cacheRoot = join(root, "cache");
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
				`[server]\nport = ${listener.port}\n\n[paths]\nwatch_root = ${JSON.stringify(watchRoot)}\ngenerated_library_root = ${JSON.stringify(generatedLibraryRoot)}\ncache_root = ${JSON.stringify(cacheRoot)}\nstaging_root = ${JSON.stringify(stagingRoot)}\nstate_root = ${JSON.stringify(stateRoot)}\nbackup_root = ${JSON.stringify(backupRoot)}\n`,
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
