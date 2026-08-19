import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import relaceCompactExtension from "../src/extension.js";

/**
 * Lifecycle tests for idle compaction modes. Drives the registered
 * extension handlers with a mock pi API to verify that:
 * - beforeNextTurn (default): the idle timer only marks the session due
 *   and the Relace compaction runs when the next message is submitted
 *   (before_agent_start), awaited so the turn starts on the compacted
 *   context.
 * - backgroundAuto: the idle timer compacts in the background, as before.
 */

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
	delete process.env.RELACE_API_KEY;
	delete process.env.PI_CODING_AGENT_DIR;
});

interface CompactCall {
	onComplete: () => void;
	onError: (error: Error) => void;
}

interface Harness {
	handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
	compactCalls: CompactCall[];
	cwd: string;
	agentDir: string;
	notifyMessages: string[];
}

async function setupHarness(
	settings: Record<string, unknown>,
): Promise<Harness> {
	const cwd = makeTempDir("relace-idle-cwd-");
	const agentDir = makeTempDir("relace-idle-agent-");
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({ relace: { apiKey: "test-key", ...settings } }),
		"utf8",
	);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.RELACE_API_KEY;

	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const compactCalls: CompactCall[] = [];
	const notifyMessages: string[] = [];

	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, handler);
		},
		registerCommand: () => {},
	};
	relaceCompactExtension(pi as never);

	const makeCtx = (overrides: Record<string, unknown> = {}) => ({
		cwd,
		hasUI: true,
		sessionManager: {
			getSessionId: () => "session-1",
			getBranch: () => [],
		},
		isProjectTrusted: () => false,
		isIdle: () => true,
		hasPendingMessages: () => false,
		getContextUsage: () => ({ tokens: 10_000, contextWindow: 200_000 }),
		model: undefined,
		ui: { notify: (text: string) => notifyMessages.push(text) },
		compact: (callbacks: CompactCall) => {
			compactCalls.push(callbacks);
		},
		...overrides,
	});

	return { handlers, compactCalls, cwd, agentDir, notifyMessages, makeCtx };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function handler(h: Harness, name: string) {
	const fn = h.handlers.get(name);
	if (!fn) throw new Error(`handler ${name} not registered`);
	return fn;
}

describe("idle compaction modes", () => {
	test("beforeNextTurn (default): timer marks due, compaction waits for the next message", async () => {
		const h = await setupHarness({ idleTimeoutSeconds: 0.05 });
		const ctx = h.makeCtx();

		await handler(h, "agent_end")({}, ctx);
		await sleep(80);

		// Idle timer elapsed but no background compaction was started.
		expect(h.compactCalls.length).toBe(0);

		// User submits the next message: the handler must block until the
		// compaction settles, so the turn starts on the compacted context.
		let handlerDone = false;
		const handlerPromise = Promise.resolve(
			handler(h, "before_agent_start")({ prompt: "hi" }, ctx),
		).then(() => {
			handlerDone = true;
		});
		await sleep(30);
		expect(handlerDone).toBe(false);
		expect(h.compactCalls.length).toBe(1);
		expect(h.notifyMessages).toContain(
			"Compacting with Relace before next turn…",
		);

		h.compactCalls[0].onComplete();
		await handlerPromise;
		expect(handlerDone).toBe(true);
		expect(h.notifyMessages).toContain("Relace compaction complete.");
	}, 10_000);

	test("beforeNextTurn: a due compaction is dropped when another compaction already ran", async () => {
		const h = await setupHarness({ idleTimeoutSeconds: 0.05 });
		const ctx = h.makeCtx();

		await handler(h, "agent_end")({}, ctx);
		await sleep(80);
		expect(h.compactCalls.length).toBe(0);

		// Pi natively compacts (threshold/overflow/manual) before the next
		// turn; session_before_compact must clear the due flag.
		await handler(h, "session_before_compact")(
			{
				type: "session_before_compact",
				preparation: {
					messagesToSummarize: [],
					turnPrefixMessages: [],
					firstKeptEntryId: "e1",
					tokensBefore: 1000,
				},
				signal: undefined,
			},
			ctx,
		);
		await handler(h, "before_agent_start")({ prompt: "hi" }, ctx);
		expect(h.compactCalls.length).toBe(0);
	}, 10_000);

	test("backgroundAuto: the idle timer compacts in the background", async () => {
		const h = await setupHarness({
			idleTimeoutSeconds: 0.05,
			idleMode: "backgroundAuto",
		});
		const ctx = h.makeCtx();

		await handler(h, "agent_end")({}, ctx);
		await sleep(80);

		expect(h.compactCalls.length).toBe(1);
		// The next turn must not trigger a second compaction.
		await handler(h, "before_agent_start")({ prompt: "hi" }, ctx);
		expect(h.compactCalls.length).toBe(1);
	}, 10_000);

	test("idle timeout 0 never arms the timer in either mode", async () => {
		const h = await setupHarness({ idleTimeoutSeconds: 0 });
		const ctx = h.makeCtx();

		await handler(h, "agent_end")({}, ctx);
		await sleep(80);
		await handler(h, "before_agent_start")({ prompt: "hi" }, ctx);
		expect(h.compactCalls.length).toBe(0);
	}, 10_000);
});
