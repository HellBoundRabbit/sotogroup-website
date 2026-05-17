const functions = require("firebase-functions");
const {
  ROUTE_GROUPER_MODEL,
  ROUTE_GROUPER_SYSTEM_INSTRUCTION,
} = require("./job-route-grouper-prompt");

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_MODEL_FALLBACKS = ["gemini-2.5-flash", "gemini-2.0-flash-lite"];

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

function isIncompleteMarkerTitle(title) {
  const t = String(title || "").trim();
  if (/\(\d+\)\s*.+\s+Free\s*$/i.test(t)) return true;
  if (/\(\d+\)\s*.+\s+TBC\s*$/i.test(t)) return true;
  if (/\bFree\s*$/i.test(t) && /\(\d+\)/.test(t)) return true;
  if (/\bTBC\s*$/i.test(t) && /\(\d+\)/.test(t)) return true;
  return false;
}

function parseTitleMeta(title) {
  const t = String(title || "").trim();
  const seqMatch = t.match(/^(.+?)\s*\((\d+)\)\s*(.*)$/i);
  if (!seqMatch) {
    return { driver_key: titleCaseDriverKey(t.split(/\s+/)[0] || "Unknown"), sequence_number: 999, rest: t };
  }
  return {
    driver_key: titleCaseDriverKey(seqMatch[1]),
    sequence_number: parseInt(seqMatch[2], 10),
    rest: seqMatch[3] || "",
  };
}

function looksLikeVehicleMove(title) {
  const t = String(title || "");
  if (isIrrelevantTitle(t)) return false;
  if (isIncompleteMarkerTitle(t)) return false;
  return /\(\d+\)/.test(t) && (/\bReg\b/i.test(t) || /\b[A-Z]{1,2}\d{1,2}\s*\d[A-Z]{2}\b/i.test(t) || /\b[A-HJ-PR-ST-Z]{2}\d{2}[A-HJ-PR-ST-Z]{3}\b/i.test(t));
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
    if (!byDriver.has(meta.driver_key)) byDriver.set(meta.driver_key, []);
    byDriver.get(meta.driver_key).push({ asana_gid: gid, title, sequence_number: meta.sequence_number, meta });
  }

  const routes = [];
  const warnings = [];

  for (const [driver_key, items] of byDriver.entries()) {
    items.sort((a, b) => a.sequence_number - b.sequence_number);
    const vehicleJobs = items.filter((i) => looksLikeVehicleMove(i.title));
    const markers = items.filter((i) => isIncompleteMarkerTitle(i.title));
    const highestSeq = items.reduce((m, i) => Math.max(m, i.sequence_number), 0);
    const hasIncompleteMarker = markers.some((m) => m.sequence_number >= highestSeq - 0)
      || items.some((i) => isIncompleteMarkerTitle(i.title) && i.sequence_number === highestSeq);

    const incomplete_route = hasIncompleteMarker && vehicleJobs.length > 0;
    const routeJobs = vehicleJobs.map((j) => ({
      asana_gid: j.asana_gid,
      title: j.title,
      sequence_number: j.sequence_number,
    }));

    if (routeJobs.length === 0) {
      for (const i of items) {
        irrelevant.push({ asana_gid: i.asana_gid, title: i.title, reason: "not_a_job" });
      }
      continue;
    }

    routes.push({
      driver_key,
      incomplete_route,
      jobs: routeJobs,
    });
  }

  const summary = buildSummary(tasks.length, routes, irrelevant);
  return { routes, irrelevant, warnings, summary, parser_source: "fallback" };
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
      if (isIrrelevantTitle(title) || isIncompleteMarkerTitle(title)) continue;
      used.add(gid);
      jobs.push({
        asana_gid: gid,
        title,
        sequence_number: Number(j.sequence_number) || 999,
      });
    }
    jobs.sort((a, b) => a.sequence_number - b.sequence_number);
    let incomplete_route = !!r.incomplete_route;
    if (!incomplete_route) {
      const driverTasks = (inputTasks || []).filter((t) => {
        const m = parseTitleMeta(t.title || t.name || "");
        return m.driver_key === driver_key;
      });
      const maxSeq = driverTasks.reduce((m, t) => Math.max(m, parseTitleMeta(t.title || t.name).sequence_number), 0);
      incomplete_route = driverTasks.some((t) => {
        const title = t.title || t.name || "";
        const m = parseTitleMeta(title);
        return m.sequence_number === maxSeq && isIncompleteMarkerTitle(title);
      });
    }
    if (jobs.length) {
      routes.push({ driver_key, incomplete_route, jobs });
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

async function callGrouperOnce(apiKey, tasks, modelId) {
  const payload = (tasks || []).map((t) => ({
    asana_gid: String(t.asana_gid || t.gid || ""),
    title: String(t.title || t.name || ""),
  }));
  const url = `${GEMINI_API_BASE}/models/${modelId}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: geminiAuthHeaders(apiKey),
    body: JSON.stringify(buildGrouperBody(JSON.stringify(payload))),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || res.statusText || `HTTP ${res.status}`);
  }
  const parsed = extractJsonObject(textFromGenerateContentResponse(data));
  if (!parsed) throw new Error(`${modelId}: non-JSON output`);
  return parsed;
}

const GROUPER_MODEL_CANDIDATES = [ROUTE_GROUPER_MODEL, ...GEMINI_MODEL_FALLBACKS];

async function groupWithGemini(apiKey, tasks) {
  const models = GROUPER_MODEL_CANDIDATES;
  const errors = [];
  for (const model of models) {
    try {
      const raw = await callGrouperOnce(apiKey, tasks, model);
      const normalized = normalizeGrouping(raw, tasks);
      return { ...normalized, parser_source: "gemini", parser_model: model };
    } catch (err) {
      errors.push(err.message || String(err));
    }
  }
  throw new Error(errors[errors.length - 1] || "Gemini grouping failed");
}

/**
 * @param {string} apiKey
 * @param {{ tasks?: Array<{ asana_gid?: string, gid?: string, title?: string, name?: string }> }} data
 */
async function handleGroupJobsIntoRoutes(apiKey, data) {
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  if (!tasks.length) {
    return { success: false, error: "tasks array is required" };
  }
  if (!String(apiKey || "").trim()) {
    return {
      success: false,
      error: "GOOGLE_AI_API_KEY is not set",
    };
  }
  try {
    const result = await groupWithGemini(apiKey, tasks);
    return { success: true, ...result };
  } catch (geminiErr) {
    functions.logger.warn("groupJobsIntoRoutes: Gemini failed, regex fallback", {
      error: geminiErr.message,
    });
    try {
      const result = regexGroupTasks(tasks);
      return {
        success: true,
        ...result,
        parser_warning: "Gemini unavailable; used rule-based fallback",
        parser_error: geminiErr.message || String(geminiErr),
      };
    } catch (fallbackErr) {
      return {
        success: false,
        error: geminiErr.message || String(geminiErr),
        fallback_error: fallbackErr.message || String(fallbackErr),
      };
    }
  }
}

module.exports = {
  handleGroupJobsIntoRoutes,
  normalizeGrouping,
  regexGroupTasks,
};
