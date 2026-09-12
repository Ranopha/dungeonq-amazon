import {
  LabSessionError,
  ScenarioValidationError,
  admitScenarioPack,
  canonicalJson,
  createWebMcpAdapter
} from "../src/index.mjs";

const element = (id) => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing UI element: ${id}`);
  return node;
};

const ui = Object.freeze({
  scenarioSelect: element("scenario-select"),
  scenarioEditor: element("scenario-editor"),
  scenarioFile: element("scenario-file"),
  scenarioStatus: element("scenario-status"),
  validationMessage: element("validation-message"),
  judgeQuickRun: element("judge-quick-run"),
  judgeGuide: element("judge-guide"),
  loadExample: element("load-example"),
  validateScenario: element("validate-scenario"),
  resetLab: element("reset-lab"),
  runtimeState: element("runtime-state"),
  webMcpStatus: element("webmcp-status"),
  riskOrbit: element("risk-orbit"),
  riskScore: element("risk-score"),
  routeResult: element("route-result"),
  decisionReason: element("decision-reason"),
  assertionScore: element("assertion-score"),
  assertionLabel: element("assertion-label"),
  inputDigest: element("input-digest"),
  adapterParity: element("adapter-parity"),
  adapterDigest: element("adapter-digest"),
  lifecycleTrack: element("lifecycle-track"),
  runSimulation: element("run-simulation"),
  requestApproval: element("request-approval"),
  humanApprove: element("human-approve"),
  applyEffect: element("apply-effect"),
  verifyReceipt: element("verify-receipt"),
  rollbackEffect: element("rollback-effect"),
  probeUnapprovedApply: element("probe-unapproved-apply"),
  probeTamperedReceipt: element("probe-tampered-receipt"),
  adversarialResult: element("adversarial-result"),
  failureCount: element("failure-count"),
  allowedCapabilities: element("allowed-capabilities"),
  blockedCapabilities: element("blocked-capabilities"),
  invariantScore: element("invariant-score"),
  invariantList: element("invariant-list"),
  auditTimeline: element("audit-timeline"),
  evidencePreview: element("evidence-preview"),
  exportEvidence: element("export-evidence")
});

const STATE_ORDER = Object.freeze([
  "SIMULATED",
  "APPROVAL_PENDING",
  "APPROVED",
  "APPLIED",
  "VERIFIED",
  "ROLLED_BACK"
]);

let session = null;
let currentScenario = null;
let lastEvidence = null;
let lastAdapterParity = null;
let editorDirty = false;
let busy = false;

function replaceList(target, items, decorate = () => {}) {
  target.replaceChildren();
  for (const item of items) {
    const listItem = document.createElement("li");
    listItem.textContent = item.label;
    decorate(listItem, item);
    target.append(listItem);
  }
}

function setMessage(message, tone = "neutral") {
  ui.validationMessage.textContent = message;
  ui.validationMessage.dataset.tone = tone;
}

function shortDigest(value) {
  if (typeof value !== "string" || value.length < 22) return value ?? "—";
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

function errorMessage(error) {
  if (error instanceof ScenarioValidationError) {
    const issues = error.issues.slice(0, 5).map((issue) => `${issue.path}: ${issue.code}`).join(" · ");
    return `${error.code} — ${issues}`;
  }
  if (error instanceof LabSessionError) return error.code;
  return "LAB_OPERATION_FAILED";
}

function snapshotSummary(snapshot) {
  return {
    status: "ok",
    claimBoundary: "SYNTHETIC_SIMULATION_ONLY",
    state: snapshot?.state ?? "NO_SCENARIO",
    scenarioId: snapshot?.scenarioId ?? null,
    route: snapshot?.simulation?.decision?.route ?? null,
    riskScore: snapshot?.simulation?.decision?.riskScore ?? null,
    proposalDigest: snapshot?.simulation?.proposal?.digest ?? null,
    receiptCount: snapshot?.receipts?.length ?? 0
  };
}

async function updateEvidence(snapshot) {
  if (!session || snapshot.state === "VALIDATED") {
    lastEvidence = null;
    ui.evidencePreview.textContent = "Evidence appears after the first simulation.";
    return;
  }
  lastEvidence = await session.exportEvidence();
  const preview = {
    bundleVersion: lastEvidence.bundleVersion,
    claimBoundary: lastEvidence.claimBoundary,
    scenarioId: lastEvidence.scenarioId,
    state: lastEvidence.state,
    route: lastEvidence.decision.route,
    riskScore: lastEvidence.decision.riskScore,
    assertionsPassed: lastEvidence.assertionsPassed,
    targetReadback: lastEvidence.targetReadback,
    receiptDigests: lastEvidence.receipts.map((receipt) => receipt.digest),
    auditHead: lastEvidence.audit.at(-1)?.digest ?? null,
    digest: lastEvidence.digest
  };
  ui.evidencePreview.textContent = JSON.stringify(preview, null, 2);
}

function updateLifecycle(state) {
  const currentIndex = STATE_ORDER.indexOf(state);
  for (const item of ui.lifecycleTrack.querySelectorAll("li")) {
    const itemIndex = STATE_ORDER.indexOf(item.dataset.state);
    delete item.dataset.progress;
    if (currentIndex === -1) continue;
    if (itemIndex < currentIndex) item.dataset.progress = "done";
    if (itemIndex === currentIndex) item.dataset.progress = state === "ROLLED_BACK" ? "done" : "current";
  }
}

function updateActions(snapshot) {
  const locked = busy || editorDirty;
  const executable = snapshot.simulation?.proposal?.executableAfterApproval === true;
  ui.judgeQuickRun.disabled = busy;
  ui.runSimulation.disabled = locked || snapshot.state !== "VALIDATED";
  ui.requestApproval.disabled = locked || snapshot.state !== "SIMULATED" || !executable;
  ui.humanApprove.disabled = locked || snapshot.state !== "APPROVAL_PENDING";
  ui.applyEffect.disabled = locked || snapshot.state !== "APPROVED";
  ui.verifyReceipt.disabled = locked || snapshot.state !== "APPLIED";
  ui.rollbackEffect.disabled = locked || !new Set(["APPLIED", "VERIFIED"]).has(snapshot.state);
  ui.probeUnapprovedApply.disabled = locked || snapshot.state !== "SIMULATED";
  ui.probeTamperedReceipt.disabled = locked || !new Set(["APPLIED", "VERIFIED"]).has(snapshot.state);
  ui.exportEvidence.disabled = locked || snapshot.state === "VALIDATED";
}

async function render() {
  const snapshot = session?.getSnapshot() ?? {
    state: "NO_SCENARIO",
    simulation: null,
    receipts: [],
    audit: []
  };
  const simulation = snapshot.simulation;

  ui.runtimeState.textContent = snapshot.state;
  ui.scenarioStatus.textContent = editorDirty ? "DIRTY" : snapshot.state === "NO_SCENARIO" ? "EMPTY" : "VALID";
  updateLifecycle(snapshot.state);
  updateActions(snapshot);

  if (simulation) {
    const risk = simulation.decision.riskScore;
    ui.riskScore.textContent = String(risk);
    ui.riskOrbit.style.setProperty("--risk", `${risk * 3.6}deg`);
    ui.riskOrbit.setAttribute("aria-label", `Risk score ${risk}`);
    ui.routeResult.textContent = simulation.decision.route;
    ui.decisionReason.textContent = simulation.decision.reasonCodes.join(" · ");
    const passed = simulation.assertionResults.filter((result) => result.passed).length;
    ui.assertionScore.textContent = `${passed}/${simulation.assertionResults.length}`;
    ui.assertionLabel.textContent = simulation.assertionsPassed ? "Expected behavior confirmed" : "Expected behavior mismatch";
    ui.inputDigest.textContent = shortDigest(simulation.inputDigest);
    ui.inputDigest.title = simulation.inputDigest;
    ui.failureCount.textContent = `${simulation.constraints.failures.length} failure${simulation.constraints.failures.length === 1 ? "" : "s"}`;
    replaceList(
      ui.allowedCapabilities,
      simulation.constraints.allowedCapabilities.map((label) => ({ label }))
    );
    replaceList(
      ui.blockedCapabilities,
      (simulation.constraints.blockedCapabilities.length ? simulation.constraints.blockedCapabilities : ["NONE"]).map(
        (label) => ({ label })
      )
    );
    const passedInvariants = simulation.invariantResults.filter((result) => result.passed).length;
    ui.invariantScore.textContent = `${passedInvariants}/${simulation.invariantResults.length}`;
    replaceList(
      ui.invariantList,
      simulation.invariantResults.map((result) => ({
        label: `${result.id} — ${result.detail}`,
        passed: result.passed
      })),
      (node, item) => {
        node.dataset.pass = String(item.passed);
      }
    );
  } else {
    ui.riskScore.textContent = "—";
    ui.riskOrbit.style.setProperty("--risk", "0deg");
    ui.riskOrbit.setAttribute("aria-label", "Risk score 0");
    ui.routeResult.textContent = "NOT RUN";
    ui.decisionReason.textContent = "Validate, then run the scenario.";
    ui.assertionScore.textContent = "—";
    ui.assertionLabel.textContent = "Awaiting run";
    ui.inputDigest.textContent = "—";
    ui.failureCount.textContent = "0 failures";
    replaceList(ui.allowedCapabilities, [{ label: "Run simulation to inspect" }]);
    replaceList(ui.blockedCapabilities, [{ label: "—" }]);
    ui.invariantScore.textContent = "—";
    replaceList(ui.invariantList, [{ label: "Awaiting deterministic evaluation" }]);
  }

  if (lastAdapterParity) {
    ui.adapterParity.textContent = lastAdapterParity.matched ? "UI = WEBMCP · MATCH" : "ADAPTER MISMATCH";
    ui.adapterParity.dataset.tone = lastAdapterParity.matched ? "success" : "error";
    ui.adapterDigest.textContent = `${shortDigest(lastAdapterParity.inputDigest)} · ${shortDigest(lastAdapterParity.proposalDigest)}`;
    ui.adapterDigest.title = `${lastAdapterParity.inputDigest} · ${lastAdapterParity.proposalDigest}`;
  } else {
    ui.adapterParity.textContent = "AWAITING RUN";
    delete ui.adapterParity.dataset.tone;
    ui.adapterDigest.textContent = "UI and WebMCP will replay the same pack independently.";
    ui.adapterDigest.removeAttribute("title");
  }

  replaceList(
    ui.auditTimeline,
    snapshot.audit.length
      ? snapshot.audit.map((entry) => ({
          label: `${String(entry.sequence).padStart(2, "0")}  ${entry.eventType}`,
          digest: entry.digest
        }))
      : [{ label: "No events yet.", digest: null }],
    (node, item) => {
      if (!item.digest) return;
      const digest = document.createElement("code");
      digest.textContent = shortDigest(item.digest);
      digest.title = item.digest;
      node.append(digest);
    }
  );

  await updateEvidence(snapshot);
  webMcpAdapter.refresh();
}

async function activateScenario(candidate) {
  const admitted = await admitScenarioPack(candidate);
  session = admitted.session;
  currentScenario = admitted.scenario;
  ui.scenarioEditor.value = `${JSON.stringify(admitted.scenario, null, 2)}\n`;
  lastEvidence = null;
  lastAdapterParity = null;
  editorDirty = false;
  ui.judgeGuide.textContent = "Runs Overlay → adapter parity → blocked apply → review request, then stops for a human.";
  delete ui.judgeGuide.dataset.tone;
  ui.adversarialResult.textContent = "Run a simulation to unlock a negative proof.";
  delete ui.adversarialResult.dataset.tone;
  await render();
  return admitted.scenario;
}

async function createSessionFromEditor() {
  const scenario = await activateScenario(ui.scenarioEditor.value);
  setMessage(`Validated ${scenario.scenarioId}. No external data was sent.`, "success");
  return scenario;
}

async function simulateWithAdapterParity(actor) {
  const primary = await session.simulate(actor);
  const mirror = await admitScenarioPack(currentScenario);
  const agentRun = await mirror.session.simulate({
    actorId: "syn-webmcp-parity-001",
    actorType: "AGENT"
  });
  const matched =
    primary.inputDigest === agentRun.inputDigest &&
    canonicalJson(primary.decision) === canonicalJson(agentRun.decision) &&
    primary.proposal.digest === agentRun.proposal.digest;
  lastAdapterParity = Object.freeze({
    matched,
    inputDigest: primary.inputDigest,
    proposalDigest: primary.proposal.digest
  });
  return primary;
}

async function runUnapprovedApplyProbe(actorId = "syn-negative-probe-001") {
  const before = session.getSnapshot();
  try {
    await session.apply({
      actorId,
      actorType: "SYSTEM",
      proposalDigest: before.simulation.proposal.digest,
      revision: before.simulation.proposal.revision,
      idempotencyKey: `${actorId}-${before.simulation.proposal.revision}`
    });
    ui.adversarialResult.textContent = "FAILED · prohibited apply unexpectedly succeeded";
    ui.adversarialResult.dataset.tone = "error";
    return false;
  } catch (error) {
    const after = session.getSnapshot();
    const unchanged = after.state === before.state && after.receipts.length === before.receipts.length;
    ui.adversarialResult.textContent = `${unchanged ? "BLOCKED" : "FAILED"} · UNAPPROVED_APPLY · ${errorMessage(error)} · session ${unchanged ? "unchanged" : "changed"}`;
    ui.adversarialResult.dataset.tone = unchanged ? "success" : "error";
    return unchanged;
  }
}

async function runJudgeProofToHumanGate() {
  await loadBuiltIn();
  const simulation = await simulateWithAdapterParity({ actorId: "syn-quick-judge-001", actorType: "HUMAN" });
  if (!lastAdapterParity?.matched) throw new Error("ADAPTER_PARITY_FAILED");
  if (!(await runUnapprovedApplyProbe("syn-quick-negative-001"))) {
    throw new Error("UNAPPROVED_APPLY_PROBE_FAILED");
  }
  if (!simulation.proposal.executableAfterApproval) {
    ui.judgeGuide.textContent = "Decision and negative proof complete. This scenario intentionally exposes no executable effect.";
    ui.judgeGuide.dataset.tone = "success";
    return { stoppedAt: "NON_EXECUTABLE_PROPOSAL" };
  }
  await session.requestApproval({ actorId: "syn-quick-agent-001", actorType: "AGENT" });
  ui.judgeGuide.textContent = "Proof ready: Overlay ran, digests match, unapproved apply was blocked. Human approval is required below.";
  ui.judgeGuide.dataset.tone = "success";
  return { stoppedAt: "HUMAN_UI" };
}

async function loadBuiltIn() {
  const filename = ui.scenarioSelect.value;
  const response = await fetch(`./scenarios/${filename}`, { cache: "no-store", credentials: "same-origin" });
  if (!response.ok || new URL(response.url).origin !== window.location.origin) throw new Error("SCENARIO_LOAD_FAILED");
  const text = await response.text();
  const scenario = await activateScenario(text);
  setMessage(`Validated ${scenario.scenarioId}. No external data was sent.`, "success");
  return scenario;
}

async function perform(operation, successMessage) {
  if (busy) return null;
  busy = true;
  if (session) updateActions(session.getSnapshot());
  try {
    const result = await operation();
    await render();
    setMessage(successMessage, "success");
    return result;
  } catch (error) {
    setMessage(errorMessage(error), "error");
    await render();
    return null;
  } finally {
    busy = false;
    if (session) updateActions(session.getSnapshot());
  }
}

const webMcpAdapter = createWebMcpAdapter({
  modelContext: document.modelContext,
  getSnapshot: () => session?.getSnapshot() ?? null,
  onRegistrationChange: (names) => {
    ui.webMcpStatus.textContent =
      document.modelContext && names.length > 0 ? `WEBMCP: ${names.length} TOOLS` : "WEBMCP: FALLBACK";
  },
  handlers: {
    dungeonq_status: async () => snapshotSummary(session?.getSnapshot()),
    dungeonq_scenario_admit: async (input) => {
      if (session?.getSnapshot().state !== "VALIDATED") {
        throw new LabSessionError("SCENARIO_ADMISSION_STATE_INVALID");
      }
      const scenario = await activateScenario(input?.scenarioPack);
      setMessage(`Agent admitted ${scenario.scenarioId} through the strict synthetic contract.`, "success");
      return {
        ...snapshotSummary(session.getSnapshot()),
        admitted: true,
        nextAvailableTools: webMcpAdapter.getActiveNames()
      };
    },
    dungeonq_simulate: async () => {
      await simulateWithAdapterParity({ actorId: "syn-webmcp-runner-001", actorType: "AGENT" });
      await render();
      return snapshotSummary(session.getSnapshot());
    },
    dungeonq_approval_request: async () => {
      await session.requestApproval({ actorId: "syn-webmcp-agent-001", actorType: "AGENT" });
      await render();
      return { ...snapshotSummary(session.getSnapshot()), nextRequiredAuthority: "HUMAN_UI" };
    },
    dungeonq_effect_apply: async () => {
      const snapshot = session.getSnapshot();
      await session.apply({
        actorId: "syn-webmcp-broker-001",
        actorType: "SYSTEM",
        proposalDigest: snapshot.simulation.proposal.digest,
        revision: snapshot.simulation.proposal.revision,
        idempotencyKey: `syn-webmcp-apply-${snapshot.simulation.proposal.revision}`
      });
      await render();
      return snapshotSummary(session.getSnapshot());
    },
    dungeonq_receipt_verify: async () => {
      const receipt = session.getSnapshot().receipts.at(-1);
      const verification = await session.verify({ receipt });
      await render();
      return { ...snapshotSummary(session.getSnapshot()), verification };
    },
    dungeonq_effect_rollback: async () => {
      const snapshot = session.getSnapshot();
      await session.rollback({
        actorId: "syn-webmcp-recovery-001",
        actorType: "AGENT",
        idempotencyKey: `syn-webmcp-rollback-${snapshot.simulation.proposal.revision}`
      });
      await render();
      return snapshotSummary(session.getSnapshot());
    },
    dungeonq_evidence_export: async () => {
      const evidence = await session.exportEvidence();
      return {
        ...snapshotSummary(session.getSnapshot()),
        evidenceDigest: evidence.digest,
        commandTranscriptDigest: evidence.commandTranscriptDigest,
        assertionsPassed: evidence.assertionsPassed
      };
    }
  }
});

ui.loadExample.addEventListener("click", () => perform(loadBuiltIn, "Built-in scenario loaded and validated."));
ui.judgeQuickRun.addEventListener("click", async () => {
  const result = await perform(
    runJudgeProofToHumanGate,
    "Judge proof generated. The workflow stopped at the separate human approval control."
  );
  if (result?.stoppedAt === "HUMAN_UI") {
    ui.humanApprove.scrollIntoView({ behavior: "smooth", block: "center" });
    ui.humanApprove.focus({ preventScroll: true });
  }
});
ui.validateScenario.addEventListener("click", () =>
  perform(createSessionFromEditor, "Scenario contract is valid and ready to run.")
);
ui.resetLab.addEventListener("click", () => perform(loadBuiltIn, "Lab reset to the selected fixed-seed scenario."));
ui.scenarioEditor.addEventListener("input", () => {
  editorDirty = true;
  ui.scenarioStatus.textContent = "DIRTY";
  if (session) updateActions(session.getSnapshot());
  setMessage("Editor changed. Validate the pack before running it.");
});
ui.scenarioFile.addEventListener("change", async () => {
  const file = ui.scenarioFile.files?.[0];
  if (!file) return;
  if (file.size > 131_072) {
    setMessage("INPUT_TOO_LARGE — maximum 128 KiB", "error");
    ui.scenarioFile.value = "";
    return;
  }
  try {
    ui.scenarioEditor.value = await file.text();
    await createSessionFromEditor();
  } catch (error) {
    editorDirty = true;
    setMessage(errorMessage(error), "error");
  } finally {
    ui.scenarioFile.value = "";
  }
});

ui.runSimulation.addEventListener("click", () =>
  perform(
    () => simulateWithAdapterParity({ actorId: "syn-ui-judge-001", actorType: "HUMAN" }),
    "Deterministic decision, assertions, and adapter-conformance proof generated."
  )
);
ui.requestApproval.addEventListener("click", () =>
  perform(
    () => session.requestApproval({ actorId: "syn-ui-agent-001", actorType: "AGENT" }),
    "Review requested. Only the separate human control can approve."
  )
);
ui.humanApprove.addEventListener("click", () =>
  perform(async () => {
    const snapshot = session.getSnapshot();
    return session.approve({
      actorId: "syn-human-reviewer-001",
      actorType: "HUMAN",
      proposalDigest: snapshot.simulation.proposal.digest,
      revision: snapshot.simulation.proposal.revision
    });
  }, "Human approval bound to the exact proposal digest and revision.")
);
ui.applyEffect.addEventListener("click", () =>
  perform(async () => {
    const snapshot = session.getSnapshot();
    return session.apply({
      actorId: "syn-effect-broker-001",
      actorType: "SYSTEM",
      proposalDigest: snapshot.simulation.proposal.digest,
      revision: snapshot.simulation.proposal.revision,
      idempotencyKey: `syn-ui-apply-${snapshot.simulation.proposal.revision}`
    });
  }, "Browser-local synthetic effect applied; receipt appended.")
);
ui.verifyReceipt.addEventListener("click", () =>
  perform(
    () => session.verify({ receipt: session.getSnapshot().receipts.at(-1) }),
    "Receipt digest and stored read-back match."
  )
);
ui.rollbackEffect.addEventListener("click", () =>
  perform(async () => {
    const snapshot = session.getSnapshot();
    return session.rollback({
      actorId: "syn-recovery-operator-001",
      actorType: "HUMAN",
      idempotencyKey: `syn-ui-rollback-${snapshot.simulation.proposal.revision}`
    });
  }, "Compensation receipt appended; original effect evidence retained.")
);
ui.probeUnapprovedApply.addEventListener("click", async () => {
  if (busy || !session) return;
  busy = true;
  updateActions(session.getSnapshot());
  try {
    await runUnapprovedApplyProbe();
  } finally {
    await render();
    busy = false;
    updateActions(session.getSnapshot());
  }
});
ui.probeTamperedReceipt.addEventListener("click", async () => {
  if (busy || !session) return;
  busy = true;
  updateActions(session.getSnapshot());
  const before = session.getSnapshot();
  const original = before.receipts.find((receipt) => receipt.result === "APPLIED");
  try {
    const tampered = structuredClone(original);
    tampered.afterState = `${tampered.afterState}_TAMPERED`;
    const verification = await session.verify({ receipt: tampered });
    const after = session.getSnapshot();
    const unchanged =
      verification.valid === false &&
      after.state === before.state &&
      after.receipts.length === before.receipts.length &&
      after.audit.length === before.audit.length;
    ui.adversarialResult.textContent = `${unchanged ? "REJECTED" : "FAILED"} · TAMPERED_RECEIPT · ${verification.reason} · original evidence ${unchanged ? "unchanged" : "changed"}`;
    ui.adversarialResult.dataset.tone = unchanged ? "success" : "error";
  } catch (error) {
    ui.adversarialResult.textContent = `FAILED · TAMPER_PROBE · ${errorMessage(error)}`;
    ui.adversarialResult.dataset.tone = "error";
  } finally {
    await render();
    busy = false;
    updateActions(session.getSnapshot());
  }
});
ui.exportEvidence.addEventListener("click", async () => {
  if (!lastEvidence) return;
  const blob = new Blob([`${canonicalJson(lastEvidence)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${currentScenario.scenarioId}-evidence.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  setMessage(`Exported verifiable evidence digest ${shortDigest(lastEvidence.digest)}.`, "success");
});

perform(loadBuiltIn, "Built-in scenario loaded and validated.");
