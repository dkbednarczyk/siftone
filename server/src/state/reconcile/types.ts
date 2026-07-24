import type { PublicationInput } from "../../publication/plan";
import type { ImportOperationPhase } from "../import-state";

export type SourceEntry = Readonly<{
	origin: "source";
	sourcePath: string;
	relativeSourcePath: string;
	destinationName: string;
	size: bigint;
	mtimeNs: bigint;
	kind: "audio" | "artwork";
}>;

export type Entry = SourceEntry;

export type Desired = {
	input: PublicationInput;
	containerPath: string;
	destination: string;
	destinationPath: string;
	entries: Entry[];
	manifestHash: string;
};

export type OperationRow = {
	id: string;
	import_id: string;
	source_release_id: string;
	kind: "add" | "replace" | "delete" | "repair";
	phase: ImportOperationPhase;
	target_destination_path: string;
	staging_path: string;
	version_id: string | null;
	version_path: string | null;
};
