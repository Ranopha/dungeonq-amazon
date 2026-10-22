import { createHash } from "node:crypto";

import { z } from "zod";

/*
 * DungeonQ 處置動作政策 v1（DQ-HANDOFF-015 M4）。
 *
 * 這是處置連接器與主機腳本唯一可用的處置判定點：
 * - A 級動作（不影響合法功能）在上限內才 ALLOW，且固定附帶四項健康／回復義務。
 * - B 級動作（需要停機或影響功能）一律 REQUIRE_APPROVAL，只產生工單。
 * - 其他情況 DENY；超過上限、自動處置已停止或合法使用者不健康時另附「升級給人」。
 *
 * 判定是純函式：時間由輸入的 evaluatedAt 提供，不讀時鐘、不讀檔、不連網。
 * 對象只能用 targetId 從登錄表解析；模型輸出、請求欄位或信件內容不能新增動作或對象。
 * 契約：docs/contracts/dungeonq-response-action-policy-v1.md；ADR：docs/adr/ADR-DQ-015-response-action-policy.md。
 */

export const DUNGEONQ_RESPONSE_ACTION_POLICY_VERSION = "dungeonq-response-action/v1";

const DIGEST_DOMAIN = {
  catalog: "dungeonq-response-action-catalog/v1",
  registry: "dungeonq-response-target-registry/v1",
  input: "dungeonq-response-action-input/v1",
  decision: "dungeonq-response-action-decision/v1"
} as const;

export const dungeonqResponseSignalKindSchema = z.enum([
  "WRONG_TICKET_USED",
  "WRONG_TICKET_SPREAD",
  "REAL_ASSET_REQUESTED",
  "ACK_TIMEOUT"
]);

export const dungeonqResponseTargetKindSchema = z.enum([
  "FLAGGED_CONTEXT",
  "FLAGGED_SOURCE",
  "FLAGGED_PERMISSION_GRANT",
  "CREDENTIAL",
  "ROUTE",
  "ACCOUNT",
  "SERVICE_SECRET",
  "HOST",
  "NETWORK_SEGMENT",
  "DEPLOYMENT_CONFIG"
]);

export type DungeonqResponseSignalKind = z.infer<typeof dungeonqResponseSignalKindSchema>;
export type DungeonqResponseTargetKind = z.infer<typeof dungeonqResponseTargetKindSchema>;
export type DungeonqResponseActionClass = "A" | "B";

/** 只屬於單一事件的對象；登錄時必須綁定事件編號，不能被其他事件拿來處置。 */
const incidentBoundTargetKinds: ReadonlySet<DungeonqResponseTargetKind> = new Set([
  "FLAGGED_CONTEXT",
  "FLAGGED_SOURCE",
  "FLAGGED_PERMISSION_GRANT"
]);

export type DungeonqResponseActionCatalogEntry = {
  readonly code: string;
  readonly actionClass: DungeonqResponseActionClass;
  readonly name: string;
  readonly targetKinds: readonly DungeonqResponseTargetKind[];
  readonly limits: {
    /** 同一事件最多執行（含嘗試後回復）的次數；null 表示不以事件計數。 */
    readonly perIncident: number | null;
    /** 同一事件同一資產最多次數；null 表示不以資產計數。 */
    readonly perIncidentPerAsset: number | null;
    /** 設定最長有效秒數；null 表示動作不帶有效期。 */
    readonly maxDurationSeconds: number | null;
  };
  /** 由政策固定、請求不能改的參數。 */
  readonly fixedParameters: {
    readonly overlapSeconds: number | null;
  };
  /** 是否為 ACK 逾時預設安全動作（D6）。 */
  readonly ackTimeoutDefault: boolean;
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/**
 * 版本化動作目錄、上限與健康門檻（D3、D6、D7、D8）。
 * 任何數值變更都必須升版 DUNGEONQ_RESPONSE_ACTION_POLICY_VERSION，目錄摘要會隨之改變。
 */
export const DUNGEONQ_RESPONSE_ACTION_CATALOG = deepFreeze({
  version: DUNGEONQ_RESPONSE_ACTION_POLICY_VERSION,
  global: {
    /** 全域（跨事件）在最近 windowSeconds 內最多可執行的 A 級自動動作數。 */
    maxAutomaticActionsPerWindow: 10,
    windowSeconds: 3600
  },
  health: {
    /** 成功率不得低於基線減 0.5 個百分點。 */
    maxSuccessRateDrop: 0.005,
    /** p95 延遲增加不得超過 200 毫秒或基線 20%，取較大者。 */
    maxP95IncreaseMs: 200,
    maxP95IncreaseRatio: 0.2,
    probeIntervalSeconds: 1,
    /** 以下三項是 v1 的設計預設：樣本太少、太舊或時間在未來時，健康狀態視為 UNKNOWN。 */
    minSamples: 5,
    maxAgeSeconds: 30,
    maxFutureSkewSeconds: 5
  },
  actions: [
    {
      code: "A-1",
      actionClass: "A",
      name: "FENCE_CONTEXT",
      targetKinds: ["FLAGGED_CONTEXT"],
      limits: { perIncident: 1, perIncidentPerAsset: null, maxDurationSeconds: null },
      fixedParameters: { overlapSeconds: null },
      ackTimeoutDefault: true
    },
    {
      code: "A-2",
      actionClass: "A",
      name: "ROTATE_CREDENTIAL_WITH_OVERLAP",
      targetKinds: ["CREDENTIAL"],
      limits: { perIncident: null, perIncidentPerAsset: 1, maxDurationSeconds: null },
      fixedParameters: { overlapSeconds: 300 },
      ackTimeoutDefault: false
    },
    {
      code: "A-3",
      actionClass: "A",
      name: "REROUTE_FLAGGED_PATH",
      targetKinds: ["ROUTE"],
      limits: { perIncident: 3, perIncidentPerAsset: null, maxDurationSeconds: null },
      fixedParameters: { overlapSeconds: null },
      ackTimeoutDefault: false
    },
    {
      code: "A-4",
      actionClass: "A",
      name: "NARROW_FLAGGED_PERMISSION",
      targetKinds: ["FLAGGED_PERMISSION_GRANT"],
      limits: { perIncident: 3, perIncidentPerAsset: null, maxDurationSeconds: null },
      fixedParameters: { overlapSeconds: null },
      ackTimeoutDefault: false
    },
    {
      code: "A-5",
      actionClass: "A",
      name: "RATE_LIMIT_FLAGGED",
      targetKinds: ["FLAGGED_CONTEXT", "FLAGGED_SOURCE"],
      limits: { perIncident: 1, perIncidentPerAsset: null, maxDurationSeconds: 86_400 },
      fixedParameters: { overlapSeconds: null },
      ackTimeoutDefault: true
    },
    {
      code: "B-1",
      actionClass: "B",
      name: "DISABLE_ACCOUNT",
      targetKinds: ["ACCOUNT"],
      limits: { perIncident: null, perIncidentPerAsset: null, maxDurationSeconds: null },
      fixedParameters: { overlapSeconds: null },
      ackTimeoutDefault: false
    },
    {
      code: "B-2",
      actionClass: "B",
      name: "ROTATE_PRIMARY_SECRET",
      targetKinds: ["SERVICE_SECRET"],
      limits: { perIncident: null, perIncidentPerAsset: null, maxDurationSeconds: null },
      fixedParameters: { overlapSeconds: null },
      ackTimeoutDefault: false
    },
    {
      code: "B-3",
      actionClass: "B",
      name: "REBUILD_HOST",
      targetKinds: ["HOST"],
      limits: { perIncident: null, perIncidentPerAsset: null, maxDurationSeconds: null },
      fixedParameters: { overlapSeconds: null },
      ackTimeoutDefault: false
    },
    {
      code: "B-4",
      actionClass: "B",
      name: "ISOLATE_NETWORK_SEGMENT",
      targetKinds: ["NETWORK_SEGMENT"],
      limits: { perIncident: null, perIncidentPerAsset: null, maxDurationSeconds: null },
      fixedParameters: { overlapSeconds: null },
      ackTimeoutDefault: false
    },
    {
      code: "B-5",
      actionClass: "B",
      name: "REDEPLOY_CONFIGURATION",
      targetKinds: ["DEPLOYMENT_CONFIG"],
      limits: { perIncident: null, perIncidentPerAsset: null, maxDurationSeconds: null },
      fixedParameters: { overlapSeconds: null },
      ackTimeoutDefault: false
    }
  ] satisfies DungeonqResponseActionCatalogEntry[]
});

const catalogByCode: ReadonlyMap<string, DungeonqResponseActionCatalogEntry> = new Map(
  DUNGEONQ_RESPONSE_ACTION_CATALOG.actions.map((entry) => [entry.code, entry] as const)
);

/** 義務代號。連接器必須逐項履行；不認得的義務一律視為無法履行並停止。 */
export const DUNGEONQ_RESPONSE_OBLIGATIONS = deepFreeze({
  readbackHealthBefore: "readback_legitimate_health_before",
  readbackHealthAfter: "readback_legitimate_health_after",
  rollbackOnHealthFailure: "auto_rollback_on_health_failure",
  escalateAfterRollback: "escalate_to_human_after_rollback",
  freezeNewChanges: "freeze_new_changes",
  createWorkOrder: "create_work_order",
  escalateToHuman: "escalate_to_human",
  recordDenialAudit: "record_denial_audit"
} as const);

const allowObligations = [
  DUNGEONQ_RESPONSE_OBLIGATIONS.readbackHealthBefore,
  DUNGEONQ_RESPONSE_OBLIGATIONS.readbackHealthAfter,
  DUNGEONQ_RESPONSE_OBLIGATIONS.rollbackOnHealthFailure,
  DUNGEONQ_RESPONSE_OBLIGATIONS.escalateAfterRollback
] as const;

export const DUNGEONQ_RESPONSE_CLOSURE_REASON_AUTO_SAFE_DEFAULT = "AUTO_SAFE_DEFAULT";

const hex64Schema = z.string().regex(/^[a-f0-9]{64}$/u);
/** 識別字只允許無空白的代號，避免自由文字（例如信件內容）被當成對象或事件。 */
const identifierSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
const actionCodeInputSchema = z.string().min(1).max(64);
const rateSchema = z.number().min(0).max(1);
const latencySchema = z.number().finite().min(0);

export const dungeonqResponseTargetRegistrySchema = z.object({
  registryId: identifierSchema,
  registryVersion: identifierSchema,
  entries: z.array(z.object({
    targetId: identifierSchema,
    kind: dungeonqResponseTargetKindSchema,
    assetId: identifierSchema,
    boundIncidentId: identifierSchema.nullable()
  }).strict()).max(1000)
}).strict().superRefine((registry, context) => {
  const seen = new Set<string>();
  registry.entries.forEach((entry, index) => {
    if (seen.has(entry.targetId)) {
      context.addIssue({
        code: "custom",
        path: ["entries", index, "targetId"],
        message: "duplicate_target_id"
      });
    }
    seen.add(entry.targetId);
    if (incidentBoundTargetKinds.has(entry.kind) && entry.boundIncidentId === null) {
      context.addIssue({
        code: "custom",
        path: ["entries", index, "boundIncidentId"],
        message: "flagged_target_requires_incident_binding"
      });
    }
  });
});

export const dungeonqLegitimateHealthMeasurementSchema = z.object({
  measuredAt: z.string().datetime(),
  sampleCount: z.number().int().nonnegative(),
  baseline: z.object({ successRate: rateSchema, p95LatencyMs: latencySchema }).strict(),
  current: z.object({ successRate: rateSchema, p95LatencyMs: latencySchema }).strict()
}).strict();

export const dungeonqResponseActionPolicyInputSchema = z.object({
  policyVersion: z.string().min(1).max(100),
  traceId: identifierSchema,
  evaluatedAt: z.string().datetime(),
  incidentId: identifierSchema,
  signal: z.object({
    kind: dungeonqResponseSignalKindSchema,
    eventId: identifierSchema
  }).strict(),
  actionCode: actionCodeInputSchema,
  targetId: identifierSchema,
  parameters: z.object({
    rateLimitDurationSeconds: z.number().int().positive().nullable()
  }).strict(),
  targetRegistry: dungeonqResponseTargetRegistrySchema,
  /** 本事件已執行或已嘗試（含已回復）的 A 級動作。 */
  incidentExecutions: z.array(z.object({
    actionCode: actionCodeInputSchema,
    targetId: identifierSchema,
    assetId: identifierSchema
  }).strict()).max(500),
  /** 全域最近 60 分鐘已執行或已嘗試（含已回復）的 A 級自動動作數。 */
  globalAutomaticExecutionsLastHour: z.number().int().nonnegative(),
  /** 回復失敗後由連接器持久記錄的停止狀態（3.3 第 5 點）。 */
  incidentAutomationHalted: z.boolean(),
  legitimateHealth: dungeonqLegitimateHealthMeasurementSchema
}).strict();

export type DungeonqResponseTargetRegistry = z.infer<typeof dungeonqResponseTargetRegistrySchema>;
export type DungeonqLegitimateHealthMeasurement = z.infer<
  typeof dungeonqLegitimateHealthMeasurementSchema
>;
export type DungeonqResponseActionPolicyInput = z.infer<
  typeof dungeonqResponseActionPolicyInputSchema
>;

export const dungeonqLegitimateHealthStatusSchema = z.enum([
  "HEALTHY",
  "UNHEALTHY",
  "UNKNOWN",
  "NOT_EVALUATED"
]);

export const dungeonqResponseActionDecisionSchema = z.object({
  effect: z.enum(["ALLOW", "DENY", "REQUIRE_APPROVAL"]),
  policyVersion: z.string().min(1),
  catalogDigest: hex64Schema,
  reason: z.string().min(1),
  obligations: z.array(z.string().min(1)),
  traceId: z.string().min(1).nullable(),
  evaluatedAt: z.string().min(1).nullable(),
  incidentId: z.string().min(1).nullable(),
  signal: z.object({
    kind: dungeonqResponseSignalKindSchema,
    eventId: z.string().min(1)
  }).strict().nullable(),
  actionCode: z.string().min(1).nullable(),
  actionClass: z.enum(["A", "B"]).nullable(),
  target: z.object({
    targetId: z.string().min(1),
    kind: dungeonqResponseTargetKindSchema,
    assetId: z.string().min(1)
  }).strict().nullable(),
  registryDigest: hex64Schema.nullable(),
  parameters: z.object({
    overlapSeconds: z.number().int().positive().nullable(),
    rateLimitDurationSeconds: z.number().int().positive().nullable()
  }).strict(),
  closureReason: z.literal(DUNGEONQ_RESPONSE_CLOSURE_REASON_AUTO_SAFE_DEFAULT).nullable(),
  healthStatus: dungeonqLegitimateHealthStatusSchema,
  inputDigest: hex64Schema.nullable(),
  decisionDigest: hex64Schema
}).strict();

export type DungeonqResponseActionDecision = z.infer<typeof dungeonqResponseActionDecisionSchema>;
export type DungeonqResponseActionDecisionBody = Omit<DungeonqResponseActionDecision, "decisionDigest">;
export type DungeonqLegitimateHealthStatus = z.infer<typeof dungeonqLegitimateHealthStatusSchema>;

/** 鍵排序、無多餘空白的 JSON，供摘要計算；物件中值為 undefined 的鍵略過，其他非 JSON 值丟出錯誤。 */
function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonical_json_non_finite_number");
      return JSON.stringify(value);
    case "object": {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
        .join(",")}}`;
    }
    default:
      throw new TypeError(`canonical_json_unsupported_${typeof value}`);
  }
}

function domainDigest(domain: string, value: unknown): string {
  return createHash("sha256").update(`${domain}\n${canonicalJson(value)}`).digest("hex");
}

export const DUNGEONQ_RESPONSE_ACTION_CATALOG_DIGEST = domainDigest(
  DIGEST_DOMAIN.catalog,
  DUNGEONQ_RESPONSE_ACTION_CATALOG
);

/** 計算決策摘要。只給政策本身與驗證使用；連接器應呼叫驗證函式，不自行計算。 */
export function computeDungeonqResponseActionDecisionDigest(
  body: DungeonqResponseActionDecisionBody
): string {
  return domainDigest(DIGEST_DOMAIN.decision, body);
}

export function computeDungeonqResponseTargetRegistryDigest(
  registry: DungeonqResponseTargetRegistry
): string {
  return domainDigest(DIGEST_DOMAIN.registry, registry);
}

/**
 * 依 D7 門檻判斷合法使用者健康。M5 的執行後健康讀回也必須用這個函式，
 * 確保執行前與執行後使用同一組門檻。
 */
export function evaluateDungeonqLegitimateHealth(
  rawMeasurement: DungeonqLegitimateHealthMeasurement,
  evaluatedAt: string
): { status: Exclude<DungeonqLegitimateHealthStatus, "NOT_EVALUATED">; reason: string } {
  const parsed = dungeonqLegitimateHealthMeasurementSchema.safeParse(rawMeasurement);
  if (!parsed.success) return { status: "UNKNOWN", reason: "health_measurement_invalid" };
  const measurement = parsed.data;
  const thresholds = DUNGEONQ_RESPONSE_ACTION_CATALOG.health;
  const ageMs = Date.parse(evaluatedAt) - Date.parse(measurement.measuredAt);
  if (!Number.isFinite(ageMs)) return { status: "UNKNOWN", reason: "health_timestamp_invalid" };
  if (ageMs < -thresholds.maxFutureSkewSeconds * 1000) {
    return { status: "UNKNOWN", reason: "health_measured_in_future" };
  }
  if (ageMs > thresholds.maxAgeSeconds * 1000) {
    return { status: "UNKNOWN", reason: "health_measurement_stale" };
  }
  if (measurement.sampleCount < thresholds.minSamples) {
    return { status: "UNKNOWN", reason: "health_insufficient_samples" };
  }
  const tolerance = 1e-9;
  const successRateFloor = measurement.baseline.successRate - thresholds.maxSuccessRateDrop;
  const successRateOk = measurement.current.successRate + tolerance >= successRateFloor;
  const allowedIncreaseMs = Math.max(
    thresholds.maxP95IncreaseMs,
    measurement.baseline.p95LatencyMs * thresholds.maxP95IncreaseRatio
  );
  const latencyOk =
    measurement.current.p95LatencyMs - measurement.baseline.p95LatencyMs <= allowedIncreaseMs + tolerance;
  if (successRateOk && latencyOk) return { status: "HEALTHY", reason: "health_within_threshold" };
  const failures = [
    ...(successRateOk ? [] : ["success_rate_below_threshold"]),
    ...(latencyOk ? [] : ["p95_latency_above_threshold"])
  ];
  return { status: "UNHEALTHY", reason: failures.join(",") };
}

/**
 * 列出某個事件訊號可提出的 A 級候選動作（依目錄，不依請求內容）。
 * ACK 逾時只回 A-1、A-5（D6）。主機腳本用它挑候選，再逐一交給 evaluateDungeonqResponseAction 判定。
 */
export function listDungeonqAutomaticActionCandidates(
  signalKind: DungeonqResponseSignalKind
): readonly DungeonqResponseActionCatalogEntry[] {
  return DUNGEONQ_RESPONSE_ACTION_CATALOG.actions.filter((entry) =>
    entry.actionClass === "A" && (signalKind !== "ACK_TIMEOUT" || entry.ackTimeoutDefault)
  );
}

export function getDungeonqResponseActionCatalogEntry(
  actionCode: string
): DungeonqResponseActionCatalogEntry | null {
  return catalogByCode.get(actionCode) ?? null;
}

/** 處置動作政策判定。純函式；同一輸入永遠得到同一決策與摘要。 */
export function evaluateDungeonqResponseAction(rawInput: unknown): DungeonqResponseActionDecision {
  const parsed = dungeonqResponseActionPolicyInputSchema.safeParse(rawInput);
  const seal = (body: DungeonqResponseActionDecisionBody): DungeonqResponseActionDecision =>
    dungeonqResponseActionDecisionSchema.parse({
      ...body,
      decisionDigest: computeDungeonqResponseActionDecisionDigest(body)
    });
  const noParameters = { overlapSeconds: null, rateLimitDurationSeconds: null };
  if (!parsed.success) {
    return seal({
      effect: "DENY",
      policyVersion: DUNGEONQ_RESPONSE_ACTION_POLICY_VERSION,
      catalogDigest: DUNGEONQ_RESPONSE_ACTION_CATALOG_DIGEST,
      reason: "invalid_input",
      obligations: [DUNGEONQ_RESPONSE_OBLIGATIONS.recordDenialAudit],
      traceId: null,
      evaluatedAt: null,
      incidentId: null,
      signal: null,
      actionCode: null,
      actionClass: null,
      target: null,
      registryDigest: null,
      parameters: noParameters,
      closureReason: null,
      healthStatus: "NOT_EVALUATED",
      inputDigest: null
    });
  }

  const input = parsed.data;
  const entry = catalogByCode.get(input.actionCode) ?? null;
  const registeredTarget = input.targetRegistry.entries.find((candidate) =>
    candidate.targetId === input.targetId
    && (candidate.boundIncidentId === null || candidate.boundIncidentId === input.incidentId)
  ) ?? null;
  const target = registeredTarget === null
    ? null
    : { targetId: registeredTarget.targetId, kind: registeredTarget.kind, assetId: registeredTarget.assetId };
  const base = {
    policyVersion: DUNGEONQ_RESPONSE_ACTION_POLICY_VERSION,
    catalogDigest: DUNGEONQ_RESPONSE_ACTION_CATALOG_DIGEST,
    traceId: input.traceId,
    evaluatedAt: input.evaluatedAt,
    incidentId: input.incidentId,
    signal: input.signal,
    actionCode: input.actionCode,
    actionClass: entry?.actionClass ?? null,
    target,
    registryDigest: computeDungeonqResponseTargetRegistryDigest(input.targetRegistry),
    inputDigest: domainDigest(DIGEST_DOMAIN.input, input)
  };
  const deny = (
    reason: string,
    options: { escalate?: boolean; healthStatus?: DungeonqLegitimateHealthStatus } = {}
  ): DungeonqResponseActionDecision => seal({
    ...base,
    effect: "DENY",
    reason,
    obligations: options.escalate
      ? [DUNGEONQ_RESPONSE_OBLIGATIONS.recordDenialAudit, DUNGEONQ_RESPONSE_OBLIGATIONS.escalateToHuman]
      : [DUNGEONQ_RESPONSE_OBLIGATIONS.recordDenialAudit],
    parameters: noParameters,
    closureReason: null,
    healthStatus: options.healthStatus ?? "NOT_EVALUATED"
  });

  if (input.policyVersion !== DUNGEONQ_RESPONSE_ACTION_POLICY_VERSION) {
    return deny("policy_version_mismatch");
  }
  if (entry === null) return deny("unknown_action");
  if (target === null) return deny("target_not_registered");
  if (!entry.targetKinds.includes(target.kind)) return deny("target_kind_mismatch");

  const requestedDuration = input.parameters.rateLimitDurationSeconds;
  if (entry.limits.maxDurationSeconds === null && requestedDuration !== null) {
    return deny("parameter_not_allowed:rateLimitDurationSeconds");
  }

  if (entry.actionClass === "B") {
    return seal({
      ...base,
      effect: "REQUIRE_APPROVAL",
      reason: "b_class_requires_human_work_order",
      obligations: [DUNGEONQ_RESPONSE_OBLIGATIONS.createWorkOrder],
      parameters: noParameters,
      closureReason: null,
      healthStatus: "NOT_EVALUATED"
    });
  }

  if (input.incidentAutomationHalted) {
    return deny("automation_halted_after_rollback_failure", { escalate: true });
  }
  const isAckTimeout = input.signal.kind === "ACK_TIMEOUT";
  if (isAckTimeout && !entry.ackTimeoutDefault) {
    return deny("not_eligible_for_ack_timeout_default");
  }
  if (entry.limits.maxDurationSeconds !== null) {
    if (requestedDuration === null) return deny("parameter_required:rateLimitDurationSeconds");
    if (requestedDuration > entry.limits.maxDurationSeconds) {
      return deny(`limit_exceeded:max_duration:${entry.code}`, { escalate: true });
    }
  }

  const sameAction = input.incidentExecutions.filter((execution) => execution.actionCode === entry.code);
  if (entry.limits.perIncident !== null && sameAction.length >= entry.limits.perIncident) {
    return deny(`limit_exceeded:per_incident:${entry.code}`, { escalate: true });
  }
  if (
    entry.limits.perIncidentPerAsset !== null
    && sameAction.filter((execution) => execution.assetId === target.assetId).length
      >= entry.limits.perIncidentPerAsset
  ) {
    return deny(`limit_exceeded:per_incident_asset:${entry.code}`, { escalate: true });
  }
  if (
    input.globalAutomaticExecutionsLastHour
      >= DUNGEONQ_RESPONSE_ACTION_CATALOG.global.maxAutomaticActionsPerWindow
  ) {
    return deny("limit_exceeded:global_hourly", { escalate: true });
  }

  const health = evaluateDungeonqLegitimateHealth(input.legitimateHealth, input.evaluatedAt);
  if (health.status !== "HEALTHY") {
    return deny(`legitimate_health_${health.status.toLowerCase()}:${health.reason}`, {
      escalate: true,
      healthStatus: health.status
    });
  }

  return seal({
    ...base,
    effect: "ALLOW",
    reason: isAckTimeout ? "ack_timeout_auto_safe_default" : "a_class_within_limits",
    obligations: isAckTimeout
      ? [...allowObligations, DUNGEONQ_RESPONSE_OBLIGATIONS.freezeNewChanges]
      : [...allowObligations],
    parameters: {
      overlapSeconds: entry.fixedParameters.overlapSeconds,
      rateLimitDurationSeconds: requestedDuration
    },
    closureReason: isAckTimeout ? DUNGEONQ_RESPONSE_CLOSURE_REASON_AUTO_SAFE_DEFAULT : null,
    healthStatus: health.status
  });
}

/** 連接器收到的處置請求；只用來比對，不能改變決策內容。 */
export type DungeonqResponseActionRequest = {
  incidentId: string;
  actionCode: string;
  targetId: string;
};

export type DungeonqResponseActionVerificationFailure =
  | "decision_malformed"
  | "policy_version_mismatch"
  | "catalog_digest_mismatch"
  | "decision_digest_mismatch"
  | "decision_not_derived_from_input"
  | "request_mismatch";

export type DungeonqResponseActionVerification =
  | { valid: true; decision: DungeonqResponseActionDecision }
  | { valid: false; reason: DungeonqResponseActionVerificationFailure };

/**
 * 驗證「這個請求真的有對應的政策決策」：
 * 1. 決策格式、政策版本與目錄摘要都是目前版本；
 * 2. 決策摘要與內容一致（被竄改即失敗）；
 * 3. 以同一份輸入重新判定，得到完全相同的決策摘要；
 * 4. 請求的事件、動作與對象和決策一致。
 */
export function verifyDungeonqResponseActionDecision(args: {
  decision: unknown;
  input: unknown;
  request: DungeonqResponseActionRequest;
}): DungeonqResponseActionVerification {
  const parsed = dungeonqResponseActionDecisionSchema.safeParse(args.decision);
  if (!parsed.success) return { valid: false, reason: "decision_malformed" };
  const decision = parsed.data;
  if (decision.policyVersion !== DUNGEONQ_RESPONSE_ACTION_POLICY_VERSION) {
    return { valid: false, reason: "policy_version_mismatch" };
  }
  if (decision.catalogDigest !== DUNGEONQ_RESPONSE_ACTION_CATALOG_DIGEST) {
    return { valid: false, reason: "catalog_digest_mismatch" };
  }
  const { decisionDigest, ...body } = decision;
  if (computeDungeonqResponseActionDecisionDigest(body) !== decisionDigest) {
    return { valid: false, reason: "decision_digest_mismatch" };
  }
  if (evaluateDungeonqResponseAction(args.input).decisionDigest !== decisionDigest) {
    return { valid: false, reason: "decision_not_derived_from_input" };
  }
  if (
    decision.incidentId !== args.request.incidentId
    || decision.actionCode !== args.request.actionCode
    || decision.target?.targetId !== args.request.targetId
  ) {
    return { valid: false, reason: "request_mismatch" };
  }
  return { valid: true, decision };
}

export type DungeonqResponseActionPurpose = "EXECUTE_A_CLASS" | "CREATE_WORK_ORDER";

export type DungeonqResponseActionAuthorization =
  | { authorized: true; decision: DungeonqResponseActionDecision }
  | {
    authorized: false;
    reason: DungeonqResponseActionVerificationFailure | "effect_not_permitted_for_purpose";
  };

/**
 * 連接器的入口：驗證決策後，確認效果符合用途。
 * - EXECUTE_A_CLASS：只接受 A 級 ALLOW。
 * - CREATE_WORK_ORDER：只接受 B 級 REQUIRE_APPROVAL。
 */
export function authorizeDungeonqResponseAction(args: {
  decision: unknown;
  input: unknown;
  request: DungeonqResponseActionRequest;
  purpose: DungeonqResponseActionPurpose;
}): DungeonqResponseActionAuthorization {
  const verification = verifyDungeonqResponseActionDecision(args);
  if (!verification.valid) return { authorized: false, reason: verification.reason };
  const { decision } = verification;
  const permitted = args.purpose === "EXECUTE_A_CLASS"
    ? decision.effect === "ALLOW" && decision.actionClass === "A"
    : decision.effect === "REQUIRE_APPROVAL" && decision.actionClass === "B";
  if (!permitted) return { authorized: false, reason: "effect_not_permitted_for_purpose" };
  return { authorized: true, decision };
}
