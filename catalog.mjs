// jam model catalog — shape Anthropic's Models API list + published prices into what the bridge and UI use.
// Pure and dependency-free so it can be unit-tested offline (catalog.test.mjs, run by check.sh).

const LEVELS = ["low", "medium", "high", "xhigh", "max"];

// "| Claude Opus 5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |" → { in, cacheRead, out }.
// The first table on the pricing page is base pricing; later ones (batch, long context) repeat names, so the first row wins.
// Columns are located from each table's header row ("Base Input", "Cache Hits", "Output"), so an added or reordered
// column can't silently shift prices; a table without those headers is ignored.
export function parsePrices(md) {
  const out = {}, usd = c => { const m = /\$([\d.]+)\s*\/\s*MTok/.exec(c || ""); return m ? +m[1] : null; };
  let col = null;
  for (const line of String(md || "").split("\n")) {
    if (!line.includes("|")) { col = null; continue; }
    const c = line.split("|").map(x => x.trim());
    if (/^model$/i.test(c[1])) { const at = re => c.findIndex(x => re.test(x)); const i = at(/base input/i), o = at(/^output/i); col = i > 0 && o > 0 ? { i, o, h: at(/cache hits?/i) } : null; continue; }
    if (!col) continue;
    const name = (c[1] || "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\s*\(.*?\)\s*/g, "").trim();
    if (!/^Claude /.test(name) || usd(c[col.i]) == null || usd(c[col.o]) == null || out[name]) continue;
    out[name] = { in: usd(c[col.i]), cacheRead: col.h > 0 ? usd(c[col.h]) : null, out: usd(c[col.o]) };
  }
  return out;
}

// Models API `data` → [{ id, label, family, window, maxOut, effort[], price, current }]; `current` = newest of its family
export function shapeModels(data, prices = {}) {
  const models = (Array.isArray(data) ? data : []).filter(m => m && m.id).map(m => {
    const e = m.capabilities?.effort; // capabilities can be null: then effort is unknown (null), not "none" ([])
    return { id: m.id, label: String(m.display_name || m.id).replace(/^Claude /, ""), family: (/(fable|mythos|opus|sonnet|haiku)/.exec(m.id) || [])[1] || String(m.id).replace(/^claude-/, "").split("-")[0] || null,
      created: Date.parse(m.created_at) || 0, window: m.max_input_tokens || null, maxOut: m.max_tokens || null,
      effort: !e ? null : e.supported ? LEVELS.filter(l => e[l]?.supported) : [], price: prices[m.display_name] || null };
  });
  const newest = {};
  for (const m of models) if (m.family && (!newest[m.family] || m.created > newest[m.family].created)) newest[m.family] = m;
  return models.map(({ created, ...m }, i) => ({ ...m, current: newest[m.family] === models[i] }));
}
