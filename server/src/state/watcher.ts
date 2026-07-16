import { relative, sep } from "node:path";
import chokidar from "chokidar";

export type SourceWatchEvent =
	| "add"
	| "change"
	| "unlink"
	| "addDir"
	| "unlinkDir";

export type WatchDriver = Readonly<{
	on(
		event: SourceWatchEvent | "error" | "ready",
		listener: (path: string | Error) => void,
	): unknown;
	close(): Promise<void>;
}>;

type ContainerWork = {
	dirty: boolean;
	running: boolean;
	timer?: ReturnType<typeof setTimeout>;
};

/** Coalesces watcher noise and serializes reconciliation for each source container. */
export class SourceWatchCoordinator {
	readonly #work = new Map<string, ContainerWork>();
	constructor(
		readonly watchRoot: string,
		readonly onContainer: (container: string) => Promise<void>,
		readonly onLoss: (error: Error) => void,
		readonly quietMs = 750,
	) {}
	event(path: string): void {
		const inside = relative(this.watchRoot, path);

		if (inside === "" || inside.startsWith(`..${sep}`) || inside === "..") {
			return;
		}

		const [container] = inside.split(sep);
		if (container === undefined || container === "") {
			return;
		}

		const work = this.#work.get(container) ?? {
			dirty: false,
			running: false,
		};

		this.#work.set(container, work);
		work.dirty = true;

		if (!work.running) {
			this.#schedule(container, work);
		}
	}

	#schedule(container: string, work: ContainerWork): void {
		if (work.timer !== undefined) {
			clearTimeout(work.timer);
		}

		work.timer = setTimeout(() => {
			work.timer = undefined;
			void this.#run(container, work);
		}, this.quietMs);
	}

	async #run(container: string, work: ContainerWork): Promise<void> {
		if (work.running || !work.dirty) {
			return;
		}

		work.running = true;
		work.dirty = false;

		try {
			await this.onContainer(container);
		} catch (error) {
			this.onLoss(
				error instanceof Error ? error : new Error(String(error)),
			);
		} finally {
			work.running = false;

			if (work.dirty) {
				this.#schedule(container, work);
			} else {
				this.#work.delete(container);
			}
		}
	}
	loss(error: Error): void {
		this.onLoss(error);
	}
	async flush(): Promise<void> {
		while (this.#work.size > 0) {
			for (const [container, work] of this.#work) {
				if (!work.running && work.timer === undefined && work.dirty) {
					void this.#run(container, work);
				}
			}

			await new Promise((resolve) =>
				setTimeout(resolve, Math.max(1, this.quietMs)),
			);
		}
	}
	async close(): Promise<void> {
		for (const work of this.#work.values()) {
			if (work.timer !== undefined) clearTimeout(work.timer);
		}
		
		this.#work.clear();
	}
}

export function startSourceWatcher(
	options: Readonly<{
		watchRoot: string;
		onContainer: (container: string) => Promise<void>;
		onLoss: (error: Error) => void;
		quietMs?: number;
	}>,
): Readonly<{
	coordinator: SourceWatchCoordinator;
	ready: Promise<void>;
	close(): Promise<void>;
}> {
	const coordinator = new SourceWatchCoordinator(
		options.watchRoot,
		options.onContainer,
		options.onLoss,
		options.quietMs,
	);

	const watcher = chokidar.watch(options.watchRoot, {
		ignoreInitial: true,
		persistent: true,
		awaitWriteFinish: {
			stabilityThreshold: options.quietMs ?? 750,
			pollInterval: 100,
		},
	}) as unknown as WatchDriver;

	for (const event of [
		"add",
		"change",
		"unlink",
		"addDir",
		"unlinkDir",
	] as const) {
		watcher.on(event, (path) => {
			if (typeof path === "string") coordinator.event(path);
		});
	}

	watcher.on("error", (error) => {
		if (error instanceof Error) coordinator.loss(error);
	});

	const ready = new Promise<void>((resolve) => {
		watcher.on("ready", () => resolve());
	});

	return {
		coordinator,
		ready,
		close: async () => {
			await coordinator.close();
			await watcher.close();
		},
	};
}
