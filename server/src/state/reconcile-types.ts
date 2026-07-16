import type { PublicationInput } from "../publication/publish";
import type { ImportOperationPhase } from "./import-state";

export type Entry = {
	sourcePath: string;
	relativeSourcePath: string;
	destinationName: string;
	size: bigint;
	mtimeNs: bigint;
	kind: "audio" | "artwork";
};

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
};
