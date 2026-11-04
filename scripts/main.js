import {
  MOTIVATION_KEYS, STARTING_ATTITUDES, clamp, resolve, statusOf, startStats, tierFromResult
} from "./rules.js";
import {
  PROFILES, PROFILE_IDS, detectProfile, getChecks, checkLabel, checkSpec, defaultCheck, dcFor, rollCheck
} from "./systems.js";

const MODULE_ID = "negotiation-tracker-5e";
const TEMPLATE = `modules/${MODULE_ID}/templates/tracker.hbs`;
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const T = (k, d) => game.i18n.format(`NT5E.${k}`, d ?? {});
const esc = (v) => foundry.utils.escapeHTML(String(v ?? ""));
const uid = () => foundry.utils.randomID();

/* -------------------------------------------- */
/*  Система и скин                              */
/* -------------------------------------------- */

const SKINS = ["fantasy", "cyber", "office"];
const SKIN_ICONS = { fantasy: "fa-solid fa-scroll", cyber: "fa-solid fa-microchip", office: "fa-solid fa-file-lines" };

function currentProfileId() {
  const chosen = game.settings.get(MODULE_ID, "ruleset");
  return PROFILE_IDS.includes(chosen) ? chosen : detectProfile();
}

function currentSkin() {
  const s = game.settings.get(MODULE_ID, "skin");
  return SKINS.includes(s) ? s : "fantasy";
}

function applySkin() {
  const body = document.body;
  SKINS.forEach((s) => body.classList.remove(`nt5e-skin-${s}`));
  body.classList.add(`nt5e-skin-${currentSkin()}`);
}

/* -------------------------------------------- */
/*  State: разговоры -> НПС                     */
/* -------------------------------------------- */

const newRows = () => [
  ...MOTIVATION_KEYS.map((key) => ({ key, label: "", role: "none", used: false, known: false })),
  ...Array.from({ length: 4 }, () => ({ key: "custom", label: "", role: "none", used: false, known: false }))
];

function newNpc(name = "") {
  return {
    id: uid(), name,
    status: "idle", // idle | active | final | ended | closed
    interest: 2, patience: 3, readLocked: false,
    dcSuccess: null, dcGreat: null,
    setup: { attitude: "neutral", language: "0", fame: "none" },
    rows: newRows()
  };
}

function newConv(name = "") {
  const npc = newNpc();
  return { id: uid(), name, currentNpc: npc.id, npcs: [npc], log: [] };
}

function loadState() {
  const saved = game.settings.get(MODULE_ID, "state");

  if (saved?.version === 2 && Array.isArray(saved.conversations) && saved.conversations.length) {
    for (const conv of saved.conversations) {
      conv.log ??= [];
      if (!conv.npcs?.length) conv.npcs = [newNpc()];
      conv.npcs = conv.npcs.map((n) => {
        const merged = foundry.utils.mergeObject(newNpc(), n, { inplace: false });
        if (!Array.isArray(merged.rows) || merged.rows.length !== newRows().length) merged.rows = newRows();
        return merged;
      });
      if (!conv.npcs.some((n) => n.id === conv.currentNpc)) conv.currentNpc = conv.npcs[0].id;
    }
    if (!saved.conversations.some((c) => c.id === saved.current)) saved.current = saved.conversations[0].id;
    return saved;
  }

  // Миграция с версии 1 (один НПС на всё окно).
  if (saved && Array.isArray(saved.rows)) {
    const conv = newConv();
    const npc = conv.npcs[0];
    Object.assign(npc, {
      name: saved.name ?? "", status: saved.status ?? "idle",
      interest: saved.interest ?? 2, patience: saved.patience ?? 3, readLocked: !!saved.readLocked
    });
    if (saved.rows.length === npc.rows.length) npc.rows = saved.rows;
    conv.log = (saved.log ?? []).map((e) => ({ ...e, npcId: npc.id, npcName: npc.name || "NPC" }));
    return { version: 2, current: conv.id, conversations: [conv] };
  }

  const conv = newConv();
  return { version: 2, current: conv.id, conversations: [conv] };
}

/* -------------------------------------------- */
/*  Application                                 */
/* -------------------------------------------- */

class NegotiationTracker extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "negotiation-tracker-5e",
    classes: ["nt5e-app"],
    tag: "div",
    window: { title: "NT5E.Title", icon: "fa-solid fa-scroll", resizable: true },
    position: { width: 900, height: "auto" },
    actions: {
      setSkin: NegotiationTracker.#onSetSkin,
      selectConv: NegotiationTracker.#onSelectConv,
      addConv: NegotiationTracker.#onAddConv,
      removeConv: NegotiationTracker.#onRemoveConv,
      selectNpc: NegotiationTracker.#onSelectNpc,
      addNpc: NegotiationTracker.#onAddNpc,
      removeNpc: NegotiationTracker.#onRemoveNpc,
      setStat: NegotiationTracker.#onSetStat,
      toggleRole: NegotiationTracker.#onToggleRole,
      toggleUsed: NegotiationTracker.#onToggleUsed,
      toggleKnown: NegotiationTracker.#onToggleKnown,
      start: NegotiationTracker.#onStart,
      requestArgument: NegotiationTracker.#onRequestArgument,
      manualArgument: NegotiationTracker.#onManualArgument,
      roleplayArgument: NegotiationTracker.#onRoleplayArgument,
      requestRead: NegotiationTracker.#onRequestRead,
      manualRead: NegotiationTracker.#onManualRead,
      acceptOffer: NegotiationTracker.#onAccept
    }
  };

  static PARTS = { main: { template: TEMPLATE } };

  state = loadState();

  /** Временные значения формы (не сохраняются в мире). */
  ui = {
    skill: "", advantage: false, argText: "", manual: "", manualNat20: false,
    readSkill: "", readManual: "", readNpc: "",
    targets: {} // npcId -> { on, row, lie, repeat }
  };

  get conv() {
    return this.state.conversations.find((c) => c.id === this.state.current) ?? this.state.conversations[0];
  }

  get npc() {
    const c = this.conv;
    return c.npcs.find((n) => n.id === c.currentNpc) ?? c.npcs[0];
  }

  #target(npcId) {
    return (this.ui.targets[npcId] ??= { on: true, row: "none", lie: false, repeat: false });
  }

  /* ---------- context ---------- */

  async _prepareContext() {
    const conv = this.conv;
    const npc = this.npc;
    const ui = this.ui;
    const anyActive = conv.npcs.some((n) => n.status === "active");

    const profileId = currentProfileId();
    const profile = PROFILES[profileId];
    const skills = getChecks(profileId);
    if (!skills.some((c) => c.id === ui.skill)) ui.skill = defaultCheck(profileId, "argument");
    if (!skills.some((c) => c.id === ui.readSkill)) ui.readSkill = defaultCheck(profileId, "read");
    const selSpec = checkSpec(profileId, ui.skill);
    const dcKind = profile.dcKind;

    const rowsOf = (n) => n.rows.map((r, i) => ({
      ...r, index: i,
      name: this.#rowName(r),
      isMotivation: r.role === "motivation",
      isPitfall: r.role === "pitfall",
      custom: r.key === "custom"
    }));
    const rows = rowsOf(npc);

    const ladder = (stat, current) => Array.from({ length: 6 }, (_, k) => 5 - k).map((value) => ({
      value, active: value === current,
      label: stat === "interest" ? T(`Offer.${value}`) : ""
    }));

    const targets = conv.npcs.map((n) => {
      const t = this.#target(n.id);
      const active = n.status === "active";
      return {
        id: n.id, name: n.name || T("Unnamed"), active,
        on: t.on && active, lie: t.lie, repeat: t.repeat,
        noneSelected: String(t.row) === "none" || !n.rows[Number(t.row)] || n.rows[Number(t.row)].role === "none",
        options: rowsOf(n).filter((r) => r.role !== "none").map((r) => ({
          ...r, selected: String(r.index) === String(t.row)
        }))
      };
    });

    const activeNpcs = conv.npcs.filter((n) => n.status === "active");
    if (!activeNpcs.some((n) => n.id === ui.readNpc)) ui.readNpc = activeNpcs[0]?.id ?? "";
    const readTargets = activeNpcs.map((n) => ({
      id: n.id, name: n.name || T("Unnamed"), selected: n.id === ui.readNpc
    }));

    const s = npc;
    return {
      ui, conv, npc,
      convs: this.state.conversations.map((c) => ({
        id: c.id, name: c.name || T("ConvDefault", { n: this.state.conversations.indexOf(c) + 1 }),
        active: c.id === conv.id
      })),
      canRemoveConv: true,
      npcs: conv.npcs.map((n) => ({
        id: n.id, name: n.name || T("Unnamed"), active: n.id === npc.id,
        started: n.status !== "idle", interest: n.interest, patience: n.patience,
        status: n.status, statusLabel: T(`Status.${n.status}`)
      })),
      idle: s.status === "idle",
      statusLabel: T(`Status.${s.status}`),
      offerText: T(`OfferText.${s.interest}`),
      finalNote: s.status === "final" ? T("FinalNote") : s.status === "ended" ? T("EndedNote") : "",
      interestLadder: ladder("interest", s.interest),
      patienceLadder: ladder("patience", s.patience),
      rows,
      skills,
      attitudes: Object.keys(STARTING_ATTITUDES).map((id) => ({
        id,
        label: `${T(`Attitude.${id}`)} (${STARTING_ATTITUDES[id].interest}/${STARTING_ATTITUDES[id].patience})`,
        selected: id === s.setup.attitude
      })),
      profileId,
      profileLabel: T(`Profile.${profileId}`),
      showAdvantage: selSpec.adv,
      showDcSuccess: dcKind !== "under" && dcKind !== "coc",
      dcSuccessLabel: T(`DC.${dcKind}.success`),
      dcGreatLabel: T(`DC.${dcKind}.great`),
      dcDefaults: profile.dc,
      dcHint: T(`DC.${dcKind}.hint`),
      manualPlaceholder: profileId === "cthulhu" ? T("ManualLevel") : selSpec.mode === "under" ? T("ManualMargin") : T("Total"),
      skins: SKINS.map((id) => ({
        id, label: T(`Skin.${id}`), icon: SKIN_ICONS[id], active: id === currentSkin()
      })),
      targets, readTargets,
      anyActive,
      disabled: !anyActive,
      log: [...conv.log].reverse().slice(0, 40)
    };
  }

  /* ---------- render hooks ---------- */

  _onRender() {
    const el = this.element;

    el.querySelector("[name=convName]")?.addEventListener("change", (ev) => {
      this.conv.name = ev.target.value;
      this.#save(true);
    });
    el.querySelector("[name=npcName]")?.addEventListener("change", (ev) => {
      this.npc.name = ev.target.value;
      this.#save(true);
    });

    el.querySelectorAll("[data-ui]").forEach((input) => {
      input.addEventListener("change", (ev) => {
        const key = ev.currentTarget.dataset.ui;
        this.ui[key] = ev.currentTarget.type === "checkbox" ? ev.currentTarget.checked : ev.currentTarget.value;
      });
    });

    el.querySelectorAll("[data-target]").forEach((input) => {
      input.addEventListener("change", (ev) => {
        const { npcId, field } = ev.currentTarget.dataset;
        this.#target(npcId)[field] = ev.currentTarget.type === "checkbox" ? ev.currentTarget.checked : ev.currentTarget.value;
      });
    });

    el.querySelectorAll("[data-setup]").forEach((input) => {
      input.addEventListener("change", (ev) => {
        this.npc.setup[ev.currentTarget.dataset.setup] = ev.currentTarget.value;
        this.#save(false);
      });
    });

    el.querySelectorAll("[data-npc-field]").forEach((input) => {
      input.addEventListener("change", (ev) => {
        const v = ev.currentTarget.value;
        this.npc[ev.currentTarget.dataset.npcField] = v === "" ? null : Number(v);
        this.#save(false);
      });
    });

    el.querySelectorAll("[data-custom-label]").forEach((input) => {
      input.addEventListener("change", (ev) => {
        this.npc.rows[Number(ev.currentTarget.dataset.customLabel)].label = ev.currentTarget.value;
        this.#save(true);
      });
    });
  }

  async #save(rerender = true) {
    await game.settings.set(MODULE_ID, "state", this.state);
    if (rerender) this.render();
  }

  /* ---------- helpers ---------- */

  #recompute(npc) {
    npc.interest = clamp(npc.interest);
    npc.patience = clamp(npc.patience);
    npc.status = statusOf(npc.interest, npc.patience, npc.status);
  }

  #rowAt(npc, idx) {
    if (idx === "none" || idx === undefined || idx === null || idx === "") return null;
    const row = npc.rows[Number(idx)] ?? null;
    return row && row.role !== "none" ? row : null;
  }

  #rowName(row) {
    return row.key === "custom" ? (row.label || "…") : T(`Motivation.${row.key}`);
  }

  #delta(n, sym) {
    return n === 0 ? "" : `${n > 0 ? "+" : "−"}${Math.abs(n)}${sym}`;
  }

  async #chat(html) {
    const data = {
      content: `<div class="nt5e-chat">${html}</div>`,
      speaker: { alias: T("Title") }
    };
    if (!game.settings.get(MODULE_ID, "publicChat")) data.whisper = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
    return ChatMessage.create(data);
  }

  /** Определяет тип аргумента для конкретного НПС и нужен ли бросок. */
  #classify(npc, { rowIndex, repeated }) {
    const row = this.#rowAt(npc, rowIndex);
    if (row?.role === "pitfall") return { kind: "pitfall", row, needsRoll: false };
    if (row?.role === "motivation") {
      return row.used ? { kind: "repeat", row, needsRoll: false } : { kind: "motivation", row, needsRoll: true };
    }
    return { kind: "neither", row: null, needsRoll: !repeated };
  }

  /** Выбранные в форме цели (активные НПС с галочкой). */
  #selectedTargets() {
    return this.conv.npcs
      .filter((n) => n.status === "active" && this.#target(n.id).on)
      .map((n) => {
        const t = this.#target(n.id);
        return { npcId: n.id, rowIndex: t.row, lie: !!t.lie, repeated: !!t.repeat };
      });
  }

  #resetTargetFlags() {
    for (const t of Object.values(this.ui.targets)) { t.row = "none"; t.lie = false; t.repeat = false; }
    this.ui.argText = "";
    this.ui.manual = "";
  }

  /* ---------- запрос проверки игрокам ---------- */

  async #postRequest(conv, type, check, targets) {
    const profile = currentProfileId();
    const request = {
      id: uid(), type, check, profile, convId: conv.id,
      advantage: !!this.ui.advantage && type === "argument",
      targets, resolved: false
    };
    const skillLabel = checkLabel(profile, check);
    const names = targets
      .map((t) => conv.npcs.find((n) => n.id === t.npcId)?.name || T("Unnamed"))
      .map(esc).join(", ");
    const text = type === "argument" ? esc(this.ui.argText) : "";
    const header = type === "read" ? T("RequestReadHeader", { name: names }) : T("RequestHeader", { name: names });
    const content = `<div class="nt5e-chat nt5e-request">
      <h3>${header}</h3>
      ${text ? `<blockquote>«${text}»</blockquote>` : ""}
      <p>${T("RequestSkill", { skill: skillLabel })}${request.advantage ? ` · ${T("Advantage")}` : ""}</p>
      <button type="button" data-nt5e-roll><i class="fa-solid fa-dice-d20"></i> ${T("PlayerRoll", { skill: skillLabel })}</button>
    </div>`;
    await ChatMessage.create({ content, speaker: { alias: T("Title") }, flags: { [MODULE_ID]: { request } } });
  }

  /** Применяет результат броска, присланный игроком. */
  async applyResult(request, result) {
    const conv = this.state.conversations.find((c) => c.id === request.convId);
    if (!conv) return;
    const rollLabel = checkLabel(request.profile, request.check);
    const ctx = { profile: request.profile, check: request.check, result, rollLabel, actorName: result.actorName ?? "" };
    if (request.type === "read") return this.#applyRead(conv, request.targets[0]?.npcId, ctx);
    return this.#applyArgument(conv, request.targets, ctx);
  }

  /** Применяет один бросок ко всем целям, у каждой свои мотивации и свои Сл. */
  async #applyArgument(conv, targets, { profile = currentProfileId(), check = "", result = null, forcedTier = null, rollLabel = "", actorName = "" } = {}) {
    const spec = checkSpec(profile, check);
    const entries = [];

    for (const target of targets) {
      const npc = conv.npcs.find((n) => n.id === target.npcId);
      if (!npc || npc.status !== "active") continue;
      const { kind, row } = this.#classify(npc, target);
      const auto = kind === "pitfall" || kind === "repeat" || (kind === "neither" && !!target.repeated);
      const tier = auto ? 1 : (forcedTier ?? (result ? tierFromResult(result, dcFor(profile, spec, npc)) : 1));
      const repeatedNeither = kind === "neither" && !!target.repeated;

      const res = resolve({ kind, tier, nat20: !!result?.crit, lie: !!target.lie, repeatedNeither });
      npc.interest += res.dI;
      npc.patience += res.dP;
      if (kind === "motivation" && tier >= 2) row.used = true;
      npc.readLocked = false;
      this.#recompute(npc);

      const entry = {
        type: "argument", kind, npcId: npc.id, npcName: npc.name || T("Unnamed"),
        row: row ? this.#rowName(row) : "",
        display: auto || !result ? "" : result.display,
        tier, dI: res.dI, dP: res.dP, notes: res.notes,
        interest: npc.interest, patience: npc.patience, status: npc.status, by: actorName
      };
      conv.log.push(entry);
      entries.push(entry);
    }

    if (!entries.length) return ui.notifications.warn(T("NotActive"));
    await this.#save();
    await this.#chat(this.#resultHtml(conv, entries, {
      display: result?.display ?? null, rollLabel, actorName, publicNotes: ["caughtLie", "nat20"]
    }));
  }

  async #applyRead(conv, npcId, { profile = currentProfileId(), check = "", result, actorName = "", rollLabel = "" }) {
    const npc = conv.npcs.find((n) => n.id === npcId);
    if (!npc || npc.status !== "active") return ui.notifications.warn(T("NotActive"));
    if (npc.readLocked) return ui.notifications.warn(T("ReadLocked"));
    const tier = tierFromResult(result, dcFor(profile, checkSpec(profile, check), npc));
    const res = resolve({ kind: "read", tier });
    npc.patience += res.dP;
    npc.readLocked = true;
    this.#recompute(npc);
    const entry = {
      type: "read", kind: "read", npcId, npcName: npc.name || T("Unnamed"), row: "", display: result.display,
      tier, by: actorName, dI: 0, dP: res.dP, notes: res.notes,
      interest: npc.interest, patience: npc.patience, status: npc.status
    };
    conv.log.push(entry);
    await this.#save();
    await this.#chat(this.#resultHtml(conv, [entry], {
      display: result.display, rollLabel, actorName, publicNotes: ["readAnnoyed", "readHard", "readLearn"]
    }));
  }

  #resultHtml(conv, entries, { display, rollLabel, actorName, publicNotes }) {
    const roll = display !== null && display !== undefined && display !== ""
      ? `<p>${actorName ? `<i>${esc(actorName)}</i> · ` : ""}${esc(rollLabel)} <b>${esc(display)}</b></p>` : "";
    const blocks = entries.map((e) => {
      const deltas = [this.#delta(e.dI, "●"), this.#delta(e.dP, "■")].filter(Boolean).join(" ") || T("NoChange");
      const reaction = e.kind === "read" ? "" : `<i>${T(`Reaction.${e.dI > 0 ? "positive" : e.dI < 0 ? "negative" : "impatient"}`)}</i>`;
      const notes = e.notes.filter((n) => publicNotes.includes(n)).map((n) => T(`Note.${n}`)).join(" ");
      return `<div class="nt5e-npc">
        <p><b>${esc(e.npcName)}</b> ${reaction}</p>
        <p class="nt5e-delta">${deltas}</p>
        ${notes ? `<p class="nt5e-note">${notes}</p>` : ""}
        ${this.#stateLine(conv.npcs.find((n) => n.id === e.npcId))}
      </div>`;
    }).join("");
    const title = entries[0].kind === "read" ? T("ReadThem") : T("ArgumentTitle");
    return `<h3>${esc(conv.name || "")}${conv.name ? ": " : ""}${title}</h3>${roll}${blocks}`;
  }

  #stateLine(npc) {
    const pips = (n, ch) => ch.repeat(n) + "○".repeat(5 - n);
    let tail = "";
    if (npc.status === "final") tail = `<br><b>${T("FinalNote")}</b> ${T(`OfferText.${npc.interest}`)}`;
    if (npc.status === "ended") tail = `<br><b>${T("EndedNote")}</b>`;
    return `<p class="nt5e-state">${T("Interest")}: ${pips(npc.interest, "●")} · ${T("Patience")}: ${pips(npc.patience, "■")}${tail}</p>`;
  }

  async #confirm(text) {
    return foundry.applications.api.DialogV2.confirm({
      window: { title: T("Title") }, content: `<p>${text}</p>`
    });
  }

  /* ---------- actions: разговоры и НПС ---------- */

  static async #onSelectConv(event, target) {
    this.state.current = target.dataset.id;
    await this.#save();
  }

  static async #onAddConv() {
    const conv = newConv();
    this.state.conversations.push(conv);
    this.state.current = conv.id;
    await this.#save();
  }

  static async #onRemoveConv(event, target) {
    if (!(await this.#confirm(T("RemoveConvConfirm")))) return;
    const id = target.dataset.id;
    this.state.conversations = this.state.conversations.filter((c) => c.id !== id);
    if (!this.state.conversations.length) this.state.conversations.push(newConv());
    if (!this.state.conversations.some((c) => c.id === this.state.current)) this.state.current = this.state.conversations[0].id;
    await this.#save();
  }

  static async #onSelectNpc(event, target) {
    this.conv.currentNpc = target.dataset.id;
    await this.#save();
  }

  static async #onAddNpc() {
    const npc = newNpc();
    this.conv.npcs.push(npc);
    this.conv.currentNpc = npc.id;
    await this.#save();
  }

  static async #onRemoveNpc(event, target) {
    if (!(await this.#confirm(T("RemoveNpcConfirm")))) return;
    const conv = this.conv;
    conv.npcs = conv.npcs.filter((n) => n.id !== target.dataset.id);
    delete this.ui.targets[target.dataset.id];
    if (!conv.npcs.length) conv.npcs.push(newNpc());
    if (!conv.npcs.some((n) => n.id === conv.currentNpc)) conv.currentNpc = conv.npcs[0].id;
    await this.#save();
  }

  /* ---------- actions: текущий НПС ---------- */

  static async #onSetStat(event, target) {
    const { stat, value } = target.dataset;
    const npc = this.npc;
    npc[stat] = clamp(Number(value));
    if (npc.status !== "idle") this.#recompute(npc);
    await this.#save();
  }

  static async #onToggleRole(event, target) {
    const row = this.npc.rows[Number(target.dataset.index)];
    const role = target.dataset.role;
    row.role = row.role === role ? "none" : role;
    row.used = false;
    await this.#save();
  }

  static async #onToggleUsed(event, target) {
    const row = this.npc.rows[Number(target.dataset.index)];
    row.used = !row.used;
    await this.#save();
  }

  static async #onToggleKnown(event, target) {
    const row = this.npc.rows[Number(target.dataset.index)];
    row.known = !row.known;
    await this.#save();
  }

  static async #onStart() {
    const npc = this.npc;
    const { attitude, language, fame } = npc.setup;
    const stats = startStats({ attitude, language: Number(language), fame });
    Object.assign(npc, { status: "active", interest: stats.interest, patience: stats.patience, readLocked: false });
    this.#recompute(npc);
    this.conv.log.push({
      type: "start", npcId: npc.id, npcName: npc.name || T("Unnamed"), interest: npc.interest, patience: npc.patience
    });
    await this.#save();
    await this.#chat(`<h3>${T("StartHeader", { name: esc(npc.name || T("Unnamed")) })}</h3>${this.#stateLine(npc)}`);
  }

  static async #onAccept() {
    const conv = this.conv;
    const npc = this.npc;
    if (npc.status === "idle" || npc.status === "closed") return;
    const wasFinal = npc.status !== "active";
    npc.status = "closed";
    conv.log.push({
      type: "accept", npcId: npc.id, npcName: npc.name || T("Unnamed"), interest: npc.interest, patience: npc.patience
    });
    await this.#save();
    await this.#chat(`
      <h3>${T("OfferHeader", { name: esc(npc.name || T("Unnamed")) })}</h3>
      <p><b>${T(`Offer.${npc.interest}`)}</b></p>
      <p>${T(`OfferText.${npc.interest}`)}</p>
      <p class="nt5e-note">${wasFinal ? T("FinalNote") : ""}</p>`);
  }

  /* ---------- actions: аргументы и проверки ---------- */

  /** Результат, введённый Мастером вручную (бросили за столом). */
  #manualResult(value, crit) {
    const profile = currentProfileId();
    const spec = checkSpec(profile, this.ui.skill);
    return spec.mode === "under"
      ? { mode: "under", margin: value, crit, display: `${value >= 0 ? "+" : ""}${value}` }
      : { mode: spec.mode, total: value, crit, display: String(value) };
  }

  static async #onRequestArgument() {
    const conv = this.conv;
    const targets = this.#selectedTargets();
    if (!targets.length) return ui.notifications.warn(T("NoTargets"));

    const needRoll = [];
    const noRoll = [];
    for (const t of targets) {
      const npc = conv.npcs.find((n) => n.id === t.npcId);
      (this.#classify(npc, t).needsRoll ? needRoll : noRoll).push(t);
    }

    // Ловушки, повторные мотивации и повторы аргумента бросков не требуют.
    if (noRoll.length) await this.#applyArgument(conv, noRoll, { check: this.ui.skill });
    if (needRoll.length) await this.#postRequest(conv, "argument", this.ui.skill, needRoll);
    this.#resetTargetFlags();
    this.render();
  }

  static async #onManualArgument() {
    const value = Number(this.ui.manual);
    if (!Number.isFinite(value) || this.ui.manual === "") return ui.notifications.warn(T("EnterTotal"));
    const targets = this.#selectedTargets();
    if (!targets.length) return ui.notifications.warn(T("NoTargets"));
    await this.#applyArgument(this.conv, targets, {
      check: this.ui.skill, result: this.#manualResult(value, this.ui.manualNat20 === true), rollLabel: T("Manual")
    });
    this.#resetTargetFlags();
    this.render();
  }

  static async #onRoleplayArgument() {
    const targets = this.#selectedTargets();
    if (!targets.length) return ui.notifications.warn(T("NoTargets"));
    await this.#applyArgument(this.conv, targets, { check: this.ui.skill, forcedTier: 3 });
    this.#resetTargetFlags();
    this.render();
  }

  static async #onRequestRead() {
    const conv = this.conv;
    const npc = conv.npcs.find((n) => n.id === this.ui.readNpc);
    if (!npc || npc.status !== "active") return ui.notifications.warn(T("NotActive"));
    if (npc.readLocked) return ui.notifications.warn(T("ReadLocked"));
    await this.#postRequest(conv, "read", this.ui.readSkill, [{ npcId: npc.id }]);
  }

  static async #onManualRead() {
    const value = Number(this.ui.readManual);
    if (!Number.isFinite(value) || this.ui.readManual === "") return ui.notifications.warn(T("EnterTotal"));
    const profile = currentProfileId();
    const spec = checkSpec(profile, this.ui.readSkill);
    const result = spec.mode === "under"
      ? { mode: "under", margin: value, display: `${value >= 0 ? "+" : ""}${value}` }
      : { mode: spec.mode, total: value, display: String(value) };
    await this.#applyRead(this.conv, this.ui.readNpc, {
      check: this.ui.readSkill, result, rollLabel: T("Manual")
    });
    this.ui.readManual = "";
    this.render();
  }

  static async #onSetSkin(event, target) {
    await game.settings.set(MODULE_ID, "skin", target.dataset.skin);
  }
}

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

let app = null;
const getApp = () => (app ??= new NegotiationTracker());

function openTracker() {
  if (!game.user.isGM) return ui.notifications.warn(T("GMOnly"));
  getApp();
  if (app.rendered) app.bringToFront();
  else app.render({ force: true });
  return app;
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "state", {
    scope: "world", config: false, type: Object, default: {}
  });
  game.settings.register(MODULE_ID, "ruleset", {
    name: "NT5E.Settings.ruleset.name", hint: "NT5E.Settings.ruleset.hint",
    scope: "world", config: true, type: String, default: "auto",
    choices: {
      auto: "NT5E.Settings.ruleset.auto",
      ...Object.fromEntries(PROFILE_IDS.map((id) => [id, `NT5E.Profile.${id}`]))
    },
    onChange: () => app?.render()
  });
  game.settings.register(MODULE_ID, "skin", {
    name: "NT5E.Settings.skin.name", hint: "NT5E.Settings.skin.hint",
    scope: "world", config: true, type: String, default: "fantasy",
    choices: Object.fromEntries(SKINS.map((id) => [id, `NT5E.Skin.${id}`])),
    onChange: () => { applySkin(); app?.render(); }
  });
  game.settings.register(MODULE_ID, "publicChat", {
    name: "NT5E.Settings.publicChat.name", hint: "NT5E.Settings.publicChat.hint",
    scope: "world", config: true, type: Boolean, default: true
  });
});

const SOCKET = `module.${MODULE_ID}`;

/** Выполняется только на клиенте активного Мастера. */
async function handleResult({ messageId, result, actorName }) {
  const message = game.messages.get(messageId);
  const request = message?.getFlag(MODULE_ID, "request");
  if (!request || request.resolved || !result) return;
  await message.update({
    flags: { [MODULE_ID]: { request: { resolved: true, total: result.display, by: actorName } } }
  });
  await getApp().applyResult(request, { ...result, actorName });
}

function submitResult(payload) {
  if (game.users.activeGM?.isSelf) return handleResult(payload);
  if (!game.users.activeGM) return ui.notifications.error(T("NoActiveGM"));
  game.socket.emit(SOCKET, { action: "result", ...payload });
}

/** Игрок нажал кнопку в чате и делает проверку. */
async function playerRoll(message, button) {
  const request = message.getFlag(MODULE_ID, "request");
  if (!request || request.resolved) return;
  const actor = canvas?.tokens?.controlled.map((t) => t.actor).find((a) => a?.isOwner) ?? game.user.character;
  if (!actor) return ui.notifications.warn(T("NoActorPlayer"));

  button.disabled = true;
  try {
    const result = await rollCheck(request.profile, request.check, actor, { advantage: request.advantage });
    if (!result) { button.disabled = false; return; }
    await submitResult({ messageId: message.id, result, actorName: actor.name });
  } catch (err) {
    console.error(`${MODULE_ID} |`, err);
    ui.notifications.error(T("RollFailed"));
    button.disabled = false;
  }
}

Hooks.on("renderChatMessageHTML", (message, html) => {
  const request = message.getFlag(MODULE_ID, "request");
  if (!request) return;
  const button = html.querySelector("[data-nt5e-roll]");
  if (!button) return;
  if (request.resolved) {
    const done = document.createElement("p");
    done.className = "nt5e-resolved";
    done.textContent = `✓ ${request.by ?? ""}: ${request.total ?? ""}`;
    button.replaceWith(done);
  } else {
    button.addEventListener("click", () => playerRoll(message, button));
  }
});

Hooks.once("ready", () => {
  applySkin();
  game.modules.get(MODULE_ID).api = { open: openTracker };
  game.socket.on(SOCKET, (data) => {
    if (data?.action === "result" && game.users.activeGM?.isSelf) handleResult(data);
  });
});

Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;
  const group = controls.tokens ?? Object.values(controls)[0];
  if (!group) return;
  group.tools.negotiation = {
    name: "negotiation",
    title: "NT5E.Title",
    icon: "fa-solid fa-handshake",
    order: Object.keys(group.tools).length,
    button: true,
    visible: true,
    onChange: () => openTracker()
  };
});
