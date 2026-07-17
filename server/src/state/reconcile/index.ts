import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { canonicalAbsolutePath, isPathWithinRoot } from "../../path-utils";
import type { PublicationInput } from "../../publication/publish";
import { mapBounded } from "../../util/util";
import type { ImportState } from "../import-state";
import { ensurePublicationRoots, isOwnedPublicLeaf } from "../operation-paths";
import { desiredFor, entriesMatch } from "../publication-snapshot";
import { immediate, nowNs } from "./database";
import { executeOperation } from "./execute-operation";
import { currentImports, destinationEntries } from "./operation-entries";
import {
	createOperation,
	existingFor,
	persistAutomaticArtwork,
} from "./operation-store";
import type { OperationRow } from "./types";
import { collectRetiredVersions } from "./version-gc";

const OPERATION_CONCURRENCY = 4;

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
	cacheRoot,
	versionRoot = join(generatedLibraryRoot, ".siftone", "versions"),
	versionRetentionHours = 24,
}: Readonly<{
	state: ImportState;
	generatedLibraryRoot: string;
	stagingRoot: string;
	cacheRoot: string;
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

	await mapBounded(
		operations,
		(operation) =>
			executeOperation(
				state,
				generatedLibraryRoot,
				stagingRoot,
				versionRoot,
				cacheRoot,
				operation,
			),
		OPERATION_CONCURRENCY,
	);
	await collectRetiredVersions(
		state,
		generatedLibraryRoot,
		versionRoot,
		versionRetentionHours,
	);
}

export async function reconcileImports({
	state,
	generatedLibraryRoot,
	stagingRoot,
	cacheRoot,
	versionRoot = join(generatedLibraryRoot, ".siftone", "versions"),
	versionRetentionHours = 24,
	watchRoot,
	inputs,
	complete,
	incompleteSourceContainers = [],
	observedSourceContainers = [],
}: Readonly<{
	state: ImportState;
	generatedLibraryRoot: string;
	stagingRoot: string;
	cacheRoot: string;
	versionRoot?: string;
	versionRetentionHours?: number;
	watchRoot: string;
	inputs: readonly PublicationInput[];
	complete: boolean;
	incompleteSourceContainers?: readonly string[];
	observedSourceContainers?: readonly string[];
}>): Promise<void> {
	await mkdir(versionRoot, { recursive: true });
	await ensurePublicationRoots(
		generatedLibraryRoot,
		stagingRoot,
		versionRoot,
	);

	const desired = await mapBounded(inputs, (input) =>
		desiredFor(watchRoot, generatedLibraryRoot, input),
	);

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
				cacheRoot,
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
				persistAutomaticArtwork(
					state,
					existing.release_id,
					item.input.automaticArtwork,
					timestamp,
				);
			});
		} else {
			immediate(state, () =>
				persistAutomaticArtwork(
					state,
					existing.release_id,
					item.input.automaticArtwork,
				),
			);
		}
	}

	if (complete || observedSourceContainers.length > 0) {
		const excluded = new Set(
			incompleteSourceContainers.map((path) =>
				containerKey(watchRoot, path),
			),
		);

		const observed = observedSourceContainers.map((path) =>
			containerKey(watchRoot, path),
		);

		const current = currentImports(state, complete ? undefined : observed);

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
	await mapBounded(
		scheduled,
		(operation) =>
			executeOperation(
				state,
				generatedLibraryRoot,
				stagingRoot,
				versionRoot,
				cacheRoot,
				operation,
			),
		OPERATION_CONCURRENCY,
	);
	await collectRetiredVersions(
		state,
		generatedLibraryRoot,
		versionRoot,
		versionRetentionHours,
	);
}
