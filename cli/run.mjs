#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  LabSessionError,
  ScenarioValidationError,
  canonicalJson,
  createLabSession,
  parseScenarioPack
} from "../public/src/index.mjs";

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function fail(code, details = []) {
  process.stderr.write(`${JSON.stringify({ status: "failed", code, details })}\n`);
  process.exitCode = 2;
}

async function main() {
  const scenarioArgument = optionValue("--scenario");
  if (!scenarioArgument || /^(?:https?:|file:)/u.test(scenarioArgument)) {
    fail("SCENARIO_PATH_REQUIRED");
    return;
  }
  const text = await readFile(resolve(process.cwd(), scenarioArgument), "utf8");
  const scenario = parseScenarioPack(text);
  const session = await createLabSession(scenario);
  const simulation = await session.simulate({ actorId: "syn-cli-runner-001", actorType: "SYSTEM" });

  if (process.argv.includes("--lifecycle") || process.argv.includes("--rollback")) {
    if (!simulation.proposal.executableAfterApproval) {
      throw new LabSessionError("EFFECT_BLOCKED");
    }
    await session.requestApproval({ actorId: "syn-cli-agent-001", actorType: "AGENT" });
    await session.approve({
      actorId: "syn-cli-reviewer-001",
      actorType: "HUMAN",
      proposalDigest: simulation.proposal.digest,
      revision: simulation.proposal.revision
    });
    const applied = await session.apply({
      actorId: "syn-cli-broker-001",
      actorType: "SYSTEM",
      proposalDigest: simulation.proposal.digest,
      revision: simulation.proposal.revision,
      idempotencyKey: "syn-cli-apply-001"
    });
    await session.verify({ receipt: applied.receipt });
    if (process.argv.includes("--rollback")) {
      await session.rollback({
        actorId: "syn-cli-recovery-001",
        actorType: "HUMAN",
        idempotencyKey: "syn-cli-rollback-001"
      });
    }
  }

  const bundle = await session.exportEvidence();
  process.stdout.write(`${canonicalJson(bundle)}\n`);
  if (!bundle.assertionsPassed) process.exitCode = 3;
}

main().catch((error) => {
  if (error instanceof ScenarioValidationError) {
    fail(error.code, error.issues);
    return;
  }
  if (error instanceof LabSessionError) {
    fail(error.code);
    return;
  }
  if (error instanceof SyntaxError) {
    fail("SCENARIO_JSON_INVALID");
    return;
  }
  fail("SIMULATION_FAILED");
});
