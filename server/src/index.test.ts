import { describe, expect, test } from "bun:test";
import { createServerCommand, type ServerCommandOptions } from "./index";

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
});
