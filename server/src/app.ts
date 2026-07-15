import { Elysia } from "elysia";

export type HealthStatus = "ok" | "degraded";

export function createApp(getHealthStatus: () => HealthStatus = () => "ok") {
	return new Elysia()
		.get("/api/v1/health", () => ({ status: getHealthStatus() }))
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
