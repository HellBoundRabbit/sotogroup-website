const functions = require("firebase-functions");
const { JOB_PARSER_SYSTEM_INSTRUCTION, JOB_PARSER_MODEL } = require("./job-parser-prompt");

const UK_POSTCODE_RE = /\b([A-Z]{1,2}\d{1,2}[A-Z]?)\s*(\d[A-Z]{2})\b/gi;
const UK_PLATE_RE = /\b([A-HJ-PR-ST-Z]{2}\d{2}[A-HJ-PR-ST-Z]{3})\b/gi;
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
/** Static prefs if ListModels fails — no retired 1.5 / preview / bare 2.0-flash. */
const GEMINI_MODEL_FALLBACKS = [
  "gemini-2.5-flash",
  "gemini-2.0-flash-lite",
];

let cachedModelIds = null;
let cachedModelIdsAt = 0;
const MODEL_CACHE_MS = 10 * 60 * 1000;

function normalizeUkPostcode(value) {
  const raw = String(value || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!raw) return "";
  if (raw.length <= 3) return raw;
  return `${raw.slice(0, -3)} ${raw.slice(-3)}`;
}

function emptyParsedData() {
  return {
    collection_address: "",
    postcode_delivery: "",
    price: 0,
    reg_number: "",
    return_reg: "",
    return_postcode: "",
    confidence_scores: {
      collection: 0,
      delivery: 0,
      price: 0,
      reg: 0,
      return_reg: 0,
      return_postcode: 0,
    },
    overall_confidence: 0,
  };
}

/**
 * @param {Record<string, unknown>} raw
 */
function normalizeGeminiParsed(raw) {
  const out = emptyParsedData();
  if (!raw || typeof raw !== "object") {
    return out;
  }

  const reg =
    raw.reg_number ||
    raw.REG ||
    raw.reg ||
    raw.Reg;
  const collection =
    raw.collection_address ||
    raw["Collection Postcode"] ||
    raw.collection_postcode ||
    raw.postcode_collection;
  const delivery =
    raw.postcode_delivery ||
    raw["Delivery Postcode"] ||
    raw.delivery_postcode;
  const returnReg = raw.return_reg || raw["Return Reg"] || raw.returnReg;
  const returnPc = raw.return_postcode || raw["Return Postcode"] || raw.returnPostcode;

  let price = raw.price != null ? raw.price : raw.Price;
  if (typeof price === "string") {
    price = parseFloat(price.replace(/[£,\s]/g, ""));
  }
  if (!Number.isFinite(price) || price < 0) {
    price = 0;
  }

  out.reg_number = String(reg || "").trim().toUpperCase();
  out.collection_address = normalizeUkPostcode(collection);
  out.postcode_delivery = normalizeUkPostcode(delivery);
  out.price = Math.round(price * 100) / 100;
  out.return_reg = String(returnReg || "").trim().toUpperCase();
  out.return_postcode = normalizeUkPostcode(returnPc);

  const scores = raw.confidence_scores && typeof raw.confidence_scores === "object"
    ? raw.confidence_scores
    : {};
  out.confidence_scores = {
    collection: clampScore(scores.collection ?? scores.collection_address),
    delivery: clampScore(scores.delivery ?? scores.postcode_delivery),
    price: clampScore(scores.price),
    reg: clampScore(scores.reg ?? scores.reg_number),
    return_reg: clampScore(scores.return_reg),
    return_postcode: clampScore(scores.return_postcode),
  };

  let overall = raw.overall_confidence;
  if (overall == null || !Number.isFinite(Number(overall))) {
    const vals = Object.values(out.confidence_scores);
    overall = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }
  out.overall_confidence = Math.round(Number(overall) * 10) / 10;

  return out;
}

function looksLikeUkPostcodeToken(token) {
  const n = String(token || "").toUpperCase().replace(/\s+/g, "");
  return /^[A-Z]{1,2}\d{1,2}[A-Z]?\d[A-Z]{2}$/.test(n);
}

/** Extract UK registration when labelled Reg/Chassis, title "GX22KKA / 6026523", etc. */
function extractUkRegistration(text) {
  const t = String(text || "");
  if (!t.trim()) return "";

  const labelled = t.match(/\bReg(?:istration)?(?:\s*\/\s*Chassis)?\s*[:.]?\s*([A-Z0-9]{5,8})\b/i);
  if (labelled) {
    const plate = labelled[1].toUpperCase();
    if (!looksLikeUkPostcodeToken(plate)) return plate;
  }

  const titleSlash = t.match(/\b([A-HJ-PR-ST-Z]{2}\d{2}[A-HJ-PR-ST-Z]{3})\s*\/\s*\d{4,}\b/i);
  if (titleSlash) return titleSlash[1].toUpperCase();

  const nearReg = t.match(/\bReg(?:istration)?(?:\s*\/\s*Chassis)?[\s\S]{0,120}?([A-HJ-PR-ST-Z]{2}\d{2}[A-HJ-PR-ST-Z]{3})\b/i);
  if (nearReg) return nearReg[1].toUpperCase();

  const plates = [];
  let m;
  const re = new RegExp(UK_PLATE_RE.source, UK_PLATE_RE.flags);
  while ((m = re.exec(t)) !== null) {
    const plate = m[1].toUpperCase();
    if (!looksLikeUkPostcodeToken(plate)) plates.push(plate);
  }
  return plates[0] || "";
}

function sanitizeRawTextForParsing(rawText) {
  let text = String(rawText || "");
  text = text.replace(/\bParsed Details\b[\s\S]*?(?=\n(?:REG|Collection Postcode|Job Price|Company Name|Fuel |=== )|$)/gi, "");
  text = text.replace(
    /(=== CUSTOM FIELDS ===[\s\S]*?)\bParsed Details\b[\s\S]*?(?=\n[A-Z][^\n]*:|\n===|$)/gi,
    "$1",
  );
  return text.trim();
}

function matchUkPostcode(text) {
  const m = String(text || "").toUpperCase().match(/\b([A-Z]{1,2}\d{1,2}[A-Z]?)\s*(\d[A-Z]{2})\b/);
  if (!m) return "";
  return normalizeUkPostcode(`${m[1]} ${m[2]}`);
}

/** Prefer transport price over surcharge / fuel lines. */
function extractTransportPrice(text) {
  const t = String(text || "");
  const patterns = [
    /Price\s*\(\s*\+?\s*VAT\s*\)\s*[:.]?\s*£?\s*(\d+(?:\.\d{1,2})?)/i,
    /Job Price\s*[:.]?\s*(\d+(?:\.\d{1,2})?)/i,
    /(?:^|\n)Price\s*[:.]?\s*£?\s*(\d+(?:\.\d{1,2})?)/im,
  ];
  for (const pattern of patterns) {
    const m = t.match(pattern);
    if (m) return parseFloat(m[1]);
  }
  return null;
}

function extractPostcodesFromAddresses(text) {
  const t = String(text || "");
  let collection = "";
  let delivery = "";
  const coll = t.match(/Collection Address\s*:[\s\S]*?\b([A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2})\b/i);
  if (coll) collection = matchUkPostcode(coll[1]);
  const del = t.match(/Delivery Address\s*:[\s\S]*?\b([A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2})\b/i);
  if (del) delivery = matchUkPostcode(del[1]);
  return { collection, delivery };
}

function finalizeParsedData(parsed, rawText, { usedFallback = false } = {}) {
  const out = parsed || emptyParsedData();
  const source = sanitizeRawTextForParsing(rawText);
  if (!out.reg_number) {
    const reg = extractUkRegistration(source);
    if (reg) {
      out.reg_number = reg;
      out.confidence_scores.reg = usedFallback
        ? Math.max(out.confidence_scores.reg, 52)
        : Math.max(out.confidence_scores.reg, 85);
    }
  }
  const vals = Object.values(out.confidence_scores);
  if (vals.length) {
    out.overall_confidence = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
  }
  return out;
}

function clampScore(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
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
  return Array.isArray(parts)
    ? parts.map((p) => p.text || "").join("")
    : "";
}

function buildGenerateContentBody(rawText) {
  return {
    systemInstruction: {
      parts: [{ text: JOB_PARSER_SYSTEM_INSTRUCTION }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: String(rawText || "").trim() }],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json",
    },
  };
}

function lightRegexFallback(rawText) {
  const text = sanitizeRawTextForParsing(rawText);
  const out = emptyParsedData();
  const transportPrice = extractTransportPrice(text);
  if (transportPrice != null) {
    out.price = transportPrice;
    out.confidence_scores.price = 58;
  }
  const labelled = extractPostcodesFromAddresses(text);
  if (labelled.collection) {
    out.collection_address = labelled.collection;
    out.confidence_scores.collection = 55;
  }
  if (labelled.delivery) {
    out.postcode_delivery = labelled.delivery;
    out.confidence_scores.delivery = 55;
  }
  if (!out.collection_address || !out.postcode_delivery) {
    const postcodes = [];
    let m;
    const re = new RegExp(UK_POSTCODE_RE.source, UK_POSTCODE_RE.flags);
    while ((m = re.exec(text.toUpperCase())) !== null) {
      postcodes.push(normalizeUkPostcode(`${m[1]} ${m[2]}`));
    }
    if (!out.collection_address && postcodes[0]) {
      out.collection_address = postcodes[0];
      out.confidence_scores.collection = 40;
    }
    if (!out.postcode_delivery && postcodes[1]) {
      out.postcode_delivery = postcodes[1];
      out.confidence_scores.delivery = 40;
    }
  }
  const reg = extractUkRegistration(text);
  if (reg) {
    out.reg_number = reg;
    out.confidence_scores.reg = 52;
  }
  const vals = Object.values(out.confidence_scores);
  out.overall_confidence = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
  return finalizeParsedData(out, rawText, { usedFallback: true });
}

function geminiAuthHeaders(apiKey) {
  const key = String(apiKey || "").trim();
  return {
    "Content-Type": "application/json",
    "x-goog-api-key": key,
  };
}

/**
 * Gemini API (Gemini API enabled on project). Use a GCP API key — often
 * service-account-bound when "Gemini API" restriction is required.
 * @param {string} apiKey
 * @param {string} rawText
 */
async function callGeminiApiKeyOnce(apiKey, rawText, modelId) {
  const key = String(apiKey || "").trim();
  if (!key) {
    throw new Error("API key is required");
  }
  const model = modelId || JOB_PARSER_MODEL;
  const url =
    `${GEMINI_API_BASE}/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: geminiAuthHeaders(key),
    body: JSON.stringify(buildGenerateContentBody(rawText)),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText || `HTTP ${res.status}`;
    throw new Error(`${model}: ${msg}`);
  }
  const parsed = extractJsonObject(textFromGenerateContentResponse(data));
  if (!parsed) {
    throw new Error(`${model}: Gemini returned non-JSON output`);
  }
  return finalizeParsedData(normalizeGeminiParsed(parsed), rawText, { usedFallback: false });
}

function modelPreferenceScore(modelId) {
  const n = String(modelId || "").toLowerCase();
  if (!n || n.includes("embedding") || n.includes("imagen") || n.includes("aqa")) return -100;
  if (n.includes("gemini-2.5-flash") && !n.includes("preview")) return 100;
  if (n.includes("2.0-flash-lite")) return 90;
  if (n.includes("flash-lite")) return 85;
  if (n.includes("2.5-flash")) return 80;
  if (n === "gemini-2.0-flash" || n.endsWith("/gemini-2.0-flash")) return 5;
  if (n.includes("flash")) return 60;
  return 40;
}

function rankModelIds(modelIds) {
  return [...new Set(modelIds)].sort((a, b) => modelPreferenceScore(b) - modelPreferenceScore(a));
}

/**
 * @param {string} apiKey
 * @returns {Promise<string[]>}
 */
async function listGeminiModelIds(apiKey) {
  const now = Date.now();
  if (cachedModelIds && now - cachedModelIdsAt < MODEL_CACHE_MS) {
    return cachedModelIds;
  }
  const url = `${GEMINI_API_BASE}/models?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, { headers: geminiAuthHeaders(apiKey) });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || res.statusText || "ListModels failed");
  }
  const ids = (data.models || [])
    .filter((m) => {
      const methods = m.supportedGenerationMethods;
      return Array.isArray(methods) && methods.includes("generateContent");
    })
    .map((m) => String(m.name || "").replace(/^models\//, ""))
    .filter(Boolean);
  cachedModelIds = ids;
  cachedModelIdsAt = now;
  functions.logger.info("parseJobText: ListModels", { count: ids.length, top: ids.slice(0, 5) });
  return ids;
}

/**
 * @param {string} apiKey
 * @returns {Promise<string[]>}
 */
async function getModelCandidates(apiKey) {
  try {
    const listed = await listGeminiModelIds(apiKey);
    if (listed.length) {
      return rankModelIds(listed).slice(0, 12);
    }
  } catch (err) {
    functions.logger.warn("parseJobText: ListModels failed, using static model list", {
      error: err.message || String(err),
    });
  }
  return rankModelIds([JOB_PARSER_MODEL, ...GEMINI_MODEL_FALLBACKS]);
}

/**
 * @param {string} apiKey
 * @param {string} rawText
 * @returns {Promise<{ parsed: object, model: string }>}
 */
async function parseJobTextWithGemini(apiKey, rawText) {
  const input = sanitizeRawTextForParsing(rawText);
  if (!input) {
    throw new Error("rawText is required");
  }
  const key = String(apiKey || "").trim();
  if (!key) {
    throw new Error("GOOGLE_AI_API_KEY is not set");
  }

  const models = await getModelCandidates(key);
  const errors = [];
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const parsed = await callGeminiApiKeyOnce(key, input, model);
        return { parsed, model };
      } catch (err) {
        const msg = err.message || String(err);
        errors.push(msg);
        functions.logger.warn("parseJobText: model attempt failed", { model, attempt, error: msg });
      }
    }
  }
  throw new Error(errors[errors.length - 1] || "Gemini parse failed");
}

/**
 * @param {string} apiKey
 * @param {{ rawText?: string }} data
 */
async function handleParseJobText(apiKey, data) {
  const rawText = data && data.rawText != null ? String(data.rawText) : "";
  if (!rawText.trim()) {
    return { success: false, error: "rawText is required" };
  }
  if (!String(apiKey || "").trim()) {
    return {
      success: false,
      error:
        "GOOGLE_AI_API_KEY is not set. Create a Gemini API key in GCP (service-account-bound), then: firebase functions:secrets:set GOOGLE_AI_API_KEY",
    };
  }

  try {
    const { parsed: parsed_data, model: parser_model } = await parseJobTextWithGemini(apiKey, rawText);
    return { success: true, parsed_data, parser_source: "gemini", parser_model };
  } catch (geminiErr) {
    functions.logger.warn("parseJobText: Gemini failed, using regex fallback", {
      error: geminiErr.message || String(geminiErr),
    });
    try {
      const parsed_data = lightRegexFallback(rawText);
      return {
        success: true,
        parsed_data,
        parser_source: "fallback",
        parser_warning: "Gemini unavailable; used low-confidence fallback",
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
  handleParseJobText,
  normalizeGeminiParsed,
  parseJobTextWithGemini,
  lightRegexFallback,
};
