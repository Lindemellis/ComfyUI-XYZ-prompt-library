// app.js — SPA entry point for /xyz/gallery.
//   * Hash router: '#/' -> MainView (T12: sidebar + filter + folder tree);
//                   '#/settings' -> MainView + settings overlay;
//                   '#/image/:id' -> DetailView (T14);
//                   '#/image/:id/settings' -> DetailView + settings overlay;
//                   anything else -> NotFoundView.
//   * Stub WS hookup via api.openWS — the real socket is T18.
// T22: startGalleryConnection() — WS + focus /index/status reconciliation.
// Selection / bulk: T23+.
import * as api from './api.js';
import { createApp, ref, computed, onMounted } from 'vue';
import { MainView } from './views/MainView.js';
import { DetailView } from './views/DetailView.js';
import { SettingsView } from './views/SettingsView.js';
import { DownloadPickModal } from './components/DownloadPickModal.js';
import { KritaSendModal } from './components/KritaSendModal.js';
import { IconButton } from './components/IconButton.js';
import { startGalleryConnection } from './stores/connection.js';
import {
  applyServerPreferences,
  applyThemeToDocument,
} from './stores/gallerySettings.js';
import { ProgressModal } from './components/ProgressModal.js';
import { initGalleryProgress, bootstrapJobsActive, progressMainFrozen } from './stores/galleryProgress.js';

function parseHash() {
  const raw = (location.hash || '').replace(/^#/, '');
  if (raw === '' || raw === '/') return { name: 'home', settingsOpen: false };
  if (raw === '/settings' || raw === '/settings/') {
    return { name: 'home', settingsOpen: true };
  }
  const mSet = raw.match(/^\/image\/(\d+)\/settings\/?$/);
  if (mSet) {
    return { name: 'detail', id: Number(mSet[1]), settingsOpen: true };
  }
  const m = raw.match(/^\/image\/(\d+)$/);
  if (m) return { name: 'detail', id: Number(m[1]), settingsOpen: false };
  return { name: 'not_found', raw, settingsOpen: false };
}

const route = ref(parseHash());
window.addEventListener('hashchange', () => {
  route.value = parseHash();
});

const NotFoundView = {
  name: 'NotFoundView',
  components: { IconButton },
  props: { raw: { type: String, default: '' } },
  template: `
    <section>
      <h2>Not Found</h2>
      <p>No route for: <code>#{{ raw }}</code></p>
      <p><IconButton href="#/" class="ib" text="Home" title="Back to gallery" /></p>
    </section>
  `,
};

const App = {
  name: 'App',
  components: {
    MainView, DetailView, SettingsView, NotFoundView, DownloadPickModal, ProgressModal,
    KritaSendModal,
  },
  setup() {
    const settingsHref = computed(() => {
      const r = route.value;
      if (r.name === 'detail') return `#/image/${r.id}/settings`;
      return '#/settings';
    });
    const settingsBackHref = computed(() => {
      const r = route.value;
      if (r.name === 'detail') return `#/image/${r.id}`;
      return '#/';
    });

    onMounted(() => {
      startGalleryConnection();
      initGalleryProgress();
      void bootstrapJobsActive();
      void (async () => {
        try {
          const p = await api.fetchGalleryPreferences();
          applyServerPreferences(p);
        } catch {
          /* offline / 503 — keep store defaults */
        }
        applyThemeToDocument();
      })();
    });
    function closeSettingsOverlay() {
      const h = settingsBackHref.value;
      window.location.hash = h.startsWith('#') ? h.slice(1) : h;
    }

    return {
      route, settingsHref, settingsBackHref, closeSettingsOverlay, progressMainFrozen,
    };
  },
  template: `
    <div class="app-root">
      <div class="topbar">
        <a href="#/">XYZ Image Gallery</a>
        <span class="muted">MVP shell</span>
        <a class="mv-settings" :href="settingsHref">Settings</a>
      </div>
      <main
        class="content"
        :class="{
          'content--settings-bg': route.settingsOpen,
          'content--progress-frozen': progressMainFrozen
        }"
      >
        <MainView v-if="route.name === 'home'" />
        <DetailView
          v-else-if="route.name === 'detail'"
          :id="route.id"
        />
        <NotFoundView v-else :raw="route.raw || ''" />
      </main>
      <div v-if="route.settingsOpen" class="gs-overlay" role="presentation"
           @click.self="closeSettingsOverlay">
        <div class="gs-window" role="dialog" aria-modal="true" aria-labelledby="gs-dialog-title"
             @click.stop>
          <SettingsView :back-href="settingsBackHref" />
        </div>
      </div>
      <ProgressModal />
      <DownloadPickModal />
      <KritaSendModal />
    </div>
  `,
};

createApp(App).mount('#app');
