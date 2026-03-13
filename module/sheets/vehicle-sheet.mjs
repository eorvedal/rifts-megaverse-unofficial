import { getTargetFromUI } from "../services/combat.mjs";
import {
  advanceMeleeAction,
  getMeleeQueueStatus,
  holdCurrentMeleeAction,
  releaseHeldAction
} from "../services/melee-sequencer.mjs";

const { ActorSheetV2 } = foundry.applications.sheets;
const { HandlebarsApplicationMixin } = foundry.applications.api;

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function weaponData(item) {
  const isMounted = item.system?.weapon?.isMounted === true;
  const fireMode = item.system?.weapon?.fireMode ?? "single";
  return {
    isMounted,
    mountName: normalizeText(item.system?.weapon?.mountName),
    linkedToVehicle: item.system?.weapon?.linkedToVehicle === true,
    requiresCrew: Math.max(1, num(item.system?.weapon?.requiresCrew, 1)),
    isMegaDamage: item.system?.weapon?.isMegaDamage === true,
    damage: item.system?.weapon?.damage ?? item.system?.damage ?? "1d6",
    bonusStrike: num(item.system?.weapon?.bonusStrike, num(item.system?.bonusStrike, 0)),
    isBurstCapable: item.system?.weapon?.isBurstCapable === true,
    fireMode,
    fireModeLabel: fireMode === "burst"
      ? game.i18n.localize("RIFTS.Advanced.BurstFire")
      : game.i18n.localize("RIFTS.Advanced.SingleShot"),
    supportsAimedShot: item.system?.weapon?.supportsAimedShot !== false,
    equipped: item.system?.equipped === true,
    active: item.system?.active === true
  };
}

function inventoryData(item) {
  return {
    quantity: num(item.system?.quantity, 1),
    weight: num(item.system?.weight, 0),
    typeLabel: item.type
  };
}

export class RiftsVehicleSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
  _listenerAbortController = null;

  static DEFAULT_OPTIONS = foundry.utils.mergeObject(super.DEFAULT_OPTIONS, {
    id: "rifts-vehicle-sheet",
    classes: ["rifts", "sheet", "actor", "vehicle"],
    position: {
      width: 1180,
      height: 860
    },
    form: {
      submitOnChange: true,
      closeOnSubmit: false
    },
    window: {
      resizable: true,
      title: "RIFTS.Sheet.Vehicle"
    }  }, { inplace: false });

  static PARTS = {
    body: {
      template: "systems/rifts-megaverse/templates/actor/vehicle-sheet.hbs"
    }
  };

  _canEditFields() {
    return this.isEditable;
  }

  _getContextTokenId() {
    return String(
      this.token?.id
      ?? this.document?.token?.id
      ?? this.document?.parent?.id
      ?? ""
    );
  }

  async _flushPendingField(root) {
    const active = document.activeElement;
    if (!active || !root.contains(active) || !active.name) return;
    active.dispatchEvent(new Event("change", { bubbles: true }));
    await foundry.utils.sleep(0);
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const activeTab = this._activeTab ?? "combat";

    const mountedWeapons = this.document.items
      .filter((item) => item.type === "weapon")
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((item) => ({ item, data: weaponData(item) }));

    const inventoryItems = this.document.items
      .filter((item) => item.type !== "weapon")
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((item) => ({ item, data: inventoryData(item) }));

    const contextTokenId = this._getContextTokenId();
    const contextTokenRef = contextTokenId
      ? (canvas?.tokens?.get?.(contextTokenId)
        ?? canvas?.tokens?.placeables?.find((entry) => String(entry.id ?? "") === String(contextTokenId))
        ?? null)
      : null;
    const uiTarget = getTargetFromUI();
    const savedTargetId = this.document.system?.combat?.lastTargetId ?? "";
    const savedTargetTokenId = this.document.system?.combat?.lastTargetTokenId ?? "";
    const savedTargetToken = savedTargetTokenId
      ? (canvas?.tokens?.get?.(savedTargetTokenId)
        ?? canvas?.tokens?.placeables?.find((entry) => entry.id === savedTargetTokenId)
        ?? null)
      : null;
    const savedTargetActor = savedTargetToken?.actor ?? (savedTargetId ? game.actors.get(savedTargetId) : null);

    const combatant = game.combat?.combatants?.find((entry) => {
      const combatantTokenId = String(entry?.tokenId ?? entry?.token?.id ?? "");
      if (contextTokenId) return combatantTokenId === contextTokenId;
      return entry.actorId === this.document.id;
    });
    const meleeQueue = getMeleeQueueStatus(game.combat, this.document.id, contextTokenId);

    context.actor = this.document;
    context.portraitImg = contextTokenRef?.document?.texture?.src
      ?? contextTokenRef?.texture?.src
      ?? this.document?.img
      ?? this.document?.prototypeToken?.texture?.src
      ?? "";
    context.system = this.document.system;
    context.vehicle = this.document.system?.vehicle ?? {};
    context.activeTab = activeTab;
    context.isCombatTab = activeTab === "combat";
    context.isSystemsTab = activeTab === "systems";
    context.isInventoryTab = activeTab === "inventory";
    context.isNotesTab = activeTab === "notes";

    context.mountedWeapons = mountedWeapons;
    context.hasMountedWeapons = mountedWeapons.length > 0;
    context.inventoryItems = inventoryItems;
    context.hasInventoryItems = inventoryItems.length > 0;

    context.hasCombat = Boolean(game.combat);
    context.hasCombatant = Boolean(combatant);
    context.currentTargetName = uiTarget?.actor?.name ?? game.i18n.localize("RIFTS.Combat.NoTarget");
    context.savedTargetName = savedTargetActor?.name ?? game.i18n.localize("RIFTS.Combat.NoSavedTarget");
    context.hasCurrentTarget = Boolean(uiTarget?.actor);
    context.hasMeleeQueue = meleeQueue.hasQueue;
    context.meleeQueuePosition = meleeQueue.position;
    context.meleeQueueTotal = meleeQueue.total;
    context.currentMeleePass = meleeQueue.currentPass;
    context.currentMeleeActorName = meleeQueue.currentActorName;
    context.isCurrentMeleeActor = meleeQueue.isCurrentActor;
    context.isWaitingForMeleeTurn = meleeQueue.hasQueue && !meleeQueue.isCurrentActor && !meleeQueue.isComplete;
    context.canAdvanceMelee = Boolean(game.combat) && game.user.isGM && meleeQueue.hasQueue;
    context.autoDodgeAvailable = this.document.system?.combat?.autoDodgeAvailable === true;
    context.effectiveDurabilityLabel = game.i18n.localize(
      this.document.system?.combat?.derived?.effectiveDurabilityLabelKey
      ?? this.document.system?.combat?.derived?.effectiveScaleLabelKey
      ?? "RIFTS.Combat.MDC"
    );
    const sizeCategory = normalizeText(this.document.system?.details?.sizeCategory || this.document.system?.vehicle?.sizeCategory || "large").toLowerCase();
    context.sizeCategory = ["small", "human", "large", "giant"].includes(sizeCategory) ? sizeCategory : "large";
    const sizeCategoryLabelKeys = {
      small: "RIFTS.Size.Small",
      human: "RIFTS.Size.Human",
      large: "RIFTS.Size.Large",
      giant: "RIFTS.Size.Giant"
    };
    context.sizeCategoryLabel = game.i18n.localize(sizeCategoryLabelKeys[context.sizeCategory] ?? "RIFTS.Size.Large");
    context.sizeCategoryOptions = {
      small: game.i18n.localize("RIFTS.Size.Small"),
      human: game.i18n.localize("RIFTS.Size.Human"),
      large: game.i18n.localize("RIFTS.Size.Large"),
      giant: game.i18n.localize("RIFTS.Size.Giant")
    };
    context.hasValidVehicleMdc = this.document.system?.combat?.derived?.hasValidVehicleMdc !== false;
    context.heldActionCount = Math.max(0, Math.floor(num(this.document.system?.combat?.heldActionCount, 0)));
    context.heldActionReady = this.document.system?.combat?.heldActionReady === true;

    context.classification = normalizeText(this.document.system?.vehicle?.classification);
    context.crewRequired = Math.max(1, num(this.document.system?.vehicle?.crewRequired, 1));
    context.passengerCapacity = Math.max(0, num(this.document.system?.vehicle?.passengerCapacity, 0));
    context.speedGround = num(this.document.system?.vehicle?.speedGround, 0);
    context.speedAir = num(this.document.system?.vehicle?.speedAir, 0);
    context.speedWater = num(this.document.system?.vehicle?.speedWater, 0);
    context.handling = num(this.document.system?.vehicle?.handling, 0);
    context.pilotBonus = num(this.document.system?.combat?.pilotBonus, 0);

    context.quickMountedCount = mountedWeapons.length;
    context.quickMdc = num(this.document.system?.resources?.mdc?.value, 0);
    context.quickFuel = num(this.document.system?.resources?.fuel?.value, 0);
    context.apmTotal = num(this.document.system?.combat?.apmTotal, num(this.document.system?.combat?.derived?.apmTotal, 0));
    context.apmRemaining = num(this.document.system?.combat?.apmRemaining, num(this.document.system?.combat?.derived?.apmRemaining, 0));

    return context;
  }

  async _handleDropItemData(dropData) {
    if (dropData?.type !== "Item") return false;

    let sourceItem = null;
    if (dropData.uuid) {
      const source = await fromUuid(dropData.uuid);
      if (source instanceof Item) sourceItem = source;
    }

    if (sourceItem?.parent?.id === this.document.id) return true;

    const itemData = sourceItem
      ? sourceItem.toObject()
      : foundry.utils.deepClone(dropData.data ?? null);

    if (!itemData || !itemData.type) return true;

    delete itemData._id;
    await this.document.createEmbeddedDocuments("Item", [itemData]);
    return true;
  }

  async _onDrop(event) {
    const dropData = TextEditor.getDragEventData(event);
    if (dropData?.type !== "Item") return super._onDrop(event);
    if (!this._canEditFields()) return false;

    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();

    await this._handleDropItemData(dropData);
    return false;
  }

  _bindEvent(element, eventName, handler, signal, options = {}) {
    element?.addEventListener(eventName, handler, { ...options, signal });
  }

  async _setWeaponFlag(itemId, path, value) {
    const item = this.document.items.get(itemId);
    if (!item || item.type !== "weapon") return;
    await item.update({ [path]: value });
  }

  _resolveTokenConfigDocument() {
    const contextTokenId = String(this._getContextTokenId?.() ?? "");
    const placeables = canvas?.tokens?.placeables ?? [];

    const contextSceneToken = contextTokenId
      ? (canvas?.tokens?.get?.(contextTokenId)
        ?? placeables.find((entry) => String(entry.id ?? "") === contextTokenId)
        ?? null)
      : null;

    const actorMatches = placeables.filter((entry) => String(entry.actor?.id ?? "") === String(this.document?.id ?? ""));
    const controlledMatch = actorMatches.find((entry) => entry.controlled) ?? null;
    const fallbackSceneToken = controlledMatch ?? actorMatches[0] ?? null;

    const candidates = [
      contextSceneToken?.document,
      fallbackSceneToken?.document,
      this.token?.document ?? this.token,
      this.options?.token?.document ?? this.options?.token,
      this.document?.token
    ];

    for (const candidate of candidates) {
      const tokenDoc = candidate?.document ?? candidate;
      if (!tokenDoc) continue;
      const isTokenDoc = tokenDoc.documentName === "Token" || tokenDoc.constructor?.name === "TokenDocument";
      if (!isTokenDoc) continue;
      return tokenDoc;
    }

    return null;
  }

  async _openTokenConfigSafe() {
    let tokenDoc = this._resolveTokenConfigDocument();

    if (!tokenDoc?.sheet?.render) {
      tokenDoc = await this.document?.getTokenDocument?.();
    }

    if (tokenDoc?.sheet?.render) {
      tokenDoc.sheet.render(true);
      return true;
    }

    ui.notifications?.warn?.("Token configuration unavailable for this sheet context");
    return false;
  }

  async _openPrototypeTokenConfigSafe() {
    const tokenDoc = this.document?.prototypeToken ?? null;

    if (tokenDoc?.sheet?.render) {
      tokenDoc.sheet.render(true);
      return true;
    }

    ui.notifications?.warn?.("Prototype token configuration unavailable for this actor");
    return false;
  }
  async _onClickAction(event, target) {
    const actionKey = String(target?.dataset?.action ?? "")
      .toLowerCase()
      .replace(/[^a-z]/g, "");

    if (actionKey === "configuretoken") {
      event.preventDefault();
      await this._openTokenConfigSafe();
      return;
    }

    return super._onClickAction?.(event, target);
  }
  _onClose(options) {
    this._listenerAbortController?.abort();
    this._listenerAbortController = null;
    return super._onClose(options);
  }

  _onRender(context, options) {
    super._onRender(context, options);

    const root = this.element instanceof HTMLElement ? this.element : this.element?.[0];
    if (!root) return;

    this._listenerAbortController?.abort();
    this._listenerAbortController = new AbortController();
    const signal = this._listenerAbortController.signal;

    this._bindEvent(root, "click", async (event) => {
      const actionTarget = event.target?.closest?.("[data-action]");
      if (!actionTarget) return;

      const actionKey = String(actionTarget.dataset.action ?? "")
        .toLowerCase()
        .replace(/[^a-z]/g, "");

      if (actionKey === "configuretoken") {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
        await this._openTokenConfigSafe();
        return;
      }
    }, signal, { capture: true });
    if (!this._canEditFields()) {
      root.querySelectorAll("input[name], select[name], textarea[name], [data-action='edit-item'], [data-action='delete-item'], [data-action='use-current-target']")
        .forEach((field) => {
          field.disabled = true;
        });
    }

    for (const button of root.querySelectorAll("[data-action='switch-tab']")) {
      this._bindEvent(button, "click", (event) => {
        event.preventDefault();
        this._activeTab = event.currentTarget.dataset.tab;
        this.render();
      }, signal);
    }

    for (const button of root.querySelectorAll("[data-action='advance-melee']")) {
      this._bindEvent(button, "click", async (event) => {
        event.preventDefault();
        if (!game.user.isGM || !game.combat) return;

        await this._flushPendingField(root);
        await advanceMeleeAction(game.combat, { announce: true });
        this.render();
      }, signal);
    }

    for (const button of root.querySelectorAll("[data-action='hold-action']")) {
      this._bindEvent(button, "click", async (event) => {
        event.preventDefault();
        if (!game.combat) {
          ui.notifications.warn(game.i18n.localize("RIFTS.Advanced.NotAvailable"));
          return;
        }

        await this._flushPendingField(root);
        const result = await holdCurrentMeleeAction({
          combat: game.combat,
          actor: this.document,
          announce: true,
          allowGMOverride: true,
          tokenId: this._getContextTokenId()
        });

        if (!result?.ok) {
          if (result?.reason === "no-attacks") {
            ui.notifications.warn(game.i18n.localize("RIFTS.Combat.NoAttacksRemaining"));
          } else if (result?.reason === "already-held") {
            ui.notifications.warn(game.i18n.localize("RIFTS.Advanced.ReleaseHeldRequired"));
          } else {
            ui.notifications.warn(game.i18n.localize("RIFTS.Advanced.NotAvailable"));
          }
        }

        this.render();
      }, signal);
    }

    for (const button of root.querySelectorAll("[data-action='release-held-action']")) {
      this._bindEvent(button, "click", async (event) => {
        event.preventDefault();

        await this._flushPendingField(root);
        const result = await releaseHeldAction(this.document, { announce: true });
        if (!result?.ok) {
          ui.notifications.warn(game.i18n.localize("RIFTS.Advanced.NotAvailable"));
        }

        this.render();
      }, signal);
    }

    for (const field of root.querySelectorAll("input[name], select[name], textarea[name]")) {
      this._bindEvent(field, "change", async (event) => {
        if (!this._canEditFields()) return;

        const target = event.currentTarget;
        const path = target.name;
        if (!path) return;

        let value;
        if (target.type === "checkbox") value = target.checked;
        else if (target.type === "number") value = Number(target.value || 0);
        else value = target.value;

        await this.document.update({ [path]: value });
      }, signal);
    }

    for (const button of root.querySelectorAll("[data-action='use-current-target']")) {
      this._bindEvent(button, "click", async (event) => {
        event.preventDefault();
        if (!this._canEditFields()) return;

        const target = getTargetFromUI();
        if (!target?.actor) {
          ui.notifications.warn(game.i18n.localize("RIFTS.Combat.NoSingleTarget"));
          return;
        }

        await this.document.update({
          "system.combat.lastTargetId": target.actor.id,
          "system.combat.lastTargetTokenId": target.token?.id ?? ""
        });
      }, signal);
    }

    for (const checkbox of root.querySelectorAll("[data-action='toggle-weapon-equipped']")) {
      this._bindEvent(checkbox, "change", async (event) => {
        if (!this._canEditFields()) return;
        await this._setWeaponFlag(event.currentTarget.dataset.itemId, "system.equipped", event.currentTarget.checked);
      }, signal);
    }

    for (const checkbox of root.querySelectorAll("[data-action='toggle-weapon-active']")) {
      this._bindEvent(checkbox, "change", async (event) => {
        if (!this._canEditFields()) return;
        await this._setWeaponFlag(event.currentTarget.dataset.itemId, "system.active", event.currentTarget.checked);
      }, signal);
    }

    for (const row of root.querySelectorAll(".inventory-item-row")) {
      this._bindEvent(row, "dblclick", (event) => {
        if (event.target?.closest?.("button, input, select, textarea, label, a")) return;
        const itemId = row.dataset.itemId;
        if (!itemId) return;
        const item = this.document.items.get(itemId);
        item?.sheet?.render(true);
      }, signal);
    }

    for (const button of root.querySelectorAll("[data-action='edit-item']")) {
      this._bindEvent(button, "click", (event) => {
        event.preventDefault();
        const itemId = event.currentTarget.dataset.itemId;
        const item = this.document.items.get(itemId);
        item?.sheet?.render(true);
      }, signal);
    }

    for (const button of root.querySelectorAll("[data-action='delete-item']")) {
      this._bindEvent(button, "click", async (event) => {
        event.preventDefault();
        if (!this._canEditFields()) return;

        const itemId = event.currentTarget.dataset.itemId;
        const item = this.document.items.get(itemId);
        if (!item) return;

        await item.delete();
      }, signal);
    }

    for (const button of root.querySelectorAll("[data-action='weapon-attack']")) {
      this._bindEvent(button, "click", async (event) => {
        event.preventDefault();
        const weaponId = event.currentTarget.dataset.itemId;
        if (!weaponId) return;

        const attackAction = event.currentTarget.dataset.attackAction ?? "standard";

        await this._flushPendingField(root);
        await this.document.rollWeaponAttack(weaponId, {
          attackAction,
          tokenId: this._getContextTokenId()
        });
      }, signal);
    }

    const initiativeButton = root.querySelector("[data-action='roll-initiative']");
    const combatInitiativeButton = root.querySelector("[data-action='roll-initiative-combat']");

    this._bindEvent(initiativeButton, "click", async () => {
      await this._flushPendingField(root);
      this.document.rollInitiative({ preferCombat: false, tokenId: this._getContextTokenId() });
    }, signal);

    this._bindEvent(combatInitiativeButton, "click", async () => {
      await this._flushPendingField(root);
      this.document.rollInitiative({ preferCombat: true, tokenId: this._getContextTokenId() });
    }, signal);
  }
}
















