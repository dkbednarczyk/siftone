import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import {
	copyFile,
	mkdir,
	readdir,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { type ImportState, validateImportStateSchema } from "./import-state";

const BACKUP_PREFIX = "library-state-";
const BACKUP_SUFFIX = ".sqlite";
const RETAINED_BACKUPS = 7;

function backupName(now: Date): string {
	return `${BACKUP_PREFIX}${now.toISOString().slice(0, 10)}${BACKUP_SUFFIX}`;
}

function hasSidecars(path: string): boolean {
	return existsSync(`${path}-wal`) || existsSync(`${path}-shm`);
}

async function verifySnapshot(path: string): Promise<void> {
	const database = new Database(path, { strict: true });

	try {
		const result = database
			.query<{ quick_check: string }, []>("PRAGMA quick_check")
			.get();

		if (result?.quick_check !== "ok") {
			throw new Error(
				`SQLite quick_check failed: ${result?.quick_check ?? "no result"}`,
			);
		}

		validateImportStateSchema(database);
	} finally {
		database.close();

		await Promise.all([
			rm(`${path}-wal`, { force: true }),
			rm(`${path}-shm`, { force: true }),
		]);
	}
}

async function backupPaths(backupRoot: string): Promise<string[]> {
	return (await readdir(backupRoot))
		.filter(
			(name) =>
				name.startsWith(BACKUP_PREFIX) && name.endsWith(BACKUP_SUFFIX),
		)
		.toSorted()
		.map((name) => join(backupRoot, name));
}

/** Creates one self-contained verified SQLite snapshot per UTC day. */
export async function createDailyBackup(
	state: ImportState,
	backupRoot: string,
	now = new Date(),
): Promise<string | undefined> {
	await mkdir(backupRoot, { recursive: true });

	const path = join(backupRoot, backupName(now));
	if ((await backupPaths(backupRoot)).includes(path)) {
		return undefined;
	}

	const temporary = `${path}.tmp-${process.pid}`;
	try {
		const snapshot = state.database.serialize();
		if (!(snapshot.buffer instanceof ArrayBuffer)) {
			throw new Error(
				"SQLite snapshot uses an unsupported shared buffer",
			);
		}

		await writeFile(
			temporary,
			new Uint8Array(
				snapshot.buffer,
				snapshot.byteOffset,
				snapshot.byteLength,
			),
		);
		await verifySnapshot(temporary);
		await rename(temporary, path);

		const paths = await backupPaths(backupRoot);
		await Promise.all(
			paths
				.slice(0, -RETAINED_BACKUPS)
				.map((oldPath) => rm(oldPath, { force: true })),
		);

		return path;
	} finally {
		await rm(temporary, { force: true });

		await Promise.all([
			rm(`${temporary}-wal`, { force: true }),
			rm(`${temporary}-shm`, { force: true }),
		]);
	}
}

/** Restores only a self-contained, compatible snapshot while the state lock is held. */
export async function restoreBackup({
	backupPath,
	databasePath,
}: Readonly<{ backupPath: string; databasePath: string }>): Promise<void> {
	if (hasSidecars(backupPath)) {
		throw new Error(
			"Refusing a backup with SQLite WAL/SHM sidecars; create a self-contained snapshot first",
		);
	}

	const temporary = `${databasePath}.restore-${process.pid}`;
	const previous = `${databasePath}.previous-${process.pid}`;
	try {
		await copyFile(backupPath, temporary);
		await verifySnapshot(temporary);

		if (existsSync(databasePath)) {
			await rename(databasePath, previous);
		}

		await Promise.all([
			rm(`${databasePath}-wal`, { force: true }),
			rm(`${databasePath}-shm`, { force: true }),
		]);

		await rename(temporary, databasePath);
		await rm(previous, { force: true });
	} catch (error) {
		if (existsSync(previous) && !existsSync(databasePath)) {
			await rename(previous, databasePath);
		}

		throw error;
	} finally {
		await Promise.all([
			rm(temporary, { force: true }),
			rm(`${temporary}-wal`, { force: true }),
			rm(`${temporary}-shm`, { force: true }),
		]);
	}
}
