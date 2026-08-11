import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Deterministic behavior tests for public `ompPluginsDir()` and
 * `getOmpPluginSettings()` resolution. Each case runs in an isolated child
 * Bun process with a private HOME / XDG_DATA_HOME / cwd so workstation OMP
 * state can never influence outcomes.
 */

const MODULE = path.resolve(import.meta.dir, "../src/settings.ts");
const PLUGIN = "relace-compact-pi";
const XDG_PLATFORM =
	process.platform === "linux" || process.platform === "darwin";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

interface ChildEnv {
	HOME: string;
	XDG_DATA_HOME?: string;
	PI_CONFIG_DIR?: string;
	OMP_PROFILE?: string;
	PI_PROFILE?: string;
	PI_CODING_AGENT_DIR?: string;
}

function runChild(script: string, env: ChildEnv, cwd?: string): string {
	const result = spawnSync(process.execPath, ["-e", script], {
		env: {
			OMP_PROFILE: env.OMP_PROFILE,
			PI_PROFILE: env.PI_PROFILE,
			PI_CODING_AGENT_DIR: env.PI_CODING_AGENT_DIR,
			PI_CONFIG_DIR: env.PI_CONFIG_DIR,
			XDG_DATA_HOME: env.XDG_DATA_HOME,
			HOME: env.HOME,
			PATH: process.env.PATH ?? "",
		},
		encoding: "utf8",
		cwd,
	});
	if (result.status !== 0) {
		throw new Error(
			`child process exited ${result.status}: ${result.stderr ?? ""}`,
		);
	}
	return result.stdout;
}

function resolvePluginsDir(env: ChildEnv): string {
	return runChild(
		`import { ompPluginsDir } from ${JSON.stringify(MODULE)};\nprocess.stdout.write(ompPluginsDir());`,
		env,
	);
}

function readPluginSettings(
	env: ChildEnv,
	cwd: string,
	pluginName: string,
): string {
	const script = `
import { getOmpPluginSettings } from ${JSON.stringify(MODULE)};
process.stdout.write(JSON.stringify(getOmpPluginSettings(${JSON.stringify(pluginName)}, ${JSON.stringify(cwd)})));
`;
	return runChild(script, env, cwd);
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
}

describe("ompPluginsDir — XDG and legacy resolution", () => {
	test("without XDG_DATA_HOME, plugin root is <home>/.omp/plugins", () => {
		const home = makeTempDir("omp-settings-home-");
		// Even if a ~/.local/share/omp/plugins path happens to exist, it must
		// not be invented; the legacy root is used.
		fs.mkdirSync(path.join(home, ".local", "share", "omp", "plugins"), {
			recursive: true,
		});
		expect(resolvePluginsDir({ HOME: home })).toBe(
			path.join(home, ".omp", "plugins"),
		);
	});

	test("existing $XDG_DATA_HOME/omp wins over a simultaneously existing legacy ~/.omp/plugins", () => {
		const home = makeTempDir("omp-settings-home-");
		const xdg = makeTempDir("omp-settings-xdg-");
		fs.mkdirSync(path.join(xdg, "omp"), { recursive: true });
		fs.mkdirSync(path.join(home, ".omp", "plugins"), { recursive: true });
		const expected = XDG_PLATFORM
			? path.join(xdg, "omp", "plugins")
			: path.join(home, ".omp", "plugins");
		expect(resolvePluginsDir({ HOME: home, XDG_DATA_HOME: xdg })).toBe(
			expected,
		);
	});

	test("for a named active profile, only an existing $XDG_DATA_HOME/omp/profiles/<profile> wins", () => {
		const home = makeTempDir("omp-settings-home-");
		const xdg = makeTempDir("omp-settings-xdg-");
		// Legacy profile dir exists, but XDG default omp root (not the
		// profile-specific one) also exists — the profile-specific XDG path is
		// absent, so legacy must win.
		fs.mkdirSync(path.join(xdg, "omp"), { recursive: true });
		fs.mkdirSync(path.join(home, ".omp", "profiles", "work", "plugins"), {
			recursive: true,
		});
		expect(
			resolvePluginsDir({
				HOME: home,
				XDG_DATA_HOME: xdg,
				OMP_PROFILE: "work",
			}),
		).toBe(path.join(home, ".omp", "profiles", "work", "plugins"));

		// Now create the profile-specific XDG root; on linux/darwin it wins,
		// elsewhere the legacy profile root remains selected.
		fs.mkdirSync(path.join(xdg, "omp", "profiles", "work"), {
			recursive: true,
		});
		const expectedProfile = XDG_PLATFORM
			? path.join(xdg, "omp", "profiles", "work", "plugins")
			: path.join(home, ".omp", "profiles", "work", "plugins");
		expect(
			resolvePluginsDir({
				HOME: home,
				XDG_DATA_HOME: xdg,
				OMP_PROFILE: "work",
			}),
		).toBe(expectedProfile);
	});

	test("PI_CONFIG_DIR changes the legacy profile base", () => {
		const home = makeTempDir("omp-settings-home-");
		expect(
			resolvePluginsDir({ HOME: home, PI_CONFIG_DIR: ".config/omp" }),
		).toBe(path.join(home, ".config", "omp", "plugins"));
	});
});

describe("getOmpPluginSettings — global + project override merge", () => {
	test("merges global lock settings with the single highest-priority project override (.omp)", () => {
		const home = makeTempDir("omp-settings-home-");
		const cwd = makeTempDir("omp-settings-cwd-");
		writeJson(path.join(home, ".omp", "plugins", "omp-plugins.lock.json"), {
			settings: {
				[PLUGIN]: { "relace.enabled": false, "relace.targetPercent": 10 },
			},
		});
		writeJson(path.join(cwd, ".omp", "plugin-overrides.json"), {
			settings: { [PLUGIN]: { "relace.targetPercent": 50 } },
		});
		writeJson(path.join(cwd, ".claude", "plugin-overrides.json"), {
			settings: { [PLUGIN]: { "relace.targetPercent": 99 } },
		});

		const parsed = JSON.parse(
			readPluginSettings({ HOME: home }, cwd, PLUGIN),
		) as Record<string, unknown>;
		// Global enabled=false preserved (not overridden), .omp targetPercent=50
		// shadows both global and the lower-priority .claude candidate.
		expect(parsed["relace.enabled"]).toBe(false);
		expect(parsed["relace.targetPercent"]).toBe(50);
	});

	test("an empty valid higher-priority object shadows lower-priority candidates", () => {
		const home = makeTempDir("omp-settings-home-");
		const cwd = makeTempDir("omp-settings-cwd-");
		writeJson(path.join(home, ".omp", "plugins", "omp-plugins.lock.json"), {
			settings: { [PLUGIN]: { "relace.enabled": false } },
		});
		// .omp override is a valid empty object → it is the selected source,
		// blocking the lower-priority .claude file while global lock settings remain.
		writeJson(path.join(cwd, ".omp", "plugin-overrides.json"), {});
		writeJson(path.join(cwd, ".claude", "plugin-overrides.json"), {
			settings: { [PLUGIN]: { "relace.enabled": true } },
		});

		const parsed = JSON.parse(
			readPluginSettings({ HOME: home }, cwd, PLUGIN),
		) as Record<string, unknown>;
		expect(parsed["relace.enabled"]).toBe(false);
	});

	test("a malformed higher-priority candidate falls through to the next valid one", () => {
		const home = makeTempDir("omp-settings-home-");
		const cwd = makeTempDir("omp-settings-cwd-");
		writeJson(path.join(home, ".omp", "plugins", "omp-plugins.lock.json"), {
			settings: { [PLUGIN]: { "relace.enabled": false } },
		});
		// Malformed JSON in .omp → fall through to .claude.
		fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
		fs.writeFileSync(
			path.join(cwd, ".omp", "plugin-overrides.json"),
			"{not json",
			"utf8",
		);
		writeJson(path.join(cwd, ".claude", "plugin-overrides.json"), {
			settings: { [PLUGIN]: { "relace.enabled": true } },
		});

		const parsed = JSON.parse(
			readPluginSettings({ HOME: home }, cwd, PLUGIN),
		) as Record<string, unknown>;
		expect(parsed["relace.enabled"]).toBe(true);
	});

	test("a missing higher-priority candidate falls through to the next present one", () => {
		const home = makeTempDir("omp-settings-home-");
		const cwd = makeTempDir("omp-settings-cwd-");
		writeJson(path.join(home, ".omp", "plugins", "omp-plugins.lock.json"), {
			settings: { [PLUGIN]: { "relace.enabled": false } },
		});
		// No .omp or .claude override; .codex is the winner.
		writeJson(path.join(cwd, ".codex", "plugin-overrides.json"), {
			settings: { [PLUGIN]: { "relace.enabled": true } },
		});

		const parsed = JSON.parse(
			readPluginSettings({ HOME: home }, cwd, PLUGIN),
		) as Record<string, unknown>;
		expect(parsed["relace.enabled"]).toBe(true);
	});

	test("a missing higher-priority candidate falls through to .gemini", () => {
		const home = makeTempDir("omp-settings-home-");
		const cwd = makeTempDir("omp-settings-cwd-");
		writeJson(path.join(home, ".omp", "plugins", "omp-plugins.lock.json"), {
			settings: { [PLUGIN]: { "relace.enabled": false } },
		});
		// No .omp, .claude, or .codex override; .gemini is the winner.
		writeJson(path.join(cwd, ".gemini", "plugin-overrides.json"), {
			settings: { [PLUGIN]: { "relace.enabled": true } },
		});

		const parsed = JSON.parse(
			readPluginSettings({ HOME: home }, cwd, PLUGIN),
		) as Record<string, unknown>;
		expect(parsed["relace.enabled"]).toBe(true);
	});

	test("an existing .codex override beats a conflicting .gemini override", () => {
		const home = makeTempDir("omp-settings-home-");
		const cwd = makeTempDir("omp-settings-cwd-");
		writeJson(path.join(home, ".omp", "plugins", "omp-plugins.lock.json"), {
			settings: { [PLUGIN]: { "relace.enabled": false } },
		});
		// .codex has higher priority than .gemini; its value wins.
		writeJson(path.join(cwd, ".codex", "plugin-overrides.json"), {
			settings: { [PLUGIN]: { "relace.enabled": true } },
		});
		writeJson(path.join(cwd, ".gemini", "plugin-overrides.json"), {
			settings: { [PLUGIN]: { "relace.enabled": false } },
		});

		const parsed = JSON.parse(
			readPluginSettings({ HOME: home }, cwd, PLUGIN),
		) as Record<string, unknown>;
		expect(parsed["relace.enabled"]).toBe(true);
	});

	test(".pi/plugin-overrides.json is ignored", () => {
		const home = makeTempDir("omp-settings-home-");
		const cwd = makeTempDir("omp-settings-cwd-");
		writeJson(path.join(home, ".omp", "plugins", "omp-plugins.lock.json"), {
			settings: { [PLUGIN]: { "relace.enabled": false } },
		});
		// .pi is not a recognized override dir; its values must not appear.
		writeJson(path.join(cwd, ".pi", "plugin-overrides.json"), {
			settings: { [PLUGIN]: { "relace.enabled": true } },
		});

		const parsed = JSON.parse(
			readPluginSettings({ HOME: home }, cwd, PLUGIN),
		) as Record<string, unknown>;
		expect(parsed["relace.enabled"]).toBe(false);
	});
});
