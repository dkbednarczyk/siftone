import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { PublicationInput } from "../../publication/plan";
import {
	canonicalAbsolutePath,
	isMissingError,
	isPathWithinRoot,
} from "../../util/path";
import type { ImportState } from "../import-state";
import { ensurePublicationRoots, isOwnedPublicLeaf } from "../operation-paths";
import { desiredFor, entriesMatch } from "../publication-snapshot";
import { immediate } from "./database";
import { executeOperation } from "./execute-operation";
import { currentImports, destinationEntries } from "./operation-entries";
import { createOperation, existingFor } from "./operation-store";
import type { OperationRow } from "./types";
import { collectRetiredVersions } from "./version-gc";

function containerKey(watchRoot: string, path: string): string {
	const containerPath = canonicalAbsolutePath(
		isAbsolute(path) ? path : join(watchRoot, path),
	);

	if (!isPathWithinRoot(watchRoot, containerPath)) {
		throw new Error(`Source container escapes its watch root: ${path}`);
	}

	return containerPath;
}

export async function recoverInterruptedOperations({
	state,
	generatedLibraryRoot,
	stagingRoot,
	versionRoot = join(generatedLibraryRoot, ".siftone", "versions"),
	versionRetentionHours = 24,
}: Readonly<{
	state: ImportState;
	generatedLibraryRoot: string;
	stagingRoot: string;
	versionRoot?: string;
	versionRetentionHours?: number;
}>): Promise<void> {
	await mkdir(versionRoot, { recursive: true });
	await ensurePublicationRoots(
		generatedLibraryRoot,
		stagingRoot,
		versionRoot,
	);

	const operations = state.database
		.query<OperationRow, []>(
			"SELECT id, import_id, kind, phase, target_destination_path, staging_path, version_id, version_path FROM operations WHERE phase <> 'attention_required' ORDER BY created_at_ns",
		)
		.all();

	for (const operation of operations) {
		await executeOperation(
			state,
			generatedLibraryRoot,
			stagingRoot,
			versionRoot,
			operation,
		);
	}
	await collectRetiredVersions(
		state,
		generatedLibraryRoot,
		versionRoot,
		versionRetentionHours,
	);
}

export async function hasPublishedOutputDrift({
	state,
	versionRoot,
}: Readonly<{
	state: ImportState;
	versionRoot: string;
}>): Promise<boolean> {
	const published = state.database
		.query<
			{
				import_id: string;
				destination_path: string | null;
				version_path: string | null;
			},
			[]
		>(
			"SELECT i.id AS import_id, i.destination_path, av.version_path FROM imports i JOIN album_versions av ON av.id = i.current_version_id WHERE i.destination_path IS NOT NULL AND i.availability = 'present'",
		)
		.all();

	for (const publication of published) {
		const entries = destinationEntries(state, publication.import_id);
		if (
			publication.destination_path === null ||
			publication.version_path === null ||
			!(await isOwnedPublicLeaf(
				publication.destination_path,
				publication.version_path,
				versionRoot,
			)) ||
			!(await entriesMatch(publication.version_path, entries))
		) {
			return true;
		}
	}

	return false;
}

async function hasUnavailableSourceEntries(
	entries: ReturnType<typeof destinationEntries>,
): Promise<boolean> {
	for (const entry of entries) {
		try {
			const status = await lstat(entry.sourcePath);
			if (!status.isFile() || status.isSymbolicLink()) {
				return true;
			}
		} catch (error) {
			if (isMissingError(error)) {
				return true;
			}

			throw error;
		}
	}

	return false;
}

/**
 * Removes public leaves whose recorded source entries are no longer real files.
 * It intentionally preserves the import and immutable version for later repair.
 */
export async function unpublishUnavailableImports({
	state,
	generatedLibraryRoot,
	stagingRoot,
	versionRoot = join(generatedLibraryRoot, ".siftone", "versions"),
	incompleteSourceContainers = [],
}: Readonly<{
	state: ImportState;
	generatedLibraryRoot: string;
	stagingRoot: string;
	versionRoot?: string;
	incompleteSourceContainers?: readonly string[];
}>): Promise<void> {
	await mkdir(versionRoot, { recursive: true });
	await ensurePublicationRoots(
		generatedLibraryRoot,
		stagingRoot,
		versionRoot,
	);

	const scheduled: OperationRow[] = [];
	const existingOperationQuery = state.database.query<
		{ id: string },
		[string]
	>("SELECT id FROM operations WHERE import_id = ?");
	const excluded = new Set(incompleteSourceContainers);

	for (const current of currentImports(state)) {
		if (
			current.availability !== "present" ||
			excluded.has(current.root_path) ||
			existingOperationQuery.get(current.import_id) !== null ||
			!(await hasUnavailableSourceEntries(
				destinationEntries(state, current.import_id),
			))
		) {
			continue;
		}

		const existing = existingFor(
			state,
			current.root_path,
			current.logical_release_key,
		);
		if (existing === null || existing.destination_path === null) {
			throw new Error("Published import has no reconciliation state");
		}

		scheduled.push(
			createOperation(
				state,
				existing,
				undefined,
				stagingRoot,
				versionRoot,
				"unpublish",
				existing.destination_path,
			),
		);
	}

	for (const operation of scheduled) {
		await executeOperation(
			state,
			generatedLibraryRoot,
			stagingRoot,
			versionRoot,
			operation,
		);
	}
}

export async function reconcileImports({
	state,
	generatedLibraryRoot,
	stagingRoot,
	versionRoot = join(generatedLibraryRoot, ".siftone", "versions"),
	versionRetentionHours = 24,
	watchRoot,
	inputs,
	complete,
	incompleteSourceContainers = [],
	onProgress,
}: Readonly<{
	state: ImportState;
	generatedLibraryRoot: string;
	stagingRoot: string;
	versionRoot?: string;
	versionRetentionHours?: number;
	watchRoot: string;
	inputs: readonly PublicationInput[];
	complete: boolean;
	incompleteSourceContainers?: readonly string[];
	onProgress?: (message: string) => void;
}>): Promise<void> {
	onProgress?.(
		`Building reconciliation state for ${inputs.length} desired import(s).`,
	);

	await mkdir(versionRoot, { recursive: true });
	await ensurePublicationRoots(
		generatedLibraryRoot,
		stagingRoot,
		versionRoot,
	);

	const desired = [];

	for (const input of inputs) {
		desired.push(await desiredFor(watchRoot, generatedLibraryRoot, input));
	}

	const desiredKeys = new Map<string, Set<string>>();
	const scheduled: OperationRow[] = [];
	const existingOperationQuery = state.database.query<
		{ id: string },
		[string]
	>("SELECT id FROM operations WHERE import_id = ?");

	for (const item of desired) {
		const releaseKeys =
			desiredKeys.get(item.containerPath) ?? new Set<string>();

		if (releaseKeys.has(item.input.logicalReleaseKey)) {
			throw new Error(
				`Duplicate source release: ${item.containerPath} (${item.input.logicalReleaseKey})`,
			);
		}

		releaseKeys.add(item.input.logicalReleaseKey);
		desiredKeys.set(item.containerPath, releaseKeys);

		const existing = existingFor(
			state,
			item.containerPath,
			item.input.logicalReleaseKey,
		);

		if (
			existing !== null &&
			existingOperationQuery.get(existing.import_id) !== null
		) {
			continue;
		}

		if (existing === null) {
			scheduled.push(
				createOperation(
					state,
					null,
					item,
					stagingRoot,
					versionRoot,
					"add",
					null,
				),
			);
		} else if (
			existing.destination_path !== item.destinationPath ||
			existing.manifest_hash !== item.manifestHash
		) {
			scheduled.push(
				createOperation(
					state,
					existing,
					item,
					stagingRoot,
					versionRoot,
					"replace",
					existing.destination_path,
				),
			);
		} else if (
			existing.version_path === null ||
			!(await isOwnedPublicLeaf(
				item.destination,
				existing.version_path,
				versionRoot,
			)) ||
			!(await entriesMatch(
				existing.version_path,
				destinationEntries(state, existing.import_id),
			))
		) {
			scheduled.push(
				createOperation(
					state,
					existing,
					item,
					stagingRoot,
					versionRoot,
					"repair",
					existing.destination_path,
				),
			);
		} else if (existing.availability !== "present") {
			immediate(state, () => {
				state.database.run(
					"UPDATE imports SET availability = 'present' WHERE id = ?",
					[existing.import_id],
				);
			});
		}
	}

	if (complete) {
		const excluded = new Set(
			incompleteSourceContainers.map((path) =>
				containerKey(watchRoot, path),
			),
		);
		const current = currentImports(state);

		for (const row of current) {
			if (
				desiredKeys.get(row.root_path)?.has(row.logical_release_key) ===
					true ||
				excluded.has(row.root_path)
			) {
				continue;
			}

			if (existingOperationQuery.get(row.import_id) !== null) {
				continue;
			}

			if (row.availability === "present") {
				const existing = existingFor(
					state,
					row.root_path,
					row.logical_release_key,
				);
				if (existing === null || existing.destination_path === null) {
					throw new Error(
						"Published import has no reconciliation state",
					);
				}

				scheduled.push(
					createOperation(
						state,
						existing,
						undefined,
						stagingRoot,
						versionRoot,
						"unpublish",
						existing.destination_path,
					),
				);
			}
		}
	}
	const additions = scheduled.filter(
		(operation) => operation.kind === "add",
	).length;
	const replacements = scheduled.filter(
		(operation) => operation.kind === "replace",
	).length;
	const repairs = scheduled.filter(
		(operation) => operation.kind === "repair",
	).length;
	const unpublished = scheduled.filter(
		(operation) => operation.kind === "unpublish",
	).length;

	if (scheduled.length === 0) {
		onProgress?.("No publication operations are needed.");
	} else {
		onProgress?.(
			`Applying ${scheduled.length} publication operation(s): ${additions} add, ${replacements} replace, ${repairs} repair, ${unpublished} unpublish.`,
		);
	}

	for (const [index, operation] of scheduled.entries()) {
		await executeOperation(
			state,
			generatedLibraryRoot,
			stagingRoot,
			versionRoot,
			operation,
		);

		const completed = index + 1;
		if (completed % 25 === 0 || completed === scheduled.length) {
			onProgress?.(
				`Applied ${completed} of ${scheduled.length} publication operation(s).`,
			);
		}
	}
	await collectRetiredVersions(
		state,
		generatedLibraryRoot,
		versionRoot,
		versionRetentionHours,
	);
}
