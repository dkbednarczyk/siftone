import { resolve } from "node:path";
import type { ServerConfig } from "./config";
import { restoreBackup } from "./state/backup";
import { DATABASE_FILE } from "./state/import-state";

export async function restoreState(
	config: ServerConfig,
	backupPath: string,
): Promise<void> {
	await restoreBackup({
		backupPath,
		databasePath: resolve(config.paths.stateRoot, DATABASE_FILE),
	});
	console.info(
		"Restored verified SQLite library state. Start Siftone normally.",
	);
}
