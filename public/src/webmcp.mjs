import { canonicalJson } from "./canonical.mjs";

const MAX_TOOL_OUTPUT_CHARS = 1_800;

const SCENARIO_PACK_INPUT_SCHEMA = Object.freeze({
  type: "object",
  description:
    "A complete SYNTHETIC_ONLY dungeonq.scenario/v1 object. Runtime admission enforces the 128 KiB, depth, field, content, and synthetic-ID bounds.",
  properties: Object.freeze({
    schemaVersion: Object.freeze({ type: "string", const: "dungeonq.scenario/v1" }),
    scenarioId: Object.freeze({ type: "string", pattern: "^syn-[a-z0-9][a-z0-9._-]{0,59}$" }),
    title: Object.freeze({ type: "string" }),
    summary: Object.freeze({ type: "string" }),
    classification: Object.freeze({ type: "string", const: "SYNTHETIC_ONLY" }),
    seed: Object.freeze({ type: "string" }),
    subject: Object.freeze({ type: "object" }),
    environment: Object.freeze({ type: "object" }),
    policy: Object.freeze({ type: "object" }),
    signals: Object.freeze({ type: "array" }),
    failures: Object.freeze({ type: "array" }),
    requestedEffect: Object.freeze({ type: "object" }),
    expected: Object.freeze({ type: "object" })
  }),
  required: Object.freeze([
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
  ]),
  additionalProperties: false
});

const TOOL_DEFINITIONS = Object.freeze({
  dungeonq_status: Object.freeze({
    name: "dungeonq_status",
    description: "Read the current synthetic lab state and available governed actions.",
    inputSchema: Object.freeze({ type: "object", properties: Object.freeze({}), additionalProperties: false }),
    annotations: Object.freeze({ readOnlyHint: true, untrustedContentHint: true })
  }),
  dungeonq_scenario_admit: Object.freeze({
    name: "dungeonq_scenario_admit",
    description:
      "Admit a complete judge-authored synthetic dungeon through DungeonQ's strict validator. Available only before simulation; never grants human approval.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({ scenarioPack: SCENARIO_PACK_INPUT_SCHEMA }),
      required: Object.freeze(["scenarioPack"]),
      additionalProperties: false
    }),
    annotations: Object.freeze({ readOnlyHint: false, untrustedContentHint: true })
  }),
  dungeonq_simulate: Object.freeze({
    name: "dungeonq_simulate",
    description: "Run the already-loaded synthetic scenario through the deterministic engine.",
    inputSchema: Object.freeze({ type: "object", properties: Object.freeze({}), additionalProperties: false }),
    annotations: Object.freeze({ readOnlyHint: true, untrustedContentHint: true })
  }),
  dungeonq_approval_request: Object.freeze({
    name: "dungeonq_approval_request",
    description: "Request human review for the current proposal. This tool cannot grant approval.",
    inputSchema: Object.freeze({ type: "object", properties: Object.freeze({}), additionalProperties: false }),
    annotations: Object.freeze({ readOnlyHint: false, untrustedContentHint: true })
  }),
  dungeonq_effect_apply: Object.freeze({
    name: "dungeonq_effect_apply",
    description: "Apply the approved effect to browser-local synthetic state only.",
    inputSchema: Object.freeze({ type: "object", properties: Object.freeze({}), additionalProperties: false }),
    annotations: Object.freeze({ readOnlyHint: false, untrustedContentHint: true })
  }),
  dungeonq_receipt_verify: Object.freeze({
    name: "dungeonq_receipt_verify",
    description: "Verify the latest synthetic receipt against its protected digest.",
    inputSchema: Object.freeze({ type: "object", properties: Object.freeze({}), additionalProperties: false }),
    annotations: Object.freeze({ readOnlyHint: true, untrustedContentHint: true })
  }),
  dungeonq_effect_rollback: Object.freeze({
    name: "dungeonq_effect_rollback",
    description: "Append a compensation receipt and restore browser-local synthetic state.",
    inputSchema: Object.freeze({ type: "object", properties: Object.freeze({}), additionalProperties: false }),
    annotations: Object.freeze({ readOnlyHint: false, untrustedContentHint: true })
  }),
  dungeonq_evidence_export: Object.freeze({
    name: "dungeonq_evidence_export",
    description: "Return a bounded summary of the current deterministic evidence bundle.",
    inputSchema: Object.freeze({ type: "object", properties: Object.freeze({}), additionalProperties: false }),
    annotations: Object.freeze({ readOnlyHint: true, untrustedContentHint: true })
  })
});

function boundedOutput(value) {
  const serialized = canonicalJson(value);
  if (serialized.length <= MAX_TOOL_OUTPUT_CHARS) return serialized;
  return canonicalJson({
    status: "truncated",
    reason: "WEBMCP_OUTPUT_BOUND",
    preview: serialized.slice(0, 1_600),
    originalLength: serialized.length
  }).slice(0, MAX_TOOL_OUTPUT_CHARS);
}

export function webMcpToolNamesForSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return Object.freeze([]);
  switch (snapshot.state) {
    case "VALIDATED":
      return Object.freeze(["dungeonq_status", "dungeonq_scenario_admit", "dungeonq_simulate"]);
    case "SIMULATED":
      return Object.freeze([
        "dungeonq_status",
        "dungeonq_evidence_export",
        ...(snapshot.simulation?.proposal?.executableAfterApproval ? ["dungeonq_approval_request"] : [])
      ]);
    case "APPROVAL_PENDING":
      return Object.freeze(["dungeonq_status", "dungeonq_evidence_export"]);
    case "APPROVED":
      return Object.freeze(["dungeonq_status", "dungeonq_evidence_export", "dungeonq_effect_apply"]);
    case "APPLIED":
      return Object.freeze([
        "dungeonq_status",
        "dungeonq_evidence_export",
        "dungeonq_receipt_verify",
        "dungeonq_effect_rollback"
      ]);
    case "VERIFIED":
      return Object.freeze(["dungeonq_status", "dungeonq_evidence_export", "dungeonq_effect_rollback"]);
    case "ROLLED_BACK":
      return Object.freeze(["dungeonq_status", "dungeonq_evidence_export"]);
    default:
      return Object.freeze([]);
  }
}

export function createWebMcpAdapter({ modelContext, getSnapshot, handlers, onRegistrationChange = () => {} }) {
  let controller = null;
  let activeNames = Object.freeze([]);
  const supported = Boolean(modelContext && typeof modelContext.registerTool === "function");

  function dispose() {
    controller?.abort();
    controller = null;
    activeNames = Object.freeze([]);
    onRegistrationChange(activeNames);
  }

  function refresh() {
    dispose();
    if (!supported) return activeNames;
    controller = new AbortController();
    activeNames = webMcpToolNamesForSnapshot(getSnapshot());
    try {
      for (const name of activeNames) {
        const definition = TOOL_DEFINITIONS[name];
        modelContext.registerTool(
          {
            ...definition,
            execute: async (input) => {
              try {
                const handler = handlers[name];
                if (typeof handler !== "function") {
                  return boundedOutput({ status: "failed", code: "TOOL_UNAVAILABLE" });
                }
                return boundedOutput(await handler(input));
              } catch (error) {
                return boundedOutput({
                  status: "failed",
                  code: typeof error?.code === "string" ? error.code : "TOOL_EXECUTION_FAILED"
                });
              }
            }
          },
          { signal: controller.signal }
        );
      }
    } catch {
      controller.abort();
      controller = null;
      activeNames = Object.freeze([]);
      onRegistrationChange(activeNames);
      return activeNames;
    }
    onRegistrationChange(activeNames);
    return activeNames;
  }

  return Object.freeze({ supported, refresh, dispose, getActiveNames: () => activeNames });
}
