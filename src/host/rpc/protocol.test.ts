/**
 * Behavioral tests for the rpc protocol helpers: the identity-changing slash deny-list, the allow-list that
 * strips frames on their way to the chat, state parsing, and write-error codes.
 * Runner: `node --test src/host/rpc/protocol.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DENIED_SLASH_COMMANDS,
	classifySlashInput,
	encodeCommand,
	parseCommands,
	parseStateData,
	toChatEventFrame,
	writeErrorCode,
} from "./protocol.ts";

describe("classifySlashInput", () => {
	it("denies every identity-changing builtin, case-insensitively, with or without arguments", () => {
		for (const name of Object.keys(DENIED_SLASH_COMMANDS)) {
			assert.deepEqual(classifySlashInput(`/${name}`), { denied: true, command: name }, name);
			assert.deepEqual(classifySlashInput(`  /${name.toUpperCase()} some argument`), { denied: true, command: name });
		}
		assert.deepEqual(classifySlashInput("/session delete"), { denied: true, command: "session" });
		assert.deepEqual(classifySlashInput("/new\nmore text"), { denied: true, command: "new" });
	});

	it("passes everything else through as OMP does: unknown commands, paths, prose, other builtins", () => {
		for (const text of [
			"/foo",
			"/usr/bin/x fails",
			"/newer",
			"/new-thing",
			"/model",
			"/compact",
			"look at /new please",
			"new",
			"",
			"//new",
			"/ new",
			"/constructor",
		]) {
			assert.deepEqual(classifySlashInput(text), { denied: false }, JSON.stringify(text));
		}
	});
});

describe("toChatEventFrame", () => {
	it("rejects malformed streamed assistants and retains visible text without provider delta payloads", () => {
		assert.equal(toChatEventFrame({ type: "message_update", messageId: "msg-1", message: { role: "assistant", content: [], timestamp: 1 } }), null);
		const frame = toChatEventFrame({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "private delta", partial: { role: "assistant" } },
			message: { role: "assistant", model: "m", stopReason: "stop", content: [{ type: "text", text: "Visible reply" }], timestamp: 1 },
			messageId: "msg-1",
		});
		assert.ok(frame?.type === "message_update" && frame.message.role === "assistant");
		assert.deepEqual(frame.message.content, [{ type: "text", text: "Visible reply" }]);
		assert.equal("assistantMessageEvent" in frame, false);
	});

	it("maps model/thinking readback and never accepts child-created command feedback", () => {
		assert.equal(toChatEventFrame({ type: "command_feedback", message: "spoofed host message" }), null);
		assert.deepEqual(toChatEventFrame({ type: "config_update", model: { provider: "p", id: "m", contextWindow: 9 }, thinkingLevel: "high" }), {
			type: "config_update",
			model: { provider: "p", id: "m", contextWindow: 9 },
			thinkingLevel: "high",
		});
		assert.deepEqual(toChatEventFrame({ type: "config_update" }), { type: "config_update" });
	});

	it("maps the prompt result and the slash catalogue, and ignores frames outside the allow-list", () => {
		assert.deepEqual(toChatEventFrame({ type: "prompt_result", id: "vsc:1", status: "error", agentInvoked: false, sessionSettled: true, error: { message: "provider text" } }), {
			type: "prompt_result",
			id: "vsc:1",
			status: "error",
			agentInvoked: false,
			sessionSettled: true,
		});
		assert.deepEqual(toChatEventFrame({ type: "available_commands_update", commands: [{ name: "compact", description: "d", source: "builtin", input: {} }, 5] }), {
			type: "available_commands_update",
			commands: [{ name: "compact", description: "d", source: "builtin" }],
		});
		for (const type of ["response", "ready", "subagent_progress", "host_tool_call", "extension_ui_request", "unknown_future"]) {
			assert.equal(toChatEventFrame({ type }), null, type);
		}
		assert.equal(toChatEventFrame({ type: "message_end", message: { role: "user", timestamp: 1 } }), null, "a message frame without a messageId cannot be correlated");
	});
});

describe("command argument metadata", () => {
	it("preserves bounded subcommand usage with descriptions and hints", () => {
		const commands = parseCommands([{name:"mcp",input:{hint:"<action>"},subcommands:[{name:"add",description:"Add server",usage:"/mcp add <name>"},{name:"long",usage:"u".repeat(501)}]}]);
		assert.equal(commands[0]?.inputHint, "<action>");
		assert.deepEqual(commands[0]?.subcommands?.[0], {name:"add",description:"Add server",usage:"/mcp add <name>"});
		assert.equal(commands[0]?.subcommands?.[1]?.usage?.length, 500);
	});
});

describe("parseStateData / codes / encoding", () => {
	it("rejects non-state payloads rather than admitting an untyped streaming observation", () => {
		assert.equal(parseStateData({ isStreaming: "yes" }), null);
		assert.equal(parseStateData(null), null);
		assert.equal(parseStateData({ isSettled: true, hasPendingAsyncWork: false }), null);
	});

	it("maps write rejections to the fixed code vocabulary", () => {
		assert.equal(writeErrorCode({ code: "input-not-owner" }), "input-not-owner");
		assert.equal(writeErrorCode({ code: "frame-too-large" }), "line-too-long");
		assert.equal(writeErrorCode(new Error("x")), "closed");
		assert.equal(writeErrorCode("nope"), "closed");
	});

	it("encodes a command with its id first-class and no trailing newline", () => {
		const line = encodeCommand("vsc:1", { type: "prompt", message: "a\nb", streamingBehavior: "steer" });
		assert.equal(line.includes("\n"), false, "embedded newlines are JSON-escaped, so a line stays one line");
		assert.deepEqual(JSON.parse(line), { id: "vsc:1", type: "prompt", message: "a\nb", streamingBehavior: "steer" });
	});
});

describe("bounded get_state tool descriptors", () => {
	it("retains names/descriptions only and distinguishes empty from unavailable", () => {
		assert.deepEqual(parseStateData({ isStreaming: false, dumpTools: [{ name: "read", description: "Read files", parameters: { secret: true }, examples: ["x"] }] })?.dumpTools, [{ name: "read", description: "Read files" }]);
		assert.deepEqual(parseStateData({ isStreaming: false, dumpTools: [] })?.dumpTools, []);
		assert.equal(parseStateData({ isStreaming: false })?.dumpTools, null);
	});
	it("rejects oversized or malformed inventories without rejecting the session state", () => {
		for (const dumpTools of [
			{}, Array(1025).fill({ name: "read", description: "d" }),
			[{ name: "x".repeat(129), description: "d" }],
			[{ name: "read\nspoof", description: "d" }],
			[{ name: "read", description: "x".repeat(8193) }],
			[{ name: "read", description: null }],
			[{ name: "read", description: "d" }, { name: "read", description: "duplicate" }],
		]) {
			const parsed = parseStateData({ isStreaming: false, dumpTools });
			assert.ok(parsed);
			assert.equal(parsed.dumpTools, null);
		}
	});
});
