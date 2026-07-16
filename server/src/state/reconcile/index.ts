import { isAbsolute, join } from "node:path";
import type { PublicationInput } from "../../publication/publish";
import { mapBounded } from "../../util/util";
import { canonicalAbsolutePath, isPathWithinRoot } from "../canonical-path";
import type { ImportState } from "../import-state";
import { ensurePublicationRoots } from "../operation-paths";
import { desiredFor, entriesMatch } from "../publication-snapshot";
import { immediate, nowNs } from "./database";
import { executeOperation } from "./execute-operation";
import { currentImports, destinationEntries } from "./operation-entries";
import { createOperation, existingFor } from "./operation-store";
import type { OperationRow } from "./types";

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
}: Readonly<{
	state: ImportState;
	generatedLibraryRoot: string;
	stagingRoot: string;
}>): Promise<void> {
	await ensurePublicationRoots(generatedLibraryRoot, stagingRoot);

	const operations = state.database
		.query<OperationRow, []>(
			"SELECT id, import_id, source_release_id, kind, phase, target_destination_path, staging_path FROM operations WHERE phase <> 'attention_required' ORDER BY created_at_ns",
		)
		.all();

	await mapBounded(
		operations,
		(operation) =>
			executeOperation(
				state,
				generatedLibraryRoot,
				stagingRoot,
				operation,
			),
		OPERATION_CONCURRENCY,
	);
}

export async function reconcileImports({
	state,
	generatedLibraryRoot,
	stagingRoot,
	watchRoot,
	inputs,
	complete,
	incompleteSourceContainers = [],
	observedSourceContainers = [],
}: Readonly<{
	state: ImportState;
	generatedLibraryRoot: string;
	stagingRoot: string;
	watchRoot: string;
	inputs: readonly PublicationInput[];
	complete: boolean;
	incompleteSourceContainers?: readonly string[];
	observedSourceContainers?: readonly string[];
}>): Promise<void> {
	await ensurePublicationRoots(generatedLibraryRoot, stagingRoot);

	const desired = await mapBounded(inputs, (input) =>
		desiredFor(watchRoot, generatedLibraryRoot, input),
	);

	const desiredKeys = new Map<string, Set<string>>();
	const scheduled: OperationRow[] = [];

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

		const id_query = state.database.query<{ id: string }, [string]>(
			"SELECT id FROM operations WHERE import_id = ?",
		);

		if (existing !== null && id_query.get(existing.import_id) !== null) {
			continue;
		}

		if (existing === null) {
			scheduled.push(
				createOperation(state, null, item, stagingRoot, "add", null),
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
					"replace",
					existing.destination_path,
				),
			);
		} else if (
			!(await entriesMatch(
				item.destination,
				destinationEntries(state, existing.import_id),
			))
		) {
			scheduled.push(
				createOperation(
					state,
					existing,
					item,
					stagingRoot,
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

			if (
				state.database
					.query<{ id: string }, [string]>(
						"SELECT id FROM operations WHERE import_id = ?",
					)
					.get(row.import_id) !== null
			) {
				continue;
			}

			immediate(state, () =>
				state.database.run(
					"UPDATE source_releases SET availability = 'missing', missing_since_ns = COALESCE(missing_since_ns, ?), updated_at_ns = ? WHERE id = ?",
					[nowNs(), nowNs(), row.release_id],
				),
			);
			scheduled.push(
				createOperation(
					state,
					{
						import_id: row.import_id,
						release_id: row.release_id,
						destination_path: row.destination_path,
						manifest_hash: "",
						container_availability: "missing",
						release_availability: "missing",
					},
					undefined,
					stagingRoot,
					"delete",
					row.destination_path,
				),
			);
		}

		if (complete) {
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
				operation,
			),
		OPERATION_CONCURRENCY,
	);
}

export async function reconcileSourceContainer(
	options: Omit<
		Parameters<typeof reconcileImports>[0],
		"complete" | "observedSourceContainers"
	> & { containerPath: string },
): Promise<void> {
	await reconcileImports({
		...options,
		complete: false,
		observedSourceContainers: [options.containerPath],
	});
}
