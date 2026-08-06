// The download dialog: one button, and two checkboxes for what rides along in the PNG.
//
// It used to be three buttons named after what they REMOVED — "Full metadata",
// "No workflow", "No Comfy metadata" — which reads backwards (you decode a negation to
// find out what you get), hides that the third one also strips the gallery's own tags,
// and cannot express "keep the workflow but not the prompt" at all. Two checkboxes say
// what you keep, cover all four combinations, and are remembered between downloads.
import { defineComponent, computed, ref, watch } from 'vue';
import {
  pickModalOpen,
  pickModalTitle,
  submitDownloadPick,
  cancelDownloadPick,
} from '../stores/downloadPick.js';
import { downloadVariant, rememberDownloadVariant } from '../stores/gallerySettings.js';
import { describeVariant, fromVariant, toVariant } from '../stores/downloadVariant.js';

export const DownloadPickModal = defineComponent({
  name: 'DownloadPickModal',
  setup() {
    const keepWorkflow = ref(true);
    const keepGen = ref(true);

    // Re-read the remembered answer every time it OPENS, not once at setup: the
    // preference can change in Settings while this component is alive.
    watch(pickModalOpen, (open) => {
      if (!open) return;
      const state = fromVariant(downloadVariant.value);
      keepWorkflow.value = state.workflow;
      keepGen.value = state.gen;
    }, { immediate: true });

    const variant = computed(() => toVariant(keepWorkflow.value, keepGen.value));
    const summary = computed(() => describeVariant(variant.value));

    function download() {
      // Remember BEFORE resolving: the caller starts fetching the moment it resolves,
      // and a bulk download would race the preference write.
      rememberDownloadVariant(variant.value);
      submitDownloadPick(variant.value);
    }

    return {
      pickModalOpen,
      pickModalTitle,
      keepWorkflow,
      keepGen,
      summary,
      download,
      cancel: cancelDownloadPick,
    };
  },
  template: `
    <div v-if="pickModalOpen" class="cm-overlay dp-pick-overlay" @click.self="cancel">
      <div class="cm-panel dp-pick-panel" role="dialog" aria-modal="true">
        <header class="cm-head">
          <h2 class="cm-title">{{ pickModalTitle }}</h2>
          <button type="button" class="cm-x" @click="cancel">×</button>
        </header>
        <div class="cm-body">
          <p class="muted cm-line">What should the PNG carry?</p>
          <label class="dp-check">
            <input type="checkbox" v-model="keepWorkflow" />
            <span>Workflow
              <span class="muted">— the editor graph, so the image can be dragged back into ComfyUI</span>
            </span>
          </label>
          <label class="dp-check">
            <input type="checkbox" v-model="keepGen" />
            <span>Generation data
              <span class="muted">— prompt, seed, steps, sampler</span>
            </span>
          </label>
          <p class="muted cm-line dp-summary">{{ summary }}</p>
        </div>
        <footer class="cm-foot">
          <button type="button" class="cm-btn" @click="cancel">Cancel</button>
          <button type="button" class="cm-btn cm-btn-primary" @click="download">Download image</button>
        </footer>
      </div>
    </div>
  `,
});

export default DownloadPickModal;
