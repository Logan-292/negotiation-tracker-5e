/**
 * Профили игровых систем.
 * Бонусы с листа персонажа НЕ подставляются автоматически: структура данных систем
 * не проверялась, поэтому игрок всегда вводит число сам. Все броски (кроме dnd5e)
 * делаются через базовые средства Foundry (Roll, DialogV2, ChatMessage).
 * Каждый профиль описывает: какие бывают проверки, чем бросать и как считать успех.
 * Режимы:
 *   high  — бросок + бонус, сравнивается с Сл (d20, 2d10, d10, 2d6)
 *   under — бросок должен быть не больше цели (d100 в WFRP, d20 в OSR)
 *   pool  — пул d10, считаются успехи (Vampire)
 *
 */

const T = (k, d) => game.i18n.format(`NT5E.${k}`, d ?? {});
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const safe = (fn) => { try { const v = fn(); return v === undefined ? null : v; } catch { return null; } };
const has = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));

export const PROFILES = {
  dnd5e: {
    id: "dnd5e", systems: ["dnd5e"], native: true,
    mode: "high", die: "1d20", adv: true, dcKind: "dc", dc: { success: 10, great: 15 }, gap: 5,
    defaults: { argument: "per", read: "ins" }
  },
  pf2e: {
    id: "pf2e", systems: ["pf2e"],
    mode: "high", die: "1d20", natShift: true, dcKind: "dc", dc: { success: 15, great: 25 }, gap: 10,
    defaults: { argument: "diplomacy", read: "perception" },
    checks: ["diplomacy", "intimidation", "deception", "performance", "society", "perception"]
  },
  wfrp4e: {
    id: "wfrp4e", systems: ["wfrp4e"],
    mode: "under", die: "1d100", dcKind: "under", dc: { success: 0, great: 2 }, gap: 2,
    defaults: { argument: "charm", read: "intuition" },
    checks: ["charm", "gossip", "haggle", "intimidate", "leadership", "bribery", "intuition", "perception"]
  },
  vtm5e: {
    id: "vtm5e", systems: ["vtm5e", "wod5e"],
    mode: "pool", die: "d10", dcKind: "pool", dc: { success: 2, great: 4 }, gap: 2,
    defaults: { argument: "persuasion", read: "insight" },
    checks: ["persuasion", "subterfuge", "intimidation", "etiquette", "leadership", "streetwise", "performance", "insight"]
  },
  osr: {
    id: "osr", systems: ["ose"],
    mode: "high", die: "2d6", dcKind: "dc", dc: { success: 6, great: 9 }, gap: 3,
    defaults: { argument: "reaction", read: "wisdom" },
    checks: [
      { id: "reaction", mode: "high", die: "2d6" },
      { id: "charisma", mode: "under", die: "1d20", greatMargin: 5 },
      { id: "wisdom", mode: "under", die: "1d20", greatMargin: 5 }
    ]
  },
  drawsteel: {
    id: "drawsteel", systems: ["draw-steel"],
    mode: "high", die: "2d10", edges: true, dcKind: "dc", dc: { success: 12, great: 17 }, gap: 5,
    defaults: { argument: "presence", read: "intuition" },
    checks: ["presence", "reason", "intuition", "might", "agility"]
  },
  cthulhu: {
    id: "cthulhu", systems: ["CoC7", "coc7"], roller: "coc",
    mode: "under", die: "1d100", dcKind: "coc", dc: { success: 0, great: 1 }, gap: 1,
    defaults: { argument: "persuade", read: "psychology" },
    checks: ["persuade", "charm", "fastTalk", "intimidate", "psychology"]
  },
  generic: {
    id: "generic", systems: [],
    mode: "high", die: "1d20", adv: true, dcKind: "dc", dc: { success: 10, great: 15 }, gap: 5,
    defaults: { argument: "persuasion", read: "insight" },
    checks: ["persuasion", "deception", "intimidation", "insight"]
  }
};

export const PROFILE_IDS = Object.keys(PROFILES);

/** Профиль по id игровой системы Foundry. */
export function detectProfile(systemId = game.system.id) {
  for (const p of Object.values(PROFILES)) if (p.systems.includes(systemId)) return p.id;
  return "generic";
}

const normCheck = (c) => (typeof c === "string" ? { id: c } : c);

/** Список проверок профиля: [{id, label}] */
export function getChecks(profileId) {
  const p = PROFILES[profileId] ?? PROFILES.generic;
  if (p.native) {
    return Object.entries(CONFIG.DND5E?.skills ?? {})
      .map(([id, v]) => ({ id, label: v.label ?? String(v) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }
  return (p.checks ?? []).map(normCheck).map((c) => ({ id: c.id, label: T(`Check.${p.id}.${c.id}`) }));
}

export function checkLabel(profileId, checkId) {
  return getChecks(profileId).find((c) => c.id === checkId)?.label ?? checkId;
}

/** Итоговые параметры проверки (режим, куб, запас для under). */
export function checkSpec(profileId, checkId) {
  const p = PROFILES[profileId] ?? PROFILES.generic;
  const own = (p.checks ?? []).map(normCheck).find((c) => c.id === checkId) ?? {};
  return {
    id: checkId, profile: p.id,
    mode: own.mode ?? p.mode,
    die: own.die ?? p.die,
    greatMargin: own.greatMargin ?? p.dc.great,
    adv: p.adv && (own.die ?? p.die) === "1d20" && (own.mode ?? p.mode) === "high",
    edges: !!p.edges, natShift: !!p.natShift
  };
}

export function defaultCheck(profileId, kind) {
  const p = PROFILES[profileId] ?? PROFILES.generic;
  const wanted = p.defaults?.[kind];
  const list = getChecks(p.id);
  return list.some((c) => c.id === wanted) ? wanted : (list[0]?.id ?? "");
}

/** Сл/пороги для конкретного НПС с учётом его ручных значений. */
export function dcFor(profileId, spec, npc = {}) {
  const p = PROFILES[profileId] ?? PROFILES.generic;
  if (spec.mode === "under") return { success: 0, great: has(npc.dcGreat) ? Number(npc.dcGreat) : spec.greatMargin };
  const success = has(npc.dcSuccess) ? Number(npc.dcSuccess) : p.dc.success;
  const great = has(npc.dcGreat) ? Number(npc.dcGreat) : (has(npc.dcSuccess) ? success + p.gap : p.dc.great);
  return { success, great };
}

/* ------------------------------------------------------------------ */
/*  Бросок на стороне игрока                                           */
/* ------------------------------------------------------------------ */

const field = (label, input) => `<div class="form-group"><label>${label}</label><div class="form-fields">${input}</div></div>`;
const sel = (name, options, value) => `<select name="${name}">${options.map(([v, l]) =>
  `<option value="${v}" ${v === value ? "selected" : ""}>${l}</option>`).join("")}</select>`;

async function ask(title, content) {
  const data = await foundry.applications.api.DialogV2.prompt({
    window: { title },
    content: `<div class="nt5e-dialog">${content}</div>`,
    ok: {
      label: T("Dialog.roll"),
      callback: (event, button) => Object.fromEntries(
        [...button.form.elements].filter((e) => e.name).map((e) => [e.name, e.value])
      )
    },
    rejectClose: false
  });
  return data ?? null;
}

const speaker = (actor) => ChatMessage.getSpeaker({ actor });
const sign = (n) => (n >= 0 ? `+ ${n}` : `- ${Math.abs(n)}`);

/**
 * Игрок делает проверку. Возвращает результат для трекера либо null (отмена).
 * { mode, total, margin, crit, auto3, shift, display }
 */
export async function rollCheck(profileId, checkId, actor, { advantage = false } = {}) {
  const p = PROFILES[profileId] ?? PROFILES.generic;
  const label = checkLabel(p.id, checkId);

  // dnd5e — штатный бросок системы (с её окном, бонусами и преимуществом)
  if (p.native) {
    const rolls = await actor.rollSkill({ skill: checkId, ...(advantage ? { advantage: true } : {}) });
    const roll = Array.isArray(rolls) ? rolls[0] : rolls;
    if (!roll) return null;
    const die = roll.d20 ?? roll.dice?.[0];
    return { mode: "high", total: roll.total, crit: die?.total === 20, display: String(roll.total) };
  }

  const spec = checkSpec(p.id, checkId);
  const preNum = null;
  const title = `${label} — ${actor.name}`;

  if (p.roller === "coc") return rollCoc(actor, title);
  if (spec.mode === "pool") return rollPool(p, actor, label, title);
  if (spec.mode === "under") return rollUnder(spec, actor, label, title, preNum);
  return rollHigh(p, spec, actor, label, title, preNum, advantage);
}

async function rollHigh(p, spec, actor, label, title, pre, advantage) {
  let html = field(T("Dialog.modifier"), `<input type="number" name="mod" value="${pre ?? 0}">`);
  if (spec.adv) {
    html += field(T("Dialog.adv"), sel("adv", [
      ["normal", T("Dialog.advNormal")], ["adv", T("Advantage")], ["dis", T("Dialog.advDis")]
    ], advantage ? "adv" : "normal"));
  }
  if (spec.edges) {
    html += field(T("Dialog.edge"), sel("edge", [
      ["dbane", T("Dialog.doubleBane")], ["bane", T("Dialog.bane")], ["none", "—"],
      ["edge", T("Dialog.edgeOne")], ["dedge", T("Dialog.doubleEdge")]
    ], "none"));
  }
  const inp = await ask(title, html);
  if (!inp) return null;

  let die = spec.die;
  if (spec.adv && inp.adv === "adv") die = "2d20kh";
  if (spec.adv && inp.adv === "dis") die = "2d20kl";
  let mod = num(inp.mod);
  let shift = 0;
  if (spec.edges) {
    if (inp.edge === "edge") mod += 2;
    if (inp.edge === "bane") mod -= 2;
    if (inp.edge === "dedge") shift = 1;
    if (inp.edge === "dbane") shift = -1;
  }

  const roll = await new Roll(`${die} ${sign(mod)}`).evaluate();
  const diceTotal = roll.dice.reduce((s, d) => s + d.total, 0);
  const first = roll.dice[0]?.results?.find((r) => r.active)?.result;
  let crit = false;
  let auto3 = false;

  if (spec.die === "1d20") crit = first === 20;
  if (spec.edges && diceTotal >= 19) { auto3 = true; crit = true; }   // Draw Steel: натуральные 19–20 = тир 3
  if (spec.natShift) {                                                 // PF2e: нат. 20 / 1 меняют степень на шаг
    if (first === 20) shift += 1;
    if (first === 1) shift -= 1;
  }

  await roll.toMessage({ speaker: speaker(actor), flavor: title });
  return { mode: "high", total: roll.total, crit, auto3, shift, display: String(roll.total) };
}

async function rollUnder(spec, actor, label, title, pre) {
  const html = field(T("Dialog.target"), `<input type="number" name="target" value="${pre ?? ""}" required>`)
    + field(T("Dialog.difficulty"), `<input type="number" name="mod" value="0">`);
  const inp = await ask(title, html);
  if (!inp || inp.target === "") return null;

  const target = num(inp.target) + num(inp.mod);
  const roll = await new Roll(spec.die).evaluate();
  const r = roll.total;
  let success;
  let margin;
  let crit = false;

  if (spec.die === "1d100") {
    success = r <= target;
    if (r <= 5) success = true;           // WFRP: 01–05 всегда успех
    if (r >= 96) success = false;         // 96–00 всегда провал
    const sl = Math.floor(target / 10) - Math.floor(r / 10);
    margin = success ? Math.max(0, sl) : Math.min(-1, sl);
    crit = success && (r % 11 === 0 || r === 100);   // дубли
  } else {
    success = r <= target && r !== 20;
    margin = success ? Math.max(0, target - r) : Math.min(-1, target - r);
    crit = r === 1;
  }

  const shown = spec.die === "1d100" ? `SL ${margin >= 0 ? "+" : ""}${margin}` : `${success ? "✓" : "✗"} (${margin >= 0 ? "+" : ""}${margin})`;
  await roll.toMessage({
    speaker: speaker(actor),
    flavor: `${title} · ${T("Dialog.target")}: ${target} · ${shown}${crit ? ` · ${T("Dialog.crit")}` : ""}`
  });
  return { mode: "under", margin, crit, display: shown };
}

async function rollPool(p, actor, label, title) {
  const html = field(T("Dialog.pool"), `<input type="number" name="pool" value="" min="1" required>`)
    + field(T("Dialog.hunger"), `<input type="number" name="hunger" value="0" min="0" max="5">`);
  const inp = await ask(title, html);
  if (!inp || inp.pool === "") return null;

  const pool = Math.max(1, Math.trunc(num(inp.pool)));
  const hungerDice = Math.min(pool, Math.max(0, Math.trunc(num(inp.hunger))));
  const normalDice = pool - hungerDice;

  const rn = normalDice ? await new Roll(`${normalDice}d10`).evaluate() : null;
  const rh = hungerDice ? await new Roll(`${hungerDice}d10`).evaluate() : null;
  const faces = (r) => (r ? r.dice[0].results.map((x) => x.result) : []);
  const n = faces(rn);
  const h = faces(rh);

  const successes = [...n, ...h].filter((x) => x >= 6).length;
  const tens = [...n, ...h].filter((x) => x === 10).length;
  const hungerTens = h.filter((x) => x === 10).length;
  const total = successes + 2 * Math.floor(tens / 2);     // каждая пара десяток = +2 успеха
  const crit = tens >= 2;
  const messy = crit && hungerTens > 0;

  const notes = [crit ? T("Dialog.crit") : "", messy ? T("Dialog.messy") : ""].filter(Boolean).join(" · ");
  await ChatMessage.create({
    speaker: speaker(actor),
    flavor: title,
    rolls: [rn, rh].filter(Boolean),
    content: `<div class="nt5e-pool">
      <p>${T("Dialog.normalDice")}: <b>${n.join(", ") || "—"}</b></p>
      ${h.length ? `<p>${T("Dialog.hungerDice")}: <b>${h.join(", ")}</b></p>` : ""}
      <p>${T("Dialog.successes")}: <b>${total}</b>${notes ? ` — ${notes}` : ""}</p>
    </div>`
  });
  return { mode: "pool", total, crit, display: T("Dialog.successesShort", { n: total }) };
}

/**
 * Call of Cthulhu 7e / Pulp Cthulhu: d100 «не больше навыка».
 * Уровни: обычный (≤ навык), трудный (≤ 1/2), экстремальный (≤ 1/5), критический (01).
 * Бонусные/штрафные кубы: лишние кубы десятков; бонус — берём меньший результат, штраф — больший.
 * margin: -1 провал, 0 обычный, 1 трудный, 2 экстремальный, 3 критический.
 */
async function rollCoc(actor, title) {
  const html = field(T("Dialog.skillValue"), `<input type="number" name="skill" value="" min="0" required>`)
    + field(T("Dialog.cocDice"), sel("dice", [
      ["-2", T("Dialog.coc.pen2")], ["-1", T("Dialog.coc.pen1")], ["0", "—"],
      ["1", T("Dialog.coc.bon1")], ["2", T("Dialog.coc.bon2")]
    ], "0"));
  const inp = await ask(title, html);
  if (!inp || inp.skill === "") return null;

  const skill = Math.max(0, Math.trunc(num(inp.skill)));
  const dice = Math.max(-2, Math.min(2, Math.trunc(num(inp.dice))));
  const extra = Math.abs(dice);

  const ru = await new Roll("1d10").evaluate();
  const rt = await new Roll(`${1 + extra}d10`).evaluate();
  const units = ru.dice[0].results[0].result % 10;
  const tensFaces = rt.dice[0].results.map((x) => x.result % 10);
  const totals = tensFaces.map((t) => { const v = t * 10 + units; return v === 0 ? 100 : v; });
  const r = dice > 0 ? Math.min(...totals) : dice < 0 ? Math.max(...totals) : totals[0];

  let level;
  if (r === 1) level = 3;
  else if (r <= Math.floor(skill / 5)) level = 2;
  else if (r <= Math.floor(skill / 2)) level = 1;
  else if (r <= skill) level = 0;
  else level = -1;
  const fumble = level < 0 && (r === 100 || (skill < 50 && r >= 96));

  const names = { "-1": T("Dialog.coc.fail"), 0: T("Dialog.coc.regular"), 1: T("Dialog.coc.hard"), 2: T("Dialog.coc.extreme"), 3: T("Dialog.coc.critical") };
  const shown = fumble ? T("Dialog.coc.fumble") : names[level];
  await ChatMessage.create({
    speaker: speaker(actor),
    flavor: title,
    rolls: [ru, rt],
    content: `<div class="nt5e-pool">
      <p>d100: <b>${r}</b> · ${T("Dialog.skillValue")}: ${skill} (${Math.floor(skill / 2)} / ${Math.floor(skill / 5)})</p>
      <p><b>${shown}</b></p>
    </div>`
  });
  return { mode: "under", margin: level, crit: level === 3, display: shown };
}
