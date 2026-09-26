/**
 * Pure core for pi-jev-skill-picker: configuration, Jev question construction,
 * response ranking, and a deterministic lexical fallback.
 *
 * Nothing here touches Pi. Everything here is unit-testable.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SYSTEM_ONE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_MODEL = "jev-latest";
export const DEFAULT_SHARD_SIZE = 50;
export const DEFAULT_MAX_SKILLS = 3;
export const DEFAULT_MIN_SCORE = 1.6;
export const DEFAULT_DESCRIPTION_LIMIT = 1200;
export const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Pi wraps the generated catalog in <skills>...</skills>. Older builds emitted the
 * bare header plus <available_skills>, so both shapes are handled.
 */
const CATALOG_OPEN = "<skills>";
const CATALOG_CLOSE = "</skills>";
const LEGACY_START = "\n\nThe following skills provide specialized instructions for specific tasks.";
const LEGACY_END = "</available_skills>";

/** The ordered Score levels every skill is judged against. */
export const RELEVANCE_LEVELS = [
	"Unrelated. The skill covers a different domain, tool, service or workflow than the task. Loading its instructions would only waste the agent's attention.",
	"Adjacent. The skill sits in the same general area as the task, but does not cover the specific tool, service or step the task actually needs.",
	"Directly applicable. The skill covers the exact tool, service, workflow or domain the task needs, and following its instructions would change how the task is carried out.",
];

export interface SkillEntry {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
}

export interface JevConfig {
	apiKey?: string;
	model: string;
	shardSize: number;
	minScore: number;
	maxSkills: number;
	descriptionLimit: number;
	timeoutMs: number;
	endpoint: string;
}

export interface ScoreAnswer {
	type?: string;
	score?: number;
	confidence?: number;
}

export interface SystemOneResponse {
	model?: string;
	answers?: Record<string, ScoreAnswer>;
	usage?: { input_tokens?: number; output_tokens?: number };
}

export interface Ranked {
	skill: SkillEntry;
	score: number;
	confidence: number;
}

/** Strip Pi's generated `<available_skills>` block from a system prompt. */
export function stripSkillCatalog(systemPrompt: string): string {
	const open = systemPrompt.indexOf(CATALOG_OPEN);
	if (open !== -1) {
		const close = systemPrompt.indexOf(CATALOG_CLOSE, open);
		if (close !== -1) {
			// Swallow one preceding blank line so the surrounding prompt stays tidy.
			const start = systemPrompt.slice(0, open).endsWith("\n\n") ? open - 1 : open;
			return systemPrompt.slice(0, start) + systemPrompt.slice(close + CATALOG_CLOSE.length);
		}
	}

	const legacyStart = systemPrompt.indexOf(LEGACY_START);
	if (legacyStart === -1) return systemPrompt;
	const legacyEnd = systemPrompt.indexOf(LEGACY_END, legacyStart);
	if (legacyEnd === -1) return systemPrompt;
	return systemPrompt.slice(0, legacyStart) + systemPrompt.slice(legacyEnd + LEGACY_END.length);
}

function positiveInteger(value: unknown, fallback: number): number {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function finiteNumber(value: unknown, fallback: number): number {
	const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
	return Number.isFinite(parsed) ? parsed : fallback;
}

function trimmed(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	return trimmed(env.PI_SKILL_JEV_CONFIG)
		?? join(trimmed(env.PI_CODING_AGENT_DIR) ?? join(homedir(), ".pi", "agent"), "skill-jev.json");
}

/**
 * Resolve configuration. Environment variables win over the JSON config file,
 * which wins over the package defaults. The API key is never read from argv.
 */
export function loadConfig(
	env: NodeJS.ProcessEnv = process.env,
	readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): JevConfig {
	let file: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(readFile(configPath(env))) as unknown;
		if (parsed && typeof parsed === "object") file = parsed as Record<string, unknown>;
	} catch {
		// A missing or malformed config file falls back to environment and defaults.
	}

	return {
		apiKey: trimmed(env.TYPESAFE_API_KEY) ?? trimmed(file.apiKey),
		model: trimmed(env.PI_SKILL_JEV_MODEL) ?? trimmed(file.model) ?? DEFAULT_MODEL,
		shardSize: positiveInteger(env.PI_SKILL_JEV_SHARD_SIZE ?? file.shardSize, DEFAULT_SHARD_SIZE),
		minScore: finiteNumber(env.PI_SKILL_JEV_MIN_SCORE ?? file.minScore, DEFAULT_MIN_SCORE),
		maxSkills: positiveInteger(env.PI_SKILL_JEV_MAX_SKILLS ?? file.maxSkills, DEFAULT_MAX_SKILLS),
		descriptionLimit: positiveInteger(file.descriptionLimit, DEFAULT_DESCRIPTION_LIMIT),
		timeoutMs: positiveInteger(env.PI_SKILL_JEV_TIMEOUT_MS ?? file.timeoutMs, DEFAULT_TIMEOUT_MS),
		endpoint: trimmed(env.PI_SKILL_JEV_ENDPOINT) ?? trimmed(file.endpoint) ?? SYSTEM_ONE_ENDPOINT,
	};
}

export function shorten(value: string, maximum: number): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	return collapsed.length <= maximum ? collapsed : `${collapsed.slice(0, maximum - 1).trimEnd()}…`;
}

/**
 * Split into evenly sized shards. `size` is a target maximum, not a fixed chunk:
 * the shard count comes from it, then items are spread evenly across that many
 * shards. Latency tracks the largest shard, so a lopsided tail (100+37) costs
 * far more than the same work split evenly (69+68).
 */
export function shard<T>(items: T[], size: number): T[][] {
	if (items.length === 0) return [];
	const count = Math.max(1, Math.ceil(items.length / Math.max(1, size)));
	const base = Math.floor(items.length / count);
	const remainder = items.length % count;
	const shards: T[][] = [];
	let index = 0;
	for (let n = 0; n < count; n++) {
		const take = base + (n < remainder ? 1 : 0);
		shards.push(items.slice(index, index + take));
		index += take;
	}
	return shards;
}

/** Question id for a skill's position in the full catalog. Ids never reach the model. */
export function questionId(index: number): string {
	return `skill_${index}`;
}

/**
 * One Score question per skill. The task lives in the shared state; each skill's
 * identity lives in its own question, so a large catalog never rots the state.
 */
export function buildQuestions(
	skills: SkillEntry[],
	offset: number,
	descriptionLimit: number,
): Record<string, unknown> {
	const questions: Record<string, unknown> = {};
	for (const [position, skill] of skills.entries()) {
		questions[questionId(offset + position)] = {
			type: "score",
			instructions: {
				judgement:
					"Rate how useful this one Agent Skill would be to an autonomous coding agent working on the task described in `task`. Judge only this skill; other skills are rated separately.",
				skill_name: skill.name,
				skill_description: shorten(skill.description, descriptionLimit),
			},
			criteria: RELEVANCE_LEVELS,
		};
	}
	return questions;
}

export function buildRequest(
	task: string,
	skills: SkillEntry[],
	offset: number,
	config: JevConfig,
): Record<string, unknown> {
	return {
		model: config.model,
		state: { task: task.trim() },
		questions: buildQuestions(skills, offset, config.descriptionLimit),
	};
}

/** Map Jev answers back onto the catalog, keeping only scores at or above the floor. */
export function rank(
	skills: SkillEntry[],
	answers: Record<string, ScoreAnswer>,
	minScore: number,
): Ranked[] {
	const ranked: Ranked[] = [];
	for (const [index, skill] of skills.entries()) {
		const answer = answers[questionId(index)];
		if (!answer || typeof answer.score !== "number" || !Number.isFinite(answer.score)) continue;
		if (answer.score < minScore) continue;
		ranked.push({
			skill,
			score: answer.score,
			confidence: typeof answer.confidence === "number" ? answer.confidence : 0,
		});
	}
	ranked.sort(
		(left, right) =>
			right.score - left.score
			|| right.confidence - left.confidence
			|| left.skill.name.localeCompare(right.skill.name),
	);
	return ranked;
}

export class JevError extends Error {
	readonly status?: number;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "JevError";
		this.status = status;
	}
}

const RETRYABLE = new Set([429, 500, 502, 503, 529]);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, ms);
		function abort() {
			clearTimeout(timer);
			reject(new JevError("Skill ranking was cancelled."));
		}
		if (signal?.aborted) return abort();
		signal?.addEventListener("abort", abort, { once: true });
	});
}

/** One POST, with backoff on the documented retryable statuses. */
export async function askJev(
	body: Record<string, unknown>,
	config: JevConfig,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
	attempts = 3,
): Promise<SystemOneResponse> {
	if (!config.apiKey) {
		throw new JevError(
			"No TypeSafe API key. Set TYPESAFE_API_KEY, or add \"apiKey\" to " + configPath() + ".",
		);
	}

	let lastError: JevError | undefined;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const timeout = AbortSignal.timeout(config.timeoutMs);
		const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;
		let response: Response;
		try {
			response = await fetchImpl(config.endpoint, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${config.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal: composed,
			});
		} catch (error) {
			if (signal?.aborted) throw new JevError("Skill ranking was cancelled.");
			lastError = new JevError(`Request to ${config.endpoint} failed: ${error instanceof Error ? error.message : String(error)}`);
			if (attempt === attempts) break;
			await sleep(250 * 2 ** (attempt - 1), signal);
			continue;
		}

		if (response.ok) return (await response.json()) as SystemOneResponse;

		const detail = shorten(await response.text().catch(() => ""), 300);
		lastError = new JevError(`TypeSafe returned ${response.status}${detail ? `: ${detail}` : ""}`, response.status);
		if (!RETRYABLE.has(response.status) || attempt === attempts) break;
		const retryAfter = Number.parseFloat(response.headers.get("retry-after") ?? "");
		await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 250 * 2 ** (attempt - 1), signal);
	}

	throw lastError ?? new JevError("TypeSafe request failed for an unknown reason.");
}

/** Rank the whole catalog by firing every shard in parallel. */
export async function rankSkills(
	task: string,
	skills: SkillEntry[],
	config: JevConfig,
	limit: number,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<{
	ranked: Ranked[];
	alsoRanked: Ranked[];
	model?: string;
	inputTokens: number;
	shards: number;
	failures: string[];
}> {
	const shards = shard(skills, config.shardSize);
	// Offsets must follow the actual shard lengths. Shards are balanced, so they
	// are not multiples of shardSize, and index * shardSize would map answers
	// onto the wrong skills.
	const offsets: number[] = [];
	let running = 0;
	for (const batch of shards) {
		offsets.push(running);
		running += batch.length;
	}
	const results = await Promise.all(
		shards.map(async (batch, index) => {
			const offset = offsets[index]!;
			try {
				const response = await askJev(buildRequest(task, batch, offset, config), config, signal, fetchImpl);
				return { response, offset, error: undefined as string | undefined };
			} catch (error) {
				if (signal?.aborted) throw error;
				return { response: undefined, offset, error: error instanceof Error ? error.message : String(error) };
			}
		}),
	);

	const answers: Record<string, ScoreAnswer> = {};
	const failures: string[] = [];
	let model: string | undefined;
	let inputTokens = 0;
	for (const result of results) {
		if (result.error) {
			failures.push(result.error);
			continue;
		}
		const response = result.response!;
		model ??= response.model;
		inputTokens += response.usage?.input_tokens ?? 0;
		for (const [id, answer] of Object.entries(response.answers ?? {})) answers[id] = answer;
	}

	if (failures.length === shards.length) {
		throw new JevError(`Every Jev request failed. ${failures[0]}`);
	}

	const scored = rank(skills, answers, config.minScore);
	return {
		ranked: scored.slice(0, limit),
		// Cleared the floor but lost on score. Reported so the agent can force-load one.
		alsoRanked: scored.slice(limit),
		model,
		inputTokens,
		shards: shards.length,
		failures,
	};
}
