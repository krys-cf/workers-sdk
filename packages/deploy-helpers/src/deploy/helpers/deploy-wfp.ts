import type { Logger } from "@cloudflare/workers-utils";

export function deployWfpUserWorker(
	dispatchNamespace: string,
	versionId: string | null,
	logger: Logger
) {
	// Will go under the "Uploaded" text
	logger.log("  Dispatch Namespace:", dispatchNamespace);
	logger.log("Current Version ID:", versionId);
}
