import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	lstat,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadServerConfig, resolveConfigPath } from "./config";

const temporaryDirectories: string[] = [];
const defaultRootParent = join(
	tmpdir(),
	`siftone-config-default-roots-${process.pid}`,
);
const defaultWatchRoot = join(defaultRootParent, "source");
const defaultGeneratedLibraryRoot = join(defaultRootParent, "generated");
const defaultHomeDirectory = join(defaultRootParent, "home");

async function makeTemporaryDirectory(): Promise<string> {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "siftone-config-")),
	);
	temporaryDirectories.push(directory);
	return directory;
}

function tomlPaths(overrides: Record<string, string> = {}): string {
	const paths = {
		watch_root: defaultWatchRoot,
		generated_library_root: defaultGeneratedLibraryRoot,
		...overrides,
	};

	return `[paths]\n${Object.entries(paths)
		.map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
		.join("\n")}\n`;
}

async function writeConfig(
	directory: string,
	contents = tomlPaths(),
): Promise<string> {
	const configPath = join(directory, "config.toml");
	await writeFile(configPath, contents);
	return configPath;
}

function loadExplicitConfig(configPath: string) {
	return loadServerConfig({
		configPath,
		homeDirectory: defaultHomeDirectory,
	});
}

beforeEach(async () => {
	await mkdir(defaultWatchRoot, { recursive: true });
});

afterEach(async () => {
	await Promise.all([
		...temporaryDirectories
			.splice(0)
			.map((directory) =>
				rm(directory, { force: true, recursive: true }),
			),
		rm(defaultRootParent, { force: true, recursive: true }),
	]);
});

describe("server configuration", () => {
	test("resolves an explicit config path relative to the working directory", () => {
		expect(
			resolveConfigPath({
				configPath: "settings/server.toml",
				cwd: "/workspace",
			}),
		).toBe("/workspace/settings/server.toml");
	});

	test("uses config.toml in the working directory when --config is absent", async () => {
		const directory = await makeTemporaryDirectory();
		await writeConfig(directory);

		expect(resolveConfigPath({ cwd: directory })).toBe(
			join(directory, "config.toml"),
		);
		await expect(
			loadServerConfig({
				cwd: directory,
				homeDirectory: defaultHomeDirectory,
			}),
		).resolves.toMatchObject({
			configPath: join(directory, "config.toml"),
			port: 3000,
		});
	});

	test("allows an optional MusicBrainz contact", async () => {
		const directory = await makeTemporaryDirectory();
		const configPath = await writeConfig(directory);

		await expect(loadExplicitConfig(configPath)).resolves.toMatchObject({
			musicBrainz: { contact: undefined },
		});

		await writeFile(
			configPath,
			`${tomlPaths()}\n[musicbrainz]\ncontact = "mailto:music@example.com"\n`,
		);
		await expect(loadExplicitConfig(configPath)).resolves.toMatchObject({
			musicBrainz: { contact: "mailto:music@example.com" },
		});

		await writeFile(
			configPath,
			`${tomlPaths()}\n[musicbrainz]\ncontact = ""\n`,
		);
		await expect(loadExplicitConfig(configPath)).resolves.toMatchObject({
			musicBrainz: { contact: "" },
		});

		await writeFile(
			configPath,
			`${tomlPaths()}\n[musicbrainz]\ncontact = 42\n`,
		);
		await expect(loadExplicitConfig(configPath)).rejects.toThrow(
			"musicbrainz.contact",
		);
	});

	test("defaults managed storage under the user Siftone directory", async () => {
		const configDirectory = await makeTemporaryDirectory();
		const configPath = await writeConfig(configDirectory);

		const config = await loadServerConfig({
			configPath,
			homeDirectory: defaultHomeDirectory,
		});

		expect(config).toMatchObject({
			port: 3000,
			paths: {
				cacheRoot: await realpath(
					join(defaultHomeDirectory, ".siftone", "cache"),
				),
				stagingRoot: await realpath(
					join(defaultRootParent, ".siftone-staging"),
				),
				stateRoot: await realpath(
					join(defaultHomeDirectory, ".siftone", "state"),
				),
				backupRoot: await realpath(
					join(defaultHomeDirectory, ".siftone", "backups"),
				),
			},
		});
	});

	test("allows explicit managed storage overrides", async () => {
		const directory = await makeTemporaryDirectory();
		const cacheRoot = join(directory, "cache");
		const stagingRoot = join(directory, "staging");
		const stateRoot = join(directory, "state");
		const backupRoot = join(directory, "backups");
		const configPath = await writeConfig(
			directory,
			tomlPaths({
				cache_root: cacheRoot,
				staging_root: stagingRoot,
				state_root: stateRoot,
				backup_root: backupRoot,
			}),
		);

		const config = await loadExplicitConfig(configPath);
		expect(config).toMatchObject({
			paths: {
				cacheRoot: await realpath(cacheRoot),
				stagingRoot: await realpath(stagingRoot),
				stateRoot: await realpath(stateRoot),
				backupRoot: await realpath(backupRoot),
			},
		});
	});

	test("reports missing explicit and fallback configuration files", async () => {
		const directory = await makeTemporaryDirectory();
		const missingPath = join(directory, "missing.toml");

		await expect(loadExplicitConfig(missingPath)).rejects.toThrow(
			`Cannot read configuration file ${missingPath}`,
		);
		await expect(loadServerConfig({ cwd: directory })).rejects.toThrow(
			`Cannot read configuration file ${join(directory, "config.toml")}`,
		);
	});

	test("rejects malformed TOML and an absent paths table", async () => {
		const directory = await makeTemporaryDirectory();
		const malformedPath = await writeConfig(
			directory,
			"[paths\nwatch_root = 1",
		);
		await expect(loadExplicitConfig(malformedPath)).rejects.toThrow(
			"Invalid TOML",
		);

		const missingPathsPath = await writeConfig(
			directory,
			"[server]\nport = 3000\n",
		);
		await expect(loadExplicitConfig(missingPathsPath)).rejects.toThrow(
			"paths: Invalid input",
		);
	});

	test("defaults the port and validates an explicit [server] port", async () => {
		const directory = await makeTemporaryDirectory();
		const configPath = await writeConfig(directory);
		await expect(loadExplicitConfig(configPath)).resolves.toMatchObject({
			port: 3000,
		});

		for (const value of ['"3000"', "3000.5", "0", "65536"]) {
			await writeFile(
				configPath,
				`[server]\nport = ${value}\n\n${tomlPaths()}`,
			);
			await expect(loadExplicitConfig(configPath)).rejects.toThrow(
				"server.port",
			);
		}
	});

	test("rejects missing, non-string, and relative path values", async () => {
		const directory = await makeTemporaryDirectory();
		const missingPath = await writeConfig(
			directory,
			'[paths]\nwatch_root = "/music"\n',
		);
		await expect(loadExplicitConfig(missingPath)).rejects.toThrow(
			"paths.generated_library_root",
		);

		const nonStringPath = await writeConfig(
			directory,
			`${tomlPaths()}cache_root = [1, 2]\n`,
		);
		await expect(loadExplicitConfig(nonStringPath)).rejects.toThrow(
			"paths.cache_root",
		);

		const relativePath = await writeConfig(
			directory,
			tomlPaths({ staging_root: "staging" }),
		);
		await expect(loadExplicitConfig(relativePath)).rejects.toThrow(
			"paths.staging_root must be an absolute path",
		);
	});

	test("rejects unknown TOML keys and schema type mismatches", async () => {
		const directory = await makeTemporaryDirectory();
		const configPath = await writeConfig(directory);
		const invalidConfigs = [
			`unexpected = true\n\n${tomlPaths()}`,
			`[server]\nunexpected = true\n\n${tomlPaths()}`,
			`${tomlPaths()}unexpected = true\n`,
			`${tomlPaths()}\n[musicbrainz]\nunexpected = true\n`,
			`server = "invalid"\n\n${tomlPaths()}`,
			'paths = "invalid"\n',
			'[paths]\nwatch_root = 1\ngenerated_library_root = "/srv/music"\n',
		];

		for (const contents of invalidConfigs) {
			await writeFile(configPath, contents);
			await expect(loadExplicitConfig(configPath)).rejects.toThrow(
				"Invalid configuration",
			);
		}
	});

	test("rejects equal roots and ancestor or descendant overlaps", async () => {
		const directory = await makeTemporaryDirectory();
		const equalPath = await writeConfig(
			directory,
			tomlPaths({ generated_library_root: defaultWatchRoot }),
		);
		await expect(loadExplicitConfig(equalPath)).rejects.toThrow(
			"must not overlap",
		);

		const nestedPath = await writeConfig(
			directory,
			tomlPaths({
				generated_library_root: join(defaultWatchRoot, "library"),
			}),
		);
		await expect(loadExplicitConfig(nestedPath)).rejects.toThrow(
			"must not overlap",
		);
		await expect(lstat(join(defaultWatchRoot, "library"))).rejects.toThrow(
			"ENOENT",
		);
	});

	test("allows non-overlapping roots with common path prefixes", async () => {
		const directory = await makeTemporaryDirectory();
		const watchRoot = join(directory, "music");
		const generatedLibraryRoot = join(directory, "music2");
		await mkdir(watchRoot);
		const configPath = await writeConfig(
			directory,
			tomlPaths({
				watch_root: watchRoot,
				generated_library_root: generatedLibraryRoot,
			}),
		);

		const config = await loadExplicitConfig(configPath);
		expect(config).toMatchObject({
			paths: {
				watchRoot: await realpath(watchRoot),
				generatedLibraryRoot: await realpath(generatedLibraryRoot),
			},
		});
	});

	test("detects an overlap concealed by an existing symlink", async () => {
		const directory = await makeTemporaryDirectory();
		const sourcePath = join(directory, "source");
		const sourceAliasPath = join(directory, "source-alias");
		await mkdir(sourcePath);
		await symlink(sourcePath, sourceAliasPath);
		const configPath = await writeConfig(
			directory,
			tomlPaths({
				watch_root: sourcePath,
				generated_library_root: join(sourceAliasPath, "library"),
			}),
		);

		await expect(loadExplicitConfig(configPath)).rejects.toThrow(
			"must not overlap",
		);
	});

	test("rejects a dangling symlink in a configured root", async () => {
		const directory = await makeTemporaryDirectory();
		const danglingPath = join(directory, "dangling");
		await symlink(join(directory, "missing-target"), danglingPath);
		const configPath = await writeConfig(
			directory,
			tomlPaths({ watch_root: danglingPath }),
		);

		await expect(loadExplicitConfig(configPath)).rejects.toThrow(
			"Cannot resolve paths.watch_root",
		);
	});

	test("resolves an existing watch-root symlink", async () => {
		const directory = await makeTemporaryDirectory();
		const realRoot = join(directory, "real-root");
		const symlinkRoot = join(directory, "linked-root");
		await mkdir(realRoot);
		await symlink(realRoot, symlinkRoot);
		const configPath = await writeConfig(
			directory,
			tomlPaths({ watch_root: symlinkRoot }),
		);

		const config = await loadExplicitConfig(configPath);
		expect(config).toMatchObject({
			paths: { watchRoot: await realpath(realRoot) },
		});
	});

	test("rejects a nonexistent watch root", async () => {
		const directory = await makeTemporaryDirectory();
		const missingWatchRoot = join(directory, "missing", "watch-root");
		const configPath = await writeConfig(
			directory,
			tomlPaths({ watch_root: missingWatchRoot }),
		);

		await expect(loadExplicitConfig(configPath)).rejects.toThrow(
			"Cannot resolve paths.watch_root",
		);
	});

	test("creates and resolves managed roots", async () => {
		const directory = await makeTemporaryDirectory();
		const generatedTarget = join(directory, "generated-target");
		const generatedAlias = join(directory, "generated-alias");
		await mkdir(generatedTarget);
		await symlink(generatedTarget, generatedAlias);
		const generatedLibraryRoot = join(generatedAlias, "library");
		const configPath = await writeConfig(
			directory,
			tomlPaths({
				generated_library_root: generatedLibraryRoot,
			}),
		);

		const config = await loadExplicitConfig(configPath);
		expect(config).toMatchObject({
			paths: {
				generatedLibraryRoot: await realpath(
					join(generatedTarget, "library"),
				),
				cacheRoot: await realpath(
					join(defaultHomeDirectory, ".siftone", "cache"),
				),
				stagingRoot: await realpath(
					join(generatedTarget, ".siftone-staging"),
				),
				stateRoot: await realpath(
					join(defaultHomeDirectory, ".siftone", "state"),
				),
				backupRoot: await realpath(
					join(defaultHomeDirectory, ".siftone", "backups"),
				),
			},
		});
	});

	test("rejects a path below an existing file", async () => {
		const directory = await makeTemporaryDirectory();
		const existingFile = join(directory, "file");
		const invalidPath = join(existingFile, "child");
		await writeFile(existingFile, "not a directory");
		const configPath = await writeConfig(
			directory,
			tomlPaths({ watch_root: invalidPath }),
		);

		await expect(loadExplicitConfig(configPath)).rejects.toThrow(
			"Cannot resolve paths.watch_root",
		);

		await writeFile(
			configPath,
			tomlPaths({ generated_library_root: invalidPath }),
		);
		await expect(loadExplicitConfig(configPath)).rejects.toThrow(
			"Cannot create paths.generated_library_root",
		);
	});
});
