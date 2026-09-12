export class ScenarioValidationError extends Error {
  constructor(issues) {
    super("SCENARIO_INVALID");
    this.name = "ScenarioValidationError";
    this.code = "SCENARIO_INVALID";
    this.issues = issues;
  }
}

const TOP_LEVEL_FIELDS = new Set([
  "schemaVersion",
  "scenarioId",
  "title",
  "summary",
  "classification",
  "seed",
  "subject",
  "environment",
  "policy",
  "signals",
  "failures",
  "requestedEffect",
  "expected"
]);

const EXTERNAL_REFERENCE_PATTERN = /(?:\b[a-z][a-z0-9+.-]*:\/\/|(?:file|data|javascript):)/iu;
const LOCAL_PATH_PATTERN = /^(?:\/|~\/|[A-Za-z]:\\)/u;
const CREDENTIAL_LIKE_PATTERN = /(?:\bAKIA[0-9A-Z]{16}\b|\bgh[ps]_[A-Za-z0-9]{30,}\b|\bsk-[A-Za-z0-9_-]{24,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/u;
const ACTIVE_CONTENT_PATTERN = /(?:<\/?[a-z][^>]*>|javascript:)/iu;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const ASSET_FIELDS = new Set(["id", "kind", "criticality", "initialState"]);
const SUBJECT_FIELDS = new Set(["type", "id"]);
const ENVIRONMENT_FIELDS = new Set(["tenantId", "assets"]);
const POLICY_FIELDS = new Set([
  "policyId",
  "deceptionThreshold",
  "quarantineThreshold",
  "denyThreshold",
  "maxAutomatedScope",
  "budgetUnits",
  "approvalRequiredEffects"
]);
const SIGNAL_FIELDS = new Set([
  "id",
  "sourceId",
  "sourceClass",
  "independenceGroup",
  "kind",
  "confidence",
  "subjectId",
  "evidence"
]);
const REQUESTED_EFFECT_FIELDS = new Set(["type", "targetAssetId", "scope", "costUnits"]);
const EXPECTED_FIELDS = new Set([
  "route",
  "approvalRequired",
  "effectExecutable",
  "requiredInvariantIds"
]);
const SUBJECT_TYPES = new Set(["SESSION", "CREDENTIAL", "DEVICE", "ACCOUNT"]);
const ASSET_KINDS = new Set(["APPLICATION", "IDENTITY", "DATA_STORE", "EDGE_PEP", "STATION_SIMULATOR"]);
const CRITICALITIES = new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const INITIAL_STATES = new Set(["AVAILABLE", "ISOLATED", "CREDENTIAL_ACTIVE", "CONTEXT_REVOKED", "DECOY_READY"]);
const SOURCE_CLASSES = new Set([
  "CONTROLLED_HONEY",
  "IDENTITY_CONTROL",
  "EDGE_TELEMETRY",
  "ENDPOINT_TELEMETRY",
  "USER_REAUTH",
  "UNTRUSTED_MODEL"
]);
const SIGNAL_KINDS = new Set([
  "HONEY_CREDENTIAL_USED",
  "CREDENTIAL_REPLAY",
  "PRIVILEGE_PROBE",
  "ANOMALOUS_BEHAVIOR",
  "FRESH_REAUTH",
  "COUNTER_EVIDENCE"
]);
const FAILURE_TYPES = new Set([
  "CAMPAIGN_STORE_UNAVAILABLE",
  "EVIDENCE_AUTHORITY_UNAVAILABLE",
  "BUDGET_EXHAUSTED",
  "APPROVAL_UNAVAILABLE",
  "ROUTE_INDEX_STALE",
  "PEP_CONTEXT_MISSING",
  "STATION_DECOMMISSION_PENDING"
]);
const EFFECT_TYPES = new Set(["STATIC_DECOY", "ISOLATE_SESSION", "ROTATE_CREDENTIAL", "RELEASE_NEW_CONTEXT"]);
const ROUTES = new Set(["NO_ADDITIONAL_RESTRICTION", "ALLOW_DECEPTION", "QUARANTINE", "DENY"]);
const INVARIANT_IDS = new Set(Array.from({ length: 10 }, (_, index) => `DQ-INV-${String(index + 1).padStart(3, "0")}`));
const MAX_INPUT_BYTES = 131_072;
const FORBIDDEN_PROPERTY_NAMES = new Set(["__proto__", "prototype", "constructor"]);
const SYNTHETIC_ID_PATTERN = /^syn-[a-z0-9][a-z0-9._-]{0,59}$/u;

function inspectStructure(value, path, depth, issues, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || issues.length >= 20) return;
  if (seen.has(value)) {
    issues.push({ path, code: "CYCLIC_VALUE_FORBIDDEN" });
    return;
  }
  if (depth > 8) {
    issues.push({ path, code: "OBJECT_DEPTH_EXCEEDED" });
    return;
  }
  seen.add(value);
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      issues.push({ path, code: "OBJECT_PROTOTYPE_INVALID" });
    }
    const keys = Object.keys(value);
    if (keys.length > 32) issues.push({ path, code: "OBJECT_PROPERTY_LIMIT_EXCEEDED" });
    for (const key of keys.sort()) {
      if (FORBIDDEN_PROPERTY_NAMES.has(key)) {
        issues.push({ path: `${path}.${key}`, code: "PROPERTY_NAME_FORBIDDEN" });
      }
      inspectStructure(value[key], `${path}.${key}`, depth + 1, issues, seen);
    }
  } else {
    value.forEach((entry, index) => inspectStructure(entry, `${path}[${index}]`, depth + 1, issues, seen));
  }
  seen.delete(value);
}

function appendUnknownFields(value, allowedFields, path, issues) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const field of Object.keys(value).sort()) {
    if (!allowedFields.has(field)) issues.push({ path: `${path}.${field}`, code: "UNKNOWN_FIELD" });
  }
}

function appendStringBound(value, path, issues, maximum = 512) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    issues.push({ path, code: "STRING_LENGTH_INVALID" });
  }
}

function appendIntegerBound(value, path, issues, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    issues.push({ path, code: "INTEGER_OUT_OF_RANGE" });
  }
}

function appendArrayBound(value, path, issues, minimum, maximum) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    issues.push({ path, code: "ARRAY_LENGTH_INVALID" });
  }
}

function appendContentSafety(value, path, issues) {
  if (typeof value !== "string") return;
  if (EXTERNAL_REFERENCE_PATTERN.test(value)) {
    issues.push({ path, code: "EXTERNAL_REFERENCE_FORBIDDEN" });
  }
  if (LOCAL_PATH_PATTERN.test(value)) {
    issues.push({ path, code: "LOCAL_PATH_FORBIDDEN" });
  }
  if (CREDENTIAL_LIKE_PATTERN.test(value)) {
    issues.push({ path, code: "CREDENTIAL_LIKE_VALUE_FORBIDDEN" });
  }
  if (ACTIVE_CONTENT_PATTERN.test(value)) {
    issues.push({ path, code: "ACTIVE_CONTENT_FORBIDDEN" });
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    issues.push({ path, code: "CONTROL_CHARACTER_FORBIDDEN" });
  }
}

function appendSyntheticId(value, path, issues) {
  if (typeof value !== "string" || !SYNTHETIC_ID_PATTERN.test(value)) {
    issues.push({ path, code: "SYNTHETIC_ID_REQUIRED" });
  }
}

function appendDuplicateValues(values, path, issues) {
  if (!Array.isArray(values)) return;
  const seen = new Set();
  values.forEach((value, index) => {
    if (seen.has(value)) issues.push({ path: `${path}[${index}]`, code: "DUPLICATE_VALUE" });
    seen.add(value);
  });
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

export function parseScenarioPack(text) {
  if (typeof text !== "string") {
    throw new ScenarioValidationError([{ path: "$", code: "TEXT_REQUIRED" }]);
  }
  if (new TextEncoder().encode(text).byteLength > MAX_INPUT_BYTES) {
    throw new ScenarioValidationError([{ path: "$", code: "INPUT_TOO_LARGE" }]);
  }
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    throw new ScenarioValidationError([{ path: "$", code: "JSON_INVALID" }]);
  }
  return validateScenarioPack(input);
}

export function validateScenarioPack(input) {
  const issues = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    issues.push({ path: "$", code: "OBJECT_REQUIRED" });
  } else {
    inspectStructure(input, "$", 0, issues);
    if (input.schemaVersion !== "dungeonq.scenario/v1") {
      issues.push({ path: "$.schemaVersion", code: "VERSION_UNSUPPORTED" });
    }
    if (input.classification !== "SYNTHETIC_ONLY") {
      issues.push({ path: "$.classification", code: "SYNTHETIC_ONLY_REQUIRED" });
    }
    for (const field of Object.keys(input).sort()) {
      if (!TOP_LEVEL_FIELDS.has(field)) {
        issues.push({ path: `$.${field}`, code: "UNKNOWN_FIELD" });
      }
    }
    appendContentSafety(input.title, "$.title", issues);
    appendStringBound(input.title, "$.title", issues);
    appendContentSafety(input.summary, "$.summary", issues);
    appendStringBound(input.summary, "$.summary", issues, 1_024);
    appendContentSafety(input.seed, "$.seed", issues);
    appendStringBound(input.seed, "$.seed", issues);
    appendSyntheticId(input.scenarioId, "$.scenarioId", issues);
    appendSyntheticId(input.subject?.id, "$.subject.id", issues);
    appendUnknownFields(input.subject, SUBJECT_FIELDS, "$.subject", issues);
    if (!SUBJECT_TYPES.has(input.subject?.type)) {
      issues.push({ path: "$.subject.type", code: "ENUM_INVALID" });
    }
    appendSyntheticId(input.environment?.tenantId, "$.environment.tenantId", issues);
    appendUnknownFields(input.environment, ENVIRONMENT_FIELDS, "$.environment", issues);
    appendArrayBound(input.environment?.assets, "$.environment.assets", issues, 1, 32);
    if (Array.isArray(input.environment?.assets)) {
      const assetIds = new Set();
      input.environment.assets.forEach((asset, index) => {
        if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
          issues.push({ path: `$.environment.assets[${index}]`, code: "OBJECT_REQUIRED" });
          return;
        }
        for (const field of Object.keys(asset).sort()) {
          if (!ASSET_FIELDS.has(field)) {
            const path = `$.environment.assets[${index}].${field}`;
            issues.push({ path, code: "UNKNOWN_FIELD" });
            if (typeof asset[field] === "string" && EXTERNAL_REFERENCE_PATTERN.test(asset[field])) {
              issues.push({ path, code: "EXTERNAL_REFERENCE_FORBIDDEN" });
            }
          }
        }
        if (!ASSET_KINDS.has(asset.kind)) {
          issues.push({ path: `$.environment.assets[${index}].kind`, code: "ENUM_INVALID" });
        }
        if (!CRITICALITIES.has(asset.criticality)) {
          issues.push({ path: `$.environment.assets[${index}].criticality`, code: "ENUM_INVALID" });
        }
        if (!INITIAL_STATES.has(asset.initialState)) {
          issues.push({ path: `$.environment.assets[${index}].initialState`, code: "ENUM_INVALID" });
        }
        appendSyntheticId(asset.id, `$.environment.assets[${index}].id`, issues);
        if (assetIds.has(asset.id)) {
          issues.push({ path: `$.environment.assets[${index}].id`, code: "DUPLICATE_ID" });
        }
        assetIds.add(asset.id);
      });
    }
    for (const [field, value] of [
      ["deceptionThreshold", input.policy?.deceptionThreshold],
      ["quarantineThreshold", input.policy?.quarantineThreshold],
      ["denyThreshold", input.policy?.denyThreshold]
    ]) {
      appendIntegerBound(value, `$.policy.${field}`, issues, 0, 100);
    }
    appendIntegerBound(input.policy?.maxAutomatedScope, "$.policy.maxAutomatedScope", issues, 1, 32);
    appendIntegerBound(input.policy?.budgetUnits, "$.policy.budgetUnits", issues, 0, 10_000);
    appendSyntheticId(input.policy?.policyId, "$.policy.policyId", issues);
    appendArrayBound(input.policy?.approvalRequiredEffects, "$.policy.approvalRequiredEffects", issues, 0, 8);
    if (Array.isArray(input.policy?.approvalRequiredEffects)) {
      input.policy.approvalRequiredEffects.forEach((effect, index) => {
        if (!EFFECT_TYPES.has(effect)) {
          issues.push({ path: `$.policy.approvalRequiredEffects[${index}]`, code: "ENUM_INVALID" });
        }
      });
      appendDuplicateValues(input.policy.approvalRequiredEffects, "$.policy.approvalRequiredEffects", issues);
    }
    if (
      input.policy &&
      !(
        input.policy.deceptionThreshold < input.policy.quarantineThreshold &&
        input.policy.quarantineThreshold < input.policy.denyThreshold
      )
    ) {
      issues.push({ path: "$.policy", code: "THRESHOLD_ORDER_INVALID" });
    }
    appendUnknownFields(input.policy, POLICY_FIELDS, "$.policy", issues);
    appendArrayBound(input.signals, "$.signals", issues, 1, 50);
    if (Array.isArray(input.signals)) {
      const signalIds = new Set();
      input.signals.forEach((signal, index) => {
        if (!signal || typeof signal !== "object" || Array.isArray(signal)) {
          issues.push({ path: `$.signals[${index}]`, code: "OBJECT_REQUIRED" });
          return;
        }
        appendUnknownFields(signal, SIGNAL_FIELDS, `$.signals[${index}]`, issues);
        if (!SOURCE_CLASSES.has(signal.sourceClass)) {
          issues.push({ path: `$.signals[${index}].sourceClass`, code: "ENUM_INVALID" });
        }
        if (!SIGNAL_KINDS.has(signal.kind)) {
          issues.push({ path: `$.signals[${index}].kind`, code: "ENUM_INVALID" });
        }
        if (!Number.isInteger(signal.confidence) || signal.confidence < 0 || signal.confidence > 100) {
          issues.push({ path: `$.signals[${index}].confidence`, code: "INTEGER_OUT_OF_RANGE" });
        }
        appendSyntheticId(signal.id, `$.signals[${index}].id`, issues);
        appendSyntheticId(signal.sourceId, `$.signals[${index}].sourceId`, issues);
        appendSyntheticId(signal.independenceGroup, `$.signals[${index}].independenceGroup`, issues);
        if (signalIds.has(signal.id)) {
          issues.push({ path: `$.signals[${index}].id`, code: "DUPLICATE_ID" });
        }
        signalIds.add(signal.id);
        if (signal.subjectId !== input.subject?.id) {
          issues.push({ path: `$.signals[${index}].subjectId`, code: "SUBJECT_MISMATCH" });
        }
        appendContentSafety(signal.evidence, `$.signals[${index}].evidence`, issues);
        appendStringBound(signal.evidence, `$.signals[${index}].evidence`, issues, 1_024);
      });
    }
    appendArrayBound(input.failures, "$.failures", issues, 0, 16);
    if (Array.isArray(input.failures)) {
      input.failures.forEach((failure, index) => {
        if (!FAILURE_TYPES.has(failure)) issues.push({ path: `$.failures[${index}]`, code: "ENUM_INVALID" });
      });
      appendDuplicateValues(input.failures, "$.failures", issues);
    }
    appendUnknownFields(input.requestedEffect, REQUESTED_EFFECT_FIELDS, "$.requestedEffect", issues);
    if (!EFFECT_TYPES.has(input.requestedEffect?.type)) {
      issues.push({ path: "$.requestedEffect.type", code: "ENUM_INVALID" });
    }
    appendIntegerBound(input.requestedEffect?.scope, "$.requestedEffect.scope", issues, 1, 32);
    appendIntegerBound(input.requestedEffect?.costUnits, "$.requestedEffect.costUnits", issues, 0, 10_000);
    if (
      Number.isInteger(input.requestedEffect?.scope) &&
      Number.isInteger(input.policy?.maxAutomatedScope) &&
      input.requestedEffect.scope > input.policy.maxAutomatedScope
    ) {
      issues.push({ path: "$.requestedEffect.scope", code: "SCOPE_EXCEEDS_POLICY" });
    }
    if (
      Number.isInteger(input.requestedEffect?.costUnits) &&
      Number.isInteger(input.policy?.budgetUnits) &&
      input.requestedEffect.costUnits > input.policy.budgetUnits
    ) {
      issues.push({ path: "$.requestedEffect.costUnits", code: "BUDGET_EXCEEDED" });
    }
    if (
      typeof input.requestedEffect?.targetAssetId === "string" &&
      Array.isArray(input.environment?.assets) &&
      !input.environment.assets.some(
        (asset) => asset && typeof asset === "object" && asset.id === input.requestedEffect.targetAssetId
      )
    ) {
      issues.push({ path: "$.requestedEffect.targetAssetId", code: "TARGET_NOT_FOUND" });
    }
    appendUnknownFields(input.expected, EXPECTED_FIELDS, "$.expected", issues);
    if (!ROUTES.has(input.expected?.route)) {
      issues.push({ path: "$.expected.route", code: "ENUM_INVALID" });
    }
    if (typeof input.expected?.approvalRequired !== "boolean") {
      issues.push({ path: "$.expected.approvalRequired", code: "BOOLEAN_REQUIRED" });
    }
    if (typeof input.expected?.effectExecutable !== "boolean") {
      issues.push({ path: "$.expected.effectExecutable", code: "BOOLEAN_REQUIRED" });
    }
    appendArrayBound(input.expected?.requiredInvariantIds, "$.expected.requiredInvariantIds", issues, 0, 16);
    if (Array.isArray(input.expected?.requiredInvariantIds)) {
      input.expected.requiredInvariantIds.forEach((invariantId, index) => {
        if (!INVARIANT_IDS.has(invariantId)) {
          issues.push({ path: `$.expected.requiredInvariantIds[${index}]`, code: "ENUM_INVALID" });
        }
      });
      appendDuplicateValues(input.expected.requiredInvariantIds, "$.expected.requiredInvariantIds", issues);
    }
  }
  if (issues.length > 0) {
    throw new ScenarioValidationError(issues.slice(0, 20));
  }
  return deepFreeze(structuredClone(input));
}
