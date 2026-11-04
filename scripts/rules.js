/**
 * Чистая логика переговоров (без Foundry API), адаптированная под d20.
 * Правила: Draw Steel (MCDM), глава «Переговоры».
 * 2d10-пороги 12 / 17 заменены на настраиваемые DC (по умолчанию 10 / 15),
 * «19–20 на кубах» -> натуральная 20 на d20.
 */

export const MIN = 0;
export const MAX = 5;

export const STARTING_ATTITUDES = {
  hostile: { interest: 1, patience: 2 },
  suspicious: { interest: 2, patience: 2 },
  neutral: { interest: 2, patience: 3 },
  open: { interest: 3, patience: 3 },
  friendly: { interest: 3, patience: 4 },
  trusting: { interest: 3, patience: 5 }
};

export const MOTIVATION_KEYS = [
  "benevolence", "discovery", "freedom", "greed", "higherAuthority", "justice",
  "legacy", "peace", "power", "protection", "revelry", "vengeance"
];

export const clamp = (n) => Math.max(MIN, Math.min(MAX, n));

/** Тир результата: 1 — провал, 2 — успех, 3 — крупный успех. */
export function tierOf(total, { success = 10, great = 15 } = {}) {
  if (total >= great) return 3;
  if (total >= success) return 2;
  return 1;
}

/**
 * Определяет изменение Интереса и Терпения.
 * @param {object} o
 * @param {"motivation"|"repeat"|"pitfall"|"neither"|"read"} o.kind
 * @param {1|2|3} o.tier
 * @param {boolean} [o.nat20]       натуральная 20 (для «ни мотивации, ни ловушки»)
 * @param {boolean} [o.lie]         аргумент — ложь (проверка Обмана)
 * @param {boolean} [o.repeatedNeither] тот же аргумент «ни то ни сё» второй раз -> авто тир 1
 * @returns {{dI:number,dP:number,learn:boolean,notes:string[]}}
 */
export function resolve({ kind, tier, nat20 = false, lie = false, repeatedNeither = false }) {
  let dI = 0;
  let dP = 0;
  let learn = false;
  const notes = [];

  switch (kind) {
    case "pitfall":
      dI = -1; dP = -1;
      notes.push("pitfall");
      break;

    case "repeat":
      dP = -1;
      notes.push("repeat");
      break;

    case "motivation":
      if (tier === 1) dP = -1;
      else if (tier === 2) { dI = 1; dP = -1; }
      else { dI = 1; }
      break;

    case "neither": {
      const t = repeatedNeither ? 1 : tier;
      if (repeatedNeither) notes.push("repeatedNeither");
      if (t === 1) { dI = -1; dP = -1; }
      else if (t === 2) { dP = -1; }
      else { dI = 1; dP = -1; }
      if (nat20 && !repeatedNeither) { dP = 0; notes.push("nat20"); }
      break;
    }

    case "read":
      if (tier === 1) { dP = -1; notes.push("readAnnoyed"); }
      else if (tier === 2) notes.push("readHard");
      else { learn = true; notes.push("readLearn"); }
      break;
  }

  // Ложь: если аргумент не поднял Интерес — ещё -1 Интереса.
  if (lie && kind !== "read" && kind !== "pitfall" && dI <= 0) {
    dI -= 1;
    notes.push("caughtLie");
  }

  return { dI, dP, learn, notes };
}

/** Итоговый статус переговоров по текущим значениям. */
export function statusOf(interest, patience, current = "active") {
  if (current === "idle" || current === "closed") return current;
  if (interest <= 0) return "ended";
  if (interest >= 5 || patience <= 0) return "final";
  return "active";
}

/** Стартовые значения. */
export function startStats({ attitude, language = 0, fame = "none" }) {
  const base = STARTING_ATTITUDES[attitude] ?? STARTING_ATTITUDES.neutral;
  let interest = base.interest;
  let patience = base.patience;
  if (language >= 3) patience += 2;
  else if (language >= 1) patience += 1;
  if (fame === "famous") patience += 1;
  if (fame === "infamous") interest -= 1;
  return { interest: Math.max(1, clamp(interest)), patience: clamp(patience) };
}

/* ------------------------------------------------------------------ */
/*  Результат броска -> тир (для любой системы)                       */
/* ------------------------------------------------------------------ */

/**
 * @param {object} result
 * @param {"high"|"under"|"pool"} result.mode  high/pool: total vs DC; under: margin (запас до цели)
 * @param {number} [result.total]
 * @param {number} [result.margin]
 * @param {boolean} [result.auto3]  автоматический тир 3 (напр. натуральные 19–20 в Draw Steel)
 * @param {number} [result.shift]   сдвиг тира (двойной edge/bane, натуральная 20 в PF2e)
 * @param {{success:number,great:number}} dc   для under: great = запас, нужный для крупного успеха
 */
export function tierFromResult(result, dc) {
  if (result.auto3) return 3;
  let tier;
  if (result.mode === "under") tier = (result.margin ?? -1) < 0 ? 1 : ((result.margin ?? 0) >= dc.great ? 3 : 2);
  else tier = tierOf(result.total ?? 0, dc);
  return Math.max(1, Math.min(3, tier + (result.shift ?? 0)));
}
