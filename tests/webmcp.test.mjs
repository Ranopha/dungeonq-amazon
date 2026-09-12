import assert from "node:assert/strict";
import test from "node:test";

import { createWebMcpAdapter, webMcpToolNamesForSnapshot } from "../public/src/webmcp.mjs";

test("WebMCP exposes only state-appropriate tools and never exposes an approval tool", () => {
  assert.deepEqual(webMcpToolNamesForSnapshot({ state: "VALIDATED" }), [
    "dungeonq_status",
    "dungeonq_scenario_admit",
    "dungeonq_simulate"
  ]);
  assert.deepEqual(
    webMcpToolNamesForSnapshot({
      state: "SIMULATED",
      simulation: { proposal: { executableAfterApproval: true } }
    }),
    ["dungeonq_status", "dungeonq_evidence_export", "dungeonq_approval_request"]
  );
  assert.deepEqual(webMcpToolNamesForSnapshot({ state: "APPROVAL_PENDING" }), [
    "dungeonq_status",
    "dungeonq_evidence_export"
  ]);
  assert.deepEqual(webMcpToolNamesForSnapshot({ state: "APPROVED" }), [
    "dungeonq_status",
    "dungeonq_evidence_export",
    "dungeonq_effect_apply"
  ]);
  assert.equal(
    webMcpToolNamesForSnapshot({ state: "APPROVED" }).some((name) => name.includes("approve")),
    false
  );
});

test("WebMCP adapter re-registers tools by state, bounds output, and cleans up registrations", async () => {
  const registrations = [];
  const modelContext = {
    registerTool(tool, options) {
      registrations.push({ tool, signal: options.signal });
    }
  };
  let snapshot = { state: "VALIDATED" };
  const adapter = createWebMcpAdapter({
    modelContext,
    getSnapshot: () => snapshot,
    handlers: {
      dungeonq_status: async () => ({ state: snapshot.state, padding: "x".repeat(4_000) }),
      dungeonq_scenario_admit: async () => ({ state: "VALIDATED", scenarioId: "syn-agent-pack-001" }),
      dungeonq_simulate: async () => ({ state: "SIMULATED" }),
      dungeonq_evidence_export: async () => ({ state: snapshot.state }),
      dungeonq_effect_apply: async () => ({ state: "APPLIED" })
    }
  });

  adapter.refresh();
  assert.deepEqual(
    registrations.slice(-3).map(({ tool }) => tool.name),
    ["dungeonq_status", "dungeonq_scenario_admit", "dungeonq_simulate"]
  );
  const admitTool = registrations.find(({ tool }) => tool.name === "dungeonq_scenario_admit").tool;
  assert.deepEqual(admitTool.inputSchema.required, ["scenarioPack"]);
  assert.equal(admitTool.inputSchema.properties.scenarioPack.type, "object");
  assert.equal(admitTool.inputSchema.additionalProperties, false);
  const firstSignal = registrations.at(-1).signal;
  const output = await registrations.at(-3).tool.execute({});
  assert.equal(typeof output, "string");
  assert.equal(output.length <= 1_800, true);

  snapshot = { state: "APPROVED" };
  adapter.refresh();
  assert.equal(firstSignal.aborted, true);
  assert.deepEqual(
    registrations.slice(-3).map(({ tool }) => tool.name),
    ["dungeonq_status", "dungeonq_evidence_export", "dungeonq_effect_apply"]
  );

  const lastSignal = registrations.at(-1).signal;
  adapter.dispose();
  assert.equal(lastSignal.aborted, true);
});

test("WebMCP registration failure degrades to zero tools without breaking the browser workflow", () => {
  const changes = [];
  const adapter = createWebMcpAdapter({
    modelContext: {
      registerTool() {
        throw new Error("unsupported experimental API");
      }
    },
    getSnapshot: () => ({ state: "VALIDATED" }),
    handlers: {},
    onRegistrationChange: (names) => changes.push([...names])
  });

  assert.doesNotThrow(() => adapter.refresh());
  assert.deepEqual(adapter.getActiveNames(), []);
  assert.deepEqual(changes.at(-1), []);
});
