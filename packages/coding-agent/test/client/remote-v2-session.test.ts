import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { afterEach, describe, expect, test } from "vitest";
import { RemoteV2Session } from "../../src/client/remote-v2-session.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

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
	let failNextCommand: CommandV2["command"] | undefined;
	let overrideResult: { command: CommandV2["command"]; result: JsonValue } | undefined;
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
			if (message.request.command === failNextCommand) {
				failNextCommand = undefined;
				const response: ServerMessageV2 = {
					type: "response",
					id: message.id,
					ok: false,
					error: { code: "invalid_request", message: "forced attach failure" },
				};
				sent.push(response);
				handlers?.onData(encodeServerMessageV2(response));
				return;
			}
			if (overrideResult?.command === message.request.command) {
				const response: ServerMessageV2 = {
					type: "response",
					id: message.id,
					ok: true,
					result: overrideResult.result,
				};
				overrideResult = undefined;
				sent.push(response);
				handlers?.onData(encodeServerMessageV2(response));
				return;
			}
			if (message.request.command === "operation/read") {
				const response: ServerMessageV2 = {
					type: "response",
					id: message.id,
					ok: true,
					result: {
						operation: {
							operationId: "operation-1",
							sessionId: "session-1",
							state: "complete",
							accepted: { operationId: "operation-1", sessionRevision: 2, eventSeq: 2 },
							terminalSeq: 3,
						},
					},
				};
				sent.push(response);
				handlers?.onData(encodeServerMessageV2(response));
				return;
			}
			const result: JsonValue =
				message.request.command === "session/read" || message.request.command === "session/create"
					? ({ session: snapshot() } as JsonValue)
					: message.request.command === "agent/list"
						? ({ agents: [] } as JsonValue)
						: message.request.command === "agent/spawn" || message.request.command === "agent/wait"
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
																			{
																				id: "web-1",
																				title: "Pi",
																				source: "faux",
																				retrievedAt: 1,
																				url: "https://example.test",
																			},
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
																								message.request.command === "plugin/upgrade" ||
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
																																			operations: [
																																				{
																																					operationId:
																																						"operation-1",
																																					state: "complete",
																																				},
																																			],
																																			operationEvents:
																																				[
																																					{
																																						event: "operation_terminal",
																																						operationId:
																																							"operation-1",
																																					},
																																				],
																																			usage: {
																																				aggregate: {
																																					responses: 1,
																																				},
																																				entries: [],
																																			},
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
				message.request.command === "goal/update" ||
				message.request.command.startsWith("session/name/") ||
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
		failNext(command: CommandV2["command"]) {
			failNextCommand = command;
		},
		overrideNextResult(command: CommandV2["command"], result: JsonValue) {
			overrideResult = { command, result };
		},
		sent,
		requests,
		deliver(message: ServerMessageV2) {
			handlers?.onData(encodeServerMessageV2(message));
		},
	};
}

describe("RemoteV2Session", () => {
	test("creates and opens a server-owned session", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.create(client, { name: "new session", cwd: "/workspace" });
		expect(session.id).toBe("session-1");
		expect(session.state.snapshot).toMatchObject({ id: "session-1", phase: "idle" });
		expect(pair.requests.map((request) => request.command)).toEqual([
			"session/create",
			"session/attach",
			"session/read",
		]);
		await session.dispose();
	});

	test("forks through the server-owned session boundary and opens the child", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		pair.overrideNextResult("session/fork", { session: { ...snapshot(), id: "session-2" } });
		const forked = await session.fork({ name: "branch", scope: "branch", position: "at" });
		expect(forked.id).toBe("session-2");
		expect(pair.requests.find((request) => request.command === "session/fork")).toMatchObject({
			sessionId: "session-1",
			payload: { name: "branch", scope: "branch", position: "at" },
		});
		await forked.dispose();
		await session.dispose();
	});

	test("deletes through the server-owned session boundary", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		await session.delete();
		expect(pair.requests.find((request) => request.command === "session/delete")).toMatchObject({
			sessionId: "session-1",
		});
		expect(session.state.lifecycle).toEqual({ status: "disposed" });
	});

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
		const completed = session.waitForOperation("operation-1");
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
		expect(await completed).toMatchObject({ revision: 3, phase: "idle" });
		await session.dispose();
	});

	test("preserves the current attachment when replacement refresh fails", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		pair.failNext("session/read");

		await expect(session.attach("session-2")).rejects.toThrow("invalid_request: forced attach failure");
		expect(session.id).toBe("session-1");
		expect(session.state.lifecycle).toEqual({ status: "ready" });
		pair.deliver({
			type: "event",
			sessionId: "session-1",
			seq: 4,
			revision: 4,
			event: "usage_updated",
			payload: {},
		});
		expect(session.state.lastEvent).toMatchObject({ sessionId: "session-1", event: "usage_updated" });
		await session.dispose();
	});

	test("reads a server-owned operation record after a missed terminal event", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		expect(await session.readOperation("operation-1")).toMatchObject({
			operationId: "operation-1",
			state: "complete",
			terminalSeq: 3,
		});
		await session.dispose();
	});

	test("recovers waitForOperation from a terminal operation record", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		expect(await session.waitForOperation("operation-1")).toMatchObject({ id: "session-1", phase: "idle" });
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

	test("applies server name and phase updates without requiring a refresh", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		pair.deliver({
			type: "event",
			sessionId: "session-1",
			seq: 2,
			revision: 2,
			event: "session_name_updated",
			payload: { name: "Renamed", nameSource: "explicit", nameRevision: 2 },
		});
		pair.deliver({
			type: "event",
			sessionId: "session-1",
			seq: 3,
			revision: 3,
			event: "session_phase_changed",
			payload: { phase: "turn" },
		});
		pair.deliver({
			type: "event",
			sessionId: "session-1",
			seq: 4,
			revision: 4,
			event: "usage_updated",
			payload: {
				usage: { input: 0, output: 2, cacheRead: 0, cacheWrite: 0, costUsd: 0, pricingState: "known" },
			},
		});
		pair.deliver({
			type: "event",
			sessionId: "session-1",
			seq: 5,
			revision: 5,
			event: "goal_updated",
			payload: {
				goal: {
					id: "goal-1",
					objective: "Ship feature",
					status: "active",
					tokensUsed: 1,
					activeTimeSeconds: 0,
					createdAt: 1,
					updatedAt: 1,
				},
			},
		});
		pair.deliver({
			type: "event",
			sessionId: "session-1",
			seq: 6,
			revision: 6,
			event: "model_compaction_policy_changed",
			payload: {
				compactionPolicy: {
					enabled: false,
					contextWindow: 16_000,
					reserveTokens: 1_000,
					keepRecentTokens: 2_000,
					triggerTokens: 15_000,
					source: "model",
				},
			},
		});
		expect(session.snapshot).toMatchObject({
			name: "Renamed",
			nameSource: "explicit",
			nameRevision: 2,
			phase: "turn",
			usage: { output: 2 },
			goal: { id: "goal-1", status: "active" },
			compactionPolicy: { enabled: false, source: "model" },
		});
		await session.dispose();
	});

	test("replaces local state from an expired-cursor session snapshot", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		const recovered = snapshot({ revision: 300, eventSeq: 300, phase: "idle", thinkingLevel: "high" });
		pair.deliver({
			type: "event",
			sessionId: "session-1",
			seq: 44,
			revision: 300,
			event: "session_snapshot",
			payload: { reason: "event_cursor_expired", requestedEventSeq: 1, retainedFrom: 45, snapshot: recovered },
		});
		expect(session.snapshot).toEqual(recovered);
		await session.dispose();
	});

	test("restores busy lifecycle from an expired-cursor active operation", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		const recovered = snapshot({
			revision: 300,
			eventSeq: 300,
			phase: "turn",
			activeOperation: { operationId: "operation-2", kind: "turn/start", state: "running", acceptedSeq: 299 },
		});
		pair.deliver({
			type: "event",
			sessionId: "session-1",
			seq: 44,
			revision: 300,
			event: "session_snapshot",
			payload: { reason: "event_cursor_expired", requestedEventSeq: 1, retainedFrom: 45, snapshot: recovered },
		});
		expect(session.state.lifecycle).toEqual({ status: "busy", operationId: "operation-2", command: "turn/start" });
		await session.dispose();
	});

	test("does not replace state from a malformed recovery snapshot", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		const original = session.snapshot;
		pair.deliver({
			type: "event",
			sessionId: "session-1",
			seq: 44,
			revision: 300,
			event: "session_snapshot",
			payload: {
				reason: "event_cursor_expired",
				requestedEventSeq: 1,
				retainedFrom: 45,
				snapshot: { id: "session-1", revision: 300, phase: "idle" },
			},
		});
		expect(session.snapshot).toEqual(original);
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

	test("ignores malformed plan and agent update payloads", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		const original = session.snapshot;
		pair.deliver({
			type: "event",
			sessionId: "session-1",
			seq: 2,
			revision: 2,
			event: "plan_updated",
			payload: { plan: { version: 1, items: [{ step: "", status: "pending" }] } },
		});
		pair.deliver({
			type: "event",
			sessionId: "session-1",
			seq: 3,
			revision: 3,
			event: "agent_updated",
			payload: { agent: { id: "agent-1", path: "/root", taskName: "child", state: "running", model: {} } },
		});
		expect(session.snapshot).toEqual(original);
		await session.dispose();
	});

	test("rejects process and blob responses with invalid numeric fields", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		pair.overrideNextResult("process/read", { output: { output: "hi", cursor: -1, truncated: false } });
		await expect(session.readProcess("process-1")).rejects.toThrow("Invalid process/read response");
		pair.overrideNextResult("blob/stat", { blob: { digest: "sha256:blob", mimeType: "text/plain", size: 1.5 } });
		await expect(session.statBlob("sha256:blob")).rejects.toThrow("Invalid blob/stat response");
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
		expect(await session.waitAgent(agent.id, 10)).toMatchObject({ id: "agent-1", state: "idle" });
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
		await session.writeProcess(process.processId, undefined, { eof: true });
		expect(pair.requests.at(-1)?.payload).toEqual({ processId: "process-1", eof: true });
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
			{ id: "web-1", title: "Pi", source: "faux", retrievedAt: 1, url: "https://example.test" },
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

	test("uploads a bounded client-local file as a server-owned blob", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-local-upload-"));
		directories.push(directory);
		const path = join(directory, "note.txt");
		await writeFile(path, "hi");
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		expect(await session.uploadLocalFile(path, "text/plain")).toEqual({
			digest: "sha256:blob",
			mimeType: "text/plain",
			size: 2,
		});
		expect(pair.requests.at(-1)?.payload).toEqual({ data: "aGk=", encoding: "base64", mimeType: "text/plain" });
		const oversizedPath = join(directory, "oversized.bin");
		await writeFile(oversizedPath, Buffer.alloc(8 * 1024 * 1024 + 1));
		await expect(session.uploadLocalFile(oversizedPath, "application/octet-stream")).rejects.toThrow(
			"maximum upload size",
		);
		await session.dispose();
	});

	test("returns an explicit structured local file reference for an uploaded file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-local-reference-"));
		directories.push(directory);
		const path = join(directory, "note.txt");
		await writeFile(path, "hi");
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		expect(await session.uploadLocalFileReference(path, "text/plain")).toEqual({
			reference: `@local:${path}`,
			path,
			kind: "file",
			size: 2,
			mimeType: "text/plain",
			blobDigest: "sha256:blob",
		});
		await session.dispose();
	});

	test("inspects server diagnostics", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		expect(await session.diagnosticsStatus()).toMatchObject({ capture: "metadata", degraded: false });
		expect(await session.diagnosticsStatus({ sessionId: "session-1" })).toMatchObject({
			capture: "metadata",
			degraded: false,
		});
		expect(pair.requests.at(-1)).toMatchObject({
			command: "diagnostics/status",
			payload: { sessionId: "session-1" },
		});
		expect(await session.diagnosticsTimeline({ afterSeq: 2 })).toEqual([
			{ seq: 3, kind: "operation", outcome: "ok" },
		]);
		expect(await session.diagnosticsTimelineEvidence({ sessionId: "session-1", operationId: "operation-1" })).toEqual(
			{
				events: [{ seq: 3, kind: "operation", outcome: "ok" }],
				operations: [{ operationId: "operation-1", state: "complete" }],
				operationEvents: [{ event: "operation_terminal", operationId: "operation-1" }],
				usage: { aggregate: { responses: 1 }, entries: [] },
			},
		);
		expect((await session.diagnosticsExport()).manifest).toMatchObject({ eventCount: 3 });
		expect(
			(
				await session.diagnosticsExport({
					decryptContent: true,
					sessionId: "session-1",
					operationId: "operation-1",
				})
			).manifest,
		).toMatchObject({ eventCount: 3 });
		expect(pair.requests.at(-1)).toMatchObject({
			command: "diagnostics/export",
			payload: { decryptContent: true, sessionId: "session-1", operationId: "operation-1" },
		});
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
		expect(await session.upgradePlugin("plugin-1", "2.0.0")).toMatchObject({ id: "plugin-1" });
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

	test("updates goals and session naming through accepted operations", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		await session.updateGoal({ status: "complete" });
		await session.setName("Renamed");
		await session.generateName();
		await session.setAutoName(true);
		expect(pair.requests.slice(-4).map((request) => request.command)).toEqual([
			"goal/update",
			"session/name/set",
			"session/name/generate",
			"session/name/auto/set",
		]);
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

	test("contains failures from the remote listener error sink", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1", {
			onListenerError: () => {
				throw new Error("listener sink failure");
			},
		});
		session.subscribe(() => {
			throw new Error("listener failure");
		});

		await expect(session.refresh()).resolves.toMatchObject({ id: "session-1" });
		await session.dispose();
	});

	test("cleans up local state when disposal detach fails", async () => {
		const pair = memoryTransport();
		const client = new PiClientV2({ transportFactory: pair.factory });
		await client.connect();
		const session = await RemoteV2Session.open(client, "session-1");
		pair.failNext("session/detach");

		await expect(session.dispose()).rejects.toThrow("invalid_request: forced attach failure");
		expect(session.state.lifecycle).toEqual({ status: "disposed" });
		expect(session.id).toBeUndefined();
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
