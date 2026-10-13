// Read-only image snapshot. Shares the Source tokenizer, without editor/session writes.
import { defineComponent, ref, computed, watch } from 'vue';

const escape = value => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tokenClass = type => {
  if (type.startsWith('lora')) return 'lora';
  if (type.startsWith('number')) return 'number';
  if (type.startsWith('keyword') || type.startsWith('attribute')) return 'keyword';
  if (type.startsWith('path') || type.startsWith('string')) return 'path';
  return 'text';
};

export const PLV4Prompt = defineComponent({
  name: 'PLV4Prompt',
  props: { snapshot: { type: Object, required: true }, copied: Boolean },
  emits: ['copy'],
  setup(props) {
    const mode = ref('source'), colored = ref(''), highlightError = ref('');
    const text = computed(() => props.snapshot?.[mode.value] ?? '');
    let generation = 0;
    watch(text, async (source, _previous, onCleanup) => {
      const token = ++generation; colored.value = ''; highlightError.value = '';
      onCleanup(() => { generation++; });
      if (!source || mode.value !== 'source') return;
      try {
        const [{ loadMonaco }, { LANG_ID, registerLanguage }] = await Promise.all([
          import('xyz-plv4-monaco'), import('xyz-plv4-language'),
        ]);
        const monaco = await loadMonaco(); registerLanguage(monaco);
        if (token !== generation) return;
        const lines = source.split('\n'), tokens = monaco.editor.tokenize(source, LANG_ID);
        colored.value = lines.map((line, i) => (tokens[i] || []).map((entry, j, entries) =>
          `<span class="dv-plv4-token-${tokenClass(entry.type)}">${escape(line.slice(entry.offset, entries[j + 1]?.offset))}</span>`
        ).join('')).join('\n');
      } catch (error) {
        if (token === generation) highlightError.value = error.message || String(error);
      }
    }, { immediate: true });
    return { mode, text, colored, highlightError };
  },
  template: `
    <div class="dv-plv4-prompt">
      <div class="dv-plv4-toolbar">
        <span class="dv-prompt-mode" role="group" aria-label="PLV4 prompt view">
          <button v-for="view in ['source','prompt','plain']" :key="view" type="button"
                  class="dv-prompt-mode-btn" :class="{active: mode === view}"
                  :aria-pressed="mode === view" @click="mode = view">{{ view === 'source' ? 'Source' : view === 'prompt' ? 'Prompt' : 'Plain' }}</button>
        </span>
        <button type="button" class="dv-copy" :disabled="!text" @click="$emit('copy', text)">{{ copied ? 'Copied!' : 'Copy' }}</button>
      </div>
      <pre v-if="mode === 'source' && colored" class="dv-prompt" v-html="colored"></pre>
      <pre v-else-if="text" class="dv-prompt">{{ text }}</pre>
      <span v-else class="muted">—</span>
      <p class="dv-plv4-info muted">PLV4 seed: {{ snapshot.seed }} · {{ snapshot.region_mode }} · output: {{ snapshot.selected_output }}</p>
      <p v-if="highlightError" class="muted">Source highlighting: {{ highlightError }}</p>
    </div>`,
});
