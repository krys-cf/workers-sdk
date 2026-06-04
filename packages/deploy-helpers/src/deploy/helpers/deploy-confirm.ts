import type { Logger } from "@cloudflare/workers-utils";

export function getDeployConfirmFunction(options: {
	strictMode?: boolean;
	isNonInteractiveOrCI: () => boolean;
	confirm: (text: string) => Promise<boolean>;
	logger: Logger;
}): (text: string) => Promise<boolean> {
	const { strictMode = false, isNonInteractiveOrCI, confirm, logger } = options;
	const nonInteractive = isNonInteractiveOrCI();

	if (nonInteractive && strictMode) {
		return async () => {
			logger.error(
				"Aborting the deployment operation because of conflicts. To override and deploy anyway remove the `--strict` flag"
			);
			process.exitCode = 1;
			return false;
		};
	} else if (nonInteractive) {
		// if its not in strict mode, continue without asking
		return async () => true;
	}

	return confirm;
}
