import type { ByteTransport, ByteTransportHandlers } from "@earendil-works/pi-client";
import { PiClientV2 } from "@earendil-works/pi-client";
import {
	type CommandV2,
	decodeCbor,
	encodeServerMessageV2,
	type JsonValue,
	PROTOCOL_V2_VERSION,
	parseClientMessageV2,
	type ServerMessageV2,
	type SessionSnapshotV2,
} from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import { RemoteV2Session } from "../../src/client/remote-v2-session.ts";

function snapshot(overrides: Partial<SessionSnapshotV2> = {}): SessionSnapshotV2 {
	return {
		id: "session-1",
		nameRevision: 0,
		revision: 1,
		eventSeq: 1,
		phase: "idle",
		model: { provider: "faux", id: "model" },
		thinkingLevel: "off",
		transcript: [],
		queues: { steer: [], followUp: [] },
		agents: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, pricingState: "known" },
		context: { inputTokens: 0, contextWindow: 16_000, usedPercentage: 0 },
		compactionPolicy: {
			enabled: true,
			contextWindow: 16_000,
			reserveTokens: 1_000,
			keepRecentTokens: 2_000,
			triggerTokens: 15_000,
			source: "global",
		},
		pluginSetHash: "plugins-empty",
		diagnostics: { capture: "metadata", degraded: false, lastCriticalEventSeq: 1 },
		persistence: { schemaVersion: 1, recoveryState: "clean" },
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function memoryTransport() {
	let handlers: ByteTransportHandlers | undefined;
	const sent: ServerMessageV2[] = [];
	const requests: CommandV2[] = [];
	const transport: ByteTransport = {
		send: async (chunk) => {
			const message = parseClientMessageV2(decodeCbor(chunk.subarray(4)));
			if (message.type === "hello") {
				handlers?.onData(
					encodeServerMessageV2({
						type: "hello",
						version: PROTOCOL_V2_VERSION,
						connectionId: "connection-1",
						snapshot: {
							serverId: "server-1",
							protocolVersion: 2,
							revision: 1,
							eventSeq: 1,
							sessions: [],
							models: [],
						},
					}),
				);
				return;
			}
			requests.push(message.request);
			const result: JsonValue =
				message.request.command === "session/read"
					? ({ session: snapshot() } as JsonValue)
					: message.request.command === "agent/list"
						? ({ agents: [] } as JsonValue)
						: message.request.command === "agent/spawn"
							? ({
									agent: {
										id: "agent-1",
										path: "/root/research",
										taskName: "research",
										state: "idle",
										model: { provider: "faux", id: "model" },
									},
								} as JsonValue)
							: message.request.command === "process/start" ||
									message.request.command === "process/wait" ||
									message.request.command === "process/terminate"
								? ({
										process: {
											processId: "process-1",
											sessionId: "session-1",
											command: "echo hi",
											pty: false,
											state: "running",
											output: "",
											cursor: 0,
											truncated: false,
										},
									} as JsonValue)
								: message.request.command === "process/read" || message.request.command === "process/write"
									? ({ output: { output: "hi", cursor: 2, truncated: false } } as JsonValue)
									: message.request.command === "filesystem/complete"
										? ({
												items: [{ reference: "project:src", path: "/workspace/src", kind: "directory" }],
											} as JsonValue)
										: message.request.command === "filesystem/reference/resolve"
											? ({
													file: {
														reference: "project:README.md",
														path: "/workspace/README.md",
														kind: "file",
														size: 2,
														mimeType: "text/markdown",
													},
												} as JsonValue)
											: message.request.command === "filesystem/reference/read"
												? ({
														file: {
															reference: "project:README.md",
															path: "/workspace/README.md",
															kind: "file",
															size: 2,
															mimeType: "text/markdown",
														},
														encoding: "base64",
														data: "aGk=",
													} as JsonValue)
												: message.request.command === "blob/put"
													? ({
															blob: { digest: "sha256:blob", mimeType: "text/plain", size: 2 },
														} as JsonValue)
													: message.request.command === "blob/read"
														? ({ digest: "sha256:blob", encoding: "base64", data: "aGk=" } as JsonValue)
														: message.request.command === "blob/stat"
															? ({
																	blob: { digest: "sha256:blob", mimeType: "text/plain", size: 2 },
																} as JsonValue)
															: message.request.command === "web"
																? ({
																		results: [
																			{ id: "web-1", title: "Pi", source: "faux", retrievedAt: 1 },
																		],
																	} as JsonValue)
																: message.request.command === "image/view"
																	? ({
																			image: {
																				digest: "sha256:image",
																				mimeType: "image/png",
																				size: 4,
																				reference: "project:image.png",
																			},
																		} as JsonValue)
																	: message.request.command === "image/generate"
																		? ({
																				image: {
																					digest: "sha256:generated",
																					mimeType: "image/png",
																					size: 4,
																					reference: "blob:sha256:generated",
																					provider: "faux",
																					model: "image-model",
																					promptHash: "hash",
																				},
																			} as JsonValue)
																		: message.request.command === "marketplace/list"
																			? ({
																					marketplaces: [
																						{ name: "local", source: "file:///tmp/local" },
																					],
																				} as JsonValue)
																			: message.request.command === "marketplace/add" ||
																					message.request.command === "marketplace/upgrade"
																				? ({
																						marketplace: {
																							name: "local",
																							source: "file:///tmp/local",
																						},
																					} as JsonValue)
																				: message.request.command === "marketplace/remove"
																					? ({ name: "local" } as JsonValue)
																					: message.request.command === "plugin/list"
																						? ({
																								plugins: [
																									{
																										id: "plugin-1",
																										name: "demo",
																										enabled: true,
																									},
																								],
																							} as JsonValue)
																						: message.request.command === "plugin/read" ||
																								message.request.command === "plugin/install" ||
																								message.request.command === "plugin/enable" ||
																								message.request.command === "plugin/disable"
																							? ({
																									plugin: {
																										id: "plugin-1",
																										name: "demo",
																										enabled: true,
																									},
																								} as JsonValue)
																							: message.request.command === "plugin/uninstall"
																								? ({ id: "plugin-1" } as JsonValue)
																								: message.request.command === "app/list"
																									? ({
																											apps: [{ id: "app-1", name: "Demo" }],
																										} as JsonValue)
																									: message.request.command === "app/read"
																										? ({
																												app: { id: "app-1", name: "Demo" },
																											} as JsonValue)
																										: message.request.command ===
																													"app/auth/start" ||
																												message.request.command ===
																													"app/auth/complete"
																											? ({
																													auth: {
																														appId: "app-1",
																														state: "authenticated",
																													},
																												} as JsonValue)
																											: message.request.command ===
																													"usage/read"
																												? ({
																														aggregate: {
																															input: 3,
																															output: 2,
																														},
																														entries: [
																															{
																																turnId: "turn-1",
																																input: 3,
																															},
																														],
																													} as JsonValue)
																												: message.request.command ===
																														"goal/read"
																													? ({
																															goal: {
																																status: "active",
																																objective: "Inspect",
																															},
																														} as JsonValue)
																													: message.request.command ===
																															"plan/read"
																														? ({
																																plan: {
																																	version: 1,
																																	items: [
																																		{
																																			step: "Inspect",
																																			status:
																																				"in_progress",
																																		},
																																	],
																																},
																															} as JsonValue)
																														: message.request.command ===
																																"input/request/read"
																															? ({
																																	request: {
																																		requestId:
																																			"request-1",
																																		sessionId:
																																			"session-1",
																																		questions: [],
																																	},
																																} as JsonValue)
																															: message.request
																																		.command ===
																																	"diagnostics/status"
																																? ({
																																		capture:
																																			"metadata",
																																		degraded: false,
																																		lastCriticalEventSeq: 3,
																																		eventCount: 3,
																																	} as JsonValue)
																																: message.request
																																			.command ===
																																		"diagnostics/timeline"
																																	? ({
																																			events: [
																																				{
																																					seq: 3,
																																					kind: "operation",
																																					outcome:
																																						"ok",
																																				},
																																			],
																																		} as JsonValue)
																																	: message.request
																																				.command ===
																																			"diagnostics/export"
																																		? ({
																																				bundle: {
																																					manifest:
																																						{
																																							schemaVersion: 1,
																																							eventCount: 3,
																																							firstSeq: 1,
																																							lastSeq: 3,
																																							eventsSha256:
																																								"hash",
																																						},
																																					events:
																																						[],
																																				},
																																			} as JsonValue)
																																		: message.request
																																					.command ===
																																				"diagnostics/verify"
																																			? ({
																																					valid: true,
																																				} as JsonValue)
																																			: message
																																						.request
																																						.command ===
																																					"diagnostics/doctor"
																																				? ({
																																						ok: true,
																																						checks:
																																							[
																																								{
																																									name: "recorder",
																																									ok: true,
																																								},
																																							],
																																					} as JsonValue)
																																				: message
																																							.request
																																							.command ===
																																						"plan/update"
																																					? ({
																																							plan: {
																																								version: 1,
																																								items: [
																																									{
																																										step: "Inspect",
																																										status:
																																											"in_progress",
																																									},
																																								],
																																							},
																																						} as JsonValue)
																																					: {
																																							command:
																																								message
																																									.request
																																									.command,
																																						};
			const response: ServerMessageV2 =
				message.request.command.startsWith("turn/") ||
				message.request.command.startsWith("session/model") ||
				message.request.command.startsWith("session/thinking")
					? {
							type: "response",
							id: message.id,
							ok: true,
							accepted: { operationId: "operation-1", sessionRevision: 2, eventSeq: 2 },
						}
					: { type: "response", id: message.id, ok: true, result };
			sent.push(response);
			handlers?.onData(encodeServerMessageV2(response));
		},
		close: () => {},
	};
	return {
		factory: async (next: ByteTransportHandlers) => {
			handlers = next;
			return transport;
		},
		sent,
		requests,
		deliver(message: ServerMessageV2) {
			handlers?.onData(encodeServerMessageV2(message));
		},
	};
}

describe("RemoteV2Session", () => {
	test("opens, reads authoritative state, and publishes terminal snapshots", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		expect(session.state).toMatchObject({
			lifecycle: { status: "ready" },
			snapshot: { id: "session-1", phase: "idle" },
		});

		await session.setThinking("high");
		const operation = session.submit("hello");
		expect(await operation).toBe("operation-1");
		expect(session.state.lifecycle).toMatchObject({ status: "busy", operationId: "operation-1" });
		expect(pair.requests.find((request) => request.command === "session/thinking/set")?.payload).toEqual({
			level: "high",
		});
		pair.deliver({
			type: "event",
			sessionId: "session-1",
			seq: 3,
			revision: 3,
			operationId: "operation-1",
			event: "operation_terminal",
			payload: { state: "complete", snapshot: snapshot({ revision: 3, eventSeq: 3, phase: "idle" }) },
		});
		expect(session.state).toMatchObject({ lifecycle: { status: "ready" }, snapshot: { revision: 3 } });
		await session.dispose();
	});

	test("applies server plan updates without requiring a refresh", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		pair.deliver({
			type: "event",
			sessionId: "session-1",
			seq: 2,
			revision: 2,
			event: "plan_updated",
			payload: { plan: { version: 1, items: [{ step: "Inspect", status: "in_progress" }] } },
		});
		expect(session.snapshot?.plan).toEqual({
			version: 1,
			items: [{ step: "Inspect", status: "in_progress" }],
		});
		pair.deliver({
			type: "event",
			sessionId: "session-1",
			seq: 3,
			revision: 3,
			event: "plan_updated",
			payload: { plan: null },
		});
		expect(session.snapshot?.plan).toBeUndefined();
		await session.dispose();
	});

	test("applies server agent updates without requiring a refresh", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		pair.deliver({
			type: "event",
			sessionId: "session-1",
			seq: 2,
			revision: 2,
			event: "agent_updated",
			payload: {
				agent: {
					id: "agent-1",
					path: "/root/research",
					taskName: "research",
					state: "running",
					model: { provider: "faux", id: "model" },
				},
			},
		});
		expect(session.snapshot?.agents).toEqual([
			{
				id: "agent-1",
				path: "/root/research",
				taskName: "research",
				state: "running",
				model: { provider: "faux", id: "model" },
			},
		]);
		await session.dispose();
	});

	test("answers and cancels structured input through the control lease", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		await session.respondInput("request-1", { answer: "yes" });
		await session.cancelInput("request-2");
		expect(pair.requests.slice(-2).map((request) => request.command)).toEqual([
			"input/request/respond",
			"input/request/cancel",
		]);
		expect(pair.requests.at(-2)?.payload).toEqual({ requestId: "request-1", answers: { answer: "yes" } });
		expect(pair.requests.at(-1)?.payload).toEqual({ requestId: "request-2" });
		await session.dispose();
	});

	test("updates and clears plans through the control lease", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		const plan = await session.updatePlan([{ step: "Inspect", status: "in_progress" }]);
		expect(plan).toEqual({ version: 1, items: [{ step: "Inspect", status: "in_progress" }] });
		await session.clearPlan();
		expect(pair.requests.slice(-2).map((request) => request.command)).toEqual(["plan/update", "plan/clear"]);
		await session.dispose();
	});

	test("lists and spawns agents through the control lease", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		expect(await session.listAgents()).toEqual([]);
		const agent = await session.spawnAgent("research", "Inspect the repository", {
			parentPath: "/root",
			model: { provider: "faux", id: "model" },
		});
		expect(agent.id).toBe("agent-1");
		expect(pair.requests.at(-1)?.payload).toEqual({
			taskName: "research",
			taskMessage: "Inspect the repository",
			parentPath: "/root",
			model: { provider: "faux", id: "model" },
		});
		await session.dispose();
	});

	test("controls server-owned process output with cursors", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		const process = await session.startProcess("echo hi");
		expect(process.processId).toBe("process-1");
		expect(await session.writeProcess(process.processId, "input")).toMatchObject({ output: "hi", cursor: 2 });
		expect(await session.readProcess(process.processId, 2)).toMatchObject({ output: "hi", cursor: 2 });
		expect(await session.waitProcess(process.processId)).toMatchObject({ state: "running" });
		expect(await session.terminateProcess(process.processId)).toMatchObject({ state: "running" });
		await session.dispose();
	});

	test("uses execution-host filesystem completion and references", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		expect(await session.completeFiles("project:s")).toEqual([
			{ reference: "project:src", path: "/workspace/src", kind: "directory" },
		]);
		expect((await session.resolveFile("project:README.md")).mimeType).toBe("text/markdown");
		expect((await session.readFile("project:README.md")).data).toBe("aGk=");
		await session.dispose();
	});

	test("uses server web and image services", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		expect(await session.webRequest("search_query", { query: "pi" })).toEqual([
			{ id: "web-1", title: "Pi", source: "faux", retrievedAt: 1 },
		]);
		expect((await session.viewImage("project:image.png")).mimeType).toBe("image/png");
		expect((await session.generateImage("draw a terminal")).provider).toBe("faux");
		expect(pair.requests.slice(-3).map((request) => request.command)).toEqual([
			"web",
			"image/view",
			"image/generate",
		]);
		await session.dispose();
	});

	test("transfers server-owned blobs", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		expect(await session.putBlob("aGk=", "text/plain")).toEqual({
			digest: "sha256:blob",
			mimeType: "text/plain",
			size: 2,
		});
		expect(await session.readBlob("sha256:blob")).toMatchObject({ encoding: "base64", data: "aGk=" });
		expect(await session.statBlob("sha256:blob")).toMatchObject({ mimeType: "text/plain", size: 2 });
		await session.dispose();
	});

	test("inspects server diagnostics", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		expect(await session.diagnosticsStatus()).toMatchObject({ capture: "metadata", degraded: false });
		expect(await session.diagnosticsTimeline({ afterSeq: 2 })).toEqual([
			{ seq: 3, kind: "operation", outcome: "ok" },
		]);
		expect((await session.diagnosticsExport()).manifest).toMatchObject({ eventCount: 3 });
		expect((await session.diagnosticsVerify()).valid).toBe(true);
		expect((await session.diagnosticsDoctor()).ok).toBe(true);
		await session.dispose();
	});

	test("controls remote plugins, apps, and usage", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		expect((await session.listMarketplaces())[0]).toMatchObject({ name: "local" });
		expect(await session.addMarketplace("local", "file:///tmp/local")).toMatchObject({ name: "local" });
		expect((await session.listPlugins(true))[0]).toMatchObject({ id: "plugin-1" });
		expect(await session.readPlugin("plugin-1")).toMatchObject({ name: "demo" });
		expect(await session.setPluginEnabled("plugin-1", true)).toMatchObject({ enabled: true });
		expect((await session.listApps())[0]).toMatchObject({ id: "app-1" });
		expect(await session.readApp("app-1")).toMatchObject({ name: "Demo" });
		expect(await session.startAppAuth({ id: "app-1" })).toMatchObject({ state: "authenticated" });
		expect((await session.readUsage({ sessionId: "session-1" })).entries).toHaveLength(1);
		await session.dispose();
	});

	test("reads remote goal, plan, and input state", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		expect(await session.readGoal()).toMatchObject({ status: "active", objective: "Inspect" });
		expect(await session.readPlan()).toMatchObject({ version: 1 });
		expect(await session.readInputRequest("request-1")).toMatchObject({ sessionId: "session-1" });
		await session.dispose();
	});

	test("rejects mutating commands after detach and reports listener failures", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1", {
			onListenerError: (error) => expect(error.message).toBe("listener"),
		});
		session.subscribe(() => {
			throw new Error("listener");
		});
		await session.detach();
		expect(session.state.lifecycle).toEqual({ status: "detached" });
		await expect(session.submit("blocked")).rejects.toThrow("Session is not open");
		await session.dispose();
	});

	test("exposes lease transfer and remote control actions", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		expect(session.mode).toBe("control");
		await session.relinquishControl();
		expect(session.mode).toBe("observer");
		await expect(session.followUp("later")).rejects.toThrow("control lease");
		await session.acquireControl();
		expect(session.mode).toBe("control");
		expect(await session.followUp("later")).toBe("operation-1");
		expect(await session.rollback()).toBe("operation-1");
		await expect(session.rollback(0)).rejects.toThrow("positive integer");
		await session.dispose();
	});
});
