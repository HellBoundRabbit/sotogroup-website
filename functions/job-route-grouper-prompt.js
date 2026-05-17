/**
 * Gemini system instruction: group Asana task titles into driver routes.
 */
const ROUTE_GROUPER_MODEL = "gemini-2.5-flash";

const ROUTE_GROUPER_SYSTEM_INSTRUCTION = `You group Asana task TITLES into ROUTES for a UK vehicle logistics office.

INPUT: JSON array of tasks: { "asana_gid": string, "title": string }. Use TITLE ONLY.

OUTPUT: JSON ONLY (no markdown):
{
  "routes": [
    {
      "driver_key": "Lee",
      "incomplete_route": false,
      "jobs": [
        { "asana_gid": "...", "title": "...", "sequence_number": 1 }
      ]
    }
  ],
  "irrelevant": [
    { "asana_gid": "...", "title": "...", "reason": "off_day" }
  ],
  "warnings": [],
  "summary": {
    "total_tasks": 0,
    "routes_created": 0,
    "complete_routes": 0,
    "incomplete_routes": 0,
    "irrelevant_tasks": 0,
    "relevant_jobs_in_routes": 0
  }
}

STEP 1 — CLASSIFY

IRRELEVANT (reason codes: off_day | standby | full | carryover_delivery | admin | not_a_job):
- "{Name} Off", standby, "Full"
- "(1) {Name} Deliver carry over" (any carry-over-only morning task)
- Non-move admin titles

RELEVANT vehicle_move: driver prefix + (n) + reg/postcodes/places (UK moves).
FREE / INCOMPLETE markers (do NOT add as jobs — use incomplete_route instead):
- "(2) Lee Free", "(3) Sajil TBC", or highest sequence ends with Free/TBC → incomplete_route: true
- When incomplete_route is true, jobs[] contains ONLY real vehicle moves (numbered moves with reg/postcodes), NOT the Free/TBC row

driver_key: text before (n), title-cased ("lee" → "Lee"). Keep disambiguators: "Lee X" vs "Lee Y".

STEP 2 — BUILD ROUTES
- One route per driver_key per day (all their numbered moves together)
- Sort jobs by sequence_number
- Missing sequence numbers: still one route; add warning
- Unnumbered but clearly same driver move: attach with warning
- 1–4+ jobs per route allowed

incomplete_route: true when the route still needs a final job (last planned slot is Free or TBC).

INTEGRITY: every input gid exactly once in routes.jobs OR irrelevant.`;

module.exports = {
  ROUTE_GROUPER_MODEL,
  ROUTE_GROUPER_SYSTEM_INSTRUCTION,
};
