/**
 * Build full Asana task text for parseJobText (title, notes, custom fields).
 */
(function (globalRef) {
  function formatCustomFields(customFields) {
    if (!Array.isArray(customFields) || !customFields.length) {
      return "";
    }
    const lines = [];
    for (const field of customFields) {
      if (!field || typeof field !== "object") continue;
      const label = field.name || field.gid || "Field";
      let value = "";
      if (field.display_value != null && String(field.display_value).trim()) {
        value = String(field.display_value).trim();
      } else if (field.text_value != null && String(field.text_value).trim()) {
        value = String(field.text_value).trim();
      } else if (field.number_value != null && field.number_value !== "") {
        value = String(field.number_value);
      } else if (field.enum_value && field.enum_value.name) {
        value = String(field.enum_value.name);
      } else if (field.multi_enum_values && field.multi_enum_values.length) {
        value = field.multi_enum_values.map((v) => v.name).filter(Boolean).join(", ");
      }
      if (value) {
        lines.push(`${label}: ${value}`);
      }
    }
    return lines.length ? lines.join("\n") : "";
  }

  function buildTaskTextForParsing(task) {
    if (task == null) return "";
    if (typeof task === "string") return task.trim();

    const name = task.name != null ? String(task.name).trim() : "";
    const notes = task.notes != null ? String(task.notes).trim() : "";
    const customBlock = formatCustomFields(task.custom_fields);

    const parts = [];
    if (name) {
      parts.push("=== TASK TITLE ===", name);
    }
    if (notes) {
      parts.push("=== NOTES ===", notes);
    }
    if (customBlock) {
      parts.push("=== CUSTOM FIELDS ===", customBlock);
    }
    if (!parts.length) {
      return name || notes || customBlock || "";
    }
    return parts.join("\n\n");
  }

  /**
   * Run async workers in parallel batches (e.g. 20 parseJobText calls at a time).
   * @template T,R
   * @param {T[]} items
   * @param {(item: T, index: number) => Promise<R>} worker
   * @param {number} [batchSize=20]
   * @returns {Promise<R[]>}
   */
  async function mapInBatches(items, worker, batchSize = 20) {
    const results = [];
    const list = Array.isArray(items) ? items : [];
    const size = Math.max(1, batchSize || 20);
    for (let i = 0; i < list.length; i += size) {
      const batch = list.slice(i, i + size);
      const batchResults = await Promise.all(
        batch.map((item, j) => worker(item, i + j)),
      );
      results.push(...batchResults);
    }
    return results;
  }

  const api = {
    buildTaskTextForParsing,
    formatCustomFields,
    mapInBatches,
  };
  if (globalRef) {
    globalRef.sotoAsanaTaskText = api;
  }
})(
  typeof globalThis !== "undefined"
    ? globalThis
    : typeof window !== "undefined"
      ? window
      : typeof self !== "undefined"
        ? self
        : this,
);
