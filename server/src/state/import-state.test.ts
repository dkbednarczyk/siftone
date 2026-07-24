import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openImportState } from "./import-state";

describe("import state", () => {
	test("tracks manifest reconciliation and reports scan issues", async () => {
		const root = await mkdtemp(join(tmpdir(), "siftone-import-state-"));
		const watchRoot = join(root, "watch");
		const generatedLibraryRoot = join(root, "generated");
		const versionRoot = join(root, "versions");
		const stateRoot = join(root, "state");
		const manifestHash = "a".repeat(64);

		try {
			await Promise.all([
				mkdir(watchRoot),
				mkdir(generatedLibraryRoot),
				mkdir(versionRoot),
				mkdir(stateRoot),
			]);
			const state = await openImportState({
				stateRoot,
				generatedLibraryRoot,
				versionRoot,
			});
			try {
				expect(
					state.observeSourceManifest({
						watchRoot,
						manifestHash,
						minimumAgeMs: 0,
					}),
				).toEqual({ confirmed: false, unchanged: false });
				expect(state.reconciliationReason(watchRoot)).toBe(
					"source snapshot awaiting confirmation",
				);

				expect(
					state.observeSourceManifest({
						watchRoot,
						manifestHash,
						minimumAgeMs: 0,
					}),
				).toEqual({ confirmed: true, unchanged: false });
				state.markManifestReconciled(watchRoot, manifestHash);
				expect(
					state.isManifestReconciled(watchRoot, manifestHash),
				).toBe(true);
				expect(state.reconciliationReason(watchRoot)).toBeUndefined();

				state.recordScanIssue("Source observation is incomplete");
				expect(state.isDegraded()).toBe(true);
				expect(state.reconciliationReason(watchRoot)).toBe(
					"Source observation is incomplete",
				);
			} finally {
				state.close();
			}
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
});
