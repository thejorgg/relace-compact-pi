import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Deterministic behavior tests for the public `ompPluginsDir()` resolver.
 *
 * OMP 17.2.12 compatibility edges:
 *  1. Invalid OMP_PROFILE / invalid PI_PROFILE fall back to the default
 *     profile instead of throwing (OMP_PROFILE takes precedence over
 *     PI_PROFILE). A valid PI_PROFILE with OMP_PROFILE absent selects the
 *     named profile's legacy root.
 *  2. With OMP_PROFILE explicitly empty (default profile), a valid PI_PROFILE,
 *     PI_CODING_AGENT_DIR exactly equal to that PI profile's derived legacy
 *     agent dir, XDG_DATA_HOME set, and the default XDG omp root present,
 *     `ompPluginsDir()` resolves to the XDG root — not the legacy root.
 *     A paired genuine-custom PI_CODING_AGENT_DIR remains legacy-root.
 *  3. For the default profile, PI_CODING_AGENT_DIR exactly equal to
 *     `<configRoot>/agent` is not a genuine override and keeps XDG eligible.
 *  4. A named OMP profile ignores a genuinely custom PI_CODING_AGENT_DIR when
 *     its exact profile-specific XDG root exists.
 *
 * XDG selection only occurs on linux/darwin; on other platforms the resolver
 * returns the legacy config root even for XDG-eligible inputs, so XDG-asserting
 * tests branch on platform.
 *
 * Each case runs in an isolated child process with a private HOME and
 * XDG_DATA_HOME so `process.env` / `os.homedir()` never leak between tests
 * and never touch the workstation's real OMP state.
 */

const MODULE = path.resolve(import.meta.dir, "../src/settings.ts");

const tempDirs: string[] = [];

function makeTempHome(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-resolver-home-"));
	tempDirs.push(dir);
	return dir;
}

function makeTempXdg(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-resolver-xdg-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

interface ResolverEnv {
	HOME: string;
	XDG_DATA_HOME?: string;
	OMP_PROFILE?: string;
	PI_PROFILE?: string;
	PI_CODING_AGENT_DIR?: string;
	PI_CONFIG_DIR?: string;
}

/**
 * Run `ompPluginsDir()` in a child process with an isolated environment and
 * return the resolved plugins directory string. Throws if the child errors.
 */
function resolveInChild(env: ResolverEnv): string {
	const script = `
import { ompPluginsDir } from ${JSON.stringify(MODULE)};
process.stdout.write(ompPluginsDir());
`;

	const result = spawnSync(process.execPath, ["-e", script], {
		env: {
			...env,
			// Strip the parent's OMP/PI/XDG vars so only the explicit env
			// passed above influences the resolver.
			OMP_PROFILE: env.OMP_PROFILE,
			PI_PROFILE: env.PI_PROFILE,
			PI_CODING_AGENT_DIR: env.PI_CODING_AGENT_DIR,
			PI_CONFIG_DIR: env.PI_CONFIG_DIR,
			XDG_DATA_HOME: env.XDG_DATA_HOME,
			HOME: env.HOME,
			PATH: process.env.PATH ?? "",
		},
		encoding: "utf8",
	});

	if (result.status !== 0) {
		const stderr = result.stderr ?? "";
		throw new Error(
			`ompPluginsDir() child process exited ${result.status}: ${stderr}`,
		);
	}

	return result.stdout;
}

/**
 * OMP only selects the XDG data root on linux/darwin. On other platforms the
 * resolver returns the legacy config root even for XDG-eligible inputs, so
 * XDG-asserting tests must branch on platform.
 */
const IS_XDG_PLATFORM =
	process.platform === "linux" || process.platform === "darwin";

function xdgOrLegacy(xdgPath: string, legacyPath: string): string {
	return IS_XDG_PLATFORM ? xdgPath : legacyPath;
}

describe("ompPluginsDir — invalid profile fallback", () => {
	test("invalid OMP_PROFILE does not throw and uses the default legacy root", () => {
		const home = makeTempHome();
		const resolved = resolveInChild({
			HOME: home,
			OMP_PROFILE: "BAD PROFILE!",
		});
		// Invalid profile falls back to default: configRoot = ~/.omp, no
		// profiles/ segment, no XDG (XDG_DATA_HOME unset).
		expect(resolved).toBe(path.join(home, ".omp", "plugins"));
	});

	test("invalid PI_PROFILE (OMP_PROFILE unset) does not throw and uses the default legacy root", () => {
		const home = makeTempHome();
		const resolved = resolveInChild({
			HOME: home,
			PI_PROFILE: "BAD PROFILE!",
		});
		expect(resolved).toBe(path.join(home, ".omp", "plugins"));
	});

	test("OMP_PROFILE precedence: a valid OMP_PROFILE wins over an invalid PI_PROFILE", () => {
		const home = makeTempHome();
		const resolved = resolveInChild({
			HOME: home,
			OMP_PROFILE: "work",
			PI_PROFILE: "BAD!",
		});
		// OMP_PROFILE is consulted first; PI_PROFILE is ignored entirely.
		expect(resolved).toBe(
			path.join(home, ".omp", "profiles", "work", "plugins"),
		);
	});

	test("OMP_PROFILE explicitly empty selects the default profile (ignoring PI_PROFILE)", () => {
		const home = makeTempHome();
		const resolved = resolveInChild({
			HOME: home,
			OMP_PROFILE: "",
			PI_PROFILE: "work",
		});
		// Empty OMP_PROFILE normalizes to default; PI_PROFILE is not consulted
		// because OMP_PROFILE is defined.
		expect(resolved).toBe(path.join(home, ".omp", "plugins"));
	});

	test("valid PI_PROFILE with OMP_PROFILE absent selects the named profile's legacy root", () => {
		const home = makeTempHome();
		const resolved = resolveInChild({
			HOME: home,
			// OMP_PROFILE deliberately absent so PI_PROFILE is consulted.
			PI_PROFILE: "work",
		});
		// No XDG_DATA_HOME set → legacy configRoot regardless of platform.
		expect(resolved).toBe(
			path.join(home, ".omp", "profiles", "work", "plugins"),
		);
	});
});

describe("ompPluginsDir — PI_CODING_AGENT_DIR profile-derived vs custom override", () => {
	test("PI_CODING_AGENT_DIR equal to a valid PI_PROFILE's derived legacy agent dir keeps XDG eligible", () => {
		const home = makeTempHome();
		const xdg = makeTempXdg();
		// The exact default XDG omp root must exist for XDG selection.
		fs.mkdirSync(path.join(xdg, "omp"), { recursive: true });

		const piProfile = "work";
		// configRoot for the default profile is ~/.omp (no profiles/ segment).
		// The PI profile's derived legacy agent dir is
		// <configRoot>/profiles/<piProfile>/agent.
		const derivedAgentDir = path.join(
			home,
			".omp",
			"profiles",
			piProfile,
			"agent",
		);

		const resolved = resolveInChild({
			HOME: home,
			XDG_DATA_HOME: xdg,
			OMP_PROFILE: "",
			PI_PROFILE: piProfile,
			PI_CODING_AGENT_DIR: derivedAgentDir,
		});

		// Profile-derived agent dir is not a genuine override → XDG root on
		// linux/darwin; legacy root elsewhere.
		expect(resolved).toBe(
			xdgOrLegacy(
				path.join(xdg, "omp", "plugins"),
				path.join(home, ".omp", "plugins"),
			),
		);
	});

	test("genuine custom PI_CODING_AGENT_DIR suppresses XDG and falls back to the legacy root", () => {
		const home = makeTempHome();
		const xdg = makeTempXdg();
		fs.mkdirSync(path.join(xdg, "omp"), { recursive: true });

		const piProfile = "work";
		// A path that is neither the default agent dir nor the PI profile's
		// derived agent dir.
		const customAgentDir = path.join(home, ".omp", "custom-agent");

		const resolved = resolveInChild({
			HOME: home,
			XDG_DATA_HOME: xdg,
			OMP_PROFILE: "",
			PI_PROFILE: piProfile,
			PI_CODING_AGENT_DIR: customAgentDir,
		});

		// Genuine override → legacy configRoot (~/.omp), no XDG.
		expect(resolved).toBe(path.join(home, ".omp", "plugins"));
	});

	test("default profile with PI_CODING_AGENT_DIR exactly equal to <configRoot>/agent keeps XDG eligible", () => {
		const home = makeTempHome();
		const xdg = makeTempXdg();
		fs.mkdirSync(path.join(xdg, "omp"), { recursive: true });

		// configRoot for the default profile is ~/.omp. The default legacy
		// agent dir is <configRoot>/agent — not a genuine override.
		const defaultAgentDir = path.join(home, ".omp", "agent");

		const resolved = resolveInChild({
			HOME: home,
			XDG_DATA_HOME: xdg,
			// No profile selected; PI_CODING_AGENT_DIR equals the default
			// agent dir, so XDG remains eligible.
			PI_CODING_AGENT_DIR: defaultAgentDir,
		});

		expect(resolved).toBe(
			xdgOrLegacy(
				path.join(xdg, "omp", "plugins"),
				path.join(home, ".omp", "plugins"),
			),
		);
	});

	test("named OMP profile ignores a genuinely custom PI_CODING_AGENT_DIR when its profile-specific XDG root exists", () => {
		const home = makeTempHome();
		const xdg = makeTempXdg();
		const profile = "work";
		// The exact profile-specific XDG root must exist for XDG selection.
		fs.mkdirSync(path.join(xdg, "omp", "profiles", profile), {
			recursive: true,
		});

		// A genuinely custom agent dir that a default-profile resolver would
		// treat as an override. A named profile ignores PI_CODING_AGENT_DIR
		// entirely, so XDG selection depends only on the profile root.
		const customAgentDir = path.join(home, ".omp", "custom-agent");

		const resolved = resolveInChild({
			HOME: home,
			XDG_DATA_HOME: xdg,
			OMP_PROFILE: profile,
			PI_CODING_AGENT_DIR: customAgentDir,
		});

		expect(resolved).toBe(
			xdgOrLegacy(
				path.join(xdg, "omp", "profiles", profile, "plugins"),
				path.join(home, ".omp", "profiles", profile, "plugins"),
			),
		);
	});
});
