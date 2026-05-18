/**
 * AI route grouping UI + helpers for optimisation port flow.
 */
(function (window) {
  'use strict';

  let pickState = { gid: null, fromRouteId: null, scrapIndex: null };

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function sequenceFromTitle(title) {
    const m = String(title || '').match(/\((\d+)\)/);
    return m ? parseInt(m[1], 10) : 0;
  }

  function sortJobsBySequence(jobs) {
    return (jobs || []).slice().sort((a, b) => {
      const sa = Number(a.sequence_number);
      const sb = Number(b.sequence_number);
      const na = Number.isFinite(sa) && sa > 0 ? sa : 999;
      const nb = Number.isFinite(sb) && sb > 0 ? sb : 999;
      if (na !== nb) return na - nb;
      return String(a.title || '').localeCompare(String(b.title || ''));
    });
  }

  function clearPick() {
    pickState = { gid: null, fromRouteId: null, scrapIndex: null };
  }

  function isJobSelected(gid) {
    return pickState.gid != null && pickState.gid === gid;
  }

  function normalizeDraftRoute(route, index) {
    const jobs = Array.isArray(route.jobs) ? route.jobs.map((j) => ({
      asana_gid: String(j.asana_gid || j.gid || ''),
      title: String(j.title || ''),
      sequence_number: Number(j.sequence_number) || sequenceFromTitle(j.title),
    })) : [];
    const pending_slots = Array.isArray(route.pending_slots) ? route.pending_slots.map((j) => ({
      asana_gid: String(j.asana_gid || j.gid || ''),
      title: String(j.title || ''),
      sequence_number: Number(j.sequence_number) || sequenceFromTitle(j.title),
    })) : [];
    return {
      routeId: route.routeId || index + 1,
      driver_key: route.driver_key || route.driver_name || `Route ${index + 1}`,
      incomplete_route: !!route.incomplete_route,
      jobs: sortJobsBySequence(jobs),
      pending_slots: sortJobsBySequence(pending_slots),
    };
  }

  function ingestGroupingResult(data) {
    clearPick();
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

  function renderJobChip(job, routeId, displayOrder) {
    const selected = isJobSelected(job.asana_gid);
    const order = displayOrder != null ? displayOrder : (job.sequence_number || '·');
    const base = 'auto-group-job rounded p-2 text-xs border cursor-pointer transition-colors';
    const cls = selected
      ? `${base} bg-[#4b5563] text-gray-300 border-blue-400 ring-2 ring-blue-500`
      : `${base} bg-[#283039] text-white border-transparent hover:border-blue-500`;
    return `<div data-pick-gid="${escapeHtml(job.asana_gid)}" data-from-route="${routeId}"
      class="${cls}"
      onclick="window.sotoRouteAutoGroup.onJobClick(event)">
      <span class="${selected ? 'text-gray-400' : 'text-gray-400'}">${order}.</span> ${escapeHtml(job.title)}
    </div>`;
  }

  function buildRouteTimeline(route) {
    const rows = [
      ...route.jobs.map((j) => ({ ...j, slot: 'job' })),
      ...(route.pending_slots || []).map((j) => ({ ...j, slot: 'pending' })),
    ];
    return sortJobsBySequence(rows);
  }

  function renderRouteCard(route) {
    const border = route.incomplete_route ? 'border-amber-500/60' : 'border-[#283039]';
    const badge = route.incomplete_route
      ? '<span class="text-amber-400 text-xs font-bold uppercase">Incomplete route</span>'
      : '';
    const pickActive = pickState.gid != null;
    const dropHint = pickActive
      ? 'ring-1 ring-blue-500/40 hover:ring-2 hover:ring-blue-500 cursor-pointer'
      : '';
    const timeline = buildRouteTimeline(route);
    const slotsHtml = timeline.length
      ? timeline.map((row) => {
        const label = row.sequence_number || '·';
        if (row.slot === 'pending') {
          return `<div class="rounded p-2 text-xs text-amber-300/90 bg-amber-500/10 border border-amber-500/30">
            <span class="text-amber-400">${label}.</span> ${escapeHtml(row.title)}
            <span class="block text-amber-500/80 text-[10px] mt-0.5">Free / TBC — awaiting final job</span>
          </div>`;
        }
        return renderJobChip(row, route.routeId, label);
      }).join('')
      : `<p class="text-gray-500 text-xs">${pickActive ? 'Click here to place selected job' : 'No jobs'}</p>`;
    return `<div class="auto-group-route bg-[#1a1f24] border ${border} rounded-lg p-3 ${dropHint}"
      data-route-id="${route.routeId}"
      onclick="window.sotoRouteAutoGroup.onRouteClick(event)">
      <div class="flex justify-between items-center mb-2 gap-2 pointer-events-none">
        <h4 class="text-white font-semibold text-sm">${escapeHtml(route.driver_key)}</h4>
        ${badge}
      </div>
      <div class="space-y-1 min-h-[2rem]">${slotsHtml}</div>
    </div>`;
  }

  function renderScrapItem(task, index) {
    const gid = String(task.asana_gid || task.gid || `scrap-${index}`);
    const selected = isJobSelected(gid);
    const base = 'text-xs py-1 border-b border-[#283039] cursor-pointer rounded px-1 -mx-1 transition-colors';
    const cls = selected
      ? `${base} bg-[#4b5563] text-gray-300 ring-2 ring-blue-500`
      : `${base} text-gray-400 hover:bg-[#283039]`;
    return `<div class="${cls}" data-pick-gid="${escapeHtml(gid)}" data-scrap-index="${index}"
      onclick="window.sotoRouteAutoGroup.onJobClick(event)">
      <span class="text-gray-500">${escapeHtml(task.reason || 'skipped')}</span> — ${escapeHtml(task.title)}
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
    const hintEl = document.getElementById('autoGroupPickHint');
    if (summaryEl) summaryEl.textContent = buildSummaryLine(draft);
    if (hintEl) {
      hintEl.textContent = pickState.gid
        ? 'Click a route to place the selected job'
        : 'Click a job to select it (grey), then click a route';
    }
    if (parserEl) {
      const src = draft.parser_source === 'gemini'
        ? `Grouped with AI${draft.parser_model ? ` (${draft.parser_model})` : ''}`
        : (draft.parser_source === 'rules' || draft.parser_source === 'fallback')
          ? 'Grouped from task titles — adjust with click-to-move if needed'
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
        ? draft.irrelevant.map((t, i) => renderScrapItem(t, i)).join('')
        : '<p class="text-gray-500 text-sm">No skipped tasks</p>';
    }
  }

  function findRoute(draft, routeId) {
    return draft.routes.find((r) => String(r.routeId) === String(routeId));
  }

  function removeJobFromRoute(route, gid) {
    route.jobs = route.jobs.filter((j) => j.asana_gid !== gid);
  }

  function onJobClick(e) {
    e.stopPropagation();
    const el = e.target.closest('[data-pick-gid]');
    if (!el) return;
    const gid = el.getAttribute('data-pick-gid');
    const fromRoute = el.getAttribute('data-from-route');
    const scrapRaw = el.getAttribute('data-scrap-index');

    if (pickState.gid === gid) {
      clearPick();
    } else {
      pickState = {
        gid,
        fromRouteId: fromRoute || null,
        scrapIndex: scrapRaw != null && scrapRaw !== '' ? parseInt(scrapRaw, 10) : null,
      };
    }
    renderConfirmScreen(window.autoGroupDraft);
  }

  function movePickedJobToRoute(draft, toRouteId) {
    const toRoute = findRoute(draft, toRouteId);
    if (!toRoute || !pickState.gid) return false;

    if (pickState.scrapIndex != null && Number.isFinite(pickState.scrapIndex)) {
      const scrap = draft.irrelevant[pickState.scrapIndex];
      if (!scrap) return false;
      const job = {
        asana_gid: String(scrap.asana_gid || scrap.gid || pickState.gid),
        title: String(scrap.title || ''),
        sequence_number: sequenceFromTitle(scrap.title),
      };
      if (toRoute.jobs.some((j) => j.asana_gid === job.asana_gid)) {
        clearPick();
        return true;
      }
      draft.irrelevant.splice(pickState.scrapIndex, 1);
      toRoute.jobs.push(job);
    } else {
      const fromRoute = findRoute(draft, pickState.fromRouteId);
      if (!fromRoute) return false;
      if (String(fromRoute.routeId) === String(toRouteId)) {
        clearPick();
        return true;
      }
      const found = fromRoute.jobs.find((j) => j.asana_gid === pickState.gid);
      if (!found) return false;
      if (toRoute.jobs.some((j) => j.asana_gid === found.asana_gid)) {
        clearPick();
        return true;
      }
      removeJobFromRoute(fromRoute, pickState.gid);
      toRoute.jobs.push(found);
    }

    toRoute.jobs = sortJobsBySequence(toRoute.jobs);
    clearPick();
    return true;
  }

  function onRouteClick(e) {
    if (e.target.closest('[data-pick-gid]')) return;
    const draft = window.autoGroupDraft;
    if (!draft || !pickState.gid) return;
    const routeEl = e.currentTarget;
    const toRouteId = routeEl.getAttribute('data-route-id');
    if (!toRouteId) return;
    movePickedJobToRoute(draft, toRouteId);
    renderConfirmScreen(draft);
  }

  function buildSavedRoutesForPort(draft, currentTasks) {
    const out = [];
    let routeCounter = 0;
    draft.routes.forEach((r) => {
      if (!r.jobs.length) return;
      routeCounter++;
      const jobs = sortJobsBySequence(r.jobs).map((j) => {
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
    onJobClick,
    onRouteClick,
    clearPick,
    escapeHtml,
  };
})(window);
