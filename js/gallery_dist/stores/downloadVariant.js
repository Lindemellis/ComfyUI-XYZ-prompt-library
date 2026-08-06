// A download variant IS two questions, and this is the only place that knows it:
//
//     keep the workflow?          the ComfyUI editor graph
//     keep the generation data?   the API prompt / A1111 parameters
//
// The old UI asked them as three buttons named after what they REMOVED — "No
// workflow", "No Comfy metadata" — which is backwards twice over: you had to read a
// negation to work out what you were getting, and the third name did not say that it
// also took the gallery's own tags with it. Two checkboxes say it plainly, and they
// cover the fourth combination the three buttons could not express at all.
//
// The wire and stored form stays the variant string: an old saved preference and an
// old `?variant=` link both keep working, and the backend already normalises it.

/** @type {readonly string[]} */
export const DOWNLOAD_VARIANTS = ['full', 'no_workflow', 'no_gen', 'clean'];

/** {workflow, gen} -> variant name. */
export function toVariant(keepWorkflow, keepGen) {
  if (keepWorkflow && keepGen) return 'full';
  if (!keepWorkflow && keepGen) return 'no_workflow';
  if (keepWorkflow && !keepGen) return 'no_gen';
  return 'clean';
}

/** variant name -> {workflow, gen}. Anything unknown reads as "keep everything". */
export function fromVariant(variant) {
  switch (String(variant || '')) {
    case 'no_workflow': return { workflow: false, gen: true };
    case 'no_gen': return { workflow: true, gen: false };
    case 'clean': return { workflow: false, gen: false };
    default: return { workflow: true, gen: true };
  }
}

/** What the user is actually asking for, in one line, for the modal. */
export function describeVariant(variant) {
  switch (String(variant || '')) {
    case 'no_workflow':
      return 'The PNG keeps its generation data, but not the editor graph.';
    case 'no_gen':
      return 'The PNG keeps the editor graph, but not the prompt or settings.';
    case 'clean':
      return 'A bare image — no workflow, no prompt, no settings, no gallery tags.';
    default:
      return 'The PNG keeps everything: workflow, prompt and settings.';
  }
}
