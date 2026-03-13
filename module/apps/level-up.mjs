import { RiftsSelectionDialog } from "./selection-dialog.mjs";
import {
  applyAutomaticLevelUpGains,
  applyLevelUpChoice,
  canUserManageLevelUp,
  clearLevelUpChoiceSelections,
  finalizeLevelUpSession,
  getLevelUpSession,
  markLevelUpChoiceComplete
} from "../services/level-up.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function normalizeText(value) {
  return String(value ?? "").trim();
}

function localize(key, fallback = "") {
  const localized = game?.i18n?.localize?.(key);
  return localized || fallback || key;
}

function choiceTypeLabel(choiceType) {
  const normalized = normalizeText(choiceType).toLowerCase();
  if (normalized === "skill") return localize("RIFTS.LevelUp.Skills");
  if (normalized === "spell") return localize("RIFTS.LevelUp.Spells");
  if (normalized === "psionic") return localize("RIFTS.LevelUp.Psionics");
  if (normalized === "maneuver") return localize("RIFTS.LevelUp.Maneuvers");
  if (normalized === "weaponproficiency") return localize("RIFTS.LevelUp.WeaponProficiencies");
  if (normalized === "package") return localize("RIFTS.LevelUp.PackageChoices");
  return choiceType;
}

function choiceCategoryLabel(category) {
  const normalized = normalizeText(category).toLowerCase();
  if (normalized === "occ") return localize("RIFTS.Skills.OccSkill");
  if (normalized === "related") return localize("RIFTS.Skills.RelatedSkill");
  if (normalized === "secondary") return localize("RIFTS.Skills.SecondarySkill");
  if (normalized === "spell") return localize("RIFTS.LevelUp.Spells");
  if (normalized === "psionic") return localize("RIFTS.LevelUp.Psionics");
  if (normalized === "specialmaneuver") return localize("RIFTS.LevelUp.Maneuvers");
  if (normalized === "weaponproficiency") return localize("RIFTS.LevelUp.WeaponProficiencies");
  if (normalized === "package") return localize("RIFTS.LevelUp.PackageChoices");
  return category || localize("RIFTS.Sheet.None");
}

function formatChoice(choice) {
  return {
    ...choice,
    typeLabel: choiceTypeLabel(choice.choiceType),
    categoryLabel: choiceCategoryLabel(choice.category),
    canChoose: choice.remainingCount > 0,
    poolSize: Array.isArray(choice.pool) ? choice.pool.length : 0,
    completionLabel: `${choice.completedCount}/${choice.count}`
  };
}

export class RiftsLevelUpApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _listenerAbortController = null;

  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
  }

  static DEFAULT_OPTIONS = foundry.utils.mergeObject(super.DEFAULT_OPTIONS, {
    id: "rifts-level-up",
    classes: ["rifts", "app", "level-up"],
    window: {
      title: "RIFTS.LevelUp.LevelUp",
      icon: "fa-solid fa-arrow-up-right-dots",
      resizable: true
    },
    position: {
      width: 900,
      height: 760
    }
  }, { inplace: false });

  static PARTS = {
    body: {
      template: "systems/rifts-megaverse/templates/apps/level-up.hbs"
    }
  };

  _onClose(options) {
    this._listenerAbortController?.abort();
    this._listenerAbortController = null;
    return super._onClose(options);
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const session = await getLevelUpSession(this.actor, { persist: true });
    const requiredChoices = (session.requiredChoices ?? []).map((entry) => formatChoice(entry));
    const optionalChoices = (session.optionalChoices ?? []).map((entry) => formatChoice(entry));

    const progressPercent = session.totals.requiredTotal > 0
      ? Math.floor((session.totals.requiredCompleted / Math.max(1, session.totals.requiredTotal)) * 100)
      : 100;

    context.actor = this.actor;
    context.session = session;
    context.requiredChoices = requiredChoices;
    context.optionalChoices = optionalChoices;
    context.hasRequiredChoices = requiredChoices.length > 0;
    context.hasOptionalChoices = optionalChoices.length > 0;
    context.hasAutomaticGains = (session.automaticGains ?? []).length > 0;
    context.progressPercent = Math.max(0, Math.min(100, progressPercent));
    context.progressStyle = `width: ${context.progressPercent}%;`;
    context.canManage = canUserManageLevelUp(this.actor);
    context.canGmOverride = game.user?.isGM === true;
    context.isComplete = session.totals.isComplete;
    context.statusLabel = localize(session.totals.isComplete ? "RIFTS.LevelUp.LevelUpComplete" : "RIFTS.LevelUp.LevelUpIncomplete");

    return context;
  }

  _openChoiceDialog(choiceId) {
    getLevelUpSession(this.actor, { persist: false }).then((session) => {
      const choice = [...session.requiredChoices, ...session.optionalChoices].find((entry) => entry.id === choiceId);
      if (!choice) return;

      const entries = (choice.pool ?? []).map((entry) => ({
        entryId: entry.entryId,
        name: entry.name,
        category: entry.category,
        detail: entry.detail,
        source: entry.source,
        status: entry.status,
        actionLabel: localize("RIFTS.LevelUp.Choose"),
        disabled: entry.disabled === true
      }));

      const app = new RiftsSelectionDialog({
        titleKey: "RIFTS.LevelUp.LevelUp",
        description: `${choice.label} (${choice.completedCount}/${choice.count})`,
        groups: [{
          id: choice.id,
          label: choice.label,
          emptyLabel: localize("RIFTS.SelectionDialog.NoneAvailable"),
          entries
        }],
        onSelect: async (selection) => {
          const result = await applyLevelUpChoice(this.actor, choice.id, selection.entryId);

          const status = String(result?.status ?? "");
          if (status === "selected") {
            this.render();
            return;
          }

          if (["already-known", "duplicate"].includes(status)) {
            ui.notifications.warn(localize("RIFTS.LevelUp.AlreadyKnown"));
            return;
          }

          if (status === "choice-already-complete") {
            ui.notifications.warn(localize("RIFTS.LevelUp.ChoiceAlreadyComplete"));
            return;
          }

          ui.notifications.warn(localize("RIFTS.Advanced.NotAvailable"));
        },
        closeOnSelect: false
      });

      app.render(true);
    });
  }

  async _onRender(context, options) {
    await super._onRender(context, options);

    this._listenerAbortController?.abort();
    const signal = (this._listenerAbortController = new AbortController()).signal;

    const root = this.element;
    if (!(root instanceof HTMLElement)) return;

    root.querySelectorAll("[data-action='refresh-level-up']").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        this.render();
      }, { signal });
    });

    root.querySelectorAll("[data-action='apply-automatic-gains']").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        const result = await applyAutomaticLevelUpGains(this.actor);
        if (result?.status !== "ok") {
          ui.notifications.warn(localize("RIFTS.Advanced.NotAvailable"));
          return;
        }

        ui.notifications.info(localize("RIFTS.LevelUp.AutomaticApplied"));
        this.render();
      }, { signal });
    });

    root.querySelectorAll("[data-action='choose-choice']").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        const choiceId = normalizeText(event.currentTarget.dataset.choiceId);
        if (!choiceId) return;
        this._openChoiceDialog(choiceId);
      }, { signal });
    });

    root.querySelectorAll("[data-action='clear-choice']").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        const choiceId = normalizeText(event.currentTarget.dataset.choiceId);
        if (!choiceId) return;

        const result = await clearLevelUpChoiceSelections(this.actor, choiceId);
        if (result?.status !== "ok") {
          ui.notifications.warn(localize("RIFTS.Advanced.NotAvailable"));
          return;
        }

        this.render();
      }, { signal });
    });

    root.querySelectorAll("[data-action='mark-choice-complete']").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        const choiceId = normalizeText(event.currentTarget.dataset.choiceId);
        const completed = normalizeText(event.currentTarget.dataset.completed) !== "false";
        if (!choiceId) return;

        const result = await markLevelUpChoiceComplete(this.actor, choiceId, completed);
        if (result?.status !== "ok") {
          ui.notifications.warn(localize("RIFTS.Advanced.NotAvailable"));
          return;
        }

        this.render();
      }, { signal });
    });

    root.querySelectorAll("[data-action='finalize-level-up']").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        const force = normalizeText(event.currentTarget.dataset.force) === "true";

        const result = await finalizeLevelUpSession(this.actor, { force });
        if (result?.status === "complete") {
          ui.notifications.info(localize("RIFTS.LevelUp.SessionFinalized"));
          this.render();
          return;
        }

        if (result?.status === "incomplete") {
          ui.notifications.warn(localize("RIFTS.LevelUp.LevelUpIncomplete"));
          return;
        }

        ui.notifications.warn(localize("RIFTS.Advanced.NotAvailable"));
      }, { signal });
    });
  }
}

export function openLevelUpDialog(actor) {
  if (!actor) return null;
  const app = new RiftsLevelUpApp(actor);
  app.render(true);
  return app;
}
