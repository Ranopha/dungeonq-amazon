import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";

/*
 * DungeonQ 處置政策架構檢查（DQ-HANDOFF-015 M4）。
 *
 * 處置連接器（plugins/dungeonq-host-integration/src/response-actions*）與
 * scripts/dungeonq-host/ 底下的處置相關程式，不得自行用條件判斷決定處置動作，
 * 必須呼叫 @eva/policy 的處置動作政策。路徑不存在時規則直接通過。
 */

const connectorDirectory = "plugins/dungeonq-host-integration/src";
const connectorPrefix = "response-actions";
const hostScriptDirectory = "scripts/dungeonq-host";
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const testFilePattern = /(?:\.|-)(?:test|spec)\.[cm]?[jt]sx?$/u;

/** 主機腳本以檔名判定為處置相關。 */
const responseScriptNamePattern =
  /^(?:response-action|work-order|incident-close|auto-response|containment|remediation)/u;

/** 主機腳本以內容判定為處置相關：引用處置連接器、處置政策或動作代號。 */
const responseContentPattern =
  /response-actions|DungeonqResponseAction|DungeonqAutomaticActionCandidates|DUNGEONQ_RESPONSE_|["'`][AB]-\d+["'`]/u;

const policyGatePattern =
  /\b(?:evaluateDungeonqResponseAction|verifyDungeonqResponseActionDecision|authorizeDungeonqResponseAction)\s*\(/u;
const connectorGatePattern =
  /\b(?:verifyDungeonqResponseActionDecision|authorizeDungeonqResponseAction)\s*\(/u;

const actionCodeLiteralPattern = /["'`]([AB]-\d+)["'`]/gu;
const signalComparisonPattern =
  /(?:[!=]==?\s*|\bcase\s+)["'`](?:WRONG_TICKET_USED|WRONG_TICKET_SPREAD|REAL_ASSET_REQUESTED|ACK_TIMEOUT)["'`]|["'`](?:WRONG_TICKET_USED|WRONG_TICKET_SPREAD|REAL_ASSET_REQUESTED|ACK_TIMEOUT)["'`]\s*[!=]==?/u;
const fabricatedEffectPattern =
  /\beffect\s*(?::|=(?!=))\s*["'`](?:ALLOW|DENY|REQUIRE_APPROVAL)["'`]/u;
const healthThresholdPattern =
  /\b(?:successRate|p95LatencyMs)\b\s*(?<!=)[<>]=?|(?<![=<>])[<>]=?\s*[\w.?]*\b(?:successRate|p95LatencyMs)\b/u;

function isSourceFile(path) {
  return sourceExtensions.has(extname(path)) && !testFilePattern.test(basename(path));
}

async function walk(path) {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const absolute = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(absolute)));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

/** 檔案路徑使用 POSIX 分隔符的 Repository 相對路徑。 */
function toPosix(path) {
  return path.split(sep).join("/");
}

/**
 * 判斷檔案是否屬於本規則的檢查範圍。
 * @param {string} relativePath Repository 相對路徑。
 * @param {string} contents 檔案內容。
 * @returns {"connector" | "host-script" | null}
 */
export function classifyDungeonqResponseScope(relativePath, contents) {
  const path = toPosix(relativePath);
  if (!isSourceFile(path)) return null;
  if (path.startsWith(`${connectorDirectory}/`)) {
    const firstSegment = path.slice(connectorDirectory.length + 1).split("/")[0] ?? "";
    return firstSegment.startsWith(connectorPrefix) ? "connector" : null;
  }
  if (path.startsWith(`${hostScriptDirectory}/`)) {
    return responseScriptNamePattern.test(basename(path)) || responseContentPattern.test(contents)
      ? "host-script"
      : null;
  }
  return null;
}

/** 動作代號只允許作為「執行器對照表」的物件鍵，例如 `{ "A-1": fenceContext }`。 */
function hardCodedActionCodes(contents) {
  const found = [];
  for (const match of contents.matchAll(actionCodeLiteralPattern)) {
    const before = contents.slice(0, match.index);
    const after = contents.slice(match.index + match[0].length);
    const isDispatchKey = /[{,]\s*$/u.test(before) && /^\s*:/u.test(after);
    if (!isDispatchKey) found.push(match[1]);
  }
  return [...new Set(found)];
}

/**
 * 檢查單一檔案內容，回傳違規說明。
 * @param {string} relativePath Repository 相對路徑。
 * @param {string} contents 檔案內容。
 * @returns {string[]}
 */
export function findDungeonqResponsePolicyBypass(relativePath, contents) {
  const scope = classifyDungeonqResponseScope(relativePath, contents);
  if (scope === null) return [];
  const path = toPosix(relativePath);
  const violations = [];
  if (!policyGatePattern.test(contents)) {
    violations.push(`${path} decides DungeonQ response actions without calling the response action policy.`);
  } else if (scope === "connector" && !connectorGatePattern.test(contents)) {
    violations.push(`${path} is a response connector but does not verify the policy decision digest.`);
  }
  const literals = hardCodedActionCodes(contents);
  if (literals.length > 0) {
    violations.push(
      `${path} hard-codes response action codes (${literals.join(", ")}) outside an executor dispatch table; select actions from the policy catalog or decision.`
    );
  }
  if (signalComparisonPattern.test(contents)) {
    violations.push(`${path} branches on incident signals to choose a response action instead of asking the policy.`);
  }
  if (fabricatedEffectPattern.test(contents)) {
    violations.push(`${path} fabricates a policy effect instead of using an evaluated decision.`);
  }
  if (/\bcomputeDungeonqResponseActionDecisionDigest\s*\(/u.test(contents)) {
    violations.push(`${path} computes a decision digest locally instead of verifying the policy decision.`);
  }
  if (healthThresholdPattern.test(contents)) {
    violations.push(`${path} compares legitimate-user health thresholds outside the response action policy.`);
  }
  return violations;
}

/**
 * 掃描 Repository 內的處置連接器與主機處置腳本；目錄不存在時回傳空陣列。
 * @param {string} root Repository 根目錄。
 * @returns {Promise<string[]>}
 */
export async function collectDungeonqResponsePolicyViolations(root) {
  const violations = [];
  const candidates = [
    ...(await walk(join(root, connectorDirectory))),
    ...(await walk(join(root, hostScriptDirectory)))
  ];
  for (const file of candidates) {
    const relativePath = toPosix(relative(root, file));
    if (!isSourceFile(relativePath)) continue;
    const contents = await readFile(file, "utf8");
    violations.push(...findDungeonqResponsePolicyBypass(relativePath, contents));
  }
  return violations;
}
