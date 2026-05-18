const functions = require("firebase-functions");
const {
  ROUTE_GROUPER_MODEL,
  ROUTE_GROUPER_SYSTEM_INSTRUCTION,
} = require("./job-route-grouper-prompt");

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_MODEL_FALLBACKS = ["gemini-2.5-flash", "gemini-2.0-flash-lite"];
/** Above this count, titles-only grouping uses rules (ms) — Gemini is too slow for large days. */
const RULES_ONLY_TASK_THRESHOLD = 30;
const GEMINI_FETCH_TIMEOUT_MS = 28000;

function geminiAuthHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    "x-goog-api-key": String(apiKey || "").trim(),
  };
}

function extractJsonObject(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    /* continue */
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch (_) {
      /* continue */
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch (_) {
      return null;
    }
  }
  return null;
}

function textFromGenerateContentResponse(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  return Array.isArray(parts) ? parts.map((p) => p.text || "").join("") : "";
}

function titleCaseDriverKey(s) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : ""))
    .join(" ");
}

function isIrrelevantTitle(title) {
  const t = String(title || "").trim();
  if (!t) return "not_a_job";
  if (/^full$/i.test(t)) return "full";
  if (/standby/i.test(t)) return "standby";
  if (/\boff\b/i.test(t) && !/\b(reg|postcode|registration)\b/i.test(t)) return "off_day";
  if (/deliver\s*carry\s*over/i.test(t)) return "carryover_delivery";
  return null;
}

/** Final slot is Free / TBC / "free from …" — route is incomplete (not a real delivery). */
function isEndOfDaySlotTitle(title) {
  const t = String(title || "").trim();
  if (!/\(\d+\)/.test(t)) return false;
  if (/\bfree\s+from\b/i.test(t)) return true;
  if (/\bTBC\b/i.test(t)) return true;
  if (/\(\d+\)\s*.+\s+Free\s*$/i.test(t)) return true;
  if (/\(\d+\)\s*.+\s+TBC\s*$/i.test(t)) return true;
  if (/\bFree\s*$/i.test(t)) return true;
  if (/\bTBC\s*$/i.test(t)) return true;
  // "(2) Name Free CW7 3AL" — Free + location, no Reg
  if (/\bFree\b/i.test(t) && !/\bReg(istration)?\s*:/i.test(t) && !/\bRegistration\s*:/i.test(t)) {
    return true;
  }
  return false;
}

function isIncompleteMarkerTitle(title) {
  return isEndOfDaySlotTitle(title);
}

function sequenceFromTitle(title) {
  const m = String(title || "").match(/\((\d+)\)/);
  return m ? parseInt(m[1], 10) : 999;
}

function driverKeyFromTitle(title) {
  const t = String(title || "").trim();
  const m = t.match(/^(.+?)\s*\(\d+\)/i);
  if (m) return titleCaseDriverKey(m[1]);
  return titleCaseDriverKey(t.split(/\s+/)[0] || "Unknown");
}

function parseTitleMeta(title) {
  const t = String(title || "").trim();
  const seqMatch = t.match(/^(.+?)\s*\((\d+)\)\s*(.*)$/i);
  if (!seqMatch) {
    return {
      driver_key: driverKeyFromTitle(t),
      sequence_number: sequenceFromTitle(t),
      rest: t,
    };
  }
  return {
    driver_key: titleCaseDriverKey(seqMatch[1]),
    sequence_number: parseInt(seqMatch[2], 10),
    rest: seqMatch[3] || "",
  };
}

function normalizeDriverKey(key) {
  return String(key || "").trim().replace(/\s+/g, " ").replace(/\.+$/g, "");
}

function driverKeysShouldMerge(a, b) {
  const na = normalizeDriverKey(a).toLowerCase();
  const nb = normalizeDriverKey(b).toLowerCase();
  if (na === nb) return true;
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  if (longer.startsWith(shorter) && (longer.length === shorter.length
    || longer[shorter.length] === " " || longer[shorter.length] === ".")) {
    return true;
  }
  const firstA = na.split(/\s+/)[0];
  const firstB = nb.split(/\s+/)[0];
  if (firstA.length >= 3 && firstA === firstB && (na.includes(nb) || nb.includes(na))) {
    return true;
  }
  return false;
}

function mergeDriverBuckets(byDriver) {
  const keys = [...byDriver.keys()];
  const canonical = new Map(keys.map((k) => [k, k]));
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      if (!driverKeysShouldMerge(keys[i], keys[j])) continue;
      const ci = canonical.get(keys[i]);
      const cj = canonical.get(keys[j]);
      const pick = normalizeDriverKey(ci).length >= normalizeDriverKey(cj).length ? ci : cj;
      canonical.set(keys[i], pick);
      canonical.set(keys[j], pick);
    }
  }
  const merged = new Map();
  for (const [key, items] of byDriver.entries()) {
    const target = canonical.get(key) || key;
    if (!merged.has(target)) merged.set(target, []);
    merged.get(target).push(...items);
  }
  return merged;
}

function pickRouteDriverKey(items) {
  const keys = items.map((i) => driverKeyFromTitle(i.title));
  keys.sort((a, b) => b.length - a.length);
  return keys[0] || "Unknown";
}

function attachOrphanEndSlotsToRoutes(routes, irrelevant) {
  const kept = [];
  for (const ir of irrelevant) {
    const title = String(ir.title || "").trim();
    if (!isEndOfDaySlotTitle(title)) {
      kept.push(ir);
      continue;
    }
    const meta = parseTitleMeta(title);
    const route = routes.find((r) => driverKeysShouldMerge(r.driver_key, meta.driver_key));
    if (!route) {
      kept.push(ir);
      continue;
    }
    route.pending_slots = route.pending_slots || [];
    if (!route.pending_slots.some((p) => p.asana_gid === ir.asana_gid)) {
      route.pending_slots.push({
        asana_gid: ir.asana_gid,
        title,
        sequence_number: meta.sequence_number,
      });
      route.pending_slots.sort((a, b) => a.sequence_number - b.sequence_number);
    }
    route.incomplete_route = true;
  }
  return kept;
}

function looksLikeVehicleMove(title) {
  const t = String(title || "");
  if (isIrrelevantTitle(t)) return false;
  if (isIncompleteMarkerTitle(t)) return false;
  return /\(\d+\)/.test(t) && (/\bReg(istration)?\s*:/i.test(t)
    || /\b[A-HJ-PR-ST-Z]{2}\d{2}[A-HJ-PR-ST-Z]{3}\b/i.test(t)
    || (/\b[A-Z]{1,2}\d{1,2}\s*\d[A-Z]{2}\b/i.test(t) && /\s+-\s+/.test(t)));
}

function regexGroupTasks(tasks) {
  const irrelevant = [];
  const byDriver = new Map();

  for (const task of tasks) {
    const gid = String(task.asana_gid || task.gid || "").trim();
    const title = String(task.title || task.name || "").trim();
    if (!gid || !title) {
      irrelevant.push({ asana_gid: gid || "unknown", title: title || "(empty)", reason: "not_a_job" });
      continue;
    }
    const irr = isIrrelevantTitle(title);
    if (irr) {
      irrelevant.push({ asana_gid: gid, title, reason: irr });
      continue;
    }
    const meta = parseTitleMeta(title);
    const seq = sequenceFromTitle(title);
    const driver_key = driverKeyFromTitle(title);
    if (!byDriver.has(driver_key)) byDriver.set(driver_key, []);
    byDriver.get(driver_key).push({
      asana_gid: gid,
      title,
      sequence_number: seq,
      meta,
    });
  }

  const mergedByDriver = mergeDriverBuckets(byDriver);
  const routes = [];
  const warnings = [];

  for (const [, items] of mergedByDriver.entries()) {
    const driver_key = pickRouteDriverKey(items);
    items.forEach((i) => {
      i.sequence_number = sequenceFromTitle(i.title);
    });
    items.sort((a, b) => a.sequence_number - b.sequence_number);
    const vehicleJobs = items.filter((i) => looksLikeVehicleMove(i.title));
    const pendingSlots = items.filter((i) => isEndOfDaySlotTitle(i.title));
    const highestSeq = items.reduce((m, i) => Math.max(m, i.sequence_number), 0);
    const incomplete_route = items.some(
      (i) => i.sequence_number === highestSeq && isEndOfDaySlotTitle(i.title),
    ) || (vehicleJobs.length > 0 && pendingSlots.length > 0);

    const routeJobs = vehicleJobs.map((j) => ({
      asana_gid: j.asana_gid,
      title: j.title,
      sequence_number: j.sequence_number,
    }));

    const pending_slots = pendingSlots.map((j) => ({
      asana_gid: j.asana_gid,
      title: j.title,
      sequence_number: j.sequence_number,
    }));

    if (routeJobs.length === 0 && pending_slots.length === 0) {
      for (const i of items) {
        irrelevant.push({ asana_gid: i.asana_gid, title: i.title, reason: "not_a_job" });
      }
      continue;
    }

    routes.push({
      driver_key,
      incomplete_route,
      jobs: routeJobs,
      pending_slots,
    });
  }

  const filteredIrrelevant = attachOrphanEndSlotsToRoutes(routes, irrelevant);
  routes.forEach((r) => {
    r.jobs.sort((a, b) => a.sequence_number - b.sequence_number);
    r.pending_slots = (r.pending_slots || []).sort((a, b) => a.sequence_number - b.sequence_number);
  });

  const summary = buildSummary(tasks.length, routes, filteredIrrelevant);
  return { routes, irrelevant: filteredIrrelevant, warnings, summary, parser_source: "rules" };
}

function buildSummary(totalTasks, routes, irrelevant) {
  const complete_routes = routes.filter((r) => !r.incomplete_route).length;
  const incomplete_routes = routes.filter((r) => r.incomplete_route).length;
  const relevant_jobs_in_routes = routes.reduce((n, r) => n + (r.jobs?.length || 0), 0);
  return {
    total_tasks: totalTasks,
    routes_created: routes.length,
    complete_routes,
    incomplete_routes,
    irrelevant_tasks: irrelevant.length,
    relevant_jobs_in_routes,
  };
}

function normalizeGrouping(raw, inputTasks) {
  const gidSet = new Set(
    (inputTasks || []).map((t) => String(t.asana_gid || t.gid || "").trim()).filter(Boolean),
  );
  const used = new Set();
  const routes = [];
  const irrelevant = [];
  const warnings = Array.isArray(raw?.warnings) ? [...raw.warnings] : [];

  for (const r of raw?.routes || []) {
    const driver_key = titleCaseDriverKey(r.driver_key || r.driver_name || "Unknown");
    const jobs = [];
    for (const j of r.jobs || []) {
      const gid = String(j.asana_gid || j.gid || "").trim();
      if (!gid || !gidSet.has(gid) || used.has(gid)) continue;
      const title = String(j.title || "").trim()
        || (inputTasks.find((t) => String(t.asana_gid || t.gid) === gid)?.title || "");
      if (isIrrelevantTitle(title) || isEndOfDaySlotTitle(title)) continue;
      used.add(gid);
      jobs.push({
        asana_gid: gid,
        title,
        sequence_number: Number(j.sequence_number) || parseTitleMeta(title).sequence_number,
      });
    }
    jobs.sort((a, b) => a.sequence_number - b.sequence_number);
    const driverTasks = (inputTasks || []).filter((t) => {
      const m = parseTitleMeta(t.title || t.name || "");
      return driverKeysShouldMerge(m.driver_key, driver_key);
    });
    const maxSeq = driverTasks.reduce(
      (m, t) => Math.max(m, parseTitleMeta(t.title || t.name || "").sequence_number),
      0,
    );
    let pending_slots = Array.isArray(r.pending_slots) ? [...r.pending_slots] : [];
    for (const t of driverTasks) {
      const title = String(t.title || t.name || "").trim();
      const gid = String(t.asana_gid || t.gid || "").trim();
      if (!gid || !isEndOfDaySlotTitle(title)) continue;
      if (!pending_slots.some((p) => p.asana_gid === gid)) {
        pending_slots.push({
          asana_gid: gid,
          title,
          sequence_number: parseTitleMeta(title).sequence_number,
        });
        used.add(gid);
      }
    }
    pending_slots.sort((a, b) => a.sequence_number - b.sequence_number);
    let incomplete_route = !!r.incomplete_route;
    if (!incomplete_route) {
      incomplete_route = driverTasks.some((t) => {
        const title = t.title || t.name || "";
        const m = parseTitleMeta(title);
        return m.sequence_number === maxSeq && isEndOfDaySlotTitle(title);
      });
    }
    if (jobs.length) {
      routes.push({ driver_key, incomplete_route, jobs, pending_slots });
    }
  }

  for (const ir of raw?.irrelevant || []) {
    const gid = String(ir.asana_gid || ir.gid || "").trim();
    if (!gid || !gidSet.has(gid) || used.has(gid)) continue;
    used.add(gid);
    irrelevant.push({
      asana_gid: gid,
      title: String(ir.title || "").trim(),
      reason: String(ir.reason || "not_a_job"),
    });
  }

  for (const task of inputTasks || []) {
    const gid = String(task.asana_gid || task.gid || "").trim();
    if (!gid || used.has(gid)) continue;
    const title = String(task.title || task.name || "").trim();
    if (isEndOfDaySlotTitle(title)) continue;
    irrelevant.push({ asana_gid: gid, title, reason: isIrrelevantTitle(title) || "not_a_job" });
    warnings.push(`Unassigned task moved to scrap: ${title.slice(0, 60)}`);
  }

  routes.sort((a, b) => {
    if (a.incomplete_route !== b.incomplete_route) return a.incomplete_route ? -1 : 1;
    return String(a.driver_key).localeCompare(String(b.driver_key));
  });

  const summary = raw?.summary && typeof raw.summary === "object"
    ? { ...buildSummary(inputTasks.length, routes, irrelevant), ...raw.summary }
    : buildSummary(inputTasks.length, routes, irrelevant);

  return { routes, irrelevant, warnings, summary };
}

function buildGrouperBody(tasksJson) {
  return {
    systemInstruction: { parts: [{ text: ROUTE_GROUPER_SYSTEM_INSTRUCTION }] },
    contents: [
      {
        role: "user",
        parts: [{ text: `Group these tasks:\n${tasksJson}` }],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json",
    },
  };
}

async function callGrouperOnce(apiKey, tasks, modelId, timeoutMs = GEMINI_FETCH_TIMEOUT_MS) {
  const payload = (tasks || []).map((t) => ({
    asana_gid: String(t.asana_gid || t.gid || ""),
    title: String(t.title || t.name || ""),
  }));
  const url = `${GEMINI_API_BASE}/models/${modelId}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: geminiAuthHeaders(apiKey),
      body: JSON.stringify(buildGrouperBody(JSON.stringify(payload))),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`${modelId}: timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || res.statusText || `HTTP ${res.status}`);
  }
  const parsed = extractJsonObject(textFromGenerateContentResponse(data));
  if (!parsed) throw new Error(`${modelId}: non-JSON output`);
  return parsed;
}

async function groupWithGemini(apiKey, tasks, logStep) {
  const model = ROUTE_GROUPER_MODEL;
  const t0 = Date.now();
  if (logStep) logStep("gemini_start", { model, taskCount: tasks.length });
  const raw = await callGrouperOnce(apiKey, tasks, model);
  const normalized = normalizeGrouping(raw, tasks);
  if (logStep) logStep("gemini_done", { model, ms: Date.now() - t0 });
  return { ...normalized, parser_source: "gemini", parser_model: model };
}

function rulesOnlyResult(regexResult, reason) {
  return {
    success: true,
    ...regexResult,
    parser_source: "rules",
    parser_warning: reason || null,
  };
}

/**
 * @param {string} apiKey
 * @param {{ tasks?: Array<{ asana_gid?: string, gid?: string, title?: string, name?: string }> }} data
 */
async function handleGroupJobsIntoRoutes(apiKey, data) {
  const startedAt = Date.now();
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  const debug = { steps: [], taskCount: tasks.length };
  const logStep = (name, extra = {}) => {
    const entry = { name, ms: Date.now() - startedAt, ...extra };
    debug.steps.push(entry);
    functions.logger.info("groupJobsIntoRoutes", entry);
  };

  logStep("start", { rulesOnly: !!data?.rulesOnly });

  if (!tasks.length) {
    return { success: false, error: "tasks array is required", _debug: debug };
  }

  const regexT0 = Date.now();
  let regexResult;
  try {
    regexResult = regexGroupTasks(tasks);
    logStep("regex_done", {
      regexMs: Date.now() - regexT0,
      routes: regexResult.routes?.length,
      irrelevant: regexResult.irrelevant?.length,
    });
  } catch (regexErr) {
    logStep("regex_error", { error: regexErr.message });
    return {
      success: false,
      error: regexErr.message || String(regexErr),
      _debug: debug,
    };
  }

  const useRulesOnly =
    !!data?.rulesOnly || tasks.length > RULES_ONLY_TASK_THRESHOLD;

  if (useRulesOnly) {
    const reason =
      data?.rulesOnly
        ? "Client requested fast title rules"
        : `${tasks.length} tasks — using title rules (faster than AI for large days)`;
    logStep("rules_only_return", { reason });
    return {
      ...rulesOnlyResult(regexResult, reason),
      _debug: debug,
    };
  }

  if (!String(apiKey || "").trim()) {
    logStep("no_api_key");
    return {
      ...rulesOnlyResult(regexResult, "GOOGLE_AI_API_KEY not set; used title rules"),
      _debug: debug,
    };
  }

  try {
    const result = await groupWithGemini(apiKey, tasks, logStep);
    logStep("success_gemini", { totalMs: Date.now() - startedAt });
    return { success: true, ...result, _debug: debug };
  } catch (geminiErr) {
    functions.logger.warn("groupJobsIntoRoutes: Gemini failed, using regex", {
      error: geminiErr.message,
      taskCount: tasks.length,
    });
    logStep("gemini_failed", { error: geminiErr.message });
    return {
      ...rulesOnlyResult(
        regexResult,
        "AI grouping timed out or failed; used title rules — review routes before continuing",
      ),
      parser_error: geminiErr.message || String(geminiErr),
      _debug: debug,
    };
  }
}

module.exports = {
  handleGroupJobsIntoRoutes,
  normalizeGrouping,
  regexGroupTasks,
};
