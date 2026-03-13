const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function localize(key, fallback = "") {
  if (!key) return fallback;
  const localized = game?.i18n?.localize?.(key);
  return localized || fallback || key;
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeGroups(groups = []) {
  if (!Array.isArray(groups)) return [];

  return groups
    .map((group, groupIndex) => {
      const entries = Array.isArray(group?.entries) ? group.entries : [];
      return {
        id: normalizeText(group?.id || `group-${groupIndex}`),
        label: normalizeText(group?.label),
        emptyLabel: normalizeText(group?.emptyLabel),
        entries: entries
      };
    })
    .filter((group) => group.id.length > 0);
}

export class RiftsSelectionDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  _listenerAbortController = null;

  constructor(options = {}) {
    super(options);

    this._state = {
      title: normalizeText(options.title),
      titleKey: normalizeText(options.titleKey),
      description: normalizeText(options.description),
      actionLabel: normalizeText(options.actionLabel) || localize("RIFTS.Sheet.Action"),
      closeOnSelect: options.closeOnSelect !== false
    };

    this._groups = normalizeGroups(options.groups);
    this._entryMap = new Map();
    this._onSelect = typeof options.onSelect === "function" ? options.onSelect : null;
  }

  static DEFAULT_OPTIONS = foundry.utils.mergeObject(super.DEFAULT_OPTIONS, {
    id: "rifts-selection-dialog",
    classes: ["rifts", "app", "selection-dialog"],
    window: {
      title: "RIFTS.SelectionDialog.Title",
      icon: "fa-solid fa-list-check",
      resizable: true
    },
    position: {
      width: 680,
      height: 640
    }
  }, { inplace: false });

  static PARTS = {
    body: {
      template: "systems/rifts-megaverse/templates/apps/selection-dialog.hbs"
    }
  };

  _onClose(options) {
    this._listenerAbortController?.abort();
    this._listenerAbortController = null;
    return super._onClose(options);
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    this._entryMap.clear();

    const groups = this._groups.map((group) => {
      const entries = (group.entries ?? []).map((entry, index) => {
        const entryId = `${group.id}:${index}`;
        this._entryMap.set(entryId, entry);

        return {
          entryId,
          name: normalizeText(entry?.name),
          category: normalizeText(entry?.category),
          detail: normalizeText(entry?.detail),
          source: normalizeText(entry?.source),
          status: normalizeText(entry?.status),
          actionLabel: normalizeText(entry?.actionLabel) || this._state.actionLabel,
          disabled: entry?.disabled === true
        };
      });

      return {
        id: group.id,
        label: group.label,
        emptyLabel: group.emptyLabel || localize("RIFTS.SelectionDialog.NoneAvailable"),
        entries,
        hasEntries: entries.length > 0
      };
    });

    context.title = this._state.title || localize(this._state.titleKey || "RIFTS.SelectionDialog.Title");
    context.description = this._state.description;
    context.groups = groups;
    context.hasGroups = groups.length > 0;

    return context;
  }

  async _onRender(context, options) {
    await super._onRender(context, options);

    this._listenerAbortController?.abort();
    const signal = (this._listenerAbortController = new AbortController()).signal;

    const root = this.element;
    if (!(root instanceof HTMLElement)) return;

    root.querySelectorAll("[data-action='select-entry']").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.preventDefault();

        const entryId = normalizeText(event.currentTarget.dataset.entryId);
        if (!entryId) return;

        const entry = this._entryMap.get(entryId);
        if (!entry || typeof this._onSelect !== "function") return;

        await this._onSelect(entry);

        if (this._state.closeOnSelect) {
          await this.close();
          return;
        }

        this.render();
      }, { signal });
    });
  }
}
