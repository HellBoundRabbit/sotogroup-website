/**
 * AI route grouping UI + helpers for optimisation port flow.
 */
(function (window) {
  'use strict';

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function normalizeDraftRoute(route, index) {
    return {
      routeId: route.routeId || index + 1,
      driver_key: route.driver_key || route.driver_name || `Route ${index + 1}`,
      incomplete_route: !!route.incomplete_route,
      jobs: Array.isArray(route.jobs) ? route.jobs.map((j) => ({
        asana_gid: String(j.asana_gid || j.gid || ''),
        title: String(j.title || ''),
        sequence_number: Number(j.sequence_number) || 0,
      })) : [],
    };
  }

  function ingestGroupingResult(data) {
    const routes = (data.routes || []).map(normalizeDraftRoute);
    routes.sort((a, b) => {
      if (a.incomplete_route !== b.incomplete_route) return a.incomplete_route ? -1 : 1;
      return String(a.driver_key).localeCompare(String(b.driver_key));
    });
    return {
      routes,
      irrelevant: Array.isArray(data.irrelevant) ? data.irrelevant : [],
      warnings: Array.isArray(data.warnings) ? data.warnings : [],
      summary: data.summary || {},
      parser_source: data.parser_source || 'unknown',
      parser_model: data.parser_model || '',
    };
  }

  function buildSummaryLine(draft) {
    const s = draft.summary || {};
    const routesN = s.routes_created != null ? s.routes_created : draft.routes.length;
    const complete = s.complete_routes != null ? s.complete_routes : draft.routes.filter((r) => !r.incomplete_route).length;
    const incomplete = s.incomplete_routes != null ? s.incomplete_routes : draft.routes.filter((r) => r.incomplete_route).length;
    const scrap = s.irrelevant_tasks != null ? s.irrelevant_tasks : draft.irrelevant.length;
    return `${routesN} routes (${complete} complete, ${incomplete} incomplete) · ${scrap} tasks not used`;
  }

  function renderJobChip(job, routeId) {
    return `<div draggable="true" data-drag-gid="${escapeHtml(job.asana_gid)}" data-from-route="${routeId}"
      class="auto-group-job bg-[#283039] rounded p-2 text-xs text-white cursor-grab border border-transparent hover:border-blue-500"
      ondragstart="window.sotoRouteAutoGroup.onDragStart(event)" ondragend="window.sotoRouteAutoGroup.onDragEnd(event)">
      <span class="text-gray-400">${job.sequence_number || '·'}.</span> ${escapeHtml(job.title)}
    </div>`;
  }

  function renderRouteCard(route) {
    const border = route.incomplete_route ? 'border-amber-500/60' : 'border-[#283039]';
    const badge = route.incomplete_route
      ? '<span class="text-amber-400 text-xs font-bold uppercase">Incomplete route</span>'
      : '';
    const jobsHtml = route.jobs.length
      ? route.jobs.map((j) => renderJobChip(j, route.routeId)).join('')
      : '<p class="text-gray-500 text-xs">No jobs — drag tasks here</p>';
    return `<div class="auto-group-route bg-[#1a1f24] border ${border} rounded-lg p-3"
      data-route-id="${route.routeId}"
      ondragover="window.sotoRouteAutoGroup.onDragOver(event)"
      ondrop="window.sotoRouteAutoGroup.onDrop(event)">
      <div class="flex justify-between items-center mb-2 gap-2">
        <h4 class="text-white font-semibold text-sm">${escapeHtml(route.driver_key)}</h4>
        ${badge}
      </div>
      <div class="space-y-1 min-h-[2rem]">${jobsHtml}</div>
    </div>`;
  }

  function renderConfirmScreen(draft) {
    const incomplete = draft.routes.filter((r) => r.incomplete_route);
    const complete = draft.routes.filter((r) => !r.incomplete_route);
    const incEl = document.getElementById('autoGroupIncompleteRoutes');
    const compEl = document.getElementById('autoGroupCompleteRoutes');
    const scrapEl = document.getElementById('autoGroupScrapTasks');
    const summaryEl = document.getElementById('autoGroupSummaryLine');
    const parserEl = document.getElementById('autoGroupParserNote');
    if (summaryEl) summaryEl.textContent = buildSummaryLine(draft);
    if (parserEl) {
      const src = draft.parser_source === 'gemini'
        ? `Grouped with AI${draft.parser_model ? ` (${draft.parser_model})` : ''}`
        : (draft.parser_source === 'rules' || draft.parser_source === 'fallback')
          ? 'Grouped from task titles (fast rules) — drag jobs if anything looks wrong'
          : '';
      parserEl.textContent = src;
    }
    if (incEl) {
      incEl.innerHTML = incomplete.length
        ? incomplete.map(renderRouteCard).join('')
        : '<p class="text-gray-500 text-sm">No incomplete routes</p>';
    }
    if (compEl) {
      compEl.innerHTML = complete.length
        ? complete.map(renderRouteCard).join('')
        : '<p class="text-gray-500 text-sm">No complete routes</p>';
    }
    if (scrapEl) {
      scrapEl.innerHTML = draft.irrelevant.length
        ? draft.irrelevant.map((t) => `<div class="text-xs text-gray-400 py-1 border-b border-[#283039]">
          <span class="text-gray-500">${escapeHtml(t.reason || 'skipped')}</span> — ${escapeHtml(t.title)}
        </div>`).join('')
        : '<p class="text-gray-500 text-sm">No skipped tasks</p>';
    }
  }

  let dragState = { gid: null, fromRouteId: null };

  function findRoute(draft, routeId) {
    return draft.routes.find((r) => String(r.routeId) === String(routeId));
  }

  function findJobInDraft(draft, gid) {
    for (const r of draft.routes) {
      const j = r.jobs.find((x) => x.asana_gid === gid);
      if (j) return { route: r, job: j };
    }
    return null;
  }

  function removeJobFromRoute(route, gid) {
    route.jobs = route.jobs.filter((j) => j.asana_gid !== gid);
  }

  function onDragStart(e) {
    const el = e.target.closest('[data-drag-gid]');
    if (!el) return;
    dragState.gid = el.getAttribute('data-drag-gid');
    dragState.fromRouteId = el.getAttribute('data-from-route');
    e.dataTransfer.effectAllowed = 'move';
  }

  function onDragEnd() {
    dragState = { gid: null, fromRouteId: null };
  }

  function onDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }

  function onDrop(e) {
    e.preventDefault();
    const draft = window.autoGroupDraft;
    if (!draft || !dragState.gid) return;
    const routeEl = e.target.closest('[data-route-id]');
    if (!routeEl) return;
    const toRouteId = routeEl.getAttribute('data-route-id');
    const fromRoute = findRoute(draft, dragState.fromRouteId);
    const toRoute = findRoute(draft, toRouteId);
    if (!fromRoute || !toRoute || fromRoute === toRoute) return;
    const found = fromRoute.jobs.find((j) => j.asana_gid === dragState.gid);
    if (!found) return;
    removeJobFromRoute(fromRoute, dragState.gid);
    toRoute.jobs.push(found);
    toRoute.jobs.sort((a, b) => (a.sequence_number || 0) - (b.sequence_number || 0));
    renderConfirmScreen(draft);
  }

  function buildSavedRoutesForPort(draft, currentTasks) {
    const out = [];
    let routeCounter = 0;
    draft.routes.forEach((r) => {
      if (!r.jobs.length) return;
      routeCounter++;
      const jobs = r.jobs.map((j) => {
        const task = (currentTasks || []).find((t) => t.gid === j.asana_gid) || { gid: j.asana_gid, name: j.title };
        return { task, parsedData: null };
      });
      out.push({
        routeId: routeCounter,
        driver_key: r.driver_key,
        incompleteRoute: !!r.incomplete_route,
        jobs,
      });
    });
    return { savedRoutesForPort: out, routeCounter };
  }

  window.sotoRouteAutoGroup = {
    ingestGroupingResult,
    renderConfirmScreen,
    buildSummaryLine,
    buildSavedRoutesForPort,
    onDragStart,
    onDragEnd,
    onDragOver,
    onDrop,
    escapeHtml,
  };
})(window);
