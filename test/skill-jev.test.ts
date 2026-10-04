import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

import extension from "../extensions/skill-jev.ts";
import type { SkillEntry } from "../extensions/jev.ts";

interface SearchDetails {
	inputTokens?: number;
	selections?: { name: string }[];
	unreadableSkills?: { name: string; error: string }[];
	fallback?: string;
}

function fixture(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "skill-jev-test-"));
	const env = {
		TYPESAFE_API_KEY: "test-key",
		PI_SKILL_JEV_CONFIG: join(dir, "config.json"),
		PI_SKILL_JEV_ENDPOINT: `https://offline.test/${dir}`,
		PI_SKILL_JEV_MODEL: "test-model",
		PI_SKILL_JEV_MIN_SCORE: "1.6",
		PI_SKILL_JEV_SHARD_SIZE: "50",
		PI_SKILL_JEV_MAX_SKILLS: "3",
		PI_SKILL_JEV_TIMEOUT_MS: "20000",
	};
	const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () => { throw new Error("Unexpected request in offline test"); }) as typeof fetch;
	t.after(() => {
		globalThis.fetch = realFetch;
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	const tools = new Map<string, ToolDefinition>();
	let beforeAgentStart: (event: BeforeAgentStartEvent) => unknown;
	extension({
		on(event: string, handler: typeof beforeAgentStart) {
			assert.equal(event, "before_agent_start");
			beforeAgentStart = handler;
		},
		registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
	} as unknown as ExtensionAPI);

	return {
		skill(name: string): SkillEntry {
			const baseDir = join(dir, name);
			mkdirSync(baseDir);
			const filePath = join(baseDir, "SKILL.md");
			writeFileSync(filePath, `---\nname: ${name}\n---\nInstructions for ${name}.`);
			return { name, description: "Run remote commands", filePath, baseDir };
		},
		async search(skills: SkillEntry[], fetchImpl: typeof fetch) {
			globalThis.fetch = fetchImpl;
			await beforeAgentStart({ systemPrompt: "You are Pi.", systemPromptOptions: { skills } } as BeforeAgentStartEvent);
			const result = await tools.get("skill_search")!.execute("test", { task: "fleet remote commands" }, undefined, undefined, {} as ExtensionContext);
			// Pi's generic registry erases the skill_search detail shape.
			const details = result.details as SearchDetails;
			return { ...result, details };
		},
	};
}

function response(init: RequestInit): Response {
	const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
	const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { score: 2, confidence: 0.9 }]));
	return new Response(JSON.stringify({ model: "test-model", answers, usage: { input_tokens: 100 } }));
}

function text(result: AgentToolResult<unknown>): string {
	return result.content.map((part) => part.type === "text" ? part.text : "").join("\n");
}

test("skill_search excludes missing and unreadable files before paying", async (t) => {
	const f = fixture(t);
	const fleet = f.skill("fleet");
	const missing = f.skill("missing");
	const unreadable = f.skill("unreadable");
	unlinkSync(missing.filePath);
	unlinkSync(unreadable.filePath);
	mkdirSync(unreadable.filePath);
	let names: string[] = [];
	const result = await f.search([missing, unreadable, fleet], (async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body)) as { questions: Record<string, { instructions: { skill_name: string } }> };
		names = Object.values(body.questions).map((question) => question.instructions.skill_name);
		return response(init);
	}) as unknown as typeof fetch);
	assert.deepEqual(names, ["fleet"]);
	assert.match(text(result), /Instructions for fleet/);
	assert.match(text(result), /missing/);
	assert.match(text(result), /unreadable/);
	assert.equal(result.details.unreadableSkills?.length, 2);
});

test("skill_search skips paid ranking when no skill files are readable", async (t) => {
	const f = fixture(t);
	const missing = f.skill("missing");
	unlinkSync(missing.filePath);
	let calls = 0;
	const result = await f.search([missing], (async (_url: string, init: RequestInit) => {
		calls++;
		return response(init);
	}) as unknown as typeof fetch);
	assert.equal(calls, 0);
	assert.match(text(result), /No readable/);
	assert.match(text(result), /missing/);
});

test("skill_search preserves paid ranking and usage if a winner disappears", async (t) => {
	const f = fixture(t);
	const vanished = f.skill("vanished");
	const fleet = f.skill("fleet");
	const result = await f.search([vanished, fleet], (async (_url: string, init: RequestInit) => {
		unlinkSync(vanished.filePath);
		return response(init);
	}) as unknown as typeof fetch);
	const details = result.details;
	assert.equal(details.inputTokens, 100);
	assert.deepEqual(details.selections?.map((entry) => entry.name), ["fleet", "vanished"]);
	assert.equal(details.unreadableSkills?.[0]?.name, "vanished");
	assert.match(details.unreadableSkills![0]!.error, /ENOENT/);
	assert.match(text(result), /Instructions for fleet/);
	assert.match(text(result), /vanished/);
	assert.match(text(result), /loaded 1 Agent Skill/);
});

test("skill_search retains usage even when every selected file disappears", async (t) => {
	const f = fixture(t);
	const vanished = f.skill("vanished");
	const result = await f.search([vanished], (async (_url: string, init: RequestInit) => {
		unlinkSync(vanished.filePath);
		return response(init);
	}) as unknown as typeof fetch);
	assert.equal(result.details.inputTokens, 100);
	assert.match(text(result), /None of the selected skills could be read/);
	assert.match(text(result), /vanished/);
});

test("skill_search keeps lexical fallback during the credit cooldown", async (t) => {
	const f = fixture(t);
	const fleet = f.skill("fleet");
	let calls = 0;
	const fakeFetch = (async () => {
		calls++;
		return new Response("no credits", { status: 402 });
	}) as unknown as typeof fetch;
	for (let i = 0; i < 2; i++) {
		const result = await f.search([fleet], fakeFetch);
		assert.equal(result.details.fallback, "lexical");
		assert.match(text(result), /lexical keyword matches/);
		assert.match(text(result), /fleet/);
		assert.match(text(result), /402/);
	}
	assert.equal(calls, 1);
});
