// T40 / PROJECT_SPEC §12.5 — icon + tokenized panel button for Back / 主导航（非裸链接色）。
// SVG 1.5 stroke, 24 视口，与 FolderTree（T39）同网格。
import { defineComponent, computed, toRefs } from 'vue';

// Heroicons 24 "outline", so the added glyphs sit on the same 24 viewport and
// 1.5 stroke grid as the two chevrons that were already here (and as
// FolderTree's icons). Anything drawn to a different grid reads as borrowed.
const PATHS = {
  chevronLeft: 'M15.75 19.5L8.25 12l7.5-7.5',
  chevronRight: 'M8.25 4.5L15.75 12l-7.5 7.5',
  download:
    'M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5'
    + 'M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3',
  brush:
    'M9.53 16.122a3 3 0 00-5.78 1.128 2.25 2.25 0 01-2.4 2.245 4.5 4.5 0 '
    + '008.4-2.245c0-.399-.078-.78-.22-1.128zm0 0a15.998 15.998 0 003.388-1.62'
    + 'm-5.043-.025a15.994 15.994 0 011.622-3.395m3.42 3.42a15.995 15.995 0 '
    + '004.764-4.648l3.876-5.814a1.151 1.151 0 00-1.597-1.597L14.146 6.32a'
    + '15.996 15.996 0 00-4.649 4.763m3.42 3.42a6.776 6.776 0 00-3.42-3.42',
  braces:
    'M14.25 9.75L16.5 12l-2.25 2.25m-4.5 0L7.5 12l2.25-2.25M6 20.25h12A2.25 '
    + '2.25 0 0020.25 18V6A2.25 2.25 0 0018 3.75H6A2.25 2.25 0 003.75 6v12A2.25 '
    + '2.25 0 006 20.25z',
  trash:
    'M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166'
    + 'm-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 '
    + '01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 '
    + '.562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v'
    + '-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037'
    + '-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0',
};

export const IconButton = defineComponent({
  name: 'IconButton',
  props: {
    href: { type: String, default: '' },
    disabled: { type: Boolean, default: false },
    /** A key of `PATHS`: chevronLeft/Right, download, brush, braces, trash. */
    icon: { type: String, default: 'chevronLeft' },
    text: { type: String, default: '' },
    /** 若真则可视文案进 `.ib-sr-only`，须配合 `text` 或 `ariaLabel` 满足可访问性 */
    textSrOnly: { type: Boolean, default: false },
    ariaLabel: { type: String, default: '' },
    title: { type: String, default: '' },
    buttonType: { type: String, default: 'button' },
    /** Link only: save the target instead of navigating to it. */
    download: { type: Boolean, default: false },
  },
  setup(props) {
    const isLink = computed(() => Boolean(props.href));
    const pathD = computed(
      () => (PATHS[props.icon] ? PATHS[props.icon] : PATHS.chevronLeft),
    );
    const aria = computed(() => {
      if (props.ariaLabel) return props.ariaLabel;
      if (props.textSrOnly && props.text) return props.text;
      return undefined;
    });
    const rootBind = computed(() => {
      if (props.href) {
        return {
          href: props.disabled ? undefined : props.href,
          'aria-disabled': props.disabled ? 'true' : undefined,
          // Empty-string attribute — `download` is boolean in HTML, and
          // `download="false"` would still save (under the name "false").
          download: (props.download && !props.disabled) ? '' : undefined,
        };
      }
      return {
        type: props.buttonType,
        disabled: props.disabled,
      };
    });
    function onLinkClick(e) {
      if (props.href && props.disabled) e.preventDefault();
    }
    return { ...toRefs(props), isLink, pathD, aria, rootBind, onLinkClick };
  },
  template: `
    <component
      :is="isLink ? 'a' : 'button'"
      v-bind="rootBind"
      class="ib"
      :class="[{ 'ib--disabled': disabled }]"
      :title="title"
      :aria-label="aria"
      @click="onLinkClick"
    >
      <span class="ib-ico" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20" focusable="false" xmlns="http://www.w3.org/2000/svg">
          <path
            :d="pathD"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round" />
        </svg>
      </span>
      <span v-if="text" :class="textSrOnly ? 'ib-sr-only' : 'ib-txt'">{{ text }}</span>
    </component>
  `,
});

export default IconButton;
