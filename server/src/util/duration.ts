export function formatDuration(milliseconds: number): string {
	const roundedMilliseconds = Math.max(0, Math.round(milliseconds));
	const hours = Math.floor(roundedMilliseconds / 3_600_000);
	const minutes = Math.floor((roundedMilliseconds % 3_600_000) / 60_000);
	const seconds = Math.floor((roundedMilliseconds % 60_000) / 1_000);
	const remainingMilliseconds = roundedMilliseconds % 1_000;
	const parts: string[] = [];

	if (hours > 0) {
		parts.push(`${hours}h`);
	}
	if (minutes > 0) {
		parts.push(`${minutes}m`);
	}
	if (seconds > 0) {
		parts.push(`${seconds}s`);
	}
	if (remainingMilliseconds > 0 || parts.length === 0) {
		parts.push(`${remainingMilliseconds}ms`);
	}

	return parts.join(" ");
}
