import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getGlobalWranglerConfigPath } from "@cloudflare/workers-utils";
import {
	normalizeString,
	runInTempDir,
} from "@cloudflare/workers-utils/test-helpers";
import { beforeEach, describe, it } from "vitest";
import {
	activateProfileForDirectory,
	deactivateDirectory,
	getProfileForDirectory,
	getResolvedProfile,
	listProfiles,
	readDirectoryBindings,
	removeAllBindingsForProfile,
	resolveProfile,
	runWithProfile,
	validateProfileName,
	writeDirectoryBindings,
} from "../user/profiles";
import { writeAuthConfigFile } from "../user/user";
import { mockConsoleMethods } from "./helpers/mock-console";
import { mockOAuthFlow } from "./helpers/mock-oauth-flow";
import { msw, mswSuccessOauthHandlers } from "./helpers/msw";
import { runWrangler } from "./helpers/run-wrangler";

describe("Profiles", () => {
	runInTempDir();
	const std = mockConsoleMethods();
	mockOAuthFlow();

	beforeEach(() => {
		msw.use(...mswSuccessOauthHandlers);
	});

	describe("validateProfileName", () => {
		it("rejects 'default' as reserved", ({ expect }) => {
			expect(() => validateProfileName("default")).toThrow(
				/reserved profile name/
			);
		});

		it("rejects 'staging' as reserved", ({ expect }) => {
			expect(() => validateProfileName("staging")).toThrow(
				/reserved profile name/
			);
		});

		it("rejects reserved names case-insensitively", ({ expect }) => {
			expect(() => validateProfileName("Default")).toThrow(
				/reserved profile name/
			);
			expect(() => validateProfileName("STAGING")).toThrow(
				/reserved profile name/
			);
		});

		it("rejects names with invalid characters", ({ expect }) => {
			expect(() => validateProfileName("my profile")).toThrow(
				/may only contain/
			);
			expect(() => validateProfileName("my.profile")).toThrow(
				/may only contain/
			);
			expect(() => validateProfileName("my/profile")).toThrow(
				/may only contain/
			);
		});

		it("accepts valid profile names", ({ expect }) => {
			expect(() => validateProfileName("my-profile")).not.toThrow();
			expect(() => validateProfileName("my_profile")).not.toThrow();
			expect(() => validateProfileName("client1")).not.toThrow();
			expect(() => validateProfileName("WORK")).not.toThrow();
		});
	});

	describe("AsyncLocalStorage profile resolution", () => {
		it("defaults to 'default' when no store is set", ({ expect }) => {
			expect(getResolvedProfile()).toBe("default");
		});

		it("returns the profile set by runWithProfile", ({ expect }) => {
			runWithProfile("client-a", () => {
				expect(getResolvedProfile()).toBe("client-a");
			});
		});

		it("restores previous profile after runWithProfile completes", ({
			expect,
		}) => {
			runWithProfile("client-a", () => {
				expect(getResolvedProfile()).toBe("client-a");
			});
			expect(getResolvedProfile()).toBe("default");
		});

		it("supports nested runWithProfile calls", ({ expect }) => {
			runWithProfile("outer", () => {
				expect(getResolvedProfile()).toBe("outer");
				runWithProfile("inner", () => {
					expect(getResolvedProfile()).toBe("inner");
				});
				expect(getResolvedProfile()).toBe("outer");
			});
		});
	});

	describe("directory bindings", () => {
		it("reads empty bindings when file does not exist", ({ expect }) => {
			const bindings = readDirectoryBindings();
			expect(bindings).toEqual({});
		});

		it("writes and reads directory bindings", ({ expect }) => {
			const bindings = { "/foo/bar": "client-a", "/baz": "personal" };
			writeDirectoryBindings(bindings);
			expect(readDirectoryBindings()).toEqual(bindings);
		});

		it("activates a profile for a directory", ({ expect }) => {
			activateProfileForDirectory("client-a", "/foo/bar");
			const bindings = readDirectoryBindings();
			const normalizedKey = path.resolve("/foo/bar");
			expect(bindings[normalizedKey]).toBe("client-a");
		});

		it("overwrites an existing binding for the same directory", ({
			expect,
		}) => {
			activateProfileForDirectory("client-a", "/foo/bar");
			activateProfileForDirectory("client-b", "/foo/bar");
			const bindings = readDirectoryBindings();
			const normalizedKey = path.resolve("/foo/bar");
			expect(bindings[normalizedKey]).toBe("client-b");
		});

		it("deactivates a directory binding", ({ expect }) => {
			const dir = path.resolve("/foo/bar");
			activateProfileForDirectory("client-a", dir);

			const result = deactivateDirectory(dir);
			expect(result.removedProfile).toBe("client-a");
			expect(result.newResolution.profile).toBe("default");

			const bindings = readDirectoryBindings();
			expect(bindings[dir]).toBeUndefined();
		});

		it("errors when deactivating an unbound directory", ({ expect }) => {
			expect(() => deactivateDirectory("/nonexistent")).toThrow(
				/No profile is bound/
			);
		});

		it("errors when deactivating from a subdirectory of a bound dir", ({
			expect,
		}) => {
			const parentDir = path.resolve("/foo/bar");
			activateProfileForDirectory("client-a", parentDir);

			expect(() => deactivateDirectory(path.join(parentDir, "sub"))).toThrow(
				/No profile is directly bound/
			);
		});

		it("falls back to parent binding after deactivation", ({ expect }) => {
			const parentDir = path.resolve("/foo");
			const childDir = path.resolve("/foo/bar");

			activateProfileForDirectory("parent-profile", parentDir);
			activateProfileForDirectory("child-profile", childDir);

			const result = deactivateDirectory(childDir);
			expect(result.removedProfile).toBe("child-profile");
			expect(result.newResolution.profile).toBe("parent-profile");
		});

		it("removes all bindings for a profile", ({ expect }) => {
			activateProfileForDirectory("client-a", "/foo");
			activateProfileForDirectory("client-a", "/bar");
			activateProfileForDirectory("other", "/baz");

			const removed = removeAllBindingsForProfile("client-a");
			expect(removed).toHaveLength(2);

			const bindings = readDirectoryBindings();
			expect(
				Object.values(bindings).filter((p) => p === "client-a")
			).toHaveLength(0);
			expect(Object.values(bindings).filter((p) => p === "other")).toHaveLength(
				1
			);
		});
	});

	describe("getProfileForDirectory (prefix matching)", () => {
		it("returns undefined when no bindings exist", ({ expect }) => {
			expect(getProfileForDirectory("/some/dir")).toBeUndefined();
		});

		it("matches exact directory", ({ expect }) => {
			const dir = path.resolve("/foo/bar");
			activateProfileForDirectory("client-a", dir);
			expect(getProfileForDirectory(dir)).toBe("client-a");
		});

		it("matches subdirectory via prefix", ({ expect }) => {
			const parentDir = path.resolve("/foo/bar");
			activateProfileForDirectory("client-a", parentDir);
			expect(getProfileForDirectory(path.join(parentDir, "sub", "deep"))).toBe(
				"client-a"
			);
		});

		it("most specific (longest) match wins", ({ expect }) => {
			const parentDir = path.resolve("/foo");
			const childDir = path.resolve("/foo/bar");
			activateProfileForDirectory("parent", parentDir);
			activateProfileForDirectory("child", childDir);

			expect(getProfileForDirectory(childDir)).toBe("child");
			expect(getProfileForDirectory(path.join(childDir, "sub"))).toBe("child");
			expect(getProfileForDirectory(path.join(parentDir, "other"))).toBe(
				"parent"
			);
		});

		it("does not match at non-path boundary", ({ expect }) => {
			const dir = path.resolve("/foo/bar");
			activateProfileForDirectory("client-a", dir);
			// /foo/barbaz should NOT match /foo/bar
			expect(getProfileForDirectory(dir + "baz")).toBeUndefined();
		});
	});

	describe("resolveProfile", () => {
		it("returns 'default' with no profile flag or bindings", ({ expect }) => {
			expect(resolveProfile({})).toBe("default");
		});

		it("--profile flag takes priority", ({ expect }) => {
			const dir = path.resolve("/foo");
			activateProfileForDirectory("dir-profile", dir);
			expect(resolveProfile({ profile: "flag-profile" })).toBe("flag-profile");
		});

		it("uses directory binding from config path", ({ expect }) => {
			const configDir = path.resolve("/projects/my-app");
			activateProfileForDirectory("app-profile", configDir);
			expect(
				resolveProfile({
					configPath: path.join(configDir, "wrangler.json"),
				})
			).toBe("app-profile");
		});

		it("uses directory binding from cwd when no config path", ({ expect }) => {
			const cwd = process.cwd();
			activateProfileForDirectory("cwd-profile", cwd);
			expect(resolveProfile({})).toBe("cwd-profile");
		});
	});

	describe("listProfiles", () => {
		it("lists profiles from config directory", ({ expect }) => {
			// Create some profile toml files
			const configDir = path.join(getGlobalWranglerConfigPath(), "config");
			mkdirSync(configDir, { recursive: true });
			writeFileSync(path.join(configDir, "default.toml"), "");
			writeFileSync(path.join(configDir, "client-a.toml"), "");
			writeFileSync(path.join(configDir, "personal.toml"), "");

			const profiles = listProfiles();
			expect(profiles).toContain("default");
			expect(profiles).toContain("client-a");
			expect(profiles).toContain("personal");
		});

		it("returns empty array when config directory does not exist", ({
			expect,
		}) => {
			expect(listProfiles()).toEqual([]);
		});
	});

	describe("wrangler auth create", () => {
		it("rejects reserved name 'default'", async ({ expect }) => {
			await expect(runWrangler("auth create default")).rejects.toThrow(
				/reserved profile name/
			);
		});

		it("rejects reserved name 'staging'", async ({ expect }) => {
			await expect(runWrangler("auth create staging")).rejects.toThrow(
				/reserved profile name/
			);
		});

		it("rejects invalid characters", async ({ expect }) => {
			await expect(runWrangler("auth create 'my profile'")).rejects.toThrow(
				/may only contain/
			);
		});
	});

	describe("wrangler auth delete", () => {
		it("rejects reserved name 'default'", async ({ expect }) => {
			await expect(runWrangler("auth delete default")).rejects.toThrow(
				/reserved profile name/
			);
		});

		it("errors when profile does not exist", async ({ expect }) => {
			await expect(runWrangler("auth delete nonexistent")).rejects.toThrow(
				/does not exist/
			);
		});
	});

	describe("wrangler auth deactivate", () => {
		it("errors when no binding exists for current directory", async ({
			expect,
		}) => {
			await expect(runWrangler("auth deactivate")).rejects.toThrow(
				/No profile is bound/
			);
		});
	});

	describe("wrangler auth list", () => {
		it("shows message when no profiles exist", async ({ expect }) => {
			await runWrangler("auth list");
			expect(normalizeString(std.out)).toContain("No profiles found");
		});

		it("lists profiles with bound directories", async ({ expect }) => {
			// Create profile files
			const configDir = path.join(getGlobalWranglerConfigPath(), "config");
			mkdirSync(configDir, { recursive: true });
			writeFileSync(path.join(configDir, "default.toml"), "");
			writeFileSync(path.join(configDir, "client-a.toml"), "");

			// Bind a directory
			activateProfileForDirectory("client-a", "/projects/client-a");

			await runWrangler("auth list");
			expect(normalizeString(std.out)).toContain("default");
			expect(normalizeString(std.out)).toContain("client-a");
		});
	});

	describe("profile-scoped auth config", () => {
		it("writes and reads auth config for a named profile", ({ expect }) => {
			runWithProfile("client-a", () => {
				writeAuthConfigFile({
					oauth_token: "test-token",
					refresh_token: "test-refresh",
					expiration_time: "2099-01-01T00:00:00.000Z",
					scopes: ["account:read"],
				});

				const configPath = path.join(
					getGlobalWranglerConfigPath(),
					"config",
					"client-a.toml"
				);
				expect(existsSync(configPath)).toBe(true);

				const content = readFileSync(configPath, "utf-8");
				expect(content).toContain("test-token");
			});
		});

		it("writes to default.toml for the default profile", ({ expect }) => {
			runWithProfile("default", () => {
				writeAuthConfigFile({
					oauth_token: "default-token",
				});

				const configPath = path.join(
					getGlobalWranglerConfigPath(),
					"config",
					"default.toml"
				);
				expect(existsSync(configPath)).toBe(true);

				const content = readFileSync(configPath, "utf-8");
				expect(content).toContain("default-token");
			});
		});
	});

	describe("banner", () => {
		it("prints active profile in the banner when non-default", async ({
			expect,
		}) => {
			// Create the profile's auth config so it shows up in list
			const configDir = path.join(
				getGlobalWranglerConfigPath(),
				"config"
			);
			mkdirSync(configDir, { recursive: true });
			writeFileSync(path.join(configDir, "my-profile.toml"), "");

			// Bind the profile to the current working directory
			activateProfileForDirectory("my-profile", process.cwd());

			await runWrangler("auth list");

			expect(normalizeString(std.out)).toContain(
				"Active profile: my-profile"
			);
		});

		it("does not print active profile line when using default", async ({
			expect,
		}) => {
			// Create the default profile
			const configDir = path.join(
				getGlobalWranglerConfigPath(),
				"config"
			);
			mkdirSync(configDir, { recursive: true });
			writeFileSync(path.join(configDir, "default.toml"), "");

			await runWrangler("auth list");

			expect(normalizeString(std.out)).not.toContain("Active profile:");
		});
	});
});
