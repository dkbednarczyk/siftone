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
