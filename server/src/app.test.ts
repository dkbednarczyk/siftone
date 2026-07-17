import { describe, expect, test } from "bun:test";
import { createApp } from "./app";

describe("server app", () => {
	test("returns its health status without opening a socket", async () => {
		const response = await createApp().handle(
			new Request("http://localhost/api/v1/health"),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok" });
	});

	test("reports degraded health without failing liveness", async () => {
		const response = await createApp(() => "degraded").handle(
			new Request("http://localhost/api/v1/health"),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "degraded" });
	});

	test("returns reconciliation status and accepts rescan requests", async () => {
		let requested = false;
		const app = createApp(undefined, () => ({
			status: () => ({ state: "idle" }),
			request: () => {
				requested = true;
				return { state: "queued" };
			},
		}));

		const status = await app.handle(
			new Request("http://localhost/api/v1/reconciliation/status"),
		);
		expect(status.status).toBe(200);
		expect(await status.json()).toEqual({ state: "idle" });

		const rescan = await app.handle(
			new Request("http://localhost/api/v1/reconciliation/rescan", {
				method: "POST",
			}),
		);
		expect(rescan.status).toBe(202);
		expect(await rescan.json()).toEqual({ state: "queued" });
		expect(requested).toBe(true);
	});

	test("returns a stable JSON error for unknown routes", async () => {
		const response = await createApp().handle(
			new Request("http://localhost/api/v1/unknown"),
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: {
				code: "NOT_FOUND",
				message: "Route not found",
			},
		});
	});
});
