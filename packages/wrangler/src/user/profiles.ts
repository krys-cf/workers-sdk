import { AsyncLocalStorage } from "node:async_hooks";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import {
	getGlobalWranglerConfigPath,
	UserError,
} from "@cloudflare/workers-utils";
import { createCommand, createNamespace } from "../core/create-command";
import { logger } from "../logger";
import { login, logout } from "./user";

const RESERVED_PROFILE_NAMES = ["default", "staging"];

const DIRECTORY_BINDINGS_FILE = "profiles/directory-bindings.json";

const profileStore = new AsyncLocalStorage<string>();

// ─── Validation ──────────────────────────────────────────────────────────

export function validateProfileName(name: string): void {
	if (RESERVED_PROFILE_NAMES.includes(name.toLowerCase())) {
		if (name.toLowerCase() === "default") {
			throw new UserError(
				`"${name}" is a reserved profile name. Use \`wrangler login\` and \`wrangler logout\` to manage the default profile.`,
				{ telemetryMessage: "auth profile reserved name default" }
			);
		}
		throw new UserError(
			`"${name}" is a reserved profile name used for the staging environment configuration.`,
			{ telemetryMessage: "auth profile reserved name staging" }
		);
	}

	if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
		throw new UserError(
			`Invalid profile name "${name}". Profile names may only contain alphanumeric characters, hyphens, and underscores.`,
			{ telemetryMessage: "auth profile invalid name" }
		);
	}
}

// ─── AsyncLocalStorage ───────────────────────────────────────────────────

export function runWithProfile<T>(profile: string, cb: () => T): T {
	return profileStore.run(profile, cb);
}

export function getResolvedProfile(): string {
	return profileStore.getStore() ?? "default";
}

// ─── Profile auth config file paths ──────────────────────────────────────

export function getProfileAuthConfigFilePath(profile: string): string {
	const globalConfigPath = getGlobalWranglerConfigPath();
	return path.join(globalConfigPath, "config", `${profile}.toml`);
}

export function profileExists(profile: string): boolean {
	return existsSync(getProfileAuthConfigFilePath(profile));
}

export function listProfiles(): string[] {
	const configDir = path.join(getGlobalWranglerConfigPath(), "config");
	if (!existsSync(configDir)) {
		return [];
	}

	const files = readdirSync(configDir);
	return files
		.filter((f) => f.endsWith(".toml"))
		.map((f) => f.replace(/\.toml$/, ""));
}

export function deleteProfileFiles(profile: string): void {
	const filePath = getProfileAuthConfigFilePath(profile);
	if (existsSync(filePath)) {
		rmSync(filePath);
	}
}

// ─── Directory bindings ──────────────────────────────────────────────────

function getDirectoryBindingsPath(): string {
	return path.join(getGlobalWranglerConfigPath(), DIRECTORY_BINDINGS_FILE);
}

export function readDirectoryBindings(): Record<string, string> {
	try {
		const raw = readFileSync(getDirectoryBindingsPath(), "utf-8");
		return JSON.parse(raw) as Record<string, string>;
	} catch {
		return {};
	}
}

export function writeDirectoryBindings(bindings: Record<string, string>): void {
	const bindingsPath = getDirectoryBindingsPath();
	mkdirSync(path.dirname(bindingsPath), { recursive: true });
	writeFileSync(bindingsPath, JSON.stringify(bindings, null, "\t"), "utf-8");
}

export function activateProfileForDirectory(
	profile: string,
	dir: string
): void {
	const normalizedDir = path.resolve(dir);
	const bindings = readDirectoryBindings();
	bindings[normalizedDir] = profile;
	writeDirectoryBindings(bindings);
}

export function deactivateDirectory(dir: string): {
	removedProfile: string;
	newResolution: { profile: string; source: string };
} {
	const normalizedDir = path.resolve(dir);
	const bindings = readDirectoryBindings();

	const boundProfile = bindings[normalizedDir];
	if (boundProfile === undefined) {
		// Check if a parent directory has a binding that covers this path
		const parentBinding = getProfileForDirectoryFromBindings(
			normalizedDir,
			bindings
		);
		if (parentBinding) {
			const parentDir = Object.entries(bindings).find(
				([, p]) => p === parentBinding
			)?.[0];
			throw new UserError(
				`No profile is directly bound to "${normalizedDir}". The active profile "${parentBinding}" is bound at "${parentDir}". Run \`wrangler auth deactivate\` from that directory instead.`,
				{ telemetryMessage: "auth deactivate wrong directory" }
			);
		}
		throw new UserError(`No profile is bound to "${normalizedDir}".`, {
			telemetryMessage: "auth deactivate no binding",
		});
	}

	delete bindings[normalizedDir];
	writeDirectoryBindings(bindings);

	// Compute new resolution after removal
	const fallbackProfile = getProfileForDirectoryFromBindings(
		normalizedDir,
		bindings
	);
	if (fallbackProfile) {
		const fallbackDir = Object.entries(bindings).find(
			([, p]) => p === fallbackProfile
		)?.[0];
		return {
			removedProfile: boundProfile,
			newResolution: {
				profile: fallbackProfile,
				source: `inherited from ${fallbackDir}`,
			},
		};
	}
	return {
		removedProfile: boundProfile,
		newResolution: { profile: "default", source: "default profile" },
	};
}

/**
 * Finds the most-specific directory binding that covers `startDir` using
 * string prefix matching. Bindings are sorted by path length descending so
 * the longest (most-specific) match wins. The match must be at a path
 * boundary — the binding path must either equal `startDir` exactly or be
 * followed by a path separator.
 */
function getProfileForDirectoryFromBindings(
	startDir: string,
	bindings: Record<string, string>
): string | undefined {
	const normalizedDir = path.resolve(startDir);

	// Sort by path length descending so most-specific match wins
	const sortedEntries = Object.entries(bindings).sort(
		([a], [b]) => b.length - a.length
	);

	for (const [boundDir, profile] of sortedEntries) {
		if (normalizedDir === boundDir) {
			return profile;
		}
		// Check that the match is at a path boundary
		if (
			normalizedDir.startsWith(boundDir) &&
			normalizedDir[boundDir.length] === path.sep
		) {
			return profile;
		}
	}

	return undefined;
}

export function getProfileForDirectory(startDir: string): string | undefined {
	const bindings = readDirectoryBindings();
	return getProfileForDirectoryFromBindings(startDir, bindings);
}

export function getBindingsForProfile(profile: string): string[] {
	const bindings = readDirectoryBindings();
	return Object.entries(bindings)
		.filter(([, p]) => p === profile)
		.map(([dir]) => dir);
}

export function removeAllBindingsForProfile(profile: string): string[] {
	const bindings = readDirectoryBindings();
	const removed: string[] = [];
	for (const [dir, p] of Object.entries(bindings)) {
		if (p === profile) {
			removed.push(dir);
			delete bindings[dir];
		}
	}
	if (removed.length > 0) {
		writeDirectoryBindings(bindings);
	}
	return removed;
}

// ─── Profile resolution ──────────────────────────────────────────────────

/**
 * Resolves which profile to use. Called once during handler setup.
 *
 * Priority:
 * 1. Explicit `--profile` flag (passed as `profileFlag`)
 * 2. Directory binding prefix match from `configPath` directory or cwd
 * 3. `"default"`
 */
export function resolveProfile(args: {
	profile?: string;
	configPath?: string | string[];
}): string {
	if (args.profile) {
		return args.profile;
	}

	const firstConfigPath = Array.isArray(args.configPath)
		? args.configPath[0]
		: args.configPath;

	const startDir = firstConfigPath
		? path.dirname(path.resolve(firstConfigPath))
		: process.cwd();

	const dirProfile = getProfileForDirectory(startDir);
	if (dirProfile) {
		return dirProfile;
	}

	return "default";
}

// ─── Commands ────────────────────────────────────────────────────────────

export const authProfilesNamespace = createNamespace({
	metadata: {
		description: "Manage auth profiles",
		owner: "Workers: Authoring and Testing",
		status: "stable",
		category: "Account",
		hidden: true,
	},
});

export const authCreateCommand = createCommand({
	metadata: {
		description: "Create or re-authenticate a named auth profile",
		owner: "Workers: Authoring and Testing",
		status: "stable",
		category: "Account",
	},
	behaviour: {
		printConfigWarnings: false,
	},
	positionalArgs: ["name"],
	args: {
		name: {
			describe: "Name for the auth profile",
			type: "string",
			demandOption: true,
		},
		browser: {
			default: true,
			type: "boolean",
			describe: "Automatically open the OAuth link in a browser",
		},
		"callback-host": {
			type: "string",
			default: "localhost",
		},
		"callback-port": {
			type: "number",
			default: 8976,
		},
	},
	async handler(args, { config }) {
		validateProfileName(args.name);

		const isUpdate = profileExists(args.name);

		await login(config, {
			browser: args.browser,
			callbackHost: args.callbackHost,
			callbackPort: args.callbackPort,
			profile: args.name,
		});

		if (isUpdate) {
			logger.log(`Profile "${args.name}" re-authenticated.`);
		} else {
			logger.log(`Profile "${args.name}" created.`);
		}
	},
});

export const authDeleteCommand = createCommand({
	metadata: {
		description: "Delete a named auth profile",
		owner: "Workers: Authoring and Testing",
		status: "stable",
		category: "Account",
	},
	behaviour: {
		printConfigWarnings: false,
		provideConfig: false,
	},
	positionalArgs: ["name"],
	args: {
		name: {
			describe: "Name of the auth profile to delete",
			type: "string",
			demandOption: true,
		},
	},
	async handler(args) {
		validateProfileName(args.name);

		if (!profileExists(args.name)) {
			throw new UserError(`Profile "${args.name}" does not exist.`, {
				telemetryMessage: "auth profile delete not found",
			});
		}

		const removedBindings = removeAllBindingsForProfile(args.name);
		if (removedBindings.length > 0) {
			logger.log("Removed directory bindings:");
			for (const dir of removedBindings) {
				logger.log(`  ${dir}`);
			}
		}

		await logout(args.name);

		logger.log(`Profile "${args.name}" deleted.`);
	},
});

export const authActivateCommand = createCommand({
	metadata: {
		description: "Bind a named auth profile to a directory",
		owner: "Workers: Authoring and Testing",
		status: "stable",
		category: "Account",
	},
	behaviour: {
		printConfigWarnings: false,
	},
	positionalArgs: ["name", "dir"],
	args: {
		name: {
			describe: "Name of the auth profile to activate",
			type: "string",
			demandOption: true,
		},
		dir: {
			describe:
				"Directory to bind the profile to (defaults to current directory)",
			type: "string",
		},
	},
	async handler(args, { config }) {
		validateProfileName(args.name);

		const targetDir = args.dir ?? process.cwd();

		if (!profileExists(args.name)) {
			logger.log(
				`Profile "${args.name}" does not exist. Starting OAuth login...`
			);
			await login(config, {
				browser: true,
				callbackHost: "localhost",
				callbackPort: 8976,
				profile: args.name,
			});
		}

		activateProfileForDirectory(args.name, targetDir);
		logger.log(
			`Profile "${args.name}" activated for "${path.resolve(targetDir)}".`
		);
	},
});

export const authDeactivateCommand = createCommand({
	metadata: {
		description: "Remove the auth profile binding from a directory",
		owner: "Workers: Authoring and Testing",
		status: "stable",
		category: "Account",
	},
	behaviour: {
		printConfigWarnings: false,
		provideConfig: false,
	},
	positionalArgs: ["dir"],
	args: {
		dir: {
			describe:
				"Directory to unbind (defaults to current directory). Must be the exact directory the profile was bound to.",
			type: "string",
		},
	},
	async handler(args) {
		const targetDir = args.dir ?? process.cwd();
		const { removedProfile, newResolution } = deactivateDirectory(targetDir);

		logger.log(
			`Profile "${removedProfile}" deactivated from "${path.resolve(targetDir)}".`
		);
		logger.log(
			`Now using: ${newResolution.profile} (${newResolution.source}).`
		);
	},
});

export const authListCommand = createCommand({
	metadata: {
		description: "List all auth profiles",
		owner: "Workers: Authoring and Testing",
		status: "stable",
		category: "Account",
		hideGlobalFlags: ["profile"],
	},
	behaviour: {
		printConfigWarnings: false,
		provideConfig: false,
	},
	validateArgs(args) {
		if (args.profile) {
			throw new UserError(
				"The --profile flag cannot be used with `wrangler auth list`.",
				{ telemetryMessage: "auth list rejects --profile flag" }
			);
		}
	},
	async handler() {
		const profiles = listProfiles();

		if (profiles.length === 0) {
			logger.log("No profiles found. Run `wrangler login` to get started.");
			return;
		}

		const bindings = readDirectoryBindings();
		const bindingsByProfile: Record<string, string[]> = {};
		for (const [dir, profile] of Object.entries(bindings)) {
			if (!bindingsByProfile[profile]) {
				bindingsByProfile[profile] = [];
			}
			bindingsByProfile[profile].push(dir);
		}

		const data = profiles.map((name) => ({
			Profile: name,
			"Bound Directories": (bindingsByProfile[name] ?? []).join(", ") || "-",
		}));

		logger.table(data);
	},
});
