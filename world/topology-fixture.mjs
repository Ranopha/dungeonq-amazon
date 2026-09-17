import { validateWorldPack } from './kernel.mjs';

export const TOPOLOGY_SCENES = Object.freeze([
  { id: 'workroom', title: 'Editorial workroom', description: 'Prepare the catalogue note for syn-atlas, an original synthetic atlas.' },
  { id: 'layout', title: 'Composition desk', description: 'Compose the annotated object into a stable edition packet.' },
  { id: 'preview', title: 'Preview room', description: 'Render and inspect the edition packet.' },
  { id: 'circulation', title: 'Circulation desk', description: 'Queue a rendered packet and run the fixed local filing consumer.' },
  { id: 'deposit', title: 'Deposit registry', description: 'Register the edition packet and its accession record.' },
  { id: 'catalogue', title: 'Visitor catalogue', description: 'Read the visitor-facing catalogue and run the fixed accession indexer.' },
]);
export const TOPOLOGY_ACTIONS = Object.freeze([
  { id: 'annotate-atlas', scene: 'workroom', label: 'Save catalogue note', description: 'Persist a descriptive note on syn-atlas.', requires: [], grants: ['annotated'], message: 'Catalogue note saved on syn-atlas.' },
  { id: 'compose-edition', scene: 'layout', label: 'Compose edition', description: 'Build an edition packet from the saved note.', requires: ['annotated'], grants: ['composed'], message: 'Edition packet composed from the saved note.' },
  { id: 'render-preview', scene: 'preview', label: 'Render preview', description: 'Save a rendered preview of the composed edition.', requires: ['composed'], grants: ['previewed'], message: 'Rendered preview saved for the edition packet.' },
  { id: 'queue-circulation', scene: 'circulation', label: 'Queue edition packet', description: 'Place the rendered packet in the local circulation queue.', requires: ['previewed'], grants: ['queued'], message: 'Edition packet saved in the local circulation queue.' },
  { id: 'file-circulation', scene: 'circulation', label: 'Run filing consumer', description: 'Deliver the queued packet to the fixed circulation clerk for local filing.', requires: ['queued'], grants: ['filed'], message: 'Circulation clerk read the packet and saved a local archive entry.' },
  { id: 'register-deposit', scene: 'deposit', label: 'Register deposit', description: 'Save an accession record for the composed edition packet.', requires: ['composed'], grants: ['deposited'], message: 'Accession record registered for syn-atlas.' },
  { id: 'index-accession', scene: 'catalogue', label: 'Index accession', description: 'Add a registered accession to the visitor catalogue.', requires: ['deposited'], grants: ['indexed'], message: 'syn-atlas is now present in the visitor catalogue.' },
]);

// A fixed declarative graph, not a script interpreter or an arbitrary workflow engine.
export function compileTopology(seed) {
  return validateWorldPack({ schemaVersion: 'dungeonq.world/v1', title: 'Atlas publishing network', seed, maxSteps: 128,
    startRoom: 'workroom', initialFlags: [], hypotheses: [{ id: 'unused', label: 'Not exposed by the workflow adapter' }],
    rooms: TOPOLOGY_SCENES.map(scene => ({ id: scene.id, title: scene.title, description: scene.description, clues: [],
      choices: [
        ...TOPOLOGY_SCENES.filter(other => other.id !== scene.id).map(other => ({ id: `visit-${scene.id}-${other.id}`,
          label: `Visit ${other.title}`, requires: [], grants: [], consumes: [], to: other.id, outcome: 'SUCCESS',
          message: `Opened ${other.title}.`, reward: false })),
        ...TOPOLOGY_ACTIONS.filter(action => action.scene === scene.id).map(action => ({ id: action.id, label: action.label,
          requires: action.requires, grants: action.grants, consumes: [], to: scene.id, outcome: 'SUCCESS', message: action.message, reward: true })),
      ] })) });
}

export const TOPOLOGY_EVALUATOR_GRAPH = Object.freeze({
  nodes: ['annotated', 'composed', 'previewed', 'queued', 'filed', 'deposited', 'indexed'],
  edges: [['annotated', 'composed'], ['composed', 'previewed'], ['previewed', 'queued'], ['queued', 'filed'],
    ['composed', 'deposited'], ['deposited', 'indexed']],
  goal: 'indexed', localBranch: ['render-preview', 'queue-circulation', 'file-circulation'],
  missingImplications: [['previewed', 'deposited'], ['filed', 'indexed']],
  consumer: { id: 'circulation-clerk', accepts: 'rendered-preview', writes: 'local-circulation-archive', neverWrites: 'visitor-catalogue' },
});
