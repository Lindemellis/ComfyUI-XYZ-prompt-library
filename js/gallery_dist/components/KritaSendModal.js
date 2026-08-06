// "Send to Krita": mode + fit, the same two questions the node asks, worded the same.
import { defineComponent, computed } from 'vue';
import {
  sendModalOpen, sendIds, sendMode, sendFit, sendBusy, sendResult,
  closeKritaSend, runKritaSend,
} from '../stores/kritaSend.js';

const FIT_HINTS = {
  keep: 'The image keeps its own pixel size, centred. The canvas is not touched.',
  fit: 'Scaled to the canvas, aspect ratio kept, centred.',
  grow_canvas: 'An image bigger than the canvas grows the canvas to it; existing '
    + 'content is scaled up without deforming.',
};

export const KritaSendModal = defineComponent({
  name: 'KritaSendModal',
  setup() {
    const count = computed(() => sendIds.value.length);
    const title = computed(() => (count.value === 1
      ? 'Send image to Krita'
      : `Send ${count.value} images to Krita`));
    const fitHint = computed(() => FIT_HINTS[sendFit.value] || '');
    // `fit` only means anything when the image lands on an existing canvas.
    const fitApplies = computed(() => sendMode.value === 'new_layer');
    const failed = computed(() => (sendResult.value && sendResult.value.failed) || []);

    return {
      sendModalOpen, sendMode, sendFit, sendBusy,
      count, title, fitHint, fitApplies, failed,
      close: closeKritaSend,
      run: runKritaSend,
    };
  },
  template: `
    <div v-if="sendModalOpen" class="cm-overlay dp-pick-overlay" @click.self="close">
      <div class="cm-panel dp-pick-panel" role="dialog" aria-modal="true">
        <header class="cm-head">
          <h2 class="cm-title">{{ title }}</h2>
          <button type="button" class="cm-x" :disabled="sendBusy" @click="close">×</button>
        </header>
        <div class="cm-body">
          <p class="muted cm-line">Krita is started if it is not already running.</p>

          <label class="ks-row">
            <span class="ks-label">Mode</span>
            <select class="gs-input" v-model="sendMode" :disabled="sendBusy">
              <option value="new_layer">New layer — on top of the open document</option>
              <option value="new_document">New document — a fresh canvas at the image's size</option>
            </select>
          </label>
          <p v-if="sendMode === 'new_layer'" class="muted gs-hint">
            With nothing open in Krita, the first image creates the document and the
            rest land on top of it.
          </p>

          <label class="ks-row" :class="{ 'gs-row--disabled': !fitApplies }">
            <span class="ks-label">Fit</span>
            <select class="gs-input" v-model="sendFit" :disabled="sendBusy || !fitApplies">
              <option value="keep">keep — own size</option>
              <option value="fit">fit — scale to canvas, keep ratio</option>
              <option value="grow_canvas">grow_canvas — grow the canvas to the image</option>
            </select>
          </label>
          <p class="muted gs-hint">
            {{ fitApplies ? fitHint : 'A new document is the image\\'s size, so there is nothing to fit.' }}
          </p>

          <div v-if="failed.length" class="ks-failed">
            <p class="cm-line">{{ failed.length }} of {{ count }} did not go:</p>
            <ul>
              <li v-for="f in failed" :key="f.id"><code>#{{ f.id }}</code> {{ f.error }}</li>
            </ul>
          </div>
        </div>
        <footer class="cm-foot">
          <button type="button" class="cm-btn" :disabled="sendBusy" @click="close">Cancel</button>
          <button type="button" class="cm-btn cm-btn-primary" :disabled="sendBusy" @click="run">
            {{ sendBusy ? 'Sending…' : 'Send to Krita' }}
          </button>
        </footer>
      </div>
    </div>
  `,
});

export default KritaSendModal;
