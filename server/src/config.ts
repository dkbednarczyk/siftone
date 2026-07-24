import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
	createAndResolveDirectory,
	isSameOrDescendant,
	resolveExistingDirectory,
	validateAbsolutePath,
} from "./util/path";

export type ServerPaths = Readonly<{
	watchRoot: string;
	generatedLibraryRoot: string;
	stagingRoot: string;
	versionRoot: string;
	stateRoot: string;
	backupRoot: string;
}>;

export type ServerConfig = Readonly<{
	configPath: string;
	port: number;
	reconciliationIntervalSeconds: number;
	paths: ServerPaths;
	versionRetentionHours: number;
}>;

export type ConfigLoadOptions = Readonly<{
	configPath?: string;
	cwd?: string;
	homeDirectory?: string;
}>;

const DEFAULT_PORT = 3000;
const DEFAULT_RECONCILIATION_INTERVAL_SECONDS = 300;

const TomlConfigSchema = z.strictObject({
	server: z
		.strictObject({
			port: z.number().int().min(1).max(65_535).optional(),
			reconciliation_interval_seconds: z.number().int().min(1).optional(),
		})
		.optional(),
	paths: z.strictObject({
		watch_root: z.string(),
		generated_library_root: z.string(),
		staging_root: z.string().optional(),
		version_root: z.string().optional(),
		state_root: z.string().optional(),
		backup_root: z.string().optional(),
	}),
	publication: z
		.strictObject({
			version_retention_hours: z.number().positive().finite().optional(),
		})
		.optional(),
});

type TomlConfig = z.infer<typeof TomlConfigSchema>;

type PathField =
	| "watch_root"
	| "generated_library_root"
	| "staging_root"
	| "version_root"
	| "state_root"
	| "backup_root";

export function resolveConfigPath({
	configPath,
	cwd = process.cwd(),
}: ConfigLoadOptions = {}): string {
	return resolve(cwd, configPath ?? "config.toml");
}

async function resolveConfigDirectory(
	value: string,
	field: PathField,
): Promise<string> {
	try {
		return await resolveExistingDirectory(value, `paths.${field}`);
	} catch (error) {
		throw new Error(`Cannot resolve paths.${field}`, {
			cause: error,
		});
	}
}

async function createConfigDirectory(
	value: string,
	field: PathField,
): Promise<string> {
	try {
		return await createAndResolveDirectory(value, `paths.${field}`);
	} catch (error) {
		throw new Error(`Cannot create paths.${field}`, { cause: error });
	}
}

const internalGeneratedDirectoryNames: Partial<
	Record<keyof ServerPaths, string>
> = {
	stagingRoot: "staging",
	versionRoot: "versions",
};

function isAllowedGeneratedChild(
	parentName: keyof ServerPaths,
	parentPath: string,
	childName: keyof ServerPaths,
	childPath: string,
): boolean {
	const directoryName = internalGeneratedDirectoryNames[childName];

	return (
		parentName === "generatedLibraryRoot" &&
		directoryName !== undefined &&
		childPath === join(parentPath, ".siftone", directoryName)
	);
}

function isAllowedInternalOverlap(
	firstName: keyof ServerPaths,
	firstPath: string,
	secondName: keyof ServerPaths,
	secondPath: string,
): boolean {
	return (
		isAllowedGeneratedChild(firstName, firstPath, secondName, secondPath) ||
		isAllowedGeneratedChild(secondName, secondPath, firstName, firstPath)
	);
}

function validateNoOverlaps(paths: ServerPaths): void {
	const entries = Object.entries(paths) as [keyof ServerPaths, string][];

	for (let first = 0; first < entries.length; first += 1) {
		for (let second = first + 1; second < entries.length; second += 1) {
			const [firstName, firstPath] = entries[first];
			const [secondName, secondPath] = entries[second];

			const pathsOverlap =
				isSameOrDescendant(firstPath, secondPath) ||
				isSameOrDescendant(secondPath, firstPath);

			if (
				!isAllowedInternalOverlap(
					firstName,
					firstPath,
					secondName,
					secondPath,
				) &&
				pathsOverlap
			) {
				throw new Error(
					`paths.${firstName} and paths.${secondName} must not overlap`,
				);
			}
		}
	}
}

async function parsePaths(
	config: TomlConfig,
	homeDirectory: string,
): Promise<ServerPaths> {
	const dataRoot = join(homeDirectory, ".siftone");

	const configuredPaths: ServerPaths = {
		watchRoot: validateAbsolutePath(
			config.paths.watch_root,
			"paths.watch_root",
		),
		generatedLibraryRoot: validateAbsolutePath(
			config.paths.generated_library_root,
			"paths.generated_library_root",
		),
		stagingRoot: validateAbsolutePath(
			config.paths.staging_root ??
				join(
					config.paths.generated_library_root,
					".siftone",
					"staging",
				),
			"paths.staging_root",
		),
		versionRoot: validateAbsolutePath(
			config.paths.version_root ??
				join(
					config.paths.generated_library_root,
					".siftone",
					"versions",
				),
			"paths.version_root",
		),
		stateRoot: validateAbsolutePath(
			config.paths.state_root ?? join(dataRoot, "state"),
			"paths.state_root",
		),
		backupRoot: validateAbsolutePath(
			config.paths.backup_root ?? join(dataRoot, "backups"),
			"paths.backup_root",
		),
	};

	validateNoOverlaps(configuredPaths);

	const watchRoot = await resolveConfigDirectory(
		configuredPaths.watchRoot,
		"watch_root",
	);
	validateNoOverlaps({ ...configuredPaths, watchRoot });

	const generatedLibraryRoot = await createConfigDirectory(
		configuredPaths.generatedLibraryRoot,
		"generated_library_root",
	);

	if (generatedLibraryRoot === resolve(homeDirectory)) {
		throw new Error(
			"paths.generated_library_root must not be the home directory because .siftone is global state",
		);
	}

	const stagingRoot = await createConfigDirectory(
		config.paths.staging_root ??
			join(generatedLibraryRoot, ".siftone", "staging"),
		"staging_root",
	);

	const versionRoot = await createConfigDirectory(
		configuredPaths.versionRoot,
		"version_root",
	);

	const stateRoot = await createConfigDirectory(
		configuredPaths.stateRoot,
		"state_root",
	);

	const backupRoot = await createConfigDirectory(
		configuredPaths.backupRoot,
		"backup_root",
	);

	const paths: ServerPaths = {
		watchRoot,
		generatedLibraryRoot,
		stagingRoot,
		versionRoot,
		stateRoot,
		backupRoot,
	};

	validateNoOverlaps(paths);

	return paths;
}

export async function loadServerConfig(
	options: ConfigLoadOptions = {},
): Promise<ServerConfig> {
	const configPath = resolveConfigPath(options);

	let contents: string;

	try {
		contents = await Bun.file(configPath).text();
	} catch (error) {
		throw new Error(`Cannot read configuration file ${configPath}`, {
			cause: error,
		});
	}

	let parsed: unknown;

	try {
		parsed = Bun.TOML.parse(contents);
	} catch (error) {
		throw new Error(`Invalid TOML in ${configPath}`, {
			cause: error,
		});
	}

	const result = TomlConfigSchema.safeParse(parsed);
	if (!result.success) {
		const issues = result.error.issues
			.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
			.join("; ");

		throw new Error(`Invalid configuration in ${configPath}: ${issues}`, {
			cause: result.error.issues,
		});
	}

	return {
		configPath,
		port: result.data.server?.port ?? DEFAULT_PORT,
		reconciliationIntervalSeconds:
			result.data.server?.reconciliation_interval_seconds ??
			DEFAULT_RECONCILIATION_INTERVAL_SECONDS,
		paths: await parsePaths(
			result.data,
			options.homeDirectory ?? homedir(),
		),
		versionRetentionHours:
			result.data.publication?.version_retention_hours ?? 24,
	};
}
