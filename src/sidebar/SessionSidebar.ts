import type { PaneInfo } from '../session/types';
import { sessionManager } from '../session/SessionManager';
import { workspaceActions } from '../workspace/WorkspaceActions';

export class SessionSidebar {
  readonly el: HTMLElement;
  private visible = false;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'session-sidebar';

    sessionManager.onChange((panes, activePaneId) => {
      this.render(panes, activePaneId);
    });
  }

  toggle() {
    this.visible = !this.visible;
    this.el.classList.toggle('sidebar-visible', this.visible);
  }

  isVisible(): boolean {
    return this.visible;
  }

  private render(panes: PaneInfo[], activePaneId: number | null) {
    // Group panes by group
    const groups: Record<string, PaneInfo[]> = {};
    for (const p of panes) {
      if (!groups[p.group]) groups[p.group] = [];
      groups[p.group].push(p);
    }

    this.el.innerHTML = `
      <div class="sb-header">
        <span class="sb-title">Sessions</span>
        <span class="sb-count">${panes.length}</span>
      </div>
      <div class="sb-body">
        ${Object.entries(groups).map(([group, ps]) => `
          <div class="sb-group">
            <div class="sb-group-label">${group}</div>
            ${ps.map(p => `
              <div class="sb-item ${p.id === activePaneId ? 'sb-active' : ''}" data-id="${p.id}">
                <span class="sb-dot sb-dot-${p.status}">●</span>
                <span class="sb-name">${p.name}</span>
                ${p.agent_type !== 'none' ? `<span class="sb-agent">${p.agent_type}</span>` : ''}
                <button class="sb-close" data-close-id="${p.id}" tabindex="-1" title="Close">✕</button>
              </div>
            `).join('')}
          </div>
        `).join('')}
      </div>
    `;

    // Bind clicks
    this.el.querySelectorAll('.sb-item').forEach(item => {
      item.addEventListener('click', () => {
        const id = parseInt((item as HTMLElement).dataset.id || '0');
        void workspaceActions.dispatch({ type: 'focus', target: String(id) }, { source: 'ui' });
      });
    });

    this.el.querySelectorAll('.sb-close').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt((btn as HTMLElement).dataset.closeId || '0');
        void workspaceActions.dispatch({ type: 'close', target: String(id) }, { source: 'ui' });
      });
    });
  }
}
