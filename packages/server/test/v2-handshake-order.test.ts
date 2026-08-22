import {
	decodeCbor,
	encodeClientMessageV2,
	type ModelMetadata,
	parseServerMessageV2,
	type ServerMessageV2,
} from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import { Deferred } from "../src/testing/index.ts";
import { type PiServerServiceV2, PiServerV2, type PiSessionRuntimeV2 } from "../src/v2.ts";

const model: ModelMetadata = {
	provider: "test",
	id: "small",
	name: "Test Small",
	api: "test-api",
	reasoning: true,
	input: ["text"],
	contextWindow: 16_000,
	maxTokens: 2_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	supportedThinkingLevels: ["off"],
	authenticated: true,
};

class ModelService implements PiServerServiceV2 {
	listSessions(): Promise<[]> {
		return Promise.resolve([]);
	}

	listModels(): Promise<ModelMetadata[]> {
		return Promise.resolve([model]);
	}

	openSession(): Promise<PiSessionRuntimeV2> {
		return Promise.reject(new Error("No sessions in this contract"));
	}
}

class BlockingRequestService extends ModelService {
	readonly started = new Deferred<void>();
	readonly release = new Deferred<void>();
	private modelListCalls = 0;

	listModels(): Promise<ModelMetadata[]> {
		this.modelListCalls += 1;
		if (this.modelListCalls === 1) return super.listModels();
		this.started.resolve(undefined);
		return this.release.promise.then(() => [model]);
	}
}

describe("PiServerV2 handshake ordering", () => {
	test("accepts a request received while the hello write is pending", async () => {
		const server = new PiServerV2(new ModelService(), { listeners: [], serverId: "memory-server" });
		const response = new Deferred<ServerMessageV2>();
		const helloRelease = new Deferred<void>();
		let handler: ReturnType<PiServerV2["accept"]> | undefined;
		let sendIndex = 0;
		const sendActions: Array<(message: ServerMessageV2) => Promise<void>> = [
			async () => {
				handler?.onData(
					encodeClientMessageV2({
						type: "request",
						id: "early-model-list",
						request: { command: "model/list" },
					}),
				);
				await helloRelease.promise;
			},
			async (message) => {
				response.resolve(message);
			},
		];
		const connection = {
			closed: false,
			send: async (chunk: Uint8Array) => {
				const message = parseServerMessageV2(decodeCbor(chunk.subarray(4)));
				await sendActions[sendIndex++]!(message);
			},
			close: async () => {},
		};
		handler = server.accept(connection);
		handler.onData(encodeClientMessageV2({ type: "hello", version: 2 }));

		expect(await response.promise).toMatchObject({ type: "response", id: "early-model-list", ok: true });
		helloRelease.resolve(undefined);
		await server.close();
	});

	test("rejects duplicate in-flight request ids without replacing the original", async () => {
		const service = new BlockingRequestService();
		const server = new PiServerV2(service, { listeners: [], serverId: "memory-server" });
		const responses: ServerMessageV2[] = [];
		const duplicateResponse = new Deferred<void>();
		const responsesReady = new Deferred<void>();
		const helloReady = new Deferred<void>();
		const connection = {
			closed: false,
			send: async (chunk: Uint8Array) => {
				const message = parseServerMessageV2(decodeCbor(chunk.subarray(4)));
				if (message.type === "hello") helloReady.resolve(undefined);
				if (message.type !== "response") return;
				responses.push(message);
				if (message.ok === false) duplicateResponse.resolve(undefined);
				if (responses.length === 2) responsesReady.resolve(undefined);
			},
			close: async () => {},
		};
		const handler = server.accept(connection);
		handler.onData(encodeClientMessageV2({ type: "hello", version: 2 }));
		await helloReady.promise;
		handler.onData(encodeClientMessageV2({ type: "request", id: "same-id", request: { command: "model/list" } }));
		await service.started.promise;
		handler.onData(encodeClientMessageV2({ type: "request", id: "same-id", request: { command: "model/list" } }));
		await duplicateResponse.promise;
		expect(responses).toContainEqual({
			type: "response",
			id: "same-id",
			ok: false,
			error: { code: "duplicate_request_id", message: "A request with this id is already in flight" },
		});
		service.release.resolve(undefined);
		await responsesReady.promise;
		await server.close();
	});
});
