import { createLabSession } from "./session.mjs";
import { parseScenarioPack, ScenarioValidationError } from "./scenario.mjs";

export async function admitScenarioPack(candidate) {
  let serialized;
  if (typeof candidate === "string") {
    serialized = candidate;
  } else {
    try {
      serialized = JSON.stringify(candidate);
    } catch {
      throw new ScenarioValidationError([{ path: "$", code: "INPUT_SERIALIZATION_FAILED" }]);
    }
  }

  const scenario = parseScenarioPack(serialized);
  const session = await createLabSession(scenario);
  return Object.freeze({ scenario, session });
}
