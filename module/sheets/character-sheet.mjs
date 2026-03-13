import { getTargetFromUI } from "../services/combat.mjs";
import { buildUnarmedDamageProfile, getUnarmedManeuvers } from "../services/unarmed.mjs";
import { normalizeSpecialManeuverEntry } from "../services/maneuvers.mjs";
import { RiftsSelectionDialog } from "../apps/selection-dialog.mjs";
import { openLevelUpDialog } from "../apps/level-up.mjs";
import { openCharacterCreationWizard } from "../apps/character-creation-wizard.mjs";
import { getLevelUpSummary } from "../services/level-up.mjs";
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
function formatRollableDisplay(value, fallback = "0") {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  const textValue = normalizeText(value);
  if (!textValue) return fallback;
  const numeric = Number(textValue);
  if (Number.isFinite(numeric)) return Math.max(0, Math.floor(numeric));
  return textValue;
}
function localize(key, fallback = "") {
  if (!key) return fallback;
  const localized = game?.i18n?.localize?.(key);
  return localized || fallback || key;
}
function normalizeProgressionMap(rawMap) {
  const map = {};

  if (Number.isFinite(Number(rawMap))) {
    const numeric = Math.floor(num(rawMap, 0));
    if (numeric > 0) map["1"] = numeric;
    return map;
  }

  if (Array.isArray(rawMap)) {
    for (let idx = 0; idx < rawMap.length; idx += 1) {
      const value = Math.floor(num(rawMap[idx], 0));
      if (!value) continue;
      map[String(idx + 1)] = value;
    }
    return map;
  }

  if (!rawMap || typeof rawMap !== "object") return map;

  for (const [rawLevel, rawValue] of Object.entries(rawMap)) {
    const level = Math.floor(num(rawLevel, 0));
    const value = Math.floor(num(rawValue, 0));
    if (!Number.isFinite(level) || level <= 0) continue;
    if (!Number.isFinite(value) || value === 0) continue;
    map[String(level)] = value;
  }

  return map;
}

function formatProgressionMapSummary(rawMap) {
  const map = normalizeProgressionMap(rawMap);
  const entries = Object.entries(map)
    .map(([level, value]) => [Math.floor(num(level, 0)), Math.floor(num(value, 0))])
    .filter(([level, value]) => level > 0 && Number.isFinite(value) && value !== 0)
    .sort((a, b) => a[0] - b[0]);

  if (entries.length <= 0) return localize("RIFTS.Sheet.None", "None");
  return entries.map(([level, value]) => `L${level}: ${value >= 0 ? "+" : ""}${value}`).join(", ");
}


function weaponData(item) {
  const fireMode = item.system?.weapon?.fireMode ?? "single";
  return {
    isMegaDamage: item.system?.weapon?.isMegaDamage === true,
    damage: item.system?.weapon?.damage ?? item.system?.damage ?? "1d6",
    bonusStrike: num(item.system?.weapon?.bonusStrike, num(item.system?.bonusStrike, 0)),
    range: item.system?.weapon?.range ?? item.system?.range ?? "",
    equipped: item.system?.equipped === true,
    isBurstCapable: item.system?.weapon?.isBurstCapable === true,
    isMounted: item.system?.weapon?.isMounted === true,
    mountName: normalizeText(item.system?.weapon?.mountName),
    linkedArmorId: normalizeText(item.system?.weapon?.linkedArmorId),
    requiresPowerArmor: item.system?.weapon?.requiresPowerArmor === true,
    fireMode,
    fireModeLabel: fireMode === "burst"
      ? game.i18n.localize("RIFTS.Advanced.BurstFire")
      : game.i18n.localize("RIFTS.Advanced.SingleShot"),
    supportsAimedShot: item.system?.weapon?.supportsAimedShot !== false
  };
}

function readPool(pool, fallbackCurrent = 0, fallbackMax = 0) {
  if (typeof pool === "number") {
    const v = num(pool, fallbackCurrent);
    return { current: v, max: num(pool, fallbackMax || v) };
  }

  if (pool && typeof pool === "object") {
    const current = num(pool.value, fallbackCurrent);
    const max = num(pool.max, fallbackMax || current);
    return { current, max };
  }

  return {
    current: num(fallbackCurrent, 0),
    max: num(fallbackMax, 0)
  };
}

function isPowerArmorItem(item) {
  return item?.system?.armor?.isPowerArmor === true || item?.system?.isPowerArmor === true;
}

function armorData(item) {
  const sdcPool = readPool(item.system?.armor?.sdc, item.system?.sdc?.value, item.system?.sdc?.max);
  const mdcPool = readPool(item.system?.armor?.mdc, item.system?.mdc?.value, item.system?.mdc?.max);
  const active = item.system?.active === true;
  const equipped = item.system?.equipped === true || active;

  return {
    ar: num(item.system?.armor?.ar, num(item.system?.ar, 0)),
    sdc: sdcPool.current,
    sdcMax: sdcPool.max,
    mdc: mdcPool.current,
    mdcMax: mdcPool.max,
    active,
    equipped,
    isPowerArmor: isPowerArmorItem(item)
  };
}

function gearData(item) {
  return {
    quantity: num(item.system?.quantity, 1),
    weight: num(item.system?.weight, 0)
  };
}


const AUGMENT_ATTRIBUTE_KEYS = ["iq", "me", "ma", "ps", "pp", "pe", "pb", "spd"];
const AUGMENT_COMBAT_KEYS = ["strike", "parry", "dodge", "initiative", "apm"];
const AUGMENT_RESOURCE_KEYS = ["hp", "sdc", "mdc", "ppe", "isp"];

function formatAugmentationEffectsSummary(effects) {
  const parts = [];

  for (const key of AUGMENT_ATTRIBUTE_KEYS) {
    const value = num(effects?.attributes?.[key], 0);
    if (!value) continue;
    parts.push(`${key.toUpperCase()} ${value >= 0 ? "+" : ""}${value}`);
  }

  for (const key of AUGMENT_COMBAT_KEYS) {
    const value = num(effects?.combat?.[key], 0);
    if (!value) continue;
    const label = key === "apm" ? "APM" : key[0].toUpperCase() + key.slice(1);
    parts.push(`${label} ${value >= 0 ? "+" : ""}${value}`);
  }

  for (const key of AUGMENT_RESOURCE_KEYS) {
    const value = num(effects?.resources?.[key], 0);
    if (!value) continue;
    parts.push(`${key.toUpperCase()} ${value >= 0 ? "+" : ""}${value}`);
  }

  const flagList = Object.entries(effects?.flags ?? {})
    .filter(([, enabled]) => enabled === true)
    .map(([flag]) => String(flag));
  if (flagList.length > 0) parts.push(`Flags: ${flagList.join(", ")}`);

  return parts.join(", ");
}

function augmentationData(item) {
  const effects = item.system?.effects ?? {};
  const grantedAbilities = Array.isArray(item.system?.grantedAbilities)
    ? item.system.grantedAbilities
    : [];

  const grantedNames = grantedAbilities
    .map((entry) => {
      if (typeof entry === "string") return normalizeText(entry);
      if (!entry || typeof entry !== "object") return "";
      return normalizeText(entry.name || entry.key || entry.label || entry.title);
    })
    .filter((name) => name.length > 0);

  const sourceType = normalizeText(item.system?.sourceType).toLowerCase();
  const sourceId = normalizeText(item.system?.sourceId);
  const sourceName = normalizeText(item.system?.sourceName);

  let sourceLabel = game.i18n.localize("RIFTS.Sheet.None");
  if (sourceType === "occ") {
    const sourceText = sourceName || sourceId || game.i18n.localize("RIFTS.Sheet.ActiveOCC");
    sourceLabel = `${game.i18n.localize("RIFTS.Augmentation.FromOCC")}: ${sourceText}`;
  } else if (sourceType === "bionic") {
    const sourceText = sourceName || sourceId || game.i18n.localize("RIFTS.Augmentation.Bionics");
    sourceLabel = `${game.i18n.localize("RIFTS.Augmentation.FromBionics")}: ${sourceText}`;
  } else if (sourceType === "cybernetic") {
    const sourceText = sourceName || sourceId || game.i18n.localize("RIFTS.Augmentation.Cybernetics");
    sourceLabel = `${game.i18n.localize("RIFTS.Augmentation.FromCybernetics")}: ${sourceText}`;
  }

  return {
    installed: item.system?.installed === true,
    slot: normalizeText(item.system?.slot),
    sourceType,
    sourceId,
    sourceName,
    sourceLabel,
    effectsSummary: formatAugmentationEffectsSummary(effects),
    grantedCount: grantedNames.length,
    grantedLabel: grantedNames.join(", ")
  };
}
function powerData(item) {
  const powerType = normalizeText(item.system?.powerType || item.system?.type || "ability").toLowerCase();
  const costType = normalizeText(item.system?.costType || "none").toLowerCase();

  const powerTypeKey = {
    psionic: "RIFTS.Powers.Psionic",
    spell: "RIFTS.Powers.Spell",
    ability: "RIFTS.Powers.Ability",
    "techno-wizard": "RIFTS.Powers.TechnoWizard",
    supernatural: "RIFTS.Powers.Supernatural"
  }[powerType] ?? "RIFTS.Powers.Ability";

  const costTypeKey = {
    isp: "RIFTS.Powers.CostTypeISP",
    ppe: "RIFTS.Powers.CostTypePPE",
    hp: "RIFTS.Powers.CostTypeHP",
    sdc: "RIFTS.Powers.CostTypeSDC",
    none: "RIFTS.Powers.CostTypeNone"
  }[costType] ?? "RIFTS.Powers.CostTypeNone";

  return {
    powerType,
    powerTypeLabel: game.i18n.localize(powerTypeKey),
    subType: normalizeText(item.system?.subType),
    costType,
    costTypeLabel: game.i18n.localize(costTypeKey),
    cost: Math.max(0, num(item.system?.cost, 0)),
    range: normalizeText(item.system?.range),
    duration: normalizeText(item.system?.duration),
    activationTime: normalizeText(item.system?.activationTime),
    saveType: normalizeText(item.system?.saveType),
    damage: normalizeText(item.system?.damage),
    requiresTarget: item.system?.requiresTarget === true,
    requiresAttackRoll: item.system?.requiresAttackRoll === true,
    requiresSave: item.system?.requiresSave === true,
    active: item.system?.active === true,
    scale: normalizeText(item.system?.scale)
  };
}
function classData(item) {
  const grantedAbilities = Array.isArray(item.system?.grantedAbilities)
    ? item.system.grantedAbilities
      .map((entry) => {
        if (typeof entry === "string") return normalizeText(entry);
        if (!entry || typeof entry !== "object") return "";
        return normalizeText(entry.name || entry.key || entry.label || entry.title);
      })
      .filter((entry) => entry.length > 0)
    : [];

  const grantedSkills = Array.isArray(item.system?.grantedSkills)
    ? item.system.grantedSkills
      .map((entry) => {
        if (typeof entry === "string") return normalizeText(entry);
        if (!entry || typeof entry !== "object") return "";
        return normalizeText(entry.name || entry.key || entry.label || entry.title);
      })
      .filter((entry) => entry.length > 0)
    : [];

  const startingBionicsCount = Array.isArray(item.system?.startingPackages?.bionics)
    ? item.system.startingPackages.bionics.length
    : 0;
  const startingCyberneticsCount = Array.isArray(item.system?.startingPackages?.cybernetics)
    ? item.system.startingPackages.cybernetics.length
    : 0;

  return {
    type: item.type,
    typeLabel: item.type === "occ" ? game.i18n.localize("RIFTS.Sheet.OCC") : game.i18n.localize("RIFTS.Sheet.RCC"),
    category: item.system?.category ?? "",
    isPrimaryClass: item.system?.isPrimaryClass === true,
    isActive: item.system?.active === true,
    baseAttacksPerMelee: num(item.system?.baseAttacksPerMelee, 2),
    classXP: num(item.system?.xp?.value, num(item.system?.experience, 0)),
    effectsSummary: formatAugmentationEffectsSummary(item.system?.effects ?? {}),
    grantedAbilitiesCount: grantedAbilities.length,
    grantedSkillsCount: grantedSkills.length,
    grantedAbilitiesLabel: grantedAbilities.join(", "),
    grantedSkillsLabel: grantedSkills.join(", "),
    startingBionicsCount,
    startingCyberneticsCount,
    bonuses: {
      strike: num(item.system?.bonuses?.combat?.strike, 0),
      parry: num(item.system?.bonuses?.combat?.parry, 0),
      dodge: num(item.system?.bonuses?.combat?.dodge, 0),
      initiative: num(item.system?.bonuses?.combat?.initiative, 0)
    }
  };
}

function handToHandData(item) {
  return {
    isActive: item.system?.active === true,
    notes: normalizeText(item.system?.notes)
  };
}

function specialManeuverData(item) {
  const normalized = normalizeSpecialManeuverEntry({
    ...item.system,
    name: item.name
  });

  const rawCategory = normalizeText(normalized.category).toLowerCase();
  const isReactive = normalized.isReactive === true;
  const categoryLabel = rawCategory === "reactive" || rawCategory === "defensive"
    ? localize("RIFTS.Maneuvers.ReactiveManeuver")
    : rawCategory === "offensive"
      ? localize("RIFTS.Maneuvers.OffensiveManeuver")
      : (normalizeText(normalized.category) || (isReactive ? localize("RIFTS.Maneuvers.ReactiveManeuver") : localize("RIFTS.Maneuvers.OffensiveManeuver")));

  return {
    key: normalized.key,
    category: normalizeText(normalized.category),
    categoryLabel,
    description: normalizeText(normalized.description),
    actionCost: Math.max(0, Math.floor(num(normalized.actionCost, 1))),
    strikeModifier: num(normalized.strikeModifier, 0),
    damageFormula: normalizeText(normalized.damageFormula || "0") || "0",
    damageMultiplier: Math.max(1, Math.floor(num(normalized.damageMultiplier, 1))),
    isReactive,
    requiresTarget: normalized.requiresTarget === true,
    requiresHit: normalized.requiresHit === true,
    minLevel: Math.max(1, Math.floor(num(normalized.minLevel, 1))),
    sourceType: normalizeText(normalized.sourceType),
    sourceId: normalizeText(normalized.sourceId),
    sourceName: normalizeText(normalized.sourceName),
    specialRules: normalizeText(normalized.specialRules),
    tags: Array.isArray(normalized.tags) ? foundry.utils.deepClone(normalized.tags) : [],
    notes: normalizeText(normalized.notes)
  };
}

function classSkillEntryData(entry, index, skillType, level) {
  const base = num(entry?.base, 0);
  const perLevel = num(entry?.perLevel, 0);
  const modifier = num(entry?.modifier, 0);
  const levelBonus = perLevel * Math.max(level - 1, 0);

  return {
    index,
    skillType,
    name: normalizeText(entry?.name),
    category: normalizeText(entry?.category),
    base,
    perLevel,
    modifier,
    notes: normalizeText(entry?.notes),
    targetPreview: Math.max(0, Math.floor(base + modifier + levelBonus))
  };
}

function skillTags(skill) {
  const tags = [];
  if (skill.system?.isOCCSkill) tags.push(game.i18n.localize("RIFTS.Skills.OccSkill"));
  if (skill.system?.isRelatedSkill) tags.push(game.i18n.localize("RIFTS.Skills.RelatedSkill"));
  if (skill.system?.isSecondarySkill) tags.push(game.i18n.localize("RIFTS.Skills.SecondarySkill"));
  return tags;
}

export class RiftsCharacterSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
  _listenerAbortController = null;

  static DEFAULT_OPTIONS = foundry.utils.mergeObject(super.DEFAULT_OPTIONS, {
    id: "rifts-character-sheet",
    classes: ["rifts", "sheet", "actor", "character"],
    position: {
      width: 1320,
      height: 860
    },
    form: {
      submitOnChange: true,
      closeOnSubmit: false
    },
    window: {
      resizable: true,
      title: "RIFTS.Sheet.Character"
    }
  }, { inplace: false });

  static PARTS = {
    body: {
      template: "systems/rifts-megaverse/templates/actor/character-sheet.hbs"
    }
  };

  _isLocked() {
    return Boolean(this.document.system?.sheet?.locked);
  }

  _canEditFields() {
    const lockedForUser = this._isLocked() && !game.user.isGM;
    return this.isEditable && !lockedForUser;
  }

  _getContextTokenId() {
    return String(
      this.token?.id
      ?? this.document?.token?.id
      ?? this.document?.parent?.id
      ?? ""
    );
  }

  _getActorPortraitPath() {
    return normalizeText(this.document?.img)
      || normalizeText(this.document?.prototypeToken?.texture?.src)
      || normalizeText(CONST?.DEFAULT_TOKEN)
      || "icons/svg/mystery-man.svg";
  }

  async _editActorPortrait() {
    if (!this._canEditFields()) return false;

    const picker = new FilePicker({
      type: "image",
      current: this._getActorPortraitPath(),
      callback: async (path) => {
        const nextPath = normalizeText(path);
        if (!nextPath || nextPath === normalizeText(this.document?.img)) return;
        await this.document.update({ img: nextPath });
        this.render();
      }
    });

    picker.render(true);
    return true;
  }

  async _flushPendingField(root) {
    const active = document.activeElement;
    if (!active || !root.contains(active) || !active.name) return;
    active.dispatchEvent(new Event("change", { bubbles: true }));
    await foundry.utils.sleep(0);
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const requestedTab = this._activeTab ?? "combat";
    const activeTab = requestedTab === "class" ? "combat" : requestedTab;
    const requestedCombatSubtab = this._activeCombatSubtab ?? "unarmed";
    const combatSubtab = ["unarmed", "weapons", "armor"].includes(requestedCombatSubtab)
      ? requestedCombatSubtab
      : "unarmed";
    const actorLevel = Math.max(1, Math.floor(num(this.document.system?.derived?.level, num(this.document.system?.details?.level, 1))));

    const skills = this.document.items
      .filter((item) => item.type === "skill")
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((skill) => {
        const breakdown = this.document.getSkillTarget(skill);
        const tags = skillTags(skill);
        return {
          item: skill,
          target: breakdown.target,
          category: normalizeText(skill.system?.category),
          sourceType: normalizeText(skill.system?.sourceType),
          tags,
          tagsLabel: tags.join(", ")
        };
      });

    const weapons = this.document.items
      .filter((item) => item.type === "weapon")
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((item) => ({ item, data: weaponData(item) }));
    const equippedWeapon = weapons.find((entry) => entry.data.equipped)?.item ?? null;

    const allArmors = this.document.items
      .filter((item) => item.type === "armor")
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((item) => ({ item, data: armorData(item) }));
    const armors = allArmors.filter((entry) => !entry.data.isPowerArmor);
    const powerArmors = allArmors.filter((entry) => entry.data.isPowerArmor);
    const equippedArmor = allArmors.find((entry) => entry.data.equipped)?.item ?? null;

    const gears = this.document.items
      .filter((item) => item.type === "gear")
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((item) => ({ item, data: gearData(item) }));

    const cybernetics = this.document.items
      .filter((item) => item.type === "cybernetic")
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((item) => ({ item, data: augmentationData(item) }));

    const bionics = this.document.items
      .filter((item) => item.type === "bionic")
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((item) => ({ item, data: augmentationData(item) }));

    const powers = this.document.items
      .filter((item) => item.type === "power")
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((item) => ({ item, data: powerData(item) }));

    const classItems = this.document.items
      .filter((item) => item.type === "occ" || item.type === "rcc")
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((item) => ({ item, data: classData(item) }));

    const handToHandItems = this.document.items
      .filter((item) => item.type === "handToHand")
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((item) => ({ item, data: handToHandData(item) }));

    const specialManeuverItems = this.document.items
      .filter((item) => item.type === "specialManeuver")
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((item) => ({ item, data: specialManeuverData(item) }));

    const handToHandManeuverContext = this.document.getHandToHandManeuverContext?.() ?? {
      activeStyle: null,
      activeHthStyleName: "",
      availableHthManeuversFromStyle: []
    };
    const styleManeuverSuggestions = (handToHandManeuverContext.availableHthManeuversFromStyle ?? [])
      .map((entry) => {
        const normalized = normalizeSpecialManeuverEntry(entry);
        const category = normalizeText(normalized.category).toLowerCase();
        const isReactive = normalized.isReactive === true;
        const categoryLabel = category === "reactive" || category === "defensive"
          ? localize("RIFTS.Maneuvers.ReactiveManeuver")
          : category === "offensive"
            ? localize("RIFTS.Maneuvers.OffensiveManeuver")
            : (normalizeText(normalized.category) || (isReactive ? localize("RIFTS.Maneuvers.ReactiveManeuver") : localize("RIFTS.Maneuvers.OffensiveManeuver")));

        return {
          ...normalized,
          categoryLabel,
          unlocked: entry.unlocked !== false,
          isAdded: Boolean(entry.duplicate),
          packageIndex: Number(entry.packageIndex ?? -1),
          duplicateItemName: entry.duplicate?.name ?? ""
        };
      })
      .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
    const combatManeuverContext = this.document.getAvailableCombatManeuverContext?.() ?? {
      availableManeuvers: [],
      grantedManeuvers: []
    };

    const grantedManeuverSuggestions = (combatManeuverContext.grantedManeuvers ?? [])
      .filter((entry) => entry?.isOwned !== true)
      .map((entry) => {
        const normalized = normalizeSpecialManeuverEntry(entry);
        const category = normalizeText(normalized.category).toLowerCase();
        const isReactive = normalized.isReactive === true;
        const categoryLabel = category === "reactive" || category === "defensive"
          ? localize("RIFTS.Maneuvers.ReactiveManeuver")
          : category === "offensive"
            ? localize("RIFTS.Maneuvers.OffensiveManeuver")
            : (normalizeText(normalized.category) || (isReactive ? localize("RIFTS.Maneuvers.ReactiveManeuver") : localize("RIFTS.Maneuvers.OffensiveManeuver")));

        return {
          ...normalized,
          categoryLabel,
          sourceLabel: normalizeText(entry.sourceName) || normalizeText(entry.sourceType) || localize("RIFTS.Sheet.None"),
          grantOrigin: normalizeText(entry.grantOrigin)
        };
      })
      .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
    const availableManeuverSelections = styleManeuverSuggestions
      .map((entry) => ({
        key: entry.key,
        name: entry.name,
        category: entry.categoryLabel,
        detail: `${localize("RIFTS.Maneuvers.ActionCost")}: ${entry.actionCost}, ${localize("RIFTS.Maneuvers.MinLevel")}: ${entry.minLevel}`,
        source: normalizeText(handToHandManeuverContext.activeHthStyleName) || localize("RIFTS.HandToHand.None"),
        status: entry.isAdded ? localize("RIFTS.Maneuvers.AlreadyAdded") : "",
        actionLabel: localize("RIFTS.Maneuvers.AddManeuver"),
        disabled: entry.isAdded === true,
        packageIndex: entry.packageIndex
      }))
      .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));

    const maneuverRows = [
      ...specialManeuverItems.map((entry) => ({
        key: normalizeText(entry.data.key),
        name: entry.item.name,
        categoryLabel: entry.data.categoryLabel,
        actionCost: entry.data.actionCost,
        minLevel: entry.data.minLevel,
        sourceLabel: localize("RIFTS.Sheet.Item"),
        itemId: entry.item.id,
        canManage: true,
        notes: normalizeText(entry.data.notes),
        specialRules: normalizeText(entry.data.specialRules)
      })),
      ...grantedManeuverSuggestions.map((entry) => ({
        key: entry.key,
        name: entry.name,
        categoryLabel: entry.categoryLabel,
        actionCost: entry.actionCost,
        minLevel: entry.minLevel,
        sourceLabel: entry.sourceLabel,
        itemId: "",
        canManage: false,
        notes: normalizeText(entry.notes),
        specialRules: normalizeText(entry.specialRules)
      }))
    ].sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));

    const progression = this.document.system?.progression ?? {};
    const derivedProgression = this.document.system?.derived ?? {};
    const combatDerived = this.document.system?.combat?.derived ?? {};
    const activeClassId = progression.activeClassId ?? "";
    const activeClass = activeClassId ? this.document.items.get(activeClassId) : null;
    const activeOccId = progression.activeOccId ?? "";
    const activeRccId = progression.activeRccId ?? "";
    const activeOccItem = activeOccId
      ? this.document.items.get(activeOccId)
      : (this.document.items.find((item) => item.type === "occ" && item.system?.active === true)
        ?? this.document.items.find((item) => item.type === "occ")
        ?? null);
    const activeRccItem = activeRccId
      ? this.document.items.get(activeRccId)
      : (this.document.items.find((item) => item.type === "rcc" && item.system?.active === true)
        ?? this.document.items.find((item) => item.type === "rcc")
        ?? null);
    const activeBonuses = progression.classBonuses ?? { strike: 0, parry: 0, dodge: 0, initiative: 0 };
    const activeHandToHandId = progression.activeHandToHandId ?? "";
    const activeHandToHand = activeHandToHandId
      ? this.document.items.get(activeHandToHandId)
      : (this.document.getActiveHandToHandItem?.() ?? null);
    const activeHandToHandBonuses = progression.handToHandBonuses ?? {};
    const occAttributeRequirements = progression.occAttributeRequirements ?? {};
    const occAttributeRequirementRows = ["iq", "me", "ma", "ps", "pp", "pe", "pb", "spd"].map((key) => {
      const required = Math.max(0, Math.floor(num(occAttributeRequirements?.[key], 0)));
      const actual = Math.max(0, Math.floor(num(this.document.system?.attributes?.[key]?.value, 0)));
      const hasRequirement = required > 0;
      return {
        key,
        label: key.toUpperCase(),
        required: hasRequirement ? required : "",
        actual,
        hasRequirement,
        met: !hasRequirement || actual >= required
      };
    });
    const occRequirementsMet = progression.occRequirementsMet !== false;
    const occRequirementsSummary = normalizeText(progression.occRequirementsSummary);
    const occSkillSelection = {
      occ: Math.max(0, Math.floor(num(progression.occSkillSelection?.occ, 0))),
      related: Math.max(0, Math.floor(num(progression.occSkillSelection?.related, 0))),
      secondary: Math.max(0, Math.floor(num(progression.occSkillSelection?.secondary, 0))),
      occProgression: normalizeProgressionMap(progression.occSkillSelection?.occProgression),
      relatedProgression: normalizeProgressionMap(progression.occSkillSelection?.relatedProgression),
      secondaryProgression: normalizeProgressionMap(progression.occSkillSelection?.secondaryProgression)
    };
        const occStartingResources = {
      hp: formatRollableDisplay(progression.occStartingResources?.hp, "0"),
      sdc: formatRollableDisplay(progression.occStartingResources?.sdc, "0"),
      isp: formatRollableDisplay(progression.occStartingResources?.isp, "0"),
      ppe: formatRollableDisplay(progression.occStartingResources?.ppe, "0")
    };
    const occResourceProgression = {
      hpPerLevel: normalizeText(progression.occResourceProgression?.hpPerLevel),
      sdcPerLevel: normalizeText(progression.occResourceProgression?.sdcPerLevel),
      ispPerLevel: normalizeText(progression.occResourceProgression?.ispPerLevel),
      ppePerLevel: normalizeText(progression.occResourceProgression?.ppePerLevel)
    };
    const occStartingPowers = {
      spells: Array.isArray(progression.occStartingPowers?.spells) ? progression.occStartingPowers.spells : [],
      psionics: Array.isArray(progression.occStartingPowers?.psionics) ? progression.occStartingPowers.psionics : []
    };
    const occPowerProgression = {
      spellProgression: normalizeProgressionMap(
        progression.occPowerProgression?.spellProgression ?? progression.occPowerProgression?.spellsPerLevel
      ),
      psionicProgression: normalizeProgressionMap(
        progression.occPowerProgression?.psionicProgression ?? progression.occPowerProgression?.psionicsPerLevel
      )
    };
        const occStartingCredits = {
      credits: formatRollableDisplay(progression.occStartingCredits?.credits, "0")
    };

    const derivedLevel = Math.max(1, Math.floor(num(derivedProgression.level, actorLevel)));
    const currentXP = Math.max(0, Math.floor(num(derivedProgression.currentXP, num(progression.activeClassExperience, num(this.document.system?.details?.experience, 0)))));
    const rawNextLevelXP = derivedProgression.nextLevelXP;
    const nextLevelXP = rawNextLevelXP === null || rawNextLevelXP === undefined ? null : Math.max(currentXP, Math.floor(num(rawNextLevelXP, currentXP)));
    const hasNextLevelXP = nextLevelXP !== null;
    const xpProgressPercent = Math.max(0, Math.min(100, Math.floor(num(derivedProgression.xpProgress, num(progression.xpProgress, 0)))));
    const levelUpSummary = await getLevelUpSummary(this.document, { persist: false });

    const packageSuggestions = this.document.getClassSkillPackageSuggestions?.() ?? {
      occSkillsFromClass: [],
      relatedSkillsFromClass: [],
      secondarySkillsFromClass: []
    };

    const occAugmentationPackage = this.document.getOccStartingAugmentationPackageSuggestions?.() ?? {
      activeOcc: null,
      bionics: [],
      cybernetics: [],
      abilities: [],
      gear: []
    };

    const occPackageBionics = (occAugmentationPackage.bionics ?? []).map((entry) => ({
      name: normalizeText(entry.name),
      slot: normalizeText(entry.slot),
      notes: normalizeText(entry.notes),
      packageType: "bionics",
      packageIndex: Number(entry.packageIndex ?? -1),
      effectsSummary: formatAugmentationEffectsSummary(entry.effects ?? {}),
      isAdded: entry.isAdded === true,
      duplicateName: entry.duplicate?.name ?? ""
    }));

    const occPackageCybernetics = (occAugmentationPackage.cybernetics ?? []).map((entry) => ({
      name: normalizeText(entry.name),
      slot: normalizeText(entry.slot),
      notes: normalizeText(entry.notes),
      packageType: "cybernetics",
      packageIndex: Number(entry.packageIndex ?? -1),
      effectsSummary: formatAugmentationEffectsSummary(entry.effects ?? {}),
      isAdded: entry.isAdded === true,
      duplicateName: entry.duplicate?.name ?? ""
    }));

    const occSkillsFromClass = (packageSuggestions.occSkillsFromClass ?? [])
      .map((entry, index) => classSkillEntryData(entry, index, "occ", actorLevel));
    const relatedSkillsFromClass = (packageSuggestions.relatedSkillsFromClass ?? [])
      .map((entry, index) => classSkillEntryData(entry, index, "related", actorLevel));
    const secondarySkillsFromClass = (packageSuggestions.secondarySkillsFromClass ?? [])
      .map((entry, index) => classSkillEntryData(entry, index, "secondary", actorLevel));

    const isLocked = this._isLocked();
    const isLockedForUser = isLocked && !game.user.isGM;

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

    const actorPortrait = normalizeText(this.document?.img);
    const prototypePortrait = normalizeText(this.document?.prototypeToken?.texture?.src);
    const contextTokenPortrait = normalizeText(contextTokenRef?.document?.texture?.src || contextTokenRef?.texture?.src);

    context.actor = this.document;
    context.portraitImg = actorPortrait
      || prototypePortrait
      || contextTokenPortrait
      || normalizeText(CONST?.DEFAULT_TOKEN)
      || "icons/svg/mystery-man.svg";
    context.system = this.document.system;
    context.attributes = CONFIG.RIFTS.attributes;
    context.resources = CONFIG.RIFTS.resources;
    context.leftResources = ["hp", "sdc", "ppe", "isp"];
    context.activeTab = activeTab;
    context.isCombatTab = activeTab === "combat";
    context.isSkillsTab = activeTab === "skills";
    context.isInventoryTab = activeTab === "inventory";
    context.isPowersTab = activeTab === "powers";
    context.isNotesTab = activeTab === "notes";
    context.combatSubtab = combatSubtab;
    context.isCombatSubtabUnarmed = combatSubtab === "unarmed";
    context.isCombatSubtabWeapons = combatSubtab === "weapons";
    context.isCombatSubtabArmor = combatSubtab === "armor";
    context.skills = skills;
    context.weapons = weapons;
    context.armors = armors;
    context.powerArmors = powerArmors;
    context.gears = gears;
    context.cybernetics = cybernetics;
    context.bionics = bionics;
    context.hasCybernetics = cybernetics.length > 0;
    context.hasBionics = bionics.length > 0;
    context.hasPowerArmors = powerArmors.length > 0;
    context.powers = powers;
    const resolvedActiveClassId = activeClass?.id ?? "";
    context.classItems = classItems.map((entry) => ({
      ...entry,
      data: {
        ...entry.data,
        isActive: entry.item.id === resolvedActiveClassId
      }
    }));
    context.hasClassItems = context.classItems.length > 0;
    context.activeClassId = resolvedActiveClassId;
    context.occAugmentationPackageName = occAugmentationPackage.activeOcc?.name ?? "";
    context.occPackageBionics = occPackageBionics;
    context.occPackageCybernetics = occPackageCybernetics;
    context.hasOccPackageBionics = occPackageBionics.length > 0;
    context.hasOccPackageCybernetics = occPackageCybernetics.length > 0;
    context.hasOccAugmentationPackage = occPackageBionics.length > 0 || occPackageCybernetics.length > 0;
    context.handToHandItems = handToHandItems.map((entry) => ({
      ...entry,
      data: {
        ...entry.data,
        isActive: entry.item.id === (activeHandToHand?.id ?? "")
      }
    }));
    context.hasHandToHandItems = context.handToHandItems.length > 0;
    context.specialManeuvers = specialManeuverItems;
    context.hasSpecialManeuvers = specialManeuverItems.length > 0;
    context.hthStyleManeuvers = styleManeuverSuggestions;
    context.hasHthStyleManeuvers = styleManeuverSuggestions.length > 0;
    context.grantedManeuvers = grantedManeuverSuggestions;
    context.hasGrantedManeuvers = grantedManeuverSuggestions.length > 0;
    context.maneuverRows = maneuverRows;
    context.hasManeuverRows = maneuverRows.length > 0;
    context.activeHthStyleManeuverName = handToHandManeuverContext.activeHthStyleName ?? (activeHandToHand?.name ?? "");
    context.isLocked = isLocked;
    context.isLockedForUser = isLockedForUser;
    context.canToggleLock = this.isEditable && game.user.isGM;
    context.currentTargetName = uiTarget?.actor?.name ?? game.i18n.localize("RIFTS.Combat.NoTarget");
    context.savedTargetName = savedTargetActor?.name ?? game.i18n.localize("RIFTS.Combat.NoSavedTarget");
    context.hasCurrentTarget = Boolean(uiTarget?.actor);
    context.hasCombat = Boolean(game.combat);
    context.hasCombatant = Boolean(combatant);
    context.hasMeleeQueue = meleeQueue.hasQueue;
    context.meleeQueuePosition = meleeQueue.position;
    context.meleeQueueTotal = meleeQueue.total;
    context.meleeQueueLength = meleeQueue.total;
    context.currentMeleePass = meleeQueue.currentPass;
    context.currentMeleeActorName = meleeQueue.currentActorName;
    context.isCurrentMeleeActor = meleeQueue.isCurrentActor;
    context.isWaitingForMeleeTurn = meleeQueue.hasQueue && !meleeQueue.isCurrentActor && !meleeQueue.isComplete;
    context.isMeleeQueueComplete = meleeQueue.isComplete;
    context.canAdvanceMelee = Boolean(game.combat) && game.user.isGM && meleeQueue.hasQueue;
    context.autoDodgeAvailable = this.document.system?.combat?.autoDodgeAvailable === true;
    context.effectiveDurabilityLabel = game.i18n.localize(
      this.document.system?.combat?.derived?.effectiveDurabilityLabelKey
      ?? this.document.system?.combat?.derived?.effectiveScaleLabelKey
      ?? "RIFTS.Combat.SDC"
    );
    const sizeCategory = normalizeText(this.document.system?.details?.sizeCategory || "human").toLowerCase();
    context.sizeCategory = ["small", "human", "large", "giant"].includes(sizeCategory) ? sizeCategory : "human";
    context.sizeCategoryLabel = game.i18n.localize(`RIFTS.Size.${context.sizeCategory[0].toUpperCase()}${context.sizeCategory.slice(1)}`);
    context.sizeCategoryOptions = {
      small: game.i18n.localize("RIFTS.Size.Small"),
      human: game.i18n.localize("RIFTS.Size.Human"),
      large: game.i18n.localize("RIFTS.Size.Large"),
      giant: game.i18n.localize("RIFTS.Size.Giant")
    };
    context.heldActionCount = Math.max(0, Math.floor(num(this.document.system?.combat?.heldActionCount, 0)));
    context.heldActionReady = this.document.system?.combat?.heldActionReady === true;
    context.heldActionActive = this.document.system?.combat?.heldAction === true;
    context.equippedArmorName = equippedArmor?.name ?? game.i18n.localize("RIFTS.Sheet.None");
    context.equippedWeaponName = equippedWeapon?.name ?? game.i18n.localize("RIFTS.Sheet.None");
    context.speedValue = num(this.document.system?.attributes?.spd?.value, 0);
    context.attacksPerMelee = num(progression.attacksPerMelee, num(this.document.system?.combat?.derived?.attacksPerMelee, 0));
    context.apmTotal = num(this.document.system?.combat?.apmTotal, num(this.document.system?.combat?.derived?.apmTotal, context.attacksPerMelee));
    context.apmRemaining = num(this.document.system?.combat?.apmRemaining, num(this.document.system?.combat?.derived?.apmRemaining, context.apmTotal));
    context.canUseUnarmedManeuver = context.apmRemaining > 0;
    context.unarmedManeuvers = getUnarmedManeuvers().map((maneuver) => {
      const profile = buildUnarmedDamageProfile(this.document, maneuver.key);
      return {
        key: maneuver.key,
        label: maneuver.label,
        actionCost: Math.max(1, Math.floor(num(maneuver.actionCost, 1))),
        strikeModifier: num(maneuver.strikeModifier, 0),
        damageFormula: profile?.formula ?? maneuver.damageFormula,
        strengthBonus: num(profile?.strengthBonus, 0),
        handToHandBonus: num(profile?.handToHandBonus, 0),
        specialRules: maneuver.specialRules ?? ""
      };
    });
    context.hasUnarmedManeuvers = context.unarmedManeuvers.length > 0;
    context.activeClassExperience = currentXP;
    context.sheetNotes = this.document.flags?.rifts?.notes ?? "";
    context.derivedLevel = derivedLevel;
    context.currentXP = currentXP;
    context.nextLevelXP = nextLevelXP;
    context.hasNextLevelXP = hasNextLevelXP;
    context.xpProgressPercent = xpProgressPercent;
    context.xpProgressBarStyle = `width: ${xpProgressPercent}%;`;
    context.xpProgressLabel = hasNextLevelXP
      ? `${currentXP} / ${nextLevelXP}`
      : `${currentXP}`;
    context.canDebugLevelOverride = game.user.isGM;
    context.canRecoveryControls = game.user.isGM;
    context.useLevelOverride = this.document.system?.debug?.useLevelOverride === true;
    context.overrideLevel = Math.max(1, Math.floor(num(this.document.system?.debug?.overrideLevel, derivedLevel)));
    context.hasLevelUpClass = levelUpSummary.hasActiveClass === true;
    context.levelUpPendingChoices = Math.max(0, Math.floor(num(levelUpSummary.pendingChoices, 0)));
    context.levelUpRequiredCompleted = Math.max(0, Math.floor(num(levelUpSummary.requiredCompleted, 0)));
    context.levelUpRequiredTotal = Math.max(0, Math.floor(num(levelUpSummary.requiredTotal, 0)));
    context.levelUpIsComplete = levelUpSummary.isComplete === true;
    context.levelUpStatusLabel = game.i18n.localize(levelUpSummary.labelKey || "RIFTS.LevelUp.LevelUpIncomplete");
    context.levelUpRequiredProgress = `${context.levelUpRequiredCompleted}/${context.levelUpRequiredTotal}`;

    context.activeClassName = activeClass?.name ?? game.i18n.localize("RIFTS.Sheet.NoActiveClass");
    context.activeOccName = progression.activeOccName || activeOccItem?.name || game.i18n.localize("RIFTS.Sheet.NoActiveOCC");
    context.activeOccCategory = progression.activeOccCategory || activeOccItem?.system?.category || game.i18n.localize("RIFTS.Sheet.None");
    context.activeRccName = progression.activeRccName || activeRccItem?.name || game.i18n.localize("RIFTS.Sheet.NoActiveRCC");
    context.activeRccCategory = progression.activeRccCategory || activeRccItem?.system?.category || game.i18n.localize("RIFTS.Sheet.None");
    context.activeOccType = progression.activeClassType ? progression.activeClassType.toUpperCase() : game.i18n.localize("RIFTS.Sheet.None");
    context.activeOccBonuses = {
      strike: num(activeBonuses.strike, 0),
      parry: num(activeBonuses.parry, 0),
      dodge: num(activeBonuses.dodge, 0),
      initiative: num(activeBonuses.initiative, 0)
    };
    context.activeOccBonusesSummary = `${game.i18n.localize("RIFTS.Rolls.Strike")}: ${num(activeBonuses.strike, 0)}, ${game.i18n.localize("RIFTS.Rolls.Parry")}: ${num(activeBonuses.parry, 0)}, ${game.i18n.localize("RIFTS.Rolls.Dodge")}: ${num(activeBonuses.dodge, 0)}, ${game.i18n.localize("RIFTS.Rolls.Initiative")}: ${num(activeBonuses.initiative, 0)}`;
    context.classPassiveEffectsSummary = normalizeText(progression.classEffectsSummary || derivedProgression.classEffectsSummary) || game.i18n.localize("RIFTS.Sheet.None");
    context.occPassiveEffectsSummary = normalizeText(progression.occEffectsSummary || derivedProgression.occEffectsSummary) || game.i18n.localize("RIFTS.Sheet.None");
    context.rccPassiveEffectsSummary = normalizeText(progression.rccEffectsSummary || derivedProgression.rccEffectsSummary) || game.i18n.localize("RIFTS.Sheet.None");

    context.occAttributeRequirementRows = occAttributeRequirementRows;
    context.hasOccAttributeRequirements = occAttributeRequirementRows.some((row) => row.hasRequirement);
    context.occRequirementsMet = occRequirementsMet;
    context.occRequirementsStatusLabel = game.i18n.localize(
      occRequirementsMet
        ? "RIFTS.Sheet.RequirementsMet"
        : "RIFTS.Sheet.RequirementsNotMet"
    );
    context.occRequirementsSummary = occRequirementsSummary || game.i18n.localize("RIFTS.Sheet.None");
    context.occSkillSelection = occSkillSelection;
    context.occStartingResources = occStartingResources;
    context.occResourceProgression = occResourceProgression;
    context.occStartingPowers = occStartingPowers;
    context.occStartingSpellsCount = occStartingPowers.spells.length;
    context.occStartingPsionicsCount = occStartingPowers.psionics.length;
    context.occPowerProgression = occPowerProgression;
    context.occSkillProgressionSummary = {
      occ: formatProgressionMapSummary(occSkillSelection.occProgression),
      related: formatProgressionMapSummary(occSkillSelection.relatedProgression),
      secondary: formatProgressionMapSummary(occSkillSelection.secondaryProgression)
    };
    context.occSpellProgressionSummary = formatProgressionMapSummary(occPowerProgression.spellProgression);
    context.occPsionicProgressionSummary = formatProgressionMapSummary(occPowerProgression.psionicProgression);
    context.occStartingCredits = occStartingCredits;

    context.activeHandToHandId = activeHandToHand?.id ?? "";
    context.activeHandToHandName = activeHandToHand?.name ?? game.i18n.localize("RIFTS.HandToHand.None");
    context.activeHandToHandBonuses = {
      apmBonus: num(combatDerived.handToHandApmBonus, num(activeHandToHandBonuses.apmBonus, 0)),
      strikeBonus: num(combatDerived.handToHandStrikeBonus, num(activeHandToHandBonuses.strikeBonus, 0)),
      parryBonus: num(combatDerived.handToHandParryBonus, num(activeHandToHandBonuses.parryBonus, 0)),
      dodgeBonus: num(combatDerived.handToHandDodgeBonus, num(activeHandToHandBonuses.dodgeBonus, 0)),
      damageBonus: num(combatDerived.handToHandDamageBonus, num(activeHandToHandBonuses.damageBonus, 0)),
      autoDodgeLevel: num(combatDerived.handToHandAutoDodgeLevel, num(activeHandToHandBonuses.autoDodgeLevel, 0))
    };
    context.activeHandToHandBonusesSummary = `${game.i18n.localize("RIFTS.HandToHand.APMBonus")}: ${context.activeHandToHandBonuses.apmBonus}, ${game.i18n.localize("RIFTS.HandToHand.StrikeBonus")}: ${context.activeHandToHandBonuses.strikeBonus}, ${game.i18n.localize("RIFTS.HandToHand.ParryBonus")}: ${context.activeHandToHandBonuses.parryBonus}, ${game.i18n.localize("RIFTS.HandToHand.DodgeBonus")}: ${context.activeHandToHandBonuses.dodgeBonus}, ${game.i18n.localize("RIFTS.HandToHand.DamageBonus")}: ${context.activeHandToHandBonuses.damageBonus}`;
    context.autoDodgeStatusLabel = context.autoDodgeAvailable
      ? game.i18n.localize("RIFTS.Sheet.Active")
      : game.i18n.localize("RIFTS.Sheet.Inactive");

    context.occSkillsFromClass = occSkillsFromClass;
    context.relatedSkillsFromClass = relatedSkillsFromClass;
    context.secondarySkillsFromClass = secondarySkillsFromClass;
    context.hasClassSkills = occSkillsFromClass.length > 0 || relatedSkillsFromClass.length > 0 || secondarySkillsFromClass.length > 0;
    context.availableOccSkillsCount = occSkillsFromClass.length;
    context.availableRelatedSkillsCount = relatedSkillsFromClass.length;
    context.availableSecondarySkillsCount = secondarySkillsFromClass.length;
    context.hasAvailableManeuverSelections = availableManeuverSelections.length > 0;
    context.availableManeuverSelectionsCount = availableManeuverSelections.length;

    const actorGrantedFlags = Object.entries(derivedProgression.actorGrantedFlags ?? {})
      .filter(([, enabled]) => enabled === true)
      .map(([flag]) => String(flag))
      .sort((a, b) => a.localeCompare(b));

    const classGrantedAbilities = Array.isArray(derivedProgression.classGrantedAbilities)
      ? derivedProgression.classGrantedAbilities
        .map((entry) => normalizeText(entry?.name || entry?.key || ""))
        .filter((name) => name.length > 0)
      : [];

    const classGrantedSkills = Array.isArray(derivedProgression.classGrantedSkills)
      ? derivedProgression.classGrantedSkills
        .map((entry) => normalizeText(entry?.name || entry?.key || ""))
        .filter((name) => name.length > 0)
      : [];

    const actorGrantedAbilities = Array.isArray(derivedProgression.grantedAbilities)
      ? derivedProgression.grantedAbilities
        .map((entry) => normalizeText(entry?.name || entry?.key || ""))
        .filter((name) => name.length > 0)
      : [];

    const actorGrantedSkills = Array.isArray(derivedProgression.grantedSkills)
      ? derivedProgression.grantedSkills
        .map((entry) => normalizeText(entry?.name || entry?.key || ""))
        .filter((name) => name.length > 0)
      : [];

    context.cyberneticEffectsSummary = normalizeText(derivedProgression.cyberneticEffectsSummary) || game.i18n.localize("RIFTS.Sheet.None");
    context.bionicEffectsSummary = normalizeText(derivedProgression.bionicEffectsSummary) || game.i18n.localize("RIFTS.Sheet.None");
    context.sourceSummaryFromOcc = context.occPassiveEffectsSummary;
    context.sourceSummaryFromBionics = context.bionicEffectsSummary;
    context.sourceSummaryFromCybernetics = context.cyberneticEffectsSummary;
    context.cyberneticsInstalled = Math.max(0, Math.floor(num(derivedProgression.cyberneticsInstalled, cybernetics.filter((entry) => entry.data.installed).length)));
    context.bionicsInstalled = Math.max(0, Math.floor(num(derivedProgression.bionicsInstalled, bionics.filter((entry) => entry.data.installed).length)));
    context.actorGrantedFlags = actorGrantedFlags;
    context.actorGrantedFlagsLabel = actorGrantedFlags.length > 0 ? actorGrantedFlags.join(", ") : game.i18n.localize("RIFTS.Sheet.None");
    context.classGrantedAbilities = classGrantedAbilities;
    context.classGrantedAbilitiesLabel = classGrantedAbilities.length > 0 ? classGrantedAbilities.join(", ") : game.i18n.localize("RIFTS.Sheet.None");
    context.classGrantedSkills = classGrantedSkills;
    context.classGrantedSkillsLabel = classGrantedSkills.length > 0 ? classGrantedSkills.join(", ") : game.i18n.localize("RIFTS.Sheet.None");
    context.actorGrantedAbilities = actorGrantedAbilities;
    context.actorGrantedAbilitiesLabel = actorGrantedAbilities.length > 0 ? actorGrantedAbilities.join(", ") : game.i18n.localize("RIFTS.Sheet.None");
    context.actorGrantedSkills = actorGrantedSkills;
    context.actorGrantedSkillsLabel = actorGrantedSkills.length > 0 ? actorGrantedSkills.join(", ") : game.i18n.localize("RIFTS.Sheet.None");
    context.hasActorGrantedFlags = actorGrantedFlags.length > 0;
    context.hasClassGrantedAbilities = classGrantedAbilities.length > 0;
    context.hasClassGrantedSkills = classGrantedSkills.length > 0;
    context.hasActorGrantedAbilities = actorGrantedAbilities.length > 0;
    context.hasActorGrantedSkills = actorGrantedSkills.length > 0;

    const powerArmorMountedWeapons = Array.isArray(combatDerived.mountedWeaponsOnPowerArmor)
      ? [...combatDerived.mountedWeaponsOnPowerArmor].sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")))
      : [];

    context.hasActivePowerArmor = combatDerived.hasActivePowerArmor === true;
    context.activePowerArmor = {
      id: combatDerived.activePowerArmorId ?? "",
      name: combatDerived.activePowerArmorName ?? "",
      powerArmorClass: combatDerived.activePowerArmorClass ?? "",
      mountCapacity: num(combatDerived.activePowerArmorMountCapacity, 0),
      handlingMod: num(combatDerived.activePowerArmorHandlingMod, 0),
      speedMod: num(combatDerived.activePowerArmorSpeedMod, 0),
      notes: combatDerived.activePowerArmorNotes ?? "",
      sdcValue: num(combatDerived.activePowerArmorSdcValue, 0),
      sdcMax: num(combatDerived.activePowerArmorSdcMax, 0),
      mdcValue: num(combatDerived.activePowerArmorMdcValue, 0),
      mdcMax: num(combatDerived.activePowerArmorMdcMax, 0)
    };
    context.powerArmorMountedWeapons = powerArmorMountedWeapons;
    context.hasPowerArmorMountedWeapons = powerArmorMountedWeapons.length > 0;

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

  async _setWeaponEquipped(itemId, equipped) {
    const item = this.document.items.get(itemId);
    if (!item || item.type !== "weapon") return;
    await item.update({ "system.equipped": equipped });
  }


  async _linkWeaponToActivePowerArmor(itemId) {
    const weapon = this.document.items.get(itemId);
    if (!weapon || weapon.type !== "weapon") return;

    const activeArmorId = normalizeText(this.document.system?.combat?.derived?.activePowerArmorId);
    if (!activeArmorId) {
      ui.notifications.warn(game.i18n.localize("RIFTS.PowerArmor.NoActivePowerArmor"));
      return;
    }

    const activeArmorName = normalizeText(this.document.system?.combat?.derived?.activePowerArmorName);
    const existingMountName = normalizeText(weapon.system?.weapon?.mountName);

    await weapon.update({
      "system.weapon.isMounted": true,
      "system.weapon.requiresPowerArmor": true,
      "system.weapon.linkedArmorId": activeArmorId,
      "system.weapon.mountName": existingMountName || activeArmorName
    });
  }

  async _unlinkWeaponFromPowerArmor(itemId) {
    const weapon = this.document.items.get(itemId);
    if (!weapon || weapon.type !== "weapon") return;

    await weapon.update({
      "system.weapon.linkedArmorId": "",
      "system.weapon.isMounted": false,
      "system.weapon.requiresPowerArmor": false
    });
  }

  async _setArmorEquipped(itemId, equipped) {
    const item = this.document.items.get(itemId);
    if (!item || item.type !== "armor") return;

    const updates = [];
    if (equipped) {
      for (const armor of this.document.items.filter((entry) => entry.type === "armor" && entry.id !== item.id && (entry.system?.equipped || entry.system?.active))) {
        updates.push(armor.update({ "system.equipped": false, "system.active": false }));
      }
    }

    updates.push(item.update({ "system.equipped": equipped, "system.active": equipped }));
    await Promise.all(updates);
  }

  async _setAugmentationInstalled(itemId, installed) {
    const item = this.document.items.get(itemId);
    if (!item || !["cybernetic", "bionic"].includes(item.type)) return;
    await item.update({ "system.installed": installed });
  }
  async _setPrimaryClass(itemId) {
    const selected = this.document.items.get(itemId);
    if (!selected || (selected.type !== "occ" && selected.type !== "rcc")) return;

    const updates = this.document.items
      .filter((item) => item.type === "occ" || item.type === "rcc")
      .map((item) => item.update({
        "system.active": item.id === selected.id,
        "system.isPrimaryClass": item.id === selected.id
      }));

    await Promise.all(updates);
    if (selected.type === "occ") {
      await this.document.applyOccStartingResources?.(selected, { onlyWhenDefault: true });
    }
  }

  async _setActiveHandToHand(itemId) {
    const selected = this.document.items.get(itemId);
    if (!selected || selected.type !== "handToHand") return;

    const updates = this.document.items
      .filter((item) => item.type === "handToHand")
      .map((item) => item.update({
        "system.active": item.id === selected.id
      }));

    await Promise.all(updates);
  }


  _applyCombatSubtabState(root) {
    const active = this._activeCombatSubtab ?? "unarmed";

    root.querySelectorAll("[data-action='switch-combat-subtab']").forEach((button) => {
      const isActive = normalizeText(button.dataset.subtab) === active;
      button.classList.toggle("active", isActive);
    });

    root.querySelectorAll("[data-combat-subtab-section]").forEach((section) => {
      const isActive = normalizeText(section.dataset.combatSubtabSection) === active;
      section.classList.toggle("active", isActive);
    });
  }

  _openSelectionDialog({ titleKey = "", description = "", groups = [], onSelect = null }) {
    const app = new RiftsSelectionDialog({
      titleKey,
      description,
      groups,
      onSelect,
      closeOnSelect: false
    });
    app.render(true);
  }

  _buildSkillSelectionEntries(skillType) {
    const actorLevel = Math.max(1, Math.floor(num(this.document.system?.derived?.level, num(this.document.system?.details?.level, 1))));
    const packageSuggestions = this.document.getClassSkillPackageSuggestions?.() ?? {
      occSkillsFromClass: [],
      relatedSkillsFromClass: [],
      secondarySkillsFromClass: []
    };

    const mapByType = {
      occ: packageSuggestions.occSkillsFromClass ?? [],
      related: packageSuggestions.relatedSkillsFromClass ?? [],
      secondary: packageSuggestions.secondarySkillsFromClass ?? []
    };

    const sourceLabel = {
      occ: game.i18n.localize("RIFTS.Skills.OccSkill"),
      related: game.i18n.localize("RIFTS.Skills.RelatedSkill"),
      secondary: game.i18n.localize("RIFTS.Skills.SecondarySkill")
    }[skillType] ?? game.i18n.localize("RIFTS.Skills.ClassSkills");

    return (mapByType[skillType] ?? []).map((entry, index) => {
      const data = classSkillEntryData(entry, index, skillType, actorLevel);
      return {
        name: data.name,
        category: data.category || game.i18n.localize("RIFTS.Sheet.None"),
        detail: `${data.targetPreview}%`,
        source: sourceLabel,
        status: "",
        actionLabel: game.i18n.localize("RIFTS.Skills.AddSkill"),
        disabled: false,
        skillType,
        skillIndex: index
      };
    });
  }

  async _openAvailableSkillsDialog(skillType) {
    const normalizedType = normalizeText(skillType).toLowerCase();
    if (!normalizedType) return;

    const titleKeyMap = {
      occ: "RIFTS.SelectionDialog.AvailableOccSkills",
      related: "RIFTS.SelectionDialog.AvailableRelatedSkills",
      secondary: "RIFTS.SelectionDialog.AvailableSecondarySkills"
    };

    const labelMap = {
      occ: game.i18n.localize("RIFTS.Skills.OccSkill"),
      related: game.i18n.localize("RIFTS.Skills.RelatedSkill"),
      secondary: game.i18n.localize("RIFTS.Skills.SecondarySkill")
    };

    const entries = this._buildSkillSelectionEntries(normalizedType);

    this._openSelectionDialog({
      titleKey: titleKeyMap[normalizedType] ?? "RIFTS.Skills.ClassSkills",
      groups: [{
        id: normalizedType,
        label: labelMap[normalizedType] ?? game.i18n.localize("RIFTS.Skills.ClassSkills"),
        emptyLabel: game.i18n.localize("RIFTS.Skills.NoClassSkills"),
        entries
      }],
      onSelect: async (selection) => {
        const result = await this.document.addSkillFromClassPackage(selection.skillType, Number(selection.skillIndex ?? -1));
        if (result?.status === "duplicate") {
          ui.notifications.warn(game.i18n.localize("RIFTS.Skills.AlreadyAdded"));
          return;
        }

        if (result?.status === "no-class") {
          ui.notifications.warn(game.i18n.localize("RIFTS.Sheet.NoActiveClass"));
          return;
        }

        if (result?.status !== "created") {
          ui.notifications.warn(game.i18n.localize("RIFTS.Errors.SkillAddFailed"));
          return;
        }

        this.render();
      }
    });
  }

  async _openAvailableManeuversDialog() {
    const hthContext = this.document.getHandToHandManeuverContext?.() ?? {
      activeStyle: null,
      activeHthStyleName: "",
      availableHthManeuversFromStyle: []
    };

    const sourceLabel = normalizeText(hthContext.activeHthStyleName) || game.i18n.localize("RIFTS.HandToHand.None");

    const entries = (hthContext.availableHthManeuversFromStyle ?? [])
      .map((entry) => {
        const normalized = normalizeSpecialManeuverEntry(entry);
        const category = normalizeText(normalized.category).toLowerCase();
        const categoryLabel = category === "reactive" || category === "defensive"
          ? localize("RIFTS.Maneuvers.ReactiveManeuver")
          : category === "offensive"
            ? localize("RIFTS.Maneuvers.OffensiveManeuver")
            : (normalizeText(normalized.category) || localize("RIFTS.Maneuvers.OffensiveManeuver"));

        const isAdded = Boolean(entry.duplicate);
        return {
          name: normalized.name,
          category: categoryLabel,
          detail: `${localize("RIFTS.Maneuvers.ActionCost")}: ${normalized.actionCost}, ${localize("RIFTS.Maneuvers.MinLevel")}: ${normalized.minLevel}`,
          source: sourceLabel,
          status: isAdded ? localize("RIFTS.Maneuvers.AlreadyAdded") : "",
          actionLabel: localize("RIFTS.Maneuvers.AddManeuver"),
          disabled: isAdded,
          packageIndex: Number(entry.packageIndex ?? -1)
        };
      })
      .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));

    this._openSelectionDialog({
      titleKey: "RIFTS.SelectionDialog.AvailableManeuvers",
      groups: [{
        id: "maneuvers",
        label: localize("RIFTS.Maneuvers.SpecialManeuvers"),
        emptyLabel: localize("RIFTS.Maneuvers.NoStyleManeuvers"),
        entries
      }],
      onSelect: async (selection) => {
        const result = await this.document.addManeuverFromHandToHandPackage?.(Number(selection.packageIndex ?? -1));

        if (result?.status === "duplicate") {
          ui.notifications.warn(game.i18n.localize("RIFTS.Maneuvers.AlreadyAdded"));
          return;
        }

        if (result?.status === "no-hth") {
          ui.notifications.warn(game.i18n.localize("RIFTS.HandToHand.None"));
          return;
        }

        if (result?.status !== "created") {
          ui.notifications.warn(game.i18n.localize("RIFTS.Advanced.NotAvailable"));
          return;
        }

        this.render();
      }
    });
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

    const portraitImage = root.querySelector(".header-portrait");
    this._bindEvent(portraitImage, "dblclick", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await this._editActorPortrait();
    }, signal);

    if (!this._canEditFields()) {
      root.querySelectorAll(
        "input[name], select[name], textarea[name], [data-action='toggle-weapon-equipped'], [data-action='toggle-armor-equipped'], [data-action='use-current-target'], [data-action='edit-item'], [data-action='delete-item'], [data-action='toggle-weapon-equipped-button'], [data-action='toggle-armor-equipped-button'], [data-action='set-primary-class'], [data-action='set-active-hth'], [data-action='add-class-skill'], [data-action='add-occ-package-item'], [data-action='add-hth-maneuver'], [data-action='open-available-skills'], [data-action='open-available-maneuvers'], [data-action='open-level-up'], [data-action='open-character-creation'], [data-action='toggle-augmentation-installed']"
      ).forEach((field) => {
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

    for (const button of root.querySelectorAll("[data-action='switch-combat-subtab']")) {
      this._bindEvent(button, "click", (event) => {
        event.preventDefault();
        this._activeCombatSubtab = normalizeText(event.currentTarget.dataset.subtab) || "unarmed";
        this._applyCombatSubtabState(root);
      }, signal);
    }
    this._applyCombatSubtabState(root);
    const toggleLockButton = root.querySelector("[data-action='toggle-lock']");
    this._bindEvent(toggleLockButton, "click", async (event) => {
      event.preventDefault();
      if (!this.isEditable || !game.user.isGM) return;
      await this.document.update({
        "system.sheet.locked": !this._isLocked()
      });
    }, signal);

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

        if (path === "system.details.experience") {
          const xpValue = Math.max(0, num(value, 0));
          let updated = await this.document.setClassXP?.(xpValue, { announce: false });

          if (!updated) {
            const fallbackClass = this.document.getActiveClassItem?.()
              ?? this.document.items.find((item) => item.type === "occ" && item.system?.isPrimaryClass === true)
              ?? this.document.items.find((item) => item.type === "rcc" && item.system?.isPrimaryClass === true)
              ?? this.document.items.find((item) => item.type === "occ")
              ?? this.document.items.find((item) => item.type === "rcc")
              ?? null;

            if (fallbackClass) {
              await fallbackClass.update({
                "system.xp.value": xpValue,
                "system.experience": xpValue
              });
              updated = { classItemId: fallbackClass.id, next: xpValue };
            }

            await this.document.update({ [path]: xpValue });
          }

          this.render();
          return;
        }

        await this.document.update({ [path]: value });
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

    for (const button of root.querySelectorAll("[data-action='gm-short-rest']")) {
      this._bindEvent(button, "click", async (event) => {
        event.preventDefault();
        if (!game.user.isGM) return;

        await this._flushPendingField(root);
        await this.document.applyShortRest?.();
        this.render();
      }, signal);
    }

    for (const button of root.querySelectorAll("[data-action='gm-full-rest']")) {
      this._bindEvent(button, "click", async (event) => {
        event.preventDefault();
        if (!game.user.isGM) return;

        await this._flushPendingField(root);
        await this.document.applyFullRest?.();
        this.render();
      }, signal);
    }

    for (const button of root.querySelectorAll("[data-action='gm-repair-armor']")) {
      this._bindEvent(button, "click", async (event) => {
        event.preventDefault();
        if (!game.user.isGM) return;

        await this._flushPendingField(root);
        await this.document.repairAllArmor?.();
        this.render();
      }, signal);
    }

    for (const button of root.querySelectorAll("[data-action='gm-reset-apm-sheet']")) {
      this._bindEvent(button, "click", async (event) => {
        event.preventDefault();
        if (!game.user.isGM) return;

        await this._flushPendingField(root);
        await this.document.resetAPM?.();
        this.render();
      }, signal);
    }

    for (const button of root.querySelectorAll("[data-action='gm-add-apm-sheet']")) {
      this._bindEvent(button, "click", async (event) => {
        event.preventDefault();
        if (!game.user.isGM) return;

        await this._flushPendingField(root);
        if (typeof this.document.addAPM === "function") {
          await this.document.addAPM(1);
        } else {
          const remaining = Math.max(0, Math.floor(num(this.document.system?.combat?.apmRemaining, 0))) + 1;
          await this.document.update({
            "system.combat.apmRemaining": remaining,
            "system.combat.lastActionType": "add-apm",
            "system.combat.reactionAvailable": remaining > 0
          });
        }
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
        await this._setWeaponEquipped(event.currentTarget.dataset.itemId, event.currentTarget.checked);
      }, signal);
    }

    for (const button of root.querySelectorAll("[data-action='toggle-weapon-equipped-button']")) {
      this._bindEvent(button, "click", async (event) => {
        event.preventDefault();
        if (!this._canEditFields()) return;

        const itemId = event.currentTarget.dataset.itemId;
        const item = this.document.items.get(itemId);
        if (!item) return;

        await this._setWeaponEquipped(itemId, !Boolean(item.system?.equipped));
      }, signal);
    }


    for (const button of root.querySelectorAll("[data-action='link-weapon-active-pa']")) {
      this._bindEvent(button, "click", async (event) => {
        event.preventDefault();
        if (!this._canEditFields()) return;

        const itemId = event.currentTarget.dataset.itemId;
        if (!itemId) return;

        await this._linkWeaponToActivePowerArmor(itemId);
      }, signal);
    }

    for (const button of root.querySelectorAll("[data-action='unlink-weapon-pa']")) {
      this._bindEvent(button, "click", async (event) => {
        event.preventDefault();
        if (!this._canEditFields()) return;

        const itemId = event.currentTarget.dataset.itemId;
        if (!itemId) return;

        await this._unlinkWeaponFromPowerArmor(itemId);
      }, signal);
    }

    for (const checkbox of root.querySelectorAll("[data-action='toggle-armor-equipped']")) {
      this._bindEvent(checkbox, "change", async (event) => {
        if (!this._canEditFields()) return;
        await this._setArmorEquipped(event.currentTarget.dataset.itemId, event.currentTarget.checked);
      }, signal);
    }

    for (const button of root.querySelectorAll("[data-action='toggle-armor-equipped-button']")) {
      this._bindEvent(button, "click", async (event) => {
        event.preventDefault();
        if (!this._canEditFields()) return;

        const itemId = event.currentTarget.dataset.itemId;
        const item = this.document.items.get(itemId);
        if (!item) return;

        await this._setArmorEquipped(itemId, !Boolean(item.system?.equipped));
      }, signal);
    }

    for (const checkbox of root.querySelectorAll("[data-action='toggle-augmentation-installed']")) {
      this._bindEvent(checkbox, "change", async (event) => {
        if (!this._canEditFields()) return;
        await this._setAugmentationInstalled(event.currentTarget.dataset.itemId, event.currentTarget.checked);
      }, signal);
    }

    for (const button of root.querySelectorAll("[data-action='set-primary-class']")) {
      this._bindEvent(button, "click", async (event) => {
        event.preventDefault();
        if (!this._canEditFields()) return;

        const itemId = event.currentTarget.dataset.itemId;
        if (!itemId) return;
        await this._setPrimaryClass(itemId);
      }, signal);
    }

    for (const button of root.querySelectorAll("[data-action='set-active-hth']")) {
      this._bindEvent(button, "click", async (event) => {
        event.preventDefault();
        if (!this._canEditFields()) return;

        const itemId = event.currentTarget.dataset.itemId;
        if (!itemId) return;
        await this._setActiveHandToHand(itemId);
      }, signal);
    }
    for (const button of root.querySelectorAll("[data-action='add-class-skill']")) {
      this._bindEvent(button, "click", async (event) => {
        event.preventDefault();
        if (!this._canEditFields()) return;

        const skillType = event.currentTarget.dataset.skillType;
        const index = Number(event.currentTarget.dataset.skillIndex ?? -1);

        const result = await this.document.addSkillFromClassPackage(skillType, index);
        if (result?.status === "duplicate") {
          ui.notifications.warn(game.i18n.localize("RIFTS.Skills.AlreadyAdded"));
          return;
        }

        if (result?.status === "no-class") {
          ui.notifications.warn(game.i18n.localize("RIFTS.Sheet.NoActiveClass"));
          return;
        }

        if (result?.status !== "created") {
          ui.notifications.warn(game.i18n.localize("RIFTS.Errors.SkillAddFailed"));
          return;
        }

        this.render();
      }, signal);
    }

    for (const button of root.querySelectorAll("[data-action='open-available-skills']")) {
      this._bindEvent(button, "click", async (event) => {
        event.preventDefault();
        if (!this._canEditFields()) return;

        const skillType = normalizeText(event.currentTarget.dataset.skillType).toLowerCase();
        if (!["occ", "related", "secondary"].includes(skillType)) return;

        await this._openAvailableSkillsDialog(skillType);
      }, signal);
    }

    for (const button of root.querySelectorAll("[data-action='open-character-creation']")) {
      this._bindEvent(button, "click", async (event) => {
        event.preventDefault();
        if (!this._canEditFields()) return;
        openCharacterCreationWizard(this.document);
      }, signal);
    }
    for (const button of root.querySelectorAll("[data-action='open-level-up']")) {
      this._bindEvent(button, "click", async (event) => {
        event.preventDefault();
        if (!this._canEditFields()) return;
        openLevelUpDialog(this.document);
      }, signal);
    }

    for (const button of root.querySelectorAll("[data-action='open-available-maneuvers']")) {
      this._bindEvent(button, "click", async (event) => {
        event.preventDefault();
        if (!this._canEditFields()) return;
        await this._openAvailableManeuversDialog();
      }, signal);
    }

    for (const button of root.querySelectorAll("[data-action='add-occ-package-item']")) {
      this._bindEvent(button, "click", async (event) => {
        event.preventDefault();
        if (!this._canEditFields()) return;

        const packageType = normalizeText(event.currentTarget.dataset.packageType);
        const packageIndex = Number(event.currentTarget.dataset.packageIndex ?? -1);

        const result = await this.document.addAugmentationFromOccPackage?.(packageType, packageIndex);
        if (result?.status === "duplicate") {
          ui.notifications.warn(game.i18n.localize("RIFTS.Augmentation.AlreadyInstalled"));
          return;
        }

        if (result?.status === "no-occ") {
          ui.notifications.warn(game.i18n.localize("RIFTS.Sheet.NoActiveOCC"));
          return;
        }

        if (result?.status !== "created") {
          ui.notifications.warn(game.i18n.localize("RIFTS.Advanced.NotAvailable"));
          return;
        }

        this.render();
      }, signal);
    }
    for (const button of root.querySelectorAll("[data-action='add-hth-maneuver']")) {
      this._bindEvent(button, "click", async (event) => {
        event.preventDefault();
        if (!this._canEditFields()) return;

        const packageIndex = Number(event.currentTarget.dataset.packageIndex ?? -1);
        const result = await this.document.addManeuverFromHandToHandPackage?.(packageIndex);

        if (result?.status === "duplicate") {
          ui.notifications.warn(game.i18n.localize("RIFTS.Maneuvers.AlreadyAdded"));
          return;
        }

        if (result?.status === "no-hth") {
          ui.notifications.warn(game.i18n.localize("RIFTS.HandToHand.None"));
          return;
        }

        if (result?.status !== "created") {
          ui.notifications.warn(game.i18n.localize("RIFTS.Advanced.NotAvailable"));
          return;
        }

        this.render();
      }, signal);
    }

    for (const button of root.querySelectorAll("[data-action='use-special-maneuver']")) {
      this._bindEvent(button, "click", async (event) => {
        event.preventDefault();
        const itemId = event.currentTarget.dataset.itemId;
        if (!itemId) return;

        await this._flushPendingField(root);
        const result = await this.document.useSpecialManeuver?.(itemId, {
          tokenId: this._getContextTokenId()
        });

        if (["reactive", "used"].includes(String(result?.status ?? ""))) {
          this.render();
          return;
        }

        ui.notifications.warn(game.i18n.localize("RIFTS.Advanced.NotAvailable"));
      }, signal);
    }


    for (const button of root.querySelectorAll("[data-action='use-granted-maneuver']")) {
      this._bindEvent(button, "click", async (event) => {
        event.preventDefault();

        const maneuverKey = normalizeText(event.currentTarget.dataset.maneuverKey);
        if (!maneuverKey) return;

        await this._flushPendingField(root);
        const result = await this.document.useSpecialManeuverByKey?.(maneuverKey, {
          tokenId: this._getContextTokenId()
        });

        if (["reactive", "used"].includes(String(result?.status ?? ""))) {
          this.render();
          return;
        }

        ui.notifications.warn(game.i18n.localize("RIFTS.Advanced.NotAvailable"));
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

    for (const button of root.querySelectorAll("[data-action='unarmed-attack']")) {
      this._bindEvent(button, "click", async (event) => {
        event.preventDefault();
        const maneuverKey = event.currentTarget.dataset.maneuverKey;
        if (!maneuverKey) return;

        await this._flushPendingField(root);
        await this.document.rollUnarmedManeuver?.(maneuverKey, {
          tokenId: this._getContextTokenId()
        });
      }, signal);
    }

    for (const button of root.querySelectorAll("[data-action='roll-attribute']")) {
      this._bindEvent(button, "click", async (event) => {
        const attributeKey = event.currentTarget.dataset.attributeKey;
        await this._flushPendingField(root);
        await this.document.rollAttribute3d6(attributeKey);
      }, signal);
    }

    for (const button of root.querySelectorAll("[data-action='roll-skill']")) {
      this._bindEvent(button, "click", async (event) => {
        event.preventDefault();
        const skillId = event.currentTarget.dataset.skillId;
        if (!skillId) return;
        await this._flushPendingField(root);
        await this.document.rollSkill(skillId);
      }, signal);
    }

    for (const button of root.querySelectorAll("[data-action='activate-power']")) {
      this._bindEvent(button, "click", async (event) => {
        event.preventDefault();
        const powerId = event.currentTarget.dataset.itemId;
        if (!powerId) return;

        await this._flushPendingField(root);
        await this.document.activatePower(powerId);
      }, signal);
    }

    for (const button of root.querySelectorAll("[data-action='deactivate-power']")) {
      this._bindEvent(button, "click", async (event) => {
        event.preventDefault();
        const powerId = event.currentTarget.dataset.itemId;
        if (!powerId) return;

        await this._flushPendingField(root);
        await this.document.deactivatePower(powerId);
      }, signal);
    }

    const initiativeButton = root.querySelector("[data-action='roll-initiative']");
    const combatInitiativeButton = root.querySelector("[data-action='roll-initiative-combat']");
    const strikeButton = root.querySelector("[data-action='roll-strike']");
    const parryButton = root.querySelector("[data-action='roll-parry']");
    const dodgeButton = root.querySelector("[data-action='roll-dodge']");

    this._bindEvent(initiativeButton, "click", async () => {
      await this._flushPendingField(root);
      this.document.rollInitiative({ preferCombat: false, tokenId: this._getContextTokenId() });
    }, signal);

    this._bindEvent(combatInitiativeButton, "click", async () => {
      await this._flushPendingField(root);
      this.document.rollInitiative({ preferCombat: true, tokenId: this._getContextTokenId() });
    }, signal);

    this._bindEvent(strikeButton, "click", async () => {
      await this._flushPendingField(root);
      this.document.rollStrike();
    }, signal);

    this._bindEvent(parryButton, "click", async () => {
      await this._flushPendingField(root);
      this.document.rollParry();
    }, signal);

    this._bindEvent(dodgeButton, "click", async () => {
      await this._flushPendingField(root);
      this.document.rollDodge();
    }, signal);
  }
}






















































