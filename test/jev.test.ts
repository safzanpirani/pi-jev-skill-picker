import assert from "node:assert/strict";
import { test } from "node:test";

import {
	askJev,
	buildQuestions,
	buildRequest,
	loadConfig,
	questionId,
	rank,
	rankSkills,
	shard,
	shorten,
	stripSkillCatalog,
	DEFAULT_MODEL,
	RELEVANCE_LEVELS,
	type JevConfig,
	type SkillEntry,
} from "../extensions/jev.ts";
import { lexicalMatches, queryTerms } from "../extensions/lexical.ts";

function skill(name: string, description: string): SkillEntry {
	return { name, description, filePath: `/skills/${name}/SKILL.md`, baseDir: `/skills/${name}` };
}

/** The shape Pi 0.86 actually emits, captured from a live system prompt. */
const CATALOG = [
	"You are Pi.",
	"",
	"<skills>",
	"The following skills provide specialized instructions for specific tasks.",
	"Use the read tool to load a skill's file when the task matches.",
	"<available_skills>",
	"  <skill>",
	"    <name>fleet</name>",
	"    <description>Run commands on remote hosts</description>",
	"  </skill>",
	"</available_skills>",
	"</skills>",
	"",
	"<cwd>",
	"/tmp",
	"</cwd>",
].join("\n");

/** Pre-<skills> builds emitted the bare header instead. */
const LEGACY_CATALOG = [
	"You are Pi.",
	"",
	"The following skills provide specialized instructions for specific tasks.",
	"<available_skills>",
	"<skill><name>fleet</name></skill>",
	"</available_skills>",
	"Tools follow.",
].join("\n");

test("stripSkillCatalog removes the <skills> block Pi actually emits", () => {
	const stripped = stripSkillCatalog(CATALOG);
	assert.ok(!stripped.includes("<skills>"));
	assert.ok(!stripped.includes("<available_skills>"));
	assert.ok(!stripped.includes("fleet"));
	assert.ok(stripped.startsWith("You are Pi."));
	assert.ok(stripped.includes("<cwd>"), "content after the catalog must survive");
});

test("stripSkillCatalog still handles the legacy bare-header shape", () => {
	const stripped = stripSkillCatalog(LEGACY_CATALOG);
	assert.ok(!stripped.includes("<available_skills>"));
	assert.ok(!stripped.includes("fleet"));
	assert.ok(stripped.endsWith("Tools follow."));
});

test("stripSkillCatalog is a no-op when no catalog is present", () => {
	assert.equal(stripSkillCatalog("You are Pi."), "You are Pi.");
});

test("stripSkillCatalog leaves the prompt alone when the closing tag is missing", () => {
	const truncated = LEGACY_CATALOG.slice(0, LEGACY_CATALOG.indexOf("</available_skills>"));
	assert.equal(stripSkillCatalog(truncated), truncated);
});

test("shard derives a count from the target size and balances the split", () => {
	assert.deepEqual(shard([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
	assert.deepEqual(shard([], 2), []);

	// 137 skills at a target of 50 must not become the lopsided 50+50+37.
	const many = Array.from({ length: 137 }, (_, i) => i);
	const sizes = shard(many, 50).map((s) => s.length);
	assert.deepEqual(sizes, [46, 46, 45]);
	assert.equal(sizes.reduce((a, b) => a + b, 0), 137);
	assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, "shards differ by at most one item");

	// Nothing is dropped or duplicated.
	assert.deepEqual(shard(many, 50).flat(), many);
});

test("shorten collapses whitespace and appends an ellipsis past the limit", () => {
	assert.equal(shorten("a   b\n c", 50), "a b c");
	assert.equal(shorten("abcdef", 4), "abc…");
});

test("buildQuestions carries the skill in the question, never in the state", () => {
	const skills = [skill("fleet", "Run commands on remote hosts"), skill("qb", "qBittorrent")];
	const questions = buildQuestions(skills, 10, 1200);
	assert.deepEqual(Object.keys(questions), [questionId(10), questionId(11)]);

	const first = questions[questionId(10)] as {
		type: string;
		instructions: { skill_name: string; skill_description: string };
		criteria: string[];
	};
	assert.equal(first.type, "score");
	assert.equal(first.instructions.skill_name, "fleet");
	assert.equal(first.instructions.skill_description, "Run commands on remote hosts");
	assert.equal(first.criteria, RELEVANCE_LEVELS);
	assert.equal(first.criteria.length, 3);
});

test("buildQuestions truncates a long description to the configured limit", () => {
	const questions = buildQuestions([skill("bhav", "x".repeat(5000))], 0, 100);
	const only = questions[questionId(0)] as { instructions: { skill_description: string } };
	assert.equal(only.instructions.skill_description.length, 100);
});

test("buildRequest puts only the task in the state", () => {
	const config = { ...loadConfig({}, () => { throw new Error("none"); }) } as JevConfig;
	const request = buildRequest("  restart jellyfin  ", [skill("fleet", "remote")], 0, config);
	assert.deepEqual(request.state, { task: "restart jellyfin" });
	assert.equal(request.model, DEFAULT_MODEL);
});

test("rank orders by score and applies the floor", () => {
	const skills = [skill("a", ""), skill("b", ""), skill("c", ""), skill("d", "")];
	const ranked = rank(
		skills,
		{
			[questionId(0)]: { score: 0.4, confidence: 0.9 },
			[questionId(1)]: { score: 1.9, confidence: 0.8 },
			[questionId(2)]: { score: 1.2, confidence: 0.7 },
			[questionId(3)]: { score: 1.2, confidence: 0.95 },
		},
		1.0,
	);
	// rank keeps everything above the floor; the caller decides how many to load.
	assert.deepEqual(ranked.map((entry) => entry.skill.name), ["b", "d", "c"]);
});

test("rank skips missing and non-numeric answers", () => {
	const ranked = rank([skill("a", ""), skill("b", "")], { [questionId(1)]: { score: Number.NaN } }, 0);
	assert.deepEqual(ranked, []);
});

test("loadConfig prefers the environment over the config file", () => {
	const config = loadConfig(
		{ TYPESAFE_API_KEY: "from-env", PI_SKILL_JEV_MIN_SCORE: "1.5" },
		() => JSON.stringify({ apiKey: "from-file", model: "jev-1.13.0", minScore: 0.2, shardSize: 7 }),
	);
	assert.equal(config.apiKey, "from-env");
	assert.equal(config.model, "jev-1.13.0");
	assert.equal(config.minScore, 1.5);
	assert.equal(config.shardSize, 7);
});

test("loadConfig falls back to defaults when the config file is unreadable", () => {
	const config = loadConfig({}, () => { throw new Error("ENOENT"); });
	assert.equal(config.apiKey, undefined);
	assert.equal(config.model, DEFAULT_MODEL);
	assert.equal(config.shardSize, 50);
});

test("rankSkills fans out across shards and merges the answers", async () => {
	const skills = Array.from({ length: 5 }, (_, index) => skill(`s${index}`, `description ${index}`));
	const config = { ...loadConfig({}, () => "{}"), apiKey: "k", shardSize: 2, minScore: 1 } as JevConfig;
	const seen: string[][] = [];

	const fakeFetch = (async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
		const ids = Object.keys(body.questions);
		seen.push(ids);
		const answers: Record<string, unknown> = {};
		for (const id of ids) answers[id] = { type: "score", score: 2, confidence: 0.9 };
		return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 100 } }), { status: 200 });
	}) as unknown as typeof fetch;

	const result = await rankSkills("a task", skills, config, 3, undefined, fakeFetch);
	assert.equal(result.shards, 3);
	assert.equal(seen.length, 3);
	assert.equal(result.inputTokens, 300);
	assert.equal(result.model, "jev-1.13.0");
	assert.equal(result.ranked.length, 3);
	assert.deepEqual(result.failures, []);
});

test("rankSkills maps answers to the right skills when shards are uneven", async () => {
	// 7 skills at a target of 3 balances to 3+2+2, so offsets are 0,3,5 — never
	// multiples of the target. Each skill is scored by its own index so any
	// misalignment shows up as the wrong names coming back.
	const skills = Array.from({ length: 7 }, (_, i) => skill(`s${i}`, ""));
	const config = { ...loadConfig({}, () => "{}"), apiKey: "k", shardSize: 3, minScore: 0 } as JevConfig;
	const fakeFetch = (async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
		const answers: Record<string, unknown> = {};
		for (const id of Object.keys(body.questions)) {
			const index = Number(id.replace("skill_", ""));
			answers[id] = { type: "score", score: index / 10, confidence: 0.5 };
		}
		return new Response(JSON.stringify({ answers }), { status: 200 });
	}) as unknown as typeof fetch;

	const result = await rankSkills("t", skills, config, 7, undefined, fakeFetch);
	assert.equal(result.shards, 3);
	assert.equal(result.ranked.length, 7);
	// Highest index scores highest, so order must be s6..s0 with matching scores.
	assert.deepEqual(result.ranked.map((r) => r.skill.name), ["s6", "s5", "s4", "s3", "s2", "s1", "s0"]);
	for (const entry of result.ranked) {
		const index = Number(entry.skill.name.slice(1));
		assert.equal(entry.score, index / 10, `${entry.skill.name} got another skill's score`);
	}
});

test("rankSkills survives a partial shard failure and reports it", async () => {
	const skills = Array.from({ length: 4 }, (_, index) => skill(`s${index}`, ""));
	const config = { ...loadConfig({}, () => "{}"), apiKey: "k", shardSize: 2, minScore: 1 } as JevConfig;
	let call = 0;
	const fakeFetch = (async (_url: string, init: RequestInit) => {
		if (call++ === 0) return new Response("boom", { status: 400 });
		const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
		const answers: Record<string, unknown> = {};
		for (const id of Object.keys(body.questions)) answers[id] = { type: "score", score: 1.8, confidence: 0.6 };
		return new Response(JSON.stringify({ answers }), { status: 200 });
	}) as unknown as typeof fetch;

	const result = await rankSkills("a task", skills, config, 5, undefined, fakeFetch);
	assert.equal(result.failures.length, 1);
	assert.deepEqual(result.ranked.map((entry) => entry.skill.name), ["s2", "s3"]);
});

test("rankSkills throws when every shard fails", async () => {
	const config = { ...loadConfig({}, () => "{}"), apiKey: "k", shardSize: 2, minScore: 1 } as JevConfig;
	const fakeFetch = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
	await assert.rejects(
		() => rankSkills("t", [skill("a", "")], config, 3, undefined, fakeFetch),
		/Every Jev request failed/,
	);
});

test("rankSkills without an API key fails before any request", async () => {
	const config = loadConfig({}, () => "{}");
	let called = false;
	const fakeFetch = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
	await assert.rejects(() => rankSkills("t", [skill("a", "")], config, 3, undefined, fakeFetch), /No TypeSafe API key/);
	assert.equal(called, false);
});

test("askJev does not resend a timed-out paid request", async () => {
	const config = { ...loadConfig({}, () => "{}"), apiKey: "k", timeoutMs: 5 };
	let calls = 0;
	const fakeFetch = (async (_url: string, init: RequestInit) => {
		if (++calls === 1) throw init.signal!.reason;
		return new Response("{}");
	}) as unknown as typeof fetch;
	const realTimeout = AbortSignal.timeout;
	AbortSignal.timeout = () => AbortSignal.abort(new DOMException("The operation timed out.", "TimeoutError"));
	try {
		await assert.rejects(() => askJev({}, config, undefined, fakeFetch), /timed out|timeout/i);
		assert.equal(calls, 1);
	} finally {
		AbortSignal.timeout = realTimeout;
	}
});

test("askJev still retries transient HTTP errors and connection resets", async () => {
	const config = { ...loadConfig({}, () => "{}"), apiKey: "k" };
	for (const status of [429, 500, 502, 503, 529, undefined]) {
		let calls = 0;
		const fakeFetch = (async () => {
			if (++calls === 1) {
				if (status === undefined) throw new TypeError("ECONNRESET");
				return new Response("try again", { status, headers: { "retry-after": "0" } });
			}
			return new Response("{}");
		}) as unknown as typeof fetch;
		await askJev({}, config, undefined, fakeFetch);
		assert.equal(calls, 2, `retry ${status ?? "connection reset"}`);
	}
});

test("askJev shares a short 402 cooldown only for the same endpoint and API key", async () => {
	const config = { ...loadConfig({}, () => "{}"), apiKey: "k", endpoint: "https://credits.test" };
	let calls = 0;
	let exhausted = true;
	const fakeFetch = (async () => {
		calls++;
		return exhausted ? new Response("no credits", { status: 402 }) : new Response("{}");
	}) as unknown as typeof fetch;
	const realNow = Date.now;
	let now = realNow();
	Date.now = () => now;
	try {
		await assert.rejects(() => askJev({}, config, undefined, fakeFetch), /402/);
		await assert.rejects(() => askJev({}, { ...config }, undefined, fakeFetch), /402/);
		assert.equal(calls, 1, "a later caller must not dispatch during the cooldown");

		exhausted = false;
		await askJev({}, { ...config, apiKey: "other-key" }, undefined, fakeFetch);
		await askJev({}, { ...config, endpoint: "https://other.test" }, undefined, fakeFetch);
		assert.equal(calls, 3, "other credentials and endpoints must remain usable");

		now += 30_001;
		await askJev({}, config, undefined, fakeFetch);
		assert.equal(calls, 4, "paid ranking must resume after the cooldown expires");
	} finally {
		Date.now = realNow;
	}
});

test("lexical fallback ranks an exact name match first", () => {
	const skills = [skill("qb", "qBittorrent"), skill("fleet", "run commands on remote hosts")];
	assert.equal(lexicalMatches(skills, "fleet", 5)[0]?.skill.name, "fleet");
	assert.deepEqual(lexicalMatches(skills, "zzzz", 5), []);
});

test("queryTerms drops stop words and single characters", () => {
	assert.deepEqual(queryTerms("run a command on the remote host"), ["run", "command", "remote", "host"]);
});
