// jam auto-routing — pick a model weight from the shape of the ask.
// Pure and dependency-free so it can be unit-tested offline (route.test.mjs, run by check.sh).

export const TIERS = {
  light:  { model: "claude-haiku-4-5-20251001", label: "Haiku 4.5",  window: 200000 },
  medium: { model: "claude-sonnet-5",           label: "Sonnet 5",   window: 200000 },
  heavy:  { model: "claude-opus-5",             label: "Opus 5",     window: 200000 },  // was Fable 5.1; Mike 2026-09-15: Fable weekly quota is scarce, pin it by hand when a turn truly needs it
};
export const ORDER = ["light", "medium", "heavy"];

// A session whose context is already past a smaller model's window can only run on the big one —
// this is correctness, not cost. Keep headroom for the turn itself.
export const SMALL_WINDOW_SAFE = 150000;

// Score cutoffs for light→medium→heavy. Overridable per call (bridge.mjs persists a learned override to
// ~/.jam/router-weights.json and passes it in) so the router can self-tune from logged misses without a code change.
export const DEFAULT_THRESHOLDS = { mediumAt: 1, heavyAt: 3 };

const HEAVY = [
  /\b(build|implement|refactor|architect|design|migrat\w+|optimi[sz]e|debug|diagnos\w+|root ?cause|investigate)\b/i,
  /\b(deploy|ship|release|rollback|publish)\b/i,
  /\b(write|create|add|generate|draft)\b.{0,40}\b(test|suite|script|module|component|endpoint|schema|worker|page|feature|doc)\w*\b/i,
  /\b(audit|review|harden|secure|threat model)\b/i,
  /\b(why (is|does|did|are)|how (do|does|should) (i|we)|what.{0,12}(wrong|broken|failing))\b/i,
  /\b(plan|strategy|trade-?offs?|options|approach)\b/i,
];
const MEDIUM = [
  /\b(fix|change|update|rename|move|adjust|tweak|make|set|swap|replace|remove|delete|revert)\b/i,
  /\b(explain|summar\w+|compare|check|verify|confirm|show me|walk me)\b/i,
  /\b(run|test|deploy|commit|push|open|close)\b/i,
];
const LIGHT = [
  /^(hi|hey|hello|yo|sup|thanks|thank you|ty|ok(ay)?|cool|nice|lol|haha|got it|gotcha|k|yes|no|yep|nope|sure|perfect|great|awesome|sweet|👍|🙏|🔥)\b[\s.!?:)]*$/i,
  /^(what|who|where|when)('| i)?s? (the |your |our )?(status|name|time|date|room|model|cost|price)\b.{0,30}$/i,
  /^(are you|you) (there|up|alive|working|done|ready)\b.{0,20}$/i,
  /^(test|ping|anything|hello world)\b[\s.!?]*$/i,
];
const CODEY = [/```/, /\b\/(Users|home|tmp|var|opt)\//, /\.(js|mjs|ts|tsx|py|sh|html|css|json|yaml|yml|toml|md)\b/, /\b(function|const |class |import |SELECT |curl |git |npm |node )/];

/**
 * @param {string} text          the message
 * @param {object} o
 * @param {number} o.attachments how many files came with it
 * @param {boolean} o.mention    does it @mention a teammate (subagent work is heavy)
 * @param {string} o.role        sender's role (scheduler for scheduled turns)
 * @param {string} o.forceTier   "light"|"medium"|"heavy" — pin this tier instead of scoring (bump + ctx guard still apply)
 * @param {number} o.ctx         tokens the session's context held after the last turn
 * @param {number} o.bump        escalate this many tiers (used when a turn is retried)
 * @param {object} o.thresholds  override DEFAULT_THRESHOLDS (self-tuned weights from tune-router.mjs)
 * @returns {{tier:string, model:string, label:string, score:number, why:string}}
 */
export function route(text, o = {}) {
  const t = String(text || "");
  const attachments = o.attachments | 0, ctx = o.ctx | 0, bump = o.bump | 0;
  const th = { ...DEFAULT_THRESHOLDS, ...(o.thresholds || {}) };
  const reasons = [];
  const forced = ORDER.includes(o.forceTier) ? o.forceTier : null;
  let score = null, idx;

  if (forced) {
    // a pinned tier (per-schedule --tier) replaces scoring and the scheduler floor, but NOT the
    // retry escalation below or the context-window guard: those are correctness, not cost.
    idx = ORDER.indexOf(forced); reasons.push("pinned " + forced);
  } else {
    score = 0;
    const chatty = LIGHT.some(re => re.test(t.trim()));
    if (chatty) { score -= 3; reasons.push("chatty"); }
    const heavy = HEAVY.filter(re => re.test(t)).length;
    if (heavy) { score += heavy > 1 ? 4 : 3; reasons.push("build/diagnose wording"); }
    const medium = MEDIUM.filter(re => re.test(t)).length;
    if (medium && !heavy) { score += 2; reasons.push("change request"); }
    if (attachments) { score += 3; reasons.push(attachments + " attachment" + (attachments > 1 ? "s" : "")); }
    if (o.mention) { score += 3; reasons.push("@teammate"); }
    if (t.length > 600) { score += 2; reasons.push("long"); }
    else if (t.length > 200) { score += 1; reasons.push("detailed"); }
    if (/\n\s*([-*•]|\d+[.)])\s/.test(t) || /\band then\b/i.test(t)) { score += 1; reasons.push("multi-step"); }
    if (CODEY.some(re => re.test(t))) { score += 1; reasons.push("code/paths"); }
    if (!score && !chatty && t.length < 40) { score -= 1; reasons.push("brief"); } // no signal at all and tiny
    idx = score >= th.heavyAt ? 2 : score >= th.mediumAt ? 1 : 0;
  }

  idx = Math.min(2, idx + Math.max(0, bump));
  if (bump > 0) reasons.push("retry escalation");
  // unattended turns get a medium floor (not a bump): light models mishandle multi-step reports
  if (!forced && o.role === "scheduler" && idx < 1) { idx = 1; reasons.push("scheduled automation floor"); }

  // hard constraint: the conversation must fit the model's window
  if (ctx > SMALL_WINDOW_SAFE && idx < 2) { idx = 2; reasons.push("context " + Math.round(ctx / 1000) + "k needs the 1M window"); }

  const tier = ORDER[idx];
  return { tier, model: TIERS[tier].model, label: TIERS[tier].label, score, why: reasons.join(", ") || "short ask" };
}
