import {
	afterAll,
	beforeAll,
	describe,
	expect,
	setSystemTime,
	test,
} from "bun:test";
import * as Sentry from "@sentry/core";
import { APIError, Drive, Sandbox } from "@vercel/sandbox";
import { stub } from "../../../test/stub";
import {
	AGENT_TOOLS_RETRY,
	agentToolsMounts,
	findSandboxSession,
	listActiveWorkspaceSandboxes,
	provisionSandbox,
	type SandboxClaim,
	SESSION_TIMEOUT_MS,
	topUpSandboxSession,
	wakeSandbox,
} from "./vercel";

type ListOptions = NonNullable<Parameters<typeof Sandbox.list>[0]>;

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const sandboxes = [
	{
		name: "environment",
		status: "running",
		createdAt: NOW,
		updatedAt: NOW,
		statusUpdatedAt: NOW,
		tags: { kind: "environment" },
	},
	{
		name: "untagged",
		status: "running",
		createdAt: NOW - HOUR,
		updatedAt: NOW - HOUR,
		statusUpdatedAt: NOW - HOUR,
	},
	{
		name: "recently-stopped",
		status: "stopped",
		createdAt: NOW - DAY,
		updatedAt: NOW - DAY,
		statusUpdatedAt: NOW - 2 * HOUR,
		tags: { kind: "workspace" },
	},
	{
		name: "dormant",
		status: "stopped",
		createdAt: NOW - 3 * DAY,
		updatedAt: NOW - 3 * DAY,
		statusUpdatedAt: NOW - 2 * DAY,
		tags: { kind: "workspace" },
	},
	{
		name: "resumed-workspace",
		status: "running",
		createdAt: NOW - 7 * DAY,
		updatedAt: NOW - 7 * DAY,
		statusUpdatedAt: NOW - 3 * HOUR,
		expiresAt: NOW + HOUR,
		currentSessionId: "session_resumed",
		tags: { kind: "workspace" },
	},
];
let listOptions: ListOptions | undefined;

stub(Sandbox, {
	list: async (options: ListOptions) => {
		listOptions = options;
		const ordered = options.tags
			? sandboxes
					.filter((sandbox) => sandbox.tags?.kind === "workspace")
					.toSorted((a, b) => b.createdAt - a.createdAt)
			: sandboxes.toSorted((a, b) => b.statusUpdatedAt - a.statusUpdatedAt);
		return (async function* () {
			yield* ordered;
		})();
	},
});

describe("findSandboxSession", () => {
	stub(Sandbox, {
		get: async () => ({
			listSessions: async () =>
				(async function* () {
					for (let index = 0; index <= 20; index += 1) {
						yield {
							id: `session_${index}`,
							memory: 16_384,
							vcpus: 8,
							status: "stopped",
							startedAt: NOW - HOUR,
							stoppedAt: NOW,
							updatedAt: NOW,
						};
					}
				})(),
		}),
	});

	test("settlement finds a recorded session beyond the first page", async () => {
		expect(await findSandboxSession("workspace", "session_20")).toEqual({
			session: {
				id: "session_20",
				memoryMb: 16_384,
				vcpus: 8,
				startedAt: NOW - HOUR,
				endedAt: NOW,
				activeCpuMs: null,
			},
		});
	});
});

describe("listActiveWorkspaceSandboxes", () => {
	test("finds older resumed workspaces when tag-filtered lists use creation order", async () => {
		expect(await listActiveWorkspaceSandboxes(NOW - 4 * HOUR)).toEqual([
			{ name: "recently-stopped", expiresAt: null, sessionId: null },
			{
				name: "resumed-workspace",
				expiresAt: new Date(NOW + HOUR),
				sessionId: "session_resumed",
			},
		]);
		expect(listOptions).toMatchObject({
			sortBy: "statusUpdatedAt",
			sortOrder: "desc",
		});
		expect(listOptions).not.toHaveProperty("tags");
	});
});

describe("topUpSandboxSession", () => {
	let expiresAt: Date;
	const extended: number[] = [];
	stub(Sandbox, {
		get: async () => ({
			status: "running",
			get expiresAt() {
				return expiresAt;
			},
			currentSession: () => ({
				extendTimeout: async (ms: number) => {
					extended.push(ms);
				},
			}),
		}),
	});
	beforeAll(() => setSystemTime(new Date(NOW)));
	afterAll(() => setSystemTime());

	test("extends a session to end a full timeout from now, unless it nearly does", async () => {
		expiresAt = new Date(NOW + SESSION_TIMEOUT_MS / 2);
		await topUpSandboxSession("sbx");
		expect(extended).toEqual([SESSION_TIMEOUT_MS / 2]);

		expiresAt = new Date(NOW + SESSION_TIMEOUT_MS - 30_000);
		await topUpSandboxSession("sbx");
		expect(extended).toEqual([SESSION_TIMEOUT_MS / 2]);
	});
});

const failure = (status: number) =>
	Object.assign(Object.create(APIError.prototype), {
		response: { status },
	}) as Error;
const reports: { message: string; tags: Record<string, unknown> }[] = [];
stub(Sentry, {
	captureMessage: (
		message: string,
		context: { tags: Record<string, unknown> },
	) => {
		reports.push({ message, tags: context.tags });
		return "";
	},
});
stub(AGENT_TOOLS_RETRY, { delayMs: 0 });

const BUNDLE = (prefix: string) =>
	prefix.padEnd(12, "0").repeat(6).slice(0, 64);

describe("agentToolsMounts", () => {
	const detached = () => Promise.resolve({ currentSandboxName: undefined });

	test("mounts a detached drive read-only, and asks only once", async () => {
		let asked = 0;
		const getDrive = () => {
			asked++;
			return detached();
		};
		const want = {
			"/opt/agents": {
				drive: "agent-tools-iad1-0123456789ab",
				mode: "snapshot",
			},
		};
		expect(
			await agentToolsMounts("agent-tools-iad1-0123456789ab", getDrive),
		).toEqual(want);
		expect(
			await agentToolsMounts("agent-tools-iad1-0123456789ab", getDrive),
		).toEqual(want);
		expect(asked).toBe(1);
	});

	test("retries a drive lookup that failed with 429 or 5xx", async () => {
		const answers = [failure(503), failure(429)];
		let asked = 0;
		const mounts = await agentToolsMounts(
			"agent-tools-iad1-a1a1a1a1a1a1",
			() => {
				asked++;
				const next = answers.shift();
				return next ? Promise.reject(next) : detached();
			},
		);
		expect(asked).toBe(3);
		expect(mounts).toBeDefined();
	});

	test("opens without the drive when it is missing or a writer holds it, and reports region and bundle", async () => {
		reports.length = 0;
		let asked = 0;
		expect(
			await agentToolsMounts("agent-tools-sfo1-aaaaaaaaaaaa", () => {
				asked++;
				return Promise.reject(failure(404));
			}),
		).toBeUndefined();
		expect(asked).toBe(1);
		expect(
			await agentToolsMounts("agent-tools-sfo1-bbbbbbbbbbbb", () =>
				Promise.resolve({ currentSandboxName: "builder" }),
			),
		).toBeUndefined();
		expect(reports.map((report) => report.tags)).toEqual([
			{
				"sandbox.agent_tools_drive": "agent-tools-sfo1-aaaaaaaaaaaa",
				"sandbox.region": "sfo1",
				"sandbox.bundle": "aaaaaaaaaaaa",
			},
			{
				"sandbox.agent_tools_drive": "agent-tools-sfo1-bbbbbbbbbbbb",
				"sandbox.region": "sfo1",
				"sandbox.bundle": "bbbbbbbbbbbb",
			},
		]);
	});
});

describe("wakeSandbox", () => {
	const drives = new Map<string, () => Promise<unknown>>();
	const asked: string[] = [];
	let updateAnswers: Error[] = [];
	const updates: unknown[] = [];
	stub(Sandbox, {
		get: async () => ({
			status: "stopped",
			region: "iad1",
			vcpus: 2,
			mounts: {},
			domain: () => "https://host.example",
			update: async (patch: unknown) => {
				updates.push(patch);
				const next = updateAnswers.shift();
				if (next) throw next;
			},
		}),
	});
	stub(Drive, {
		get: ({ name }: { name: string }) => {
			asked.push(name);
			return (
				drives.get(name)?.() ??
				Promise.resolve({ currentSandboxName: undefined })
			);
		},
	});
	const resumed = new Error("resumed");
	const wake = (bundleSha: string) =>
		wakeSandbox({
			providerSandboxId: "sbx",
			claim: {
				vcpus: 2,
				identity: { SUPERSET_BUNDLE_SHA: bundleSha },
			} as unknown as SandboxClaim,
			beforeResume: () => Promise.reject(resumed),
		});
	const mountOf = (drive: string) => ({
		mounts: { "/opt/agents": { drive, mode: "snapshot" } },
	});

	test("mounts the drive of the box's own region, not its environment's", async () => {
		asked.length = 0;
		updates.length = 0;
		await expect(wake(BUNDLE("c1"))).rejects.toBe(resumed);
		expect(asked).toEqual(["agent-tools-iad1-c10000000000"]);
		expect(updates).toEqual([mountOf("agent-tools-iad1-c10000000000")]);
	});

	test("a missing drive does not fail the wake: the box resumes without it", async () => {
		updates.length = 0;
		drives.set("agent-tools-iad1-c20000000000", () =>
			Promise.reject(failure(404)),
		);
		await expect(wake(BUNDLE("c2"))).rejects.toBe(resumed);
		expect(updates).toEqual([]);
	});

	test("a mounts update is retried on 5xx, and its last failure is tolerated", async () => {
		updates.length = 0;
		updateAnswers = [failure(502)];
		await expect(wake(BUNDLE("c3"))).rejects.toBe(resumed);
		expect(updates).toHaveLength(2);
		updates.length = 0;
		updateAnswers = [failure(409)];
		await expect(wake(BUNDLE("c4"))).rejects.toBe(resumed);
		expect(updates).toHaveLength(1);
	});
});

describe("provisionSandbox", () => {
	const creates: { mounts?: unknown }[] = [];
	stub(Sandbox, {
		get: () => Promise.reject(failure(404)),
		create: async (config: { mounts?: unknown }) => {
			creates.push(config);
			if (config.mounts) throw failure(400);
			return {
				domain: () => "https://host.example",
				writeFiles: async () => {},
				runCommand: async () => {},
			};
		},
	});
	stub(Drive, { get: async () => ({ currentSandboxName: undefined }) });

	test("a create the mount makes fail is made again without it", async () => {
		const made = await provisionSandbox({
			name: "ws",
			environment: { sourceKind: "image", sourceRef: "img", region: "sfo1" },
			claim: {
				vcpus: 2,
				hostSecret: "s",
				managedEnv: {},
				networkPolicy: "allow-all",
				identity: {
					SUPERSET_SANDBOX_CONTRACT: "1",
					SUPERSET_BUNDLE_SHA: BUNDLE("d1"),
					SUPERSET_API_URL: "https://api.example",
					SUPERSET_SANDBOX_WORKSPACE_ID: "6f1c2b8e-1d2a-4c55-9a3e-0b7f5d2c9e11",
					SUPERSET_SANDBOX_ORGANIZATION_ID:
						"6f1c2b8e-1d2a-4c55-9a3e-0b7f5d2c9e12",
					SUPERSET_SANDBOX_REPOSITORIES: "[]",
					SUPERSET_SANDBOX_IMAGE_TAG: "img",
					SUPERSET_SANDBOX_PROVIDER: "vercel",
				},
			} as unknown as SandboxClaim,
		});
		expect(made.providerSandboxId).toBe("ws");
		expect(creates.map((config) => Boolean(config.mounts))).toEqual([
			true,
			false,
		]);
	});
});
