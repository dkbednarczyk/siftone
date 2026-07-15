import { describe, expect, test } from "bun:test";
import { SourceWatchCoordinator } from "./watcher";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
describe("source watcher coordinator", () => {
	test("coalesces create modify rename delete duplicates and bursts by container", async () => {
		const seen: string[] = [];
		const coordinator = new SourceWatchCoordinator(
			"/watch",
			async (container) => {
				seen.push(container);
			},
			() => {
				throw new Error("unexpected watcher loss");
			},
			5,
		);
		for (const path of [
			"/watch/A/01.flac",
			"/watch/A/01.flac",
			"/watch/A/02.flac",
			"/watch/B/01.flac",
			"/watch/A/renamed.flac",
		])
			coordinator.event(path);
		await wait(20);
		expect(seen.toSorted()).toEqual(["A", "B"]);
		await coordinator.close();
	});
	test("reports watcher loss for missed/offline reconciliation", () => {
		let loss: Error | undefined;
		const coordinator = new SourceWatchCoordinator(
			"/watch",
			async () => {},
			(error) => {
				loss = error;
			},
		);
		coordinator.loss(new Error("overflow"));
		expect(loss?.message).toBe("overflow");
	});
});
