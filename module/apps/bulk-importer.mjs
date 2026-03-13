import {
  executeBulkImport,
  getBulkImportProfiles,
  getCompendiumChoicesForProfile,
  getImportSummaryRows,
  getImporterDestinations,
  getImporterDuplicateModes,
  getImporterWorldFolders,
  getImporterInputFormats,
  getImporterTemplate,
  getSupportedFormatsForProfile,
  previewBulkImport
} from "../services/bulk-import.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function localize(key) {
  return game.i18n.localize(key);
}

function formatCount(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

export class RiftsBulkImporterApp extends HandlebarsApplicationMixin(ApplicationV2) {
  _listenerAbortController = null;

  constructor(options = {}) {
    super(options);

    const profiles = getBulkImportProfiles();
    const defaultProfileId = profiles[0]?.id ?? "skill";

    this._state = {
      profileId: defaultProfileId,
      inputFormat: "csv",
      duplicateMode: "skip",
      destination: "world",
      packId: "",
      folderId: "",
      raw: getImporterTemplate(defaultProfileId, "csv"),
      preview: null,
      report: null,
      previewSignature: ""
    };
  }

  static DEFAULT_OPTIONS = foundry.utils.mergeObject(super.DEFAULT_OPTIONS, {
    id: "rifts-bulk-importer",
    classes: ["rifts", "app", "bulk-importer"],
    window: {
      title: "RIFTS.Importer.BulkImporter",
      icon: "fa-solid fa-file-import",
      resizable: true
    },
    position: {
      width: 860,
      height: 860
    }
  }, { inplace: false });

  static PARTS = {
    body: {
      template: "systems/rifts-megaverse/templates/apps/bulk-importer.hbs"
    }
  };

  _sanitizeState() {
    const profiles = getBulkImportProfiles();
    if (!profiles.some((entry) => entry.id === this._state.profileId)) {
      this._state.profileId = profiles[0]?.id ?? "skill";
    }

    const supportedFormats = getSupportedFormatsForProfile(this._state.profileId);
    if (!supportedFormats.includes(this._state.inputFormat)) {
      this._state.inputFormat = supportedFormats[0] ?? "json";
    }

    if (!getImporterDuplicateModes().some((entry) => entry.id === this._state.duplicateMode)) {
      this._state.duplicateMode = "skip";
    }

    if (!getImporterDestinations().some((entry) => entry.id === this._state.destination)) {
      this._state.destination = "world";
    }

    const packs = getCompendiumChoicesForProfile(this._state.profileId);
    if (this._state.destination === "compendium" && !packs.some((entry) => entry.id === this._state.packId)) {
      this._state.packId = packs[0]?.id ?? "";
    }

    if (this._state.destination !== "world") {
      this._state.folderId = "";
    } else {
      const folders = getImporterWorldFolders(this._state.profileId);
      if (this._state.folderId && !folders.some((entry) => entry.id === this._state.folderId)) {
        this._state.folderId = "";
      }
    }
  }

  _buildOperationOptions() {
    this._sanitizeState();

    return {
      profileId: this._state.profileId,
      inputFormat: this._state.inputFormat,
      duplicateMode: this._state.duplicateMode,
      destination: this._state.destination,
      packId: this._state.packId,
      folderId: this._state.destination === "world" ? this._state.folderId : "",
      raw: this._state.raw
    };
  }

  _buildSignature(options) {
    return JSON.stringify(options);
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    this._sanitizeState();

    const profiles = getBulkImportProfiles().map((entry) => ({
      ...entry,
      label: localize(entry.labelKey),
      selected: entry.id === this._state.profileId
    }));

    const supportedFormats = getSupportedFormatsForProfile(this._state.profileId);
    const inputFormats = getImporterInputFormats()
      .filter((entry) => supportedFormats.includes(entry.id))
      .map((entry) => ({
        ...entry,
        label: localize(entry.labelKey),
        selected: entry.id === this._state.inputFormat
      }));

    const duplicateModes = getImporterDuplicateModes().map((entry) => ({
      ...entry,
      label: localize(entry.labelKey),
      selected: entry.id === this._state.duplicateMode
    }));

    const destinations = getImporterDestinations().map((entry) => ({
      ...entry,
      label: localize(entry.labelKey),
      selected: entry.id === this._state.destination
    }));

    const compendiumChoices = getCompendiumChoicesForProfile(this._state.profileId).map((entry) => ({
      ...entry,
      selected: entry.id === this._state.packId
    }));

    const worldFolderChoices = [
      {
        id: "",
        label: localize("RIFTS.Importer.NoFolder"),
        selected: !this._state.folderId
      },
      ...getImporterWorldFolders(this._state.profileId).map((entry) => ({
        id: entry.id,
        label: entry.name,
        selected: entry.id === this._state.folderId
      }))
    ];

    const preview = this._state.preview;
    const report = this._state.report;

    const activeProfile = profiles.find((entry) => entry.selected) ?? profiles[0] ?? null;

    context.profiles = profiles;
    context.activeProfileLabel = activeProfile?.label ?? this._state.profileId;
    context.inputFormats = inputFormats;
    context.duplicateModes = duplicateModes;
    context.destinations = destinations;
    context.compendiumChoices = compendiumChoices;
    context.worldFolderChoices = worldFolderChoices;
    context.showCompendiumChoice = this._state.destination === "compendium";
    context.showWorldFolderChoice = this._state.destination === "world";

    context.state = {
      ...this._state,
      sampleTemplate: getImporterTemplate(this._state.profileId, this._state.inputFormat)
    };

    context.preview = preview;
    context.previewRows = getImportSummaryRows(preview, 25);
    context.previewHasErrors = (preview?.errors?.length ?? 0) > 0;
    context.previewCanImport = formatCount(preview?.counts?.create) + formatCount(preview?.counts?.update) > 0;

    context.report = report;
    context.reportRows = getImportSummaryRows(report, 25);
    context.reportHasErrors = (report?.errors?.length ?? 0) > 0;

    return context;
  }

  _onClose(options) {
    this._listenerAbortController?.abort();
    this._listenerAbortController = null;
    return super._onClose(options);
  }

  _bind(element, eventName, handler, signal) {
    element?.addEventListener(eventName, handler, { signal });
  }

  async _runPreview() {
    if (!game.user?.isGM) {
      ui.notifications.warn(localize("RIFTS.Recovery.GMOnly"));
      return;
    }

    const operationOptions = this._buildOperationOptions();
    const preview = await previewBulkImport(operationOptions);

    this._state.preview = preview;
    this._state.report = null;
    this._state.previewSignature = this._buildSignature(operationOptions);

    if (!preview.ok) {
      ui.notifications.error(localize("RIFTS.Importer.PreviewFailed"));
    } else {
      ui.notifications.info(game.i18n.format("RIFTS.Importer.PreviewReady", {
        parsed: preview.counts.parsed,
        valid: preview.counts.valid,
        invalid: preview.counts.invalid
      }));
    }

    this.render();
  }

  async _runImport() {
    if (!game.user?.isGM) {
      ui.notifications.warn(localize("RIFTS.Recovery.GMOnly"));
      return;
    }

    const operationOptions = this._buildOperationOptions();
    const signature = this._buildSignature(operationOptions);

    if (!this._state.preview || this._state.previewSignature !== signature) {
      await this._runPreview();
      if (!this._state.preview?.ok) return;
    }

    const canImport = formatCount(this._state.preview?.counts?.create) + formatCount(this._state.preview?.counts?.update);
    if (canImport <= 0) {
      ui.notifications.warn(localize("RIFTS.Importer.NothingToImport"));
      return;
    }

    const report = await executeBulkImport(operationOptions);
    this._state.report = report;

    if (report.ok) {
      ui.notifications.info(game.i18n.format("RIFTS.Importer.ImportComplete", {
        created: report.counts.created,
        updated: report.counts.updated,
        skipped: report.counts.skipped,
        errors: report.counts.errors
      }));
    } else {
      ui.notifications.error(localize("RIFTS.Importer.ImportFailed"));
    }

    if ((report.counts.created + report.counts.updated) > 0) {
      ui.items?.render?.();
      ui.actors?.render?.();
      ui.compendium?.render?.();
    }

    this.render();
  }

  _onRender(context, options) {
    super._onRender(context, options);

    const root = this.element instanceof HTMLElement ? this.element : this.element?.[0];
    if (!root) return;

    this._listenerAbortController?.abort();
    this._listenerAbortController = new AbortController();
    const signal = this._listenerAbortController.signal;

    for (const control of root.querySelectorAll("[name='profileId'], [name='inputFormat'], [name='duplicateMode'], [name='destination'], [name='packId'], [name='folderId']")) {
      this._bind(control, "change", (event) => {
        const target = event.currentTarget;
        const key = target.name;
        this._state[key] = target.value;

        if (key === "profileId") {
          const supported = getSupportedFormatsForProfile(this._state.profileId);
          if (!supported.includes(this._state.inputFormat)) {
            this._state.inputFormat = supported[0] ?? "json";
          }
          this._state.preview = null;
          this._state.report = null;
          this._state.raw = getImporterTemplate(this._state.profileId, this._state.inputFormat);
        }

        if (key === "inputFormat") {
          this._state.preview = null;
          this._state.report = null;
          this._state.raw = getImporterTemplate(this._state.profileId, this._state.inputFormat);
        }

        if (["duplicateMode", "destination", "packId", "folderId"].includes(key)) {
          this._state.preview = null;
          this._state.report = null;
        }

        this.render();
      }, signal);
    }

    const rawInput = root.querySelector("textarea[name='raw']");
    this._bind(rawInput, "change", (event) => {
      this._state.raw = String(event.currentTarget.value ?? "");
      this._state.preview = null;
      this._state.report = null;
    }, signal);

    for (const button of root.querySelectorAll("[data-action='use-sample']")) {
      this._bind(button, "click", (event) => {
        event.preventDefault();
        this._state.raw = getImporterTemplate(this._state.profileId, this._state.inputFormat);
        this._state.preview = null;
        this._state.report = null;
        this.render();
      }, signal);
    }

    for (const button of root.querySelectorAll("[data-action='preview']")) {
      this._bind(button, "click", async (event) => {
        event.preventDefault();
        this._state.raw = String(rawInput?.value ?? this._state.raw ?? "");
        await this._runPreview();
      }, signal);
    }

    for (const button of root.querySelectorAll("[data-action='import']")) {
      this._bind(button, "click", async (event) => {
        event.preventDefault();
        this._state.raw = String(rawInput?.value ?? this._state.raw ?? "");
        await this._runImport();
      }, signal);
    }
  }
}

export class RiftsBulkImporterMenu extends FormApplication {
  render(force, options = {}) {
    if (!game.user?.isGM) return this;

    openBulkImporter();

    // Menu launcher must not remain as its own application window.
    if (this.rendered) {
      this.close({ force: true });
    } else {
      queueMicrotask(() => this.close({ force: true }));
    }

    return this;
  }

  async _updateObject(_event, _formData) {
    return;
  }
}

export function openBulkImporter() {
  const app = new RiftsBulkImporterApp();
  app.render(true);
  return app;
}

