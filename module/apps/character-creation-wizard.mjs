const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const ATTRIBUTE_KEYS = ["iq", "me", "ma", "ps", "pp", "pe", "pb", "spd"];

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeName(value) {
  return normalizeText(value).toLowerCase();
}

function localize(key, fallback = "") {
  if (!key) return fallback;
  const localized = game?.i18n?.localize?.(key);
  return localized || fallback || key;
}

function evaluateOccRequirements(actor, occItem) {
  const unmet = [];

  for (const key of ATTRIBUTE_KEYS) {
    const requirement = Math.floor(num(occItem?.system?.attributeRequirements?.[key], 0));
    if (requirement <= 0) continue;

    const actual = Math.floor(num(actor?.system?.attributes?.[key]?.value, 0));
    if (actual >= requirement) continue;

    unmet.push({ key: key.toUpperCase(), actual, requirement });
  }

  return {
    met: unmet.length <= 0,
    unmet,
    summary: unmet.map((entry) => `${entry.key} ${entry.actual}/${entry.requirement}`).join(", ")
  };
}

function getActiveOccId(actor) {
  const activeClass = actor?.getActiveClassItem?.() ?? actor?.getActiveClass?.() ?? null;
  if (activeClass?.type === "occ") return activeClass.id;

  const activeOcc = (actor?.items ?? []).find((item) => item.type === "occ" && item.system?.active === true);
  return activeOcc?.id ?? "";
}

function buildOccRows(actor) {
  const activeOccId = getActiveOccId(actor);
  const occItems = (actor?.items ?? [])
    .filter((item) => item.type === "occ")
    .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));

  return occItems.map((occ) => {
    const requirementState = evaluateOccRequirements(actor, occ);
    const category = normalizeText(occ.system?.category);

    return {
      id: occ.id,
      name: occ.name,
      category: category || localize("RIFTS.Sheet.None"),
      requirementsMet: requirementState.met,
      requirementsLabel: requirementState.met
        ? localize("RIFTS.Sheet.RequirementsMet")
        : localize("RIFTS.Sheet.RequirementsNotMet"),
      requirementsSummary: requirementState.summary || localize("RIFTS.Sheet.None"),
      isActive: occ.id === activeOccId
    };
  });
}

export class RiftsCharacterCreationWizard extends HandlebarsApplicationMixin(ApplicationV2) {
  _listenerAbortController = null;

  constructor(actor, options = {}) {
    super(options);
    this.actor = actor ?? null;
  }

  static DEFAULT_OPTIONS = foundry.utils.mergeObject(super.DEFAULT_OPTIONS, {
    id: "rifts-character-creation-wizard",
    classes: ["rifts", "app", "character-creation-wizard"],
    window: {
      title: "RIFTS.Creation.WizardTitle",
      icon: "fa-solid fa-wand-magic-sparkles",
      resizable: true
    },
    position: {
      width: 760,
      height: 700
    }
  }, { inplace: false });

  static PARTS = {
    body: {
      template: "systems/rifts-megaverse/templates/apps/character-creation-wizard.hbs"
    }
  };

  _onClose(options) {
    this._listenerAbortController?.abort();
    this._listenerAbortController = null;
    return super._onClose(options);
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    const actor = this.actor;
    const occRows = buildOccRows(actor);
    const selectedOcc = occRows.find((row) => row.isActive) ?? null;

    context.actorName = actor?.name || "";
    context.attributes = ATTRIBUTE_KEYS.map((key) => ({
      key,
      label: key.toUpperCase(),
      value: Math.floor(num(actor?.system?.attributes?.[key]?.value, 0))
    }));
    context.occRows = occRows;
    context.hasOccRows = occRows.length > 0;
    context.selectedOccId = selectedOcc?.id ?? "";
    context.selectedOccName = selectedOcc?.name ?? localize("RIFTS.Creation.NoOcc");
    context.defaultRuleHint = localize("RIFTS.Creation.DefaultRuleHint");

    return context;
  }

  async _rollAllAttributes() {
    if (!this.actor) return;

    const updates = {};
    const summary = [];

    for (const key of ATTRIBUTE_KEYS) {
      const roll = await (new Roll("3d6")).evaluate();
      const total = Math.max(1, Math.floor(num(roll.total, 0)));
      updates[`system.attributes.${key}.value`] = total;
      summary.push(`${key.toUpperCase()}: ${total}`);
    }

    await this.actor.update(updates);

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      content: `<p><strong>${localize("RIFTS.Creation.RollAllStats")}</strong></p><p>${summary.join(" | ")}</p>`
    });
  }

  async _selectOcc(occId) {
    if (!this.actor) return;
    const selected = this.actor.items.get(occId);
    if (!selected || selected.type !== "occ") return;

    const updates = this.actor.items
      .filter((item) => item.type === "occ" || item.type === "rcc")
      .map((item) => item.update({
        "system.active": item.id === selected.id,
        "system.isPrimaryClass": item.id === selected.id
      }));

    await Promise.all(updates);

    const req = evaluateOccRequirements(this.actor, selected);
    if (!req.met) {
      ui.notifications?.warn?.(`${selected.name}: ${localize("RIFTS.Sheet.RequirementsNotMet")} (${req.summary})`);
    }
  }

  async _applyStartingPools() {
    if (!this.actor) return;

    const selectedOccId = getActiveOccId(this.actor);
    if (!selectedOccId) {
      ui.notifications?.warn?.(localize("RIFTS.Creation.NoOcc"));
      return;
    }

    const result = await this.actor.applyOccStartingResources?.(selectedOccId, { onlyWhenDefault: true });

    if (!result) return;
    if (result.status === "already-initialized") {
      ui.notifications?.info?.(localize("RIFTS.Creation.AlreadyInitialized"));
      return;
    }
    if (result.status === "skipped-existing") {
      ui.notifications?.info?.(localize("RIFTS.Creation.SkippedExistingResources"));
      return;
    }
    if (result.status === "no-starting-resources") {
      ui.notifications?.warn?.(localize("RIFTS.Creation.NoStartingPools"));
      return;
    }

    ui.notifications?.info?.(localize("RIFTS.Creation.StartingPoolsApplied"));
  }

  async _onRender(context, options) {
    await super._onRender(context, options);

    this._listenerAbortController?.abort();
    const signal = (this._listenerAbortController = new AbortController()).signal;

    const root = this.element;
    if (!(root instanceof HTMLElement)) return;

    root.querySelectorAll("[data-action='roll-all-stats']").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        await this._rollAllAttributes();
        this.render();
      }, { signal });
    });

    root.querySelectorAll("[data-action='select-occ']").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        const occId = normalizeText(event.currentTarget.dataset.occId);
        if (!occId) return;
        await this._selectOcc(occId);
        this.render();
      }, { signal });
    });

    root.querySelectorAll("[data-action='apply-starting-pools']").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        await this._applyStartingPools();
        this.render();
      }, { signal });
    });
  }
}

export function openCharacterCreationWizard(actor) {
  if (!actor) return null;
  const app = new RiftsCharacterCreationWizard(actor);
  app.render(true);
  return app;
}
