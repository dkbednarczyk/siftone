import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import {
	dirname,
	isAbsolute,
	join,
	normalize,
	relative,
	resolve,
} from "node:path";
import { z } from "zod";

export type ServerPaths = Readonly<{
	watchRoot: string;
	generatedLibraryRoot: string;
	cacheRoot: string;
	stagingRoot: string;
	stateRoot: string;
	backupRoot: string;
}>;

export type ServerConfig = Readonly<{
	configPath: string;
	port: number;
	paths: ServerPaths;
}>;

export type ConfigLoadOptions = Readonly<{
	configPath?: string;
	cwd?: string;
	executablePath?: string;
	homeDirectory?: string;
}>;

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

const DEFAULT_PORT = 3000;

type PathField =
	| "watch_root"
	| "generated_library_root"
	| "cache_root"
	| "staging_root"
	| "state_root"
	| "backup_root";

const TomlConfigSchema = z.strictObject({
	server: z
		.strictObject({
			port: z.number().int().min(1).max(65_535).optional(),
		})
		.optional(),
	paths: z.strictObject({
		watch_root: z.string(),
		generated_library_root: z.string(),
		cache_root: z.string().optional(),
		staging_root: z.string().optional(),
		state_root: z.string().optional(),
		backup_root: z.string().optional(),
	}),
});

type TomlConfig = z.infer<typeof TomlConfigSchema>;

export function resolveConfigPath({
	configPath,
	cwd = process.cwd(),
	executablePath = process.execPath,
}: ConfigLoadOptions = {}): string {
	if (configPath !== undefined) {
		return resolve(cwd, configPath);
	}

	return join(dirname(executablePath), "config.toml");
}

function validateAbsolutePath(value: string, field: PathField[0]): string {
	if (value.trim() === "") {
		throw new ConfigError(
			`paths.${field} must be a non-empty absolute path`,
		);
	}

	if (!isAbsolute(value)) {
		throw new ConfigError(`paths.${field} must be an absolute path`);
	}

	return normalize(value);
}

async function resolveExistingDirectory(
	value: string,
	field: PathField[0],
): Promise<string> {
	const path = validateAbsolutePath(value, field);

	try {
		const canonicalPath = await realpath(path);

		if (!(await stat(canonicalPath)).isDirectory()) {
			throw new ConfigError(`paths.${field} must be a directory`);
		}

		return canonicalPath;
	} catch (error) {
		if (error instanceof ConfigError) {
			throw error;
		}

		throw new ConfigError(
			`Cannot resolve paths.${field} (${path}): ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

async function createAndResolveDirectory(
	value: string,
	field: PathField[0],
): Promise<string> {
	const path = validateAbsolutePath(value, field);

	try {
		await mkdir(path, { recursive: true });
		const canonicalPath = await realpath(path);

		if (!(await stat(canonicalPath)).isDirectory()) {
			throw new ConfigError(`paths.${field} must be a directory`);
		}

		return canonicalPath;
	} catch (error) {
		throw new ConfigError(
			`Cannot create paths.${field} (${path}): ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

function pathsOverlap(firstPath: string, secondPath: string): boolean {
	const difference = relative(firstPath, secondPath);
	return (
		difference === "" ||
		(difference !== ".." && !difference.startsWith("../"))
	);
}

function validateNoOverlaps(paths: ServerPaths): void {
	const entries = Object.entries(paths) as [keyof ServerPaths, string][];

	for (let first = 0; first < entries.length; first += 1) {
		for (let second = first + 1; second < entries.length; second += 1) {
			const [firstName, firstPath] = entries[first];
			const [secondName, secondPath] = entries[second];
			if (
				pathsOverlap(firstPath, secondPath) ||
				pathsOverlap(secondPath, firstPath)
			) {
				throw new ConfigError(
					`paths.${firstName} and paths.${secondName} must not overlap`,
				);
			}
		}
	}
}

function parsePort(config: TomlConfig): number {
	return config.server?.port ?? DEFAULT_PORT;
}

async function parsePaths(
	config: TomlConfig,
	homeDirectory: string,
): Promise<ServerPaths> {
	const dataRoot = join(homeDirectory, ".siftone");
	const configuredPaths: ServerPaths = {
		watchRoot: validateAbsolutePath(config.paths.watch_root, "watch_root"),
		generatedLibraryRoot: validateAbsolutePath(
			config.paths.generated_library_root,
			"generated_library_root",
		),
		cacheRoot: validateAbsolutePath(
			config.paths.cache_root ?? join(dataRoot, "cache"),
			"cache_root",
		),
		stagingRoot: validateAbsolutePath(
			config.paths.staging_root ??
				join(
					dirname(config.paths.generated_library_root),
					".siftone-staging",
				),
			"staging_root",
		),
		stateRoot: validateAbsolutePath(
			config.paths.state_root ?? join(dataRoot, "state"),
			"state_root",
		),
		backupRoot: validateAbsolutePath(
			config.paths.backup_root ?? join(dataRoot, "backups"),
			"backup_root",
		),
	};
	validateNoOverlaps(configuredPaths);

	const watchRoot = await resolveExistingDirectory(
		configuredPaths.watchRoot,
		"watch_root",
	);
	validateNoOverlaps({ ...configuredPaths, watchRoot });

	const generatedLibraryRoot = await createAndResolveDirectory(
		configuredPaths.generatedLibraryRoot,
		"generated_library_root",
	);
	const cacheRoot = await createAndResolveDirectory(
		configuredPaths.cacheRoot,
		"cache_root",
	);
	const stagingRoot = await createAndResolveDirectory(
		config.paths.staging_root ??
			join(dirname(generatedLibraryRoot), ".siftone-staging"),
		"staging_root",
	);
	const stateRoot = await createAndResolveDirectory(
		configuredPaths.stateRoot,
		"state_root",
	);
	const backupRoot = await createAndResolveDirectory(
		configuredPaths.backupRoot,
		"backup_root",
	);

	const paths: ServerPaths = {
		watchRoot,
		generatedLibraryRoot,
		cacheRoot,
		stagingRoot,
		stateRoot,
		backupRoot,
	};
	validateNoOverlaps(paths);
	return paths;
}

export async function loadServerConfig(
	options: ConfigLoadOptions = {},
): Promise<ServerConfig> {
	const executablePath = options.executablePath ?? process.execPath;
	const configPath = resolveConfigPath({ ...options, executablePath });

	let contents: string;

	try {
		contents = await Bun.file(configPath).text();
	} catch (error) {
		throw new ConfigError(
			`Cannot read configuration file ${configPath}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}

	let parsed: unknown;
	try {
		parsed = Bun.TOML.parse(contents);
	} catch (error) {
		throw new ConfigError(
			`Invalid TOML in ${configPath}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}

	const result = TomlConfigSchema.safeParse(parsed);
	if (!result.success) {
		const issues = result.error.issues
			.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
			.join("; ");
		throw new ConfigError(
			`Invalid configuration in ${configPath}: ${issues}`,
		);
	}

	return {
		configPath,
		port: parsePort(result.data),
		paths: await parsePaths(
			result.data,
			options.homeDirectory ?? homedir(),
		),
	};
}
