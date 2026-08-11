import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	DynamicSettings,
	HostKind,
	RelaceConfig,
	SettingsRecord,
} from "./types.js";
import {
	getPathValue,
	isRecord,
	mergeSettings,
	nonNegativeNumber,
	positiveNumber,
	readJsonObject,
	setPathValue,
	writeJsonObject,
} from "./utils.js";

export const PACKAGE_NAME = "relace-compact-pi";
export const RELACE_ENDPOINT =
	"https://compact.endpoint.relace.run/v1/code/compact";
export const DEFAULT_IDLE_SECONDS = 300;
export const DEFAULT_TARGET_PERCENT = 33;
export const DEFAULT_PI_THRESHOLD = 66;

export function endpointSetting(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) return RELACE_ENDPOINT;
	try {
		const parsed = new URL(value);
		return parsed.protocol === "https:" || parsed.protocol === "http:"
			? parsed.toString()
			: RELACE_ENDPOINT;
	} catch {
		return RELACE_ENDPOINT;
	}
}

export function parseIdleOverrides(
	value: unknown,
): ReadonlyArray<readonly [string, number]> {
	let parsed = value;
	if (typeof value === "string") {
		try {
			parsed = JSON.parse(value) as unknown;
		} catch {
			return [];
		}
	}
	if (!isRecord(parsed)) return [];
	const overrides: Array<readonly [string, number]> = [];
	for (const [pattern, seconds] of Object.entries(parsed)) {
		if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0)
			overrides.push([pattern, seconds]);
	}
	return overrides;
}

export function buildConfig(
	values: SettingsRecord,
	enabledOverride: boolean | undefined,
): RelaceConfig {
	const configuredKey = getPathValue(values, "relace.apiKey");
	const apiKey =
		process.env.RELACE_API_KEY ??
		process.env.RELACE_API_TOKEN ??
		(typeof configuredKey === "string" ? configuredKey : "");
	const thresholdType = getPathValue(values, "relace.pi.thresholdType");
	return {
		enabled:
			enabledOverride ?? getPathValue(values, "relace.enabled") !== false,
		apiKey,
		endpoint: endpointSetting(getPathValue(values, "relace.endpoint")),
		targetPercent: Math.min(
			100,
			Math.max(
				1,
				positiveNumber(
					getPathValue(values, "relace.targetPercent"),
					DEFAULT_TARGET_PERCENT,
				),
			),
		),
		idleTimeoutSeconds: nonNegativeNumber(
			getPathValue(values, "relace.idleTimeoutSeconds"),
			DEFAULT_IDLE_SECONDS,
		),
		idleModelOverrides: parseIdleOverrides(
			getPathValue(values, "relace.idleModelOverrides"),
		),
		piThresholdType: thresholdType === "tokens" ? "tokens" : "percentage",
		piThreshold: positiveNumber(
			getPathValue(values, "relace.pi.threshold"),
			DEFAULT_PI_THRESHOLD,
		),
	};
}

export function findOmpSettings(pi: unknown): DynamicSettings | undefined {
	if (!isRecord(pi) || !isRecord(pi.pi)) return undefined;
	const candidate = pi.pi.settings;
	if (!isRecord(candidate) || typeof candidate.get !== "function")
		return undefined;
	return candidate as unknown as DynamicSettings;
}

/**
 * Resolve ~/.omp/plugins (or the XDG data equivalent) without importing
 * `@oh-my-pi/*`. Dynamic imports of those packages from a linked extension
 * resolve through bun's install cache and fail to load `pi_natives`.
 */
export function ompPluginsDir(): string {
	const home = process.env.HOME || os.homedir();
	const legacy = path.join(home, ".omp", "plugins");
	if (fs.existsSync(legacy)) return legacy;
	const xdgData =
		process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
	return path.join(xdgData, "omp", "plugins");
}

function ompPluginsLockfile(): string {
	return path.join(ompPluginsDir(), "omp-plugins.lock.json");
}

function projectPluginOverrides(cwd: string): SettingsRecord {
	for (const relative of [".omp/plugin-overrides.json", ".pi/plugin-overrides.json"]) {
		const values = readJsonObject(path.join(cwd, relative));
		if (Object.keys(values).length > 0) return values;
	}
	return {};
}

function pluginSettingsFromRecord(
	settings: unknown,
	pluginName: string,
): SettingsRecord {
	if (!isRecord(settings)) return {};
	const plugin = settings[pluginName];
	return isRecord(plugin) ? { ...plugin } : {};
}

export function getOmpPluginSettings(
	pluginName: string,
	cwd: string,
): SettingsRecord {
	const lock = readJsonObject(ompPluginsLockfile());
	const global = pluginSettingsFromRecord(lock.settings, pluginName);
	const overrides = projectPluginOverrides(cwd);
	const project = pluginSettingsFromRecord(overrides.settings, pluginName);
	return { ...global, ...project };
}

export function setOmpPluginSetting(
	pluginName: string,
	key: string,
	value: unknown,
): void {
	const lockPath = ompPluginsLockfile();
	const lock = readJsonObject(lockPath);
	if (!isRecord(lock.plugins)) lock.plugins = {};
	if (!isRecord(lock.settings)) lock.settings = {};
	const settings = lock.settings as SettingsRecord;
	const current = settings[pluginName];
	const pluginSettings = isRecord(current) ? { ...current } : {};
	pluginSettings[key] = value;
	settings[pluginName] = pluginSettings;
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	const temporaryPath = `${lockPath}.${process.pid}.tmp`;
	// Match OMP's lockfile formatting (2-space indent).
	fs.writeFileSync(temporaryPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
	fs.renameSync(temporaryPath, lockPath);
}

export class SettingsStore {
	readonly host: HostKind;
	readonly #ompSettings: DynamicSettings | undefined;
	#cacheKey = "";
	#cachedConfig: RelaceConfig | undefined;
	#enabledOverride: boolean | undefined;

	constructor(host: HostKind, ompSettings: DynamicSettings | undefined) {
		this.host = host;
		this.#ompSettings = ompSettings;
	}

	async getConfig(ctx: ExtensionContext): Promise<RelaceConfig> {
		const trusted = this.host === "omp" || ctx.isProjectTrusted();
		const cacheKey = `${ctx.cwd}\u0000${trusted}`;
		if (this.#cachedConfig && this.#cacheKey === cacheKey)
			return this.#cachedConfig;
		let values: SettingsRecord;
		if (this.host === "omp") {
			values = getOmpPluginSettings(PACKAGE_NAME, ctx.cwd);
			if (this.#ompSettings) {
				const ompIdleEnabled = this.#ompSettings.get("compaction.idleEnabled");
				const ompIdleTimeout = this.#ompSettings.get(
					"compaction.idleTimeoutSeconds",
				);
				if (ompIdleEnabled !== undefined) {
					const idleSeconds =
						ompIdleEnabled === true
							? typeof ompIdleTimeout === "number"
								? ompIdleTimeout
								: DEFAULT_IDLE_SECONDS
							: 0;
					setPathValue(values, "relace.idleTimeoutSeconds", idleSeconds);
				} else if (typeof ompIdleTimeout === "number") {
					setPathValue(values, "relace.idleTimeoutSeconds", ompIdleTimeout);
				}
			}
		} else {
			const agentDir =
				process.env.PI_CODING_AGENT_DIR ??
				path.join(process.env.HOME ?? "", ".pi", "agent");
			const globalValues = readJsonObject(path.join(agentDir, "settings.json"));
			const projectValues = trusted
				? readJsonObject(path.join(ctx.cwd, ".pi", "settings.json"))
				: {};
			values = mergeSettings(globalValues, projectValues);
		}
		this.#cacheKey = cacheKey;
		this.#cachedConfig = buildConfig(values, this.#enabledOverride);
		return this.#cachedConfig;
	}

	getOmpStrategy(): "context-full" | "handoff" | undefined {
		const value = this.#ompSettings?.get("compaction.strategy");
		return value === "context-full" || value === "handoff" ? value : undefined;
	}

	async setEnabled(cwd: string, enabled: boolean): Promise<void> {
		this.#enabledOverride = enabled;
		await this.setSetting(cwd, "relace.enabled", enabled);
	}

	async setSetting(_cwd: string, key: string, value: unknown): Promise<void> {
		if (this.host === "omp") {
			setOmpPluginSetting(PACKAGE_NAME, key, value);
		} else {
			const agentDir =
				process.env.PI_CODING_AGENT_DIR ??
				path.join(process.env.HOME ?? "", ".pi", "agent");
			const settingsPath = path.join(agentDir, "settings.json");
			const values = readJsonObject(settingsPath);
			setPathValue(values, key, value);
			writeJsonObject(settingsPath, values);
		}
		this.#cachedConfig = undefined;
	}
}
