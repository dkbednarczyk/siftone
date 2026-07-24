import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { PublicationInput } from "../../publication/plan";
import { canonicalAbsolutePath, isPathWithinRoot } from "../../util/path";
import type { ImportState } from "../import-state";
import { ensurePublicationRoots, isOwnedPublicLeaf } from "../operation-paths";
import { desiredFor, entriesMatch } from "../publication-snapshot";
import { immediate, nowNs } from "./database";
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
			"SELECT id, import_id, source_release_id, kind, phase, target_destination_path, staging_path, version_id, version_path FROM operations WHERE phase <> 'attention_required' ORDER BY created_at_ns",
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
			"SELECT i.id AS import_id, pd.destination_path, av.version_path FROM imports i LEFT JOIN published_destinations pd ON pd.import_id = i.id LEFT JOIN album_versions av ON av.id = pd.version_id",
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
		} else if (
			existing.container_availability !== "present" ||
			existing.release_availability !== "present"
		) {
			immediate(state, () => {
				const timestamp = nowNs();
				state.database.run(
					"UPDATE source_containers SET availability = 'present', missing_since_ns = NULL, updated_at_ns = ? WHERE root_path = ?",
					[timestamp, item.containerPath],
				);
				state.database.run(
					"UPDATE source_releases SET availability = 'present', missing_since_ns = NULL, updated_at_ns = ? WHERE id = ?",
					[timestamp, existing.release_id],
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

			if (row.release_availability === "present") {
				immediate(state, () =>
					state.database.run(
						"UPDATE source_releases SET availability = 'missing', missing_since_ns = COALESCE(missing_since_ns, ?), updated_at_ns = ? WHERE id = ?",
						[nowNs(), nowNs(), row.release_id],
					),
				);

				continue;
			}

			scheduled.push(
				createOperation(
					state,
					{
						import_id: row.import_id,
						release_id: row.release_id,
						destination_path: row.destination_path,
						version_id: null,
						version_path: null,
						manifest_hash: "",
						container_availability: "missing",
						release_availability: "missing",
					},
					undefined,
					stagingRoot,
					versionRoot,
					"delete",
					row.destination_path,
				),
			);
		}

		if (complete && incompleteSourceContainers.length === 0) {
			state.database.run(
				"UPDATE reconciliation_state SET required = 0, last_full_scan_at_ns = ?, last_error = NULL, updated_at_ns = ? WHERE id = 1",
				[nowNs(), nowNs()],
			);
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
	const deletions = scheduled.filter(
		(operation) => operation.kind === "delete",
	).length;

	if (scheduled.length === 0) {
		onProgress?.("No publication operations are needed.");
	} else {
		onProgress?.(
			`Applying ${scheduled.length} publication operation(s): ${additions} add, ${replacements} replace, ${repairs} repair, ${deletions} delete.`,
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
