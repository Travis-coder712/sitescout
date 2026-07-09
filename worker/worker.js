/**
 * SiteScout — Cloudflare Worker proxy for the Anthropic Messages API.
 *
 * Holds the Anthropic API key server-side so the public PWA never sees it.
 * Gates every request behind a shared team access code, adds CORS for the
 * GitHub Pages origin, and returns structured JSON the PWA can render directly.
 *
 * Secrets / vars (set with `wrangler secret put` or in the dashboard):
 *   ANTHROPIC_API_KEY  (secret)  — your Anthropic key
 *   ACCESS_CODE        (secret)  — shared code your field team enters once
 *   ALLOWED_ORIGIN     (var)     — e.g. https://travis-coder712.github.io
 *                                   (use "*" only for local testing)
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-5";
const ANTHROPIC_VERSION = "2023-06-01";

// ---- Prompts ---------------------------------------------------------------

const BASE_PERSONA = `You are SiteScout, a health, safety and environment (HSE) field assistant for people doing site investigation, geotechnical and similar work at remote, non-industrial sites in Australia. Your users are often NOT trained HSE professionals. Write in plain, direct language — no jargon, no acronyms without expansion. You PROMPT a competent person to look, think and verify; you never certify a site as safe. Be specific and practical, not generic. Prioritise the hazards most likely to cause serious harm. Consider environmental issues as first-class, not an afterthought: fuel/oil spills and drip trays, sediment and erosion into waterways, weed and pathogen hygiene between sites (e.g. Phytophthora, weed seed), proximity to vegetation/watercourses, fauna, and cultural/Aboriginal heritage ground disturbance. Australian context (Safe Work Australia / state WHS).`;

const DISCLAIMER =
  "This is an AI prompt to support a competent person. It does not replace a formal risk assessment (JSEA/SWMS) or a qualified HSE advisor. Verify everything on site.";

const SCAN_PROMPT = `${BASE_PERSONA}

You are shown a photo of a work site or work activity. Identify hazards and "things to look out for". For each, give a plain-language title, the risk level, what specifically to watch for in this scene, and a suggested control framed as something to check or do. Include environmental and health items where relevant. Also list a few good practices you can see. If the image is unclear or not a work site, say so in the summary and return whatever you can.`;

const JSEA_PROMPT = `${BASE_PERSONA}

You are reviewing a Job Safety and Environmental Analysis (JSEA/SWMS) or a description of planned work that has NOT yet started. Act as a critical friend. Identify gaps and give pointed questions the crew should answer before starting, plus hazards they may not have considered and suggested controls. Cover safety, health and environment. Be specific to the work described.`;

const DESCRIBE_PROMPT = `${BASE_PERSONA}

You are given a short description of planned work at a site that has NOT yet started (no photo available). Produce a pre-start hazard prompt list and suggested JSEA line items so a non-HSE person knows what to look out for and plan for. Cover safety, health and environment, specific to the described work.`;

const JOURNEY_PROMPT = `${BASE_PERSONA}

You are helping plan a drive to or from a remote work site (a "journey management plan"). Given the trip details, identify route and driving hazards to watch for and practical controls. Consider: fatigue and the 2-hour-maximum driving-before-a-break rule, unsealed roads, wildlife at dawn/dusk, fuel range and point-of-no-return, mobile coverage blackspots, weather, and lone-worker check-in. Be specific to the described trip.`;

// Shared JSON schema for the hazard-list modes (scan / jsea / describe).
const HAZARD_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    site_type: { type: "string" },
    hazards: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string", enum: ["safety", "environment", "health"] },
          title: { type: "string" },
          risk: { type: "string", enum: ["low", "medium", "high"] },
          watch_for: { type: "string" },
          suggested_control: { type: "string" },
        },
        required: ["category", "title", "risk", "watch_for", "suggested_control"],
        additionalProperties: false,
      },
    },
    questions: { type: "array", items: { type: "string" } },
    good_practices: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "site_type", "hazards", "questions", "good_practices"],
  additionalProperties: false,
};

const JOURNEY_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    hazards: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string", enum: ["fatigue", "road", "wildlife", "remote", "weather", "comms"] },
          title: { type: "string" },
          risk: { type: "string", enum: ["low", "medium", "high"] },
          watch_for: { type: "string" },
          suggested_control: { type: "string" },
        },
        required: ["category", "title", "risk", "watch_for", "suggested_control"],
        additionalProperties: false,
      },
    },
    checklist: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "hazards", "checklist"],
  additionalProperties: false,
};

// ---- Worker ----------------------------------------------------------------

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "POST") {
      return json({ error: "POST only" }, 405, cors);
    }

    // Gate on the shared team access code.
    const provided = request.headers.get("x-sitescout-access") || "";
    if (!env.ACCESS_CODE || provided !== env.ACCESS_CODE) {
      return json({ error: "Invalid or missing access code." }, 401, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Bad JSON." }, 400, cors);
    }

    const mode = body.mode;
    const userContent = buildUserContent(mode, body);
    if (!userContent) {
      return json({ error: "Unknown or incomplete request." }, 400, cors);
    }

    const isJourney = mode === "journey";
    const payload = {
      model: MODEL,
      max_tokens: 3000,
      thinking: { type: "disabled" }, // fast single-shot; enable adaptive for deeper analysis
      system: systemFor(mode),
      output_config: {
        format: {
          type: "json_schema",
          schema: isJourney ? JOURNEY_SCHEMA : HAZARD_SCHEMA,
        },
      },
      messages: [{ role: "user", content: userContent }],
    };

    let apiRes;
    try {
      apiRes = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      return json({ error: "Upstream request failed.", detail: String(e) }, 502, cors);
    }

    if (!apiRes.ok) {
      const text = await apiRes.text();
      return json({ error: "Analysis failed.", status: apiRes.status, detail: text }, apiRes.status, cors);
    }

    const data = await apiRes.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    if (!textBlock) {
      return json({ error: "No analysis returned." }, 502, cors);
    }

    let result;
    try {
      result = JSON.parse(textBlock.text);
    } catch {
      return json({ error: "Malformed analysis.", raw: textBlock.text }, 502, cors);
    }

    result.disclaimer = DISCLAIMER;
    result.mode = mode;
    return json(result, 200, cors);
  },
};

function systemFor(mode) {
  switch (mode) {
    case "scan": return SCAN_PROMPT;
    case "jsea": return JSEA_PROMPT;
    case "describe": return DESCRIBE_PROMPT;
    case "journey": return JOURNEY_PROMPT;
    default: return BASE_PERSONA;
  }
}

function buildUserContent(mode, body) {
  if (mode === "scan") {
    if (!body.image || !body.media_type) return null;
    return [
      { type: "image", source: { type: "base64", media_type: body.media_type, data: body.image } },
      { type: "text", text: body.note
          ? `Context from the worker: ${body.note}`
          : "Analyse this work site photo for hazards and things to look out for." },
    ];
  }
  if (mode === "jsea") {
    if (!body.text) return null;
    return [{ type: "text", text: `Here is the JSEA / planned work to review:\n\n${body.text}` }];
  }
  if (mode === "describe") {
    if (!body.text) return null;
    return [{ type: "text", text: `Planned work description:\n\n${body.text}` }];
  }
  if (mode === "journey") {
    const t = [
      body.from && `From: ${body.from}`,
      body.to && `To: ${body.to}`,
      body.hours != null && `Estimated driving time: ${body.hours} hours`,
      body.notes && `Notes: ${body.notes}`,
    ].filter(Boolean).join("\n");
    if (!t) return null;
    return [{ type: "text", text: `Trip details:\n${t}` }];
  }
  return null;
}

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-sitescout-access",
    "Access-Control-Max-Age": "86400",
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}
