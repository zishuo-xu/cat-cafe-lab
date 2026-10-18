/** 自定义剧本的导入校验：宁可拒绝，也不要让坏剧本把 runtime 带崩。 */

import type { Scenario } from "../domain/types.ts";

export type ScenarioValidation =
  | { ok: true; scenario: Scenario }
  | { ok: false; errors: string[] };

const STAGES = ["intake", "planning", "working", "reviewing", "revising", "done"] as const;
const ARTIFACT_KINDS = ["spec", "design", "patch", "review", "decision"] as const;
const MEMORY_KINDS = ["decision", "lesson", "preference"] as const;
const VERDICTS = ["approve", "request_changes"] as const;
const SEVERITIES = ["blocker", "minor"] as const;
const TOOLS = ["read_file", "write_file", "list_files", "run_command"] as const;
const COMMANDS = ["node", "npm"] as const;

const MAX_BEATS = 120;

export function validateScenario(
  raw: unknown,
  opts: { catIds: string[] },
): ScenarioValidation {
  const errors: string[] = [];

  if (!isObject(raw)) return { ok: false, errors: ["scenario 必须是一个 JSON 对象"] };

  const id = raw["id"];
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{1,48}$/.test(id)) {
    errors.push("id 必须是 2–49 位字母/数字/_/-，且以字母或数字开头");
  }
  const name = raw["name"];
  if (typeof name !== "string" || name.trim().length < 1 || name.length > 60) {
    errors.push("name 必须是 1–60 字的字符串");
  }
  const sampleBrief = raw["sampleBrief"];
  if (
    typeof sampleBrief !== "string" ||
    sampleBrief.trim().length < 4 ||
    sampleBrief.length > 500
  ) {
    errors.push("sampleBrief 必须是 4–500 字的字符串");
  }
  const tags = raw["tags"];
  if (!Array.isArray(tags) || tags.length > 12) {
    errors.push("tags 必须是最多 12 个字符串的数组");
  } else {
    tags.forEach((tag, index) => {
      if (typeof tag !== "string" || tag.length < 1 || tag.length > 24) {
        errors.push(`tags[${index}] 必须是 1–24 字的字符串`);
      }
    });
  }

  const beats = raw["beats"];
  if (!Array.isArray(beats) || beats.length < 1 || beats.length > MAX_BEATS) {
    errors.push(`beats 必须是 1–${MAX_BEATS} 个元素的数组`);
  } else {
    beats.forEach((beat, index) => validateBeat(beat, index, opts.catIds, errors));
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, scenario: structuredClone(raw) as unknown as Scenario };
}

function validateBeat(
  raw: unknown,
  index: number,
  catIds: string[],
  errors: string[],
): void {
  const path = `beats[${index}]`;
  if (!isObject(raw)) {
    errors.push(`${path} 必须是对象`);
    return;
  }
  const stage = raw["stage"];
  if (typeof stage !== "string" || !STAGES.includes(stage as (typeof STAGES)[number])) {
    errors.push(`${path}.stage 必须是 ${STAGES.join(" / ")} 之一`);
  }
  const cat = raw["cat"];
  if (typeof cat !== "string" || !catIds.includes(cat)) {
    errors.push(`${path}.cat 必须是现有猫的 id（${catIds.join(" / ")}）`);
  }
  if (raw["fault"] !== undefined && raw["fault"] !== "missed_mention" && raw["fault"] !== "silent_drop") {
    errors.push(`${path}.fault 只能是 missed_mention 或 silent_drop`);
  }
  validateTurn(raw["turn"], `${path}.turn`, catIds, errors);
}

function validateTurn(
  raw: unknown,
  path: string,
  catIds: string[],
  errors: string[],
): void {
  if (!isObject(raw)) {
    errors.push(`${path} 必须是对象`);
    return;
  }
  const kind = raw["kind"];
  switch (kind) {
    case "message": {
      requireText(raw, "text", path, 1, 500, errors);
      optionalMentions(raw, path, catIds, errors);
      optionalDelay(raw, path, errors);
      return;
    }
    case "handoff": {
      if (typeof raw["to"] !== "string" || !catIds.includes(raw["to"])) {
        errors.push(`${path}.to 必须是现有猫的 id`);
      }
      const card = raw["card"];
      if (!isObject(card)) {
        errors.push(`${path}.card 必须是五栏对象`);
      } else {
        for (const field of ["what", "why", "tradeoff", "nextAction"] as const) {
          requireText(card, field, `${path}.card`, 1, 1000, errors);
        }
        const openQuestions = card["openQuestions"];
        if (!Array.isArray(openQuestions) || openQuestions.length > 10) {
          errors.push(`${path}.card.openQuestions 必须是数组（≤10 条）`);
        } else {
          openQuestions.forEach((q, i) => {
            if (typeof q !== "string" || q.length > 200) {
              errors.push(`${path}.card.openQuestions[${i}] 必须是 ≤200 字的字符串`);
            }
          });
        }
      }
      optionalText(raw, "text", path, errors);
      if (raw["fault"] !== undefined && raw["fault"] !== "missed_mention") {
        errors.push(`${path}.fault 只能是 missed_mention`);
      }
      optionalDelay(raw, path, errors);
      return;
    }
    case "artifact": {
      const artifact = raw["artifact"];
      if (!isObject(artifact)) {
        errors.push(`${path}.artifact 必须是对象`);
      } else {
        requireEnum(artifact, "kind", ARTIFACT_KINDS, `${path}.artifact`, errors);
        requireText(artifact, "title", `${path}.artifact`, 1, 120, errors);
        requireText(artifact, "body", `${path}.artifact`, 1, 4000, errors);
      }
      optionalText(raw, "text", path, errors);
      optionalMentions(raw, path, catIds, errors);
      optionalDelay(raw, path, errors);
      return;
    }
    case "review": {
      requireEnum(raw, "verdict", VERDICTS, path, errors);
      requireText(raw, "title", path, 1, 120, errors);
      requireText(raw, "text", path, 1, 500, errors);
      const findings = raw["findings"];
      if (!Array.isArray(findings) || findings.length > 20) {
        errors.push(`${path}.findings 必须是最多 20 条的数组`);
      } else if (raw["verdict"] === "request_changes" && findings.length < 1) {
        errors.push(`${path}.findings 在 request_changes 时至少需要 1 条`);
      } else {
        findings.forEach((finding, i) => {
          if (!isObject(finding)) {
            errors.push(`${path}.findings[${i}] 必须是对象`);
            return;
          }
          requireEnum(finding, "severity", SEVERITIES, `${path}.findings[${i}]`, errors);
          requireText(finding, "title", `${path}.findings[${i}]`, 1, 200, errors);
          optionalText(finding, "detail", `${path}.findings[${i}]`, errors);
        });
      }
      optionalMentions(raw, path, catIds, errors);
      optionalDelay(raw, path, errors);
      return;
    }
    case "decision": {
      const artifact = raw["artifact"];
      if (!isObject(artifact)) {
        errors.push(`${path}.artifact 必须是对象`);
      } else {
        requireText(artifact, "title", `${path}.artifact`, 1, 120, errors);
        requireText(artifact, "body", `${path}.artifact`, 1, 4000, errors);
      }
      requireText(raw, "text", path, 1, 500, errors);
      const memory = raw["memory"];
      if (!Array.isArray(memory) || memory.length < 1 || memory.length > 10) {
        errors.push(`${path}.memory 必须是 1–10 条数组`);
      } else {
        memory.forEach((entry, i) => validateMemory(entry, `${path}.memory[${i}]`, errors));
      }
      optionalDelay(raw, path, errors);
      return;
    }
    case "memory": {
      validateMemory(raw["memory"], `${path}.memory`, errors);
      requireText(raw, "text", path, 1, 500, errors);
      optionalDelay(raw, path, errors);
      return;
    }
    case "tool": {
      validateToolInput(raw, path, errors);
      const label = raw["label"];
      if (label !== undefined && (typeof label !== "string" || label.length > 100)) {
        errors.push(`${path}.label 必须是不超过 100 字的字符串`);
      }
      optionalText(raw, "text", path, errors);
      optionalMentions(raw, path, catIds, errors);
      optionalDelay(raw, path, errors);
      return;
    }
    default:
      errors.push(`${path}.kind 未知（应为 message/handoff/artifact/review/decision/memory）`);
  }
}

function validateMemory(raw: unknown, path: string, errors: string[]): void {
  if (!isObject(raw)) {
    errors.push(`${path} 必须是对象`);
    return;
  }
  requireEnum(raw, "kind", MEMORY_KINDS, path, errors);
  requireText(raw, "title", path, 1, 120, errors);
  requireText(raw, "body", path, 1, 1000, errors);
  const tags = raw["tags"];
  if (!Array.isArray(tags) || tags.length > 10) {
    errors.push(`${path}.tags 必须是数组（≤10 个）`);
  } else {
    tags.forEach((tag, i) => {
      if (typeof tag !== "string" || tag.length < 1 || tag.length > 24) {
        errors.push(`${path}.tags[${i}] 必须是 1–24 字的字符串`);
      }
    });
  }
}

function requireText(
  raw: Record<string, unknown>,
  field: string,
  path: string,
  min: number,
  max: number,
  errors: string[],
): void {
  const value = raw[field];
  if (typeof value !== "string" || value.length < min || value.length > max) {
    errors.push(`${path}.${field} 必须是 ${min}–${max} 字的字符串`);
  }
}

function optionalText(
  raw: Record<string, unknown>,
  field: string,
  path: string,
  errors: string[],
): void {
  const value = raw[field];
  if (value !== undefined && (typeof value !== "string" || value.length > 500)) {
    errors.push(`${path}.${field} 必须是不超过 500 字的字符串`);
  }
}

function requireEnum(
  raw: Record<string, unknown>,
  field: string,
  allowed: readonly string[],
  path: string,
  errors: string[],
): void {
  const value = raw[field];
  if (typeof value !== "string" || !allowed.includes(value)) {
    errors.push(`${path}.${field} 必须是 ${allowed.join(" / ")} 之一`);
  }
}

function optionalMentions(
  raw: Record<string, unknown>,
  path: string,
  catIds: string[],
  errors: string[],
): void {
  const mentions = raw["mentions"];
  if (mentions === undefined) return;
  if (!Array.isArray(mentions)) {
    errors.push(`${path}.mentions 必须是数组`);
    return;
  }
  mentions.forEach((mention, i) => {
    if (typeof mention !== "string" || !catIds.includes(mention)) {
      errors.push(`${path}.mentions[${i}] 必须是现有猫的 id`);
    }
  });
}

function optionalDelay(
  raw: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  const delay = raw["delayMs"];
  if (delay === undefined) return;
  if (typeof delay !== "number" || !Number.isFinite(delay) || delay < 0 || delay > 20000) {
    errors.push(`${path}.delayMs 必须是 0–20000 的数字`);
  }
}

function validateToolInput(
  raw: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  const tool = raw["tool"];
  if (typeof tool !== "string" || !TOOLS.includes(tool as (typeof TOOLS)[number])) {
    errors.push(`${path}.tool 必须是 ${TOOLS.join(" / ")} 之一`);
    return;
  }
  const input = raw["input"];
  if (!isObject(input)) {
    errors.push(`${path}.input 必须是对象`);
    return;
  }
  const inputPath = `${path}.input`;
  switch (tool) {
    case "read_file":
      requireText(input, "path", inputPath, 1, 200, errors);
      return;
    case "write_file": {
      requireText(input, "path", inputPath, 1, 200, errors);
      const content = input["content"];
      if (typeof content !== "string" || content.length > 20000) {
        errors.push(`${inputPath}.content 必须是不超过 20000 字的字符串`);
      }
      return;
    }
    case "list_files":
      return;
    case "run_command": {
      const cmd = input["cmd"];
      if (typeof cmd !== "string" || !COMMANDS.includes(cmd as (typeof COMMANDS)[number])) {
        errors.push(`${inputPath}.cmd 必须是 ${COMMANDS.join(" / ")} 之一`);
        return;
      }
      const args = input["args"];
      if (args === undefined) return;
      if (!Array.isArray(args) || args.length > 10) {
        errors.push(`${inputPath}.args 必须是最多 10 个字符串的数组`);
        return;
      }
      args.forEach((arg, i) => {
        if (typeof arg !== "string" || arg.length > 80 || arg.includes("..")) {
          errors.push(`${inputPath}.args[${i}] 必须是不超过 80 字且不含 .. 的字符串`);
        }
      });
      return;
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
