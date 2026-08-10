// components/ThumbCard.js — T13 scope: single thumbnail card rendered
// inside VirtualGrid. Stays deliberately dumb: only receives an
// ImageRecord via props and emits intent events up to the parent.
//
// * `<img loading="lazy" decoding="async">` per SPEC §8.6 so the
//   browser skips off-viewport decode work automatically (the
//   VirtualGrid bounds the DOM, `loading=lazy` bounds network/decode
//   within the DOM window).
// * `object-fit: cover` is applied in CSS (FR-11: all thumbs share the
//   same aspect ratio).
// * `thumb_url` comes verbatim from the backend DTO (§4 #39 — the URL
//   is minted server-side with `?v=<mtime_ns>` for cache-busting;
//   frontend MUST NOT concatenate `/thumb/{id}`).
// * Favorite toggle is a stub: the real PATCH call lands in T19. We
//   emit 'toggle-favorite' so the parent can patch local state today
//   and swap in api.patch() later without re-plumbing the child.
// * Right-click → parent context menu (Move… T24, Delete… T25).
// * T22: `gallery.sync_status` — pending=amber dot, failed=red dot, ok=hidden.
// * Video cards (schema v8) keep the same server-rendered .webp poster as the
//   still card — a grid page must not fetch 60 clips to show 60 tiles. The
//   `<video>` element is created only on hover, and only when the user has
//   left the hover-preview preference on. `preload="metadata"` plus the raw
//   route's HTTP Range support means resting on a card pulls the first few
//   hundred KB, not the whole file.
import { defineComponent, computed, ref } from 'vue';
import { videoPrefs } from '../stores/gallerySettings.js';

/** ``m:ss`` (or ``h:mm:ss`` past an hour) for the corner badge. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  if (!Number.isFinite(total)) return '';
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

export const ThumbCard = defineComponent({
  name: 'ThumbCard',
  props: {
    item: { type: Object, required: true },
    bulkMode: { type: Boolean, default: false },
    bulkSelected: { type: Boolean, default: false },
  },
  emits: ['open', 'toggle-favorite', 'context', 'toggle-bulk'],
  setup(props, { emit }) {
    const isFav = computed(
      () => !!(props.item && props.item.gallery && props.item.gallery.favorite),
    );
    const syncBadge = computed(() => {
      const s = props.item && props.item.gallery && props.item.gallery.sync_status;
      if (s === 'pending') return 'pending';
      if (s === 'failed') return 'failed';
      return null;
    });
    const syncTitle = computed(() => {
      if (syncBadge.value === 'pending') return 'Metadata sync: pending';
      if (syncBadge.value === 'failed') return 'Metadata sync: failed';
      return '';
    });

    function onClick() {
      if (props.bulkMode) {
        emit('toggle-bulk', props.item.id);
        return;
      }
      emit('open', props.item.id);
    }
    function onContextMenu(e) {
      e.preventDefault();
      emit('context', { id: props.item.id, x: e.clientX, y: e.clientY });
    }
    function onFavClick(e) {
      e.stopPropagation();
      emit('toggle-favorite', props.item.id);
    }

    // -- video ---------------------------------------------------------------
    const isVideo = computed(() => props.item && props.item.media_kind === 'video');
    const vinfo = computed(() => (props.item && props.item.video) || null);
    const durationLabel = computed(() => {
      const d = vinfo.value && vinfo.value.duration_ms;
      return d ? formatDuration(d) : '';
    });
    // Silent vs muxed matters here more than usual: ComfyUI video workflows
    // emit both halves of a pair and the gallery keeps the one with sound, so
    // a card with no speaker really is a clip that has no audio track.
    const hasAudio = computed(() => !!(vinfo.value && vinfo.value.has_audio));

    const previewing = ref(false);
    const previewEl = ref(null);

    function onEnter() {
      if (!isVideo.value || !videoPrefs.hoverPreview) return;
      previewing.value = true;
    }
    function onLeave() {
      if (!previewing.value) return;
      previewing.value = false;
      // Vue tears the element down on the next tick, but an in-flight range
      // request keeps streaming until the element is actually detached and
      // its src cleared. Do it now so leaving a row does not leave six
      // downloads running behind the grid.
      const el = previewEl.value;
      if (el) {
        try { el.pause(); el.removeAttribute('src'); el.load(); } catch { /* ignore */ }
      }
    }
    function onPreviewReady(e) {
      // Autoplay can still be refused (a policy change, a background tab).
      // A rejected promise here is not an error worth surfacing — the poster
      // stays visible, which is exactly the non-preview experience.
      const p = e.target && e.target.play && e.target.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }

    return {
      isFav, syncBadge, syncTitle, onClick, onContextMenu, onFavClick,
      isVideo, durationLabel, hasAudio,
      previewing, previewEl, onEnter, onLeave, onPreviewReady,
    };
  },
  template: `
    <div class="tc" :class="{ 'tc-bulk-on': bulkMode }" @click="onClick" @contextmenu="onContextMenu"
         @mouseenter="onEnter" @mouseleave="onLeave">
      <div class="tc-thumb">
        <img v-if="item.thumb_url"
             class="tc-media"
             :src="item.thumb_url"
             :alt="item.filename || ''"
             loading="lazy"
             decoding="async" />
        <div v-else class="tc-thumb-empty tc-media" aria-hidden="true"></div>
        <video v-if="isVideo && previewing"
               ref="previewEl"
               class="tc-media tc-preview"
               :src="item.raw_url"
               muted
               loop
               playsinline
               preload="metadata"
               tabindex="-1"
               aria-hidden="true"
               @loadeddata="onPreviewReady"></video>
        <div v-if="isVideo" class="tc-vbadge" aria-hidden="true">
          <span v-if="hasAudio" class="tc-vbadge-audio" title="has audio">♪</span>
          <span v-if="durationLabel">{{ durationLabel }}</span>
        </div>
        <div v-if="bulkMode" class="tc-bulk" aria-hidden="true">
          <input
            type="checkbox"
            class="tc-bulk-cb"
            :checked="bulkSelected"
            tabindex="-1"
            @click.stop
          />
        </div>
        <div v-if="syncBadge" class="tc-sync" :class="'tc-sync-'+syncBadge" :title="syncTitle" aria-label="metadata sync" />
        <button type="button"
                class="tc-fav"
                :class="{ active: isFav }"
                :aria-pressed="isFav ? 'true' : 'false'"
                :title="isFav ? 'Unfavorite' : 'Favorite'"
                @click="onFavClick">
          <span class="tc-fav-icon" aria-hidden="true">{{ isFav ? '♥' : '♡' }}</span>
        </button>
      </div>
      <div class="tc-name" :title="item.filename || ''">{{ item.filename }}</div>
    </div>
  `,
});

export default ThumbCard;
