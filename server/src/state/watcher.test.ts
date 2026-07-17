import { describe, expect, test } from "bun:test";
import { startSourceWatcher } from "./watcher";

function wait(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("source reconciliation scheduler", () => {
	test("runs a manual reconciliation and exposes its status", async () => {
		let calls = 0;
		let resolveRun: (() => void) | undefined;
		const running = new Promise<void>((resolve) => {
			resolveRun = resolve;
		});
		const scheduler = startSourceWatcher({
			intervalMs: 60_000,
			onReconcile: async () => {
				calls += 1;
				await running;
			},
			onFailure: () => {},
		});

		try {
			expect(scheduler.request().state).toBe("running");
			expect(scheduler.request().state).toBe("queued");
			resolveRun?.();
			await wait(10);
			expect(calls).toBe(2);
		} finally {
			await scheduler.close();
		}
	});

	test("coalesces an elapsed timer tick while a scan is running", async () => {
		let calls = 0;
		let resolveRun: (() => void) | undefined;
		const running = new Promise<void>((resolve) => {
			resolveRun = resolve;
		});
		const scheduler = startSourceWatcher({
			intervalMs: 5,
			onReconcile: async () => {
				calls += 1;
				if (calls === 1) {
					await running;
				}
			},
			onFailure: () => {},
		});

		try {
			await wait(15);
			const status = scheduler.status();
			resolveRun?.();
			await wait(10);
			expect(status.state).toBe("queued");
			expect(calls).toBeGreaterThanOrEqual(2);
		} finally {
			resolveRun?.();
			await scheduler.close();
		}
	});

	test("backs off after a failed scheduled reconciliation", async () => {
		const failures: string[] = [];
		const scheduler = startSourceWatcher({
			intervalMs: 60_000,
			onReconcile: async () => {
				throw new Error("scan failed");
			},
			onFailure: (error) => {
				failures.push(error.message);
			},
		});

		try {
			scheduler.request();
			await wait(10);
			expect(failures).toEqual(["scan failed"]);
			expect(scheduler.status()).toMatchObject({
				state: "backoff",
				lastError: "scan failed",
			});
		} finally {
			await scheduler.close();
		}
	});

	test("manual requests bypass scheduled backoff", async () => {
		let calls = 0;
		const scheduler = startSourceWatcher({
			intervalMs: 60_000,
			onReconcile: async () => {
				calls += 1;
				if (calls === 1) {
					throw new Error("offline");
				}
			},
			onFailure: () => {},
		});

		try {
			scheduler.request();
			await wait(10);
			expect(scheduler.status().state).toBe("backoff");
			scheduler.request();
			await wait(10);
			expect(calls).toBe(2);
			expect(scheduler.status().state).toBe("idle");
		} finally {
			await scheduler.close();
		}
	});
});
