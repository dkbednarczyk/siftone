import { Elysia } from "elysia";
import type { ReconciliationStatus } from "./state/watcher";

export type HealthStatus = "ok" | "degraded";

export type ReconciliationController = Readonly<{
	status(): ReconciliationStatus;
	request(): ReconciliationStatus;
}>;

export function createApp(
	getHealthStatus: () => HealthStatus = () => "ok",
	getReconciliationController: () =>
		| ReconciliationController
		| undefined = () => undefined,
) {
	return new Elysia()
		.get("/api/v1/health", () => ({ status: getHealthStatus() }))
		.get("/api/v1/reconciliation/status", ({ set }) => {
			const controller = getReconciliationController();

			if (controller === undefined) {
				set.status = 503;
				return {
					error: {
						code: "UNAVAILABLE",
						message: "Reconciliation is not ready",
					},
				};
			}

			return controller.status();
		})
		.post("/api/v1/reconciliation/rescan", ({ set }) => {
			const controller = getReconciliationController();

			if (controller === undefined) {
				set.status = 503;
				return {
					error: {
						code: "UNAVAILABLE",
						message: "Reconciliation is not ready",
					},
				};
			}

			set.status = 202;
			return controller.request();
		})
		.onError(({ code, set }) => {
			if (code === "NOT_FOUND") {
				set.status = 404;
				return {
					error: {
						code: "NOT_FOUND",
						message: "Route not found",
					},
				};
			}

			set.status = 500;
			return {
				error: {
					code: "INTERNAL_ERROR",
					message: "Internal server error",
				},
			};
		});
}
