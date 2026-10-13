// UI preferences stay outside Document/history and survive browser/service restarts.
const PREFIX = 'xyz-plv4-details-v1:';
export class DetailsPreferences {
  constructor(host) { this.host = host; this.maps = new WeakMap(); }
  scope(session) {
    const asset = this.host.context?.session === session && this.host.context?.asset?.id;
    return asset ? `library:${asset}` : `document:${session.state.doc.root.meta?.owner || ''}`;
  }
  map(session, kind) {
    const scope = this.scope(session);
    let saved = this.maps.get(session);
    if (!saved || saved.scope !== scope) {
      let data = {};
      try { data = JSON.parse(localStorage.getItem(PREFIX + scope) || '{}'); } catch {}
      saved = { scope, filters: new Map(Array.isArray(data?.filters) ? data.filters : []), views: new Map(Array.isArray(data?.views) ? data.views : []) };
      this.maps.set(session, saved);
    }
    return saved[kind];
  }
  save(session) {
    const saved = this.maps.get(session);
    if (!saved || saved.scope === 'document:') return;
    try { localStorage.setItem(PREFIX + saved.scope, JSON.stringify({ filters: [...saved.filters], views: [...saved.views] })); } catch {}
  }
}
