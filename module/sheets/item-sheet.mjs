import { isXPTableAscending, normalizeXPThresholdTable } from "../services/progression.mjs";
import { normalizeManeuverPackageEntries, normalizeSpecialManeuverEntry } from "../services/maneuvers.mjs";

const { ItemSheetV2 } = foundry.applications.sheets;
const { HandlebarsApplicationMixin } = foundry.applications.api;
const SYSTEM_ID = "rifts-megaverse";

function stringifyJson(value, fallback = {}) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? fallback, null, 2);
  } catch (_error) {
    return JSON.stringify(fallback, null, 2);
  }
}

function formatXPTableInput(value) {
  const normalized = normalizeXPThresholdTable(value).xpTable;
  return normalized.join(", ");
}

function normalizeProgressionArrayInput(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => Number(entry))
      .filter((entry) => Number.isFinite(entry));
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];

    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map((entry) => Number(entry))
          .filter((entry) => Number.isFinite(entry));
      }
    } catch (_error) {
      // Fall back to CSV-style entry.
    }

    return trimmed
      .split(/[\n,;]/)
      .map((entry) => Number(entry.trim()))
      .filter((entry) => Number.isFinite(entry));
  }

  if (value && typeof value === "object") {
    const mapped = [];
    for (const [levelKey, rawValue] of Object.entries(value)) {
      const level = Number(levelKey);
      const numeric = Number(rawValue);
      if (!Number.isFinite(level) || !Number.isFinite(numeric) || level <= 0) continue;
      mapped[Math.floor(level) - 1] = numeric;
    }

    return mapped
      .map((entry) => Number(entry))
      .filter((entry) => Number.isFinite(entry));
  }

  return [];
}

function formatProgressionArrayInput(value) {
  return normalizeProgressionArrayInput(value).join(", ");
}

function normalizeProgressionMapInput(value) {
  let parsed = value;

  if (typeof parsed === "string") {
    const trimmed = parsed.trim();
    if (!trimmed) return {};

    try {
      parsed = JSON.parse(trimmed);
    } catch (_error) {
      parsed = {};
      for (const part of trimmed.split(/[\n,;]/)) {
        const token = String(part ?? "").trim();
        if (!token) continue;
        const [rawLevel, rawValue] = token.split(":");
        const level = Math.floor(Number(String(rawLevel ?? "").trim()));
        const numeric = Math.floor(Number(String(rawValue ?? "").trim()));
        if (!Number.isFinite(level) || level <= 0) continue;
        if (!Number.isFinite(numeric) || numeric === 0) continue;
        parsed[String(level)] = numeric;
      }
    }
  }

  if (Number.isFinite(Number(parsed))) {
    const numeric = Math.floor(Number(parsed));
    return numeric > 0 ? { "1": numeric } : {};
  }

  if (Array.isArray(parsed)) {
    const map = {};
    for (let idx = 0; idx < parsed.length; idx += 1) {
      const numeric = Math.floor(Number(parsed[idx]));
      if (!Number.isFinite(numeric) || numeric === 0) continue;
      map[String(idx + 1)] = numeric;
    }
    return map;
  }

  if (!parsed || typeof parsed !== "object") return {};

  const map = {};
  for (const [rawLevel, rawValue] of Object.entries(parsed)) {
    const level = Math.floor(Number(rawLevel));
    const numeric = Math.floor(Number(rawValue));
    if (!Number.isFinite(level) || level <= 0) continue;
    if (!Number.isFinite(numeric) || numeric === 0) continue;
    map[String(level)] = numeric;
  }

  return map;
}

function formatProgressionMapInput(value) {
  const normalized = normalizeProgressionMapInput(value);
  return stringifyJson(normalized, {});
}
function normalizeRollableFieldInput(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }

  const textValue = String(value ?? "").trim();
  if (!textValue) return Math.max(0, Math.floor(Number(fallback) || 0));

  const numeric = Number(textValue);
  if (Number.isFinite(numeric)) return Math.max(0, Math.floor(numeric));

  return textValue;
}
function normalizeChoicePoolInput(value) {
  if (Array.isArray(value)) return foundry.utils.deepClone(value);

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];

    try {
      const parsed = parseJsonLenient(trimmed);
      if (Array.isArray(parsed)) return foundry.utils.deepClone(parsed);
      if (parsed && typeof parsed === "object") return [foundry.utils.deepClone(parsed)];
      return [];
    } catch (_error) {
      return [];
    }
  }

  if (value && typeof value === "object") {
    return [foundry.utils.deepClone(value)];
  }

  return [];
}

function parseChoicePoolInput(raw, { poolKey = "" } = {}) {
  const text = String(raw ?? "").trim();
  if (!text) return [];

  try {
    const parsed = parseJsonLenient(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") {
      if (poolKey && Array.isArray(parsed[poolKey])) return parsed[poolKey];
      if (Array.isArray(parsed.entries)) return parsed.entries;
      return [parsed];
    }
  } catch (_error) {
    // Fall through to plain text parsing.
  }

  return text
    .split(/[\r\n,;]+/)
    .map((entry) => String(entry ?? "").trim())
    .map((entry) => entry.replace(/^["']+|["']+$/g, ""))
    .filter((entry) => entry.length > 0);
}

function normalizeClassChoiceProgressionInput(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const out = {};
  for (const key of CLASS_CHOICE_PROGRESSION_KEYS) {
    out[key] = normalizeProgressionMapInput(source[key] ?? {});
  }
  return out;
}

function normalizeClassChoicePoolsInput(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const out = {};
  for (const key of CLASS_CHOICE_POOL_KEYS) {
    out[key] = normalizeChoicePoolInput(source[key]);
  }
  return out;
}
function mapHasEntries(value) {
  return Object.keys(normalizeProgressionMapInput(value)).length > 0;
}

function mergeClassChoiceProgression(systemValue, flagValue) {
  const system = normalizeClassChoiceProgressionInput(systemValue ?? {});
  const flags = normalizeClassChoiceProgressionInput(flagValue ?? {});
  const out = {};

  for (const key of CLASS_CHOICE_PROGRESSION_KEYS) {
    out[key] = mapHasEntries(flags[key]) ? flags[key] : system[key];
  }

  return out;
}

function mergeClassChoicePools(systemValue, flagValue) {
  const system = normalizeClassChoicePoolsInput(systemValue ?? {});
  const flags = normalizeClassChoicePoolsInput(flagValue ?? {});
  const out = {};

  for (const key of CLASS_CHOICE_POOL_KEYS) {
    out[key] = Array.isArray(flags[key]) && flags[key].length > 0
      ? flags[key]
      : system[key];
  }

  return out;
}

const AUGMENT_ATTRIBUTE_KEYS = ["iq", "me", "ma", "ps", "pp", "pe", "pb", "spd"];
const AUGMENT_COMBAT_KEYS = ["strike", "parry", "dodge", "initiative", "apm"];
const AUGMENT_RESOURCE_KEYS = ["hp", "sdc", "mdc", "ppe", "isp"];
const OCC_ATTRIBUTE_KEYS = ["iq", "me", "ma", "ps", "pp", "pe", "pb", "spd"];
const CLASS_CHOICE_PROGRESSION_KEYS = ["spells", "psionics", "maneuvers", "weaponProficiencies", "packageChoices", "optionalChoices"];
const CLASS_CHOICE_POOL_KEYS = ["spells", "psionics", "maneuvers", "weaponProficiencies", "packageChoices", "optionalChoices"];

function defaultAugmentationEffects() {
  const attributes = {};
  const combat = {};
  const resources = {};

  for (const key of AUGMENT_ATTRIBUTE_KEYS) attributes[key] = 0;
  for (const key of AUGMENT_COMBAT_KEYS) combat[key] = 0;
  for (const key of AUGMENT_RESOURCE_KEYS) resources[key] = 0;

  return { attributes, combat, resources, flags: {} };
}


function decodeHtmlEntities(value) {
  const text = String(value ?? "");
  if (!text) return "";
  if (typeof document === "undefined") return text;

  const el = document.createElement("textarea");
  el.innerHTML = text;
  return el.value;
}

function parseJsonLenient(value) {
  const raw = String(value ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/[\u200B-\u200D\u2060]/g, "")
    .trim();
  const decoded = decodeHtmlEntities(raw);
  const normalizedQuotes = decoded
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");

  const variants = [raw, decoded, normalizedQuotes]
    .filter((entry, index, list) => entry.length > 0 && list.indexOf(entry) === index);

  let lastError = null;
  for (const candidate of variants) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("Invalid JSON payload.");
}

function unwrapParsedJsonString(value, maxDepth = 3) {
  let parsed = value;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (typeof parsed !== "string") break;
    const trimmed = parsed.trim();
    if (!trimmed) break;
    parsed = parseJsonLenient(trimmed);
  }
  return parsed;
}

function normalizeAugmentationEffectsInput(value) {
  let parsed = value;
  if (typeof parsed === "string") {
    const trimmed = parsed.trim();
    if (!trimmed) return defaultAugmentationEffects();
    parsed = parseJsonLenient(trimmed);
  }

  parsed = unwrapParsedJsonString(parsed);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.effects && typeof parsed.effects === "object") {
    parsed = parsed.effects;
  }
  if (Array.isArray(parsed) && parsed.length === 0) {
    return defaultAugmentationEffects();
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Augmentation effects payload must be an object.");
  }

  const defaults = defaultAugmentationEffects();
  const effects = {
    attributes: { ...defaults.attributes },
    combat: { ...defaults.combat },
    resources: { ...defaults.resources },
    flags: {}
  };

  for (const key of AUGMENT_ATTRIBUTE_KEYS) {
    effects.attributes[key] = Number(parsed?.attributes?.[key] ?? 0);
    if (!Number.isFinite(effects.attributes[key])) effects.attributes[key] = 0;
  }

  for (const key of AUGMENT_COMBAT_KEYS) {
    effects.combat[key] = Number(parsed?.combat?.[key] ?? 0);
    if (!Number.isFinite(effects.combat[key])) effects.combat[key] = 0;
  }

  for (const key of AUGMENT_RESOURCE_KEYS) {
    effects.resources[key] = Number(parsed?.resources?.[key] ?? 0);
    if (!Number.isFinite(effects.resources[key])) effects.resources[key] = 0;
  }

  const parsedFlags = parsed?.flags;
  if (parsedFlags && typeof parsedFlags === "object" && !Array.isArray(parsedFlags)) {
    for (const [flagKey, flagValue] of Object.entries(parsedFlags)) {
      const normalizedKey = String(flagKey ?? "").trim();
      if (!normalizedKey) continue;
      const enabled = flagValue === true || String(flagValue ?? "").trim().toLowerCase() === "true" || Number(flagValue) > 0;
      effects.flags[normalizedKey] = enabled;
    }
  }

  return effects;
}

function normalizeGrantedAbilitiesInput(value) {
  let parsed = value;
  if (typeof parsed === "string") {
    const trimmed = parsed.trim();
    if (!trimmed) return [];
    parsed = parseJsonLenient(trimmed);
  }

  parsed = unwrapParsedJsonString(parsed);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.grantedAbilities)) {
    parsed = parsed.grantedAbilities;
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Granted abilities payload must be an array.");
  }

  return foundry.utils.deepClone(parsed);
}

function normalizeGrantedSkillsInput(value) {
  let parsed = value;
  if (typeof parsed === "string") {
    const trimmed = parsed.trim();
    if (!trimmed) return [];
    parsed = parseJsonLenient(trimmed);
  }

  parsed = unwrapParsedJsonString(parsed);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.grantedSkills)) {
    parsed = parsed.grantedSkills;
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Granted skills payload must be an array.");
  }

  return foundry.utils.deepClone(parsed);
}

function normalizeHthManeuverPackageInput(value) {
  let parsed = value;
  if (typeof parsed === "string") {
    const trimmed = parsed.trim();
    if (!trimmed) return [];
    parsed = parseJsonLenient(trimmed);
  }

  parsed = unwrapParsedJsonString(parsed);

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    if (Array.isArray(parsed.grantedManeuvers)) {
      parsed = parsed.grantedManeuvers;
    } else if (parsed.maneuverPackage && typeof parsed.maneuverPackage === "object" && Array.isArray(parsed.maneuverPackage.grantedManeuvers)) {
      parsed = parsed.maneuverPackage.grantedManeuvers;
    }
  }

  if (!Array.isArray(parsed)) {
    throw new Error("HtH maneuver package must be an array.");
  }

  return normalizeManeuverPackageEntries(parsed);
}
export class RiftsItemSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
  _listenerAbortController = null;

  static DEFAULT_OPTIONS = foundry.utils.mergeObject(super.DEFAULT_OPTIONS, {
    classes: ["rifts", "sheet", "item"],
    position: {
      width: 620,
      height: 760
    },
    form: {
      submitOnChange: true,
      closeOnSubmit: false
    },
    window: {
      resizable: true,
      title: "RIFTS.Sheet.Item"
    }
  }, { inplace: false });

  static PARTS = {
    body: {
      template: "systems/rifts-megaverse/templates/item/item-sheet.hbs"
    }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const itemType = this.document.type;

    context.item = this.document;
    context.system = this.document.system;
    context.itemType = itemType;

    context.isSkill = itemType === "skill";
    context.isWeapon = itemType === "weapon";
    context.isArmor = itemType === "armor";
    context.isOcc = itemType === "occ";
    context.isRcc = itemType === "rcc";
    context.isCybernetic = itemType === "cybernetic";
    context.isBionic = itemType === "bionic";
    context.isAugmentation = context.isCybernetic || context.isBionic;
    context.isHandToHand = itemType === "handToHand";
    context.isSpecialManeuver = itemType === "specialManeuver";
    context.isClassItem = context.isOcc || context.isRcc;
    context.classLabel = context.isOcc
      ? game.i18n.localize("RIFTS.Sheet.OCC")
      : context.isRcc
        ? game.i18n.localize("RIFTS.Sheet.RCC")
        : "";

    context.powerScaleOptions = {
      "": game.i18n.localize("RIFTS.Sheet.None"),
      sdc: game.i18n.localize("RIFTS.Combat.SDC"),
      mdc: game.i18n.localize("RIFTS.Combat.MDC"),
      powerArmor: game.i18n.localize("RIFTS.PowerArmor.PowerArmor"),
      vehicle: game.i18n.localize("RIFTS.Sheet.Vehicle"),
      giantCreature: game.i18n.localize("RIFTS.Size.Giant")
    };


    context.classProgressionText = stringifyJson(this.document.system?.attacksPerMeleePerLevel ?? {}, {});
    context.classXPValue = Number.isFinite(Number(this.document.system?.xp?.value))
      ? Number(this.document.system?.xp?.value)
      : Number(this.document.system?.experience ?? 0);
    context.classXPTableText = formatXPTableInput(this.document.system?.progression?.xpTable ?? [0]);
    context.classMaxLevel = Number.isFinite(Number(this.document.system?.progression?.maxLevel))
      ? Number(this.document.system?.progression?.maxLevel)
      : 15;
    context.classOccSkillsText = stringifyJson(this.document.system?.skillPackage?.occSkills ?? [], []);
    context.classRelatedSkillsText = stringifyJson(this.document.system?.skillPackage?.relatedSkills ?? [], []);
    context.classSecondarySkillsText = stringifyJson(this.document.system?.skillPackage?.secondarySkills ?? [], []);
    context.classStartingBionicsText = stringifyJson(this.document.system?.startingPackages?.bionics ?? [], []);
    context.classStartingCyberneticsText = stringifyJson(this.document.system?.startingPackages?.cybernetics ?? [], []);
    context.classStartingAbilitiesText = stringifyJson(this.document.system?.startingPackages?.abilities ?? [], []);
    context.classStartingGearText = stringifyJson(this.document.system?.startingPackages?.gear ?? [], []);
    context.classStartingSpellsText = stringifyJson(this.document.system?.startingPowers?.spells ?? [], []);
    context.classStartingPsionicsText = stringifyJson(this.document.system?.startingPowers?.psionics ?? [], []);
    context.classOccSkillProgressionText = formatProgressionMapInput(this.document.system?.skillSelection?.occProgression ?? {});
    context.classRelatedSkillProgressionText = formatProgressionMapInput(this.document.system?.skillSelection?.relatedProgression ?? {});
    context.classSecondarySkillProgressionText = formatProgressionMapInput(this.document.system?.skillSelection?.secondaryProgression ?? {});
    context.classSpellProgressionText = formatProgressionMapInput(
      this.document.system?.powerProgression?.spellProgression ?? this.document.system?.powerProgression?.spellsPerLevel
    );
    context.classPsionicProgressionText = formatProgressionMapInput(
      this.document.system?.powerProgression?.psionicProgression ?? this.document.system?.powerProgression?.psionicsPerLevel
    );
    const choiceProgressionFlags = this.document.getFlag?.(SYSTEM_ID, "choiceProgression") ?? {};
    const choicePoolsFlags = this.document.getFlag?.(SYSTEM_ID, "choicePools") ?? {};
    const initialChoiceProgression = mergeClassChoiceProgression(this.document.system?.choiceProgression ?? {}, choiceProgressionFlags);
    const initialChoicePools = mergeClassChoicePools(this.document.system?.choicePools ?? {}, choicePoolsFlags);
    context.classChoiceProgressionText = stringifyJson(initialChoiceProgression, {});
    context.classChoicePoolSpellsText = stringifyJson(initialChoicePools.spells, []);
    context.classChoicePoolPsionicsText = stringifyJson(initialChoicePools.psionics, []);
    context.classChoicePoolManeuversText = stringifyJson(initialChoicePools.maneuvers, []);
    context.classChoicePoolWeaponProficienciesText = stringifyJson(initialChoicePools.weaponProficiencies, []);
    context.classChoicePoolPackageChoicesText = stringifyJson(initialChoicePools.packageChoices, []);
    context.classChoicePoolOptionalChoicesText = stringifyJson(initialChoicePools.optionalChoices, []);
    context.classAttributeRequirements = {};
    for (const key of OCC_ATTRIBUTE_KEYS) {
      const requirementValue = Number(this.document.system?.attributeRequirements?.[key]);
      context.classAttributeRequirements[key] = Number.isFinite(requirementValue) && requirementValue > 0
        ? Math.floor(requirementValue)
        : "";
    }
    context.classEffectsText = stringifyJson(this.document.system?.effects ?? defaultAugmentationEffects(), defaultAugmentationEffects());
    context.classGrantedAbilitiesText = stringifyJson(this.document.system?.grantedAbilities ?? [], []);
    context.classGrantedSkillsText = stringifyJson(this.document.system?.grantedSkills ?? [], []);

    if (context.isClassItem) {
      try {
        context.system.effects = normalizeAugmentationEffectsInput(context.system.effects ?? defaultAugmentationEffects());
      } catch (_error) {
        context.system.effects = defaultAugmentationEffects();
      }

      context.system.grantedAbilities = Array.isArray(context.system.grantedAbilities)
        ? context.system.grantedAbilities
        : [];
      context.system.grantedSkills = Array.isArray(context.system.grantedSkills)
        ? context.system.grantedSkills
        : [];
      context.system.startingPackages ??= {};
      context.system.startingPackages.bionics = Array.isArray(context.system.startingPackages.bionics)
        ? context.system.startingPackages.bionics
        : [];
      context.system.startingPackages.cybernetics = Array.isArray(context.system.startingPackages.cybernetics)
        ? context.system.startingPackages.cybernetics
        : [];
      context.system.startingPackages.abilities = Array.isArray(context.system.startingPackages.abilities)
        ? context.system.startingPackages.abilities
        : [];
      context.system.startingPackages.gear = Array.isArray(context.system.startingPackages.gear)
        ? context.system.startingPackages.gear
        : [];
      context.system.attributeRequirements ??= {};
      for (const key of OCC_ATTRIBUTE_KEYS) {
        const requirementValue = Number(context.system.attributeRequirements[key]);
        context.system.attributeRequirements[key] = Number.isFinite(requirementValue) && requirementValue > 0
          ? Math.floor(requirementValue)
          : null;
      }
      context.system.skillSelection ??= { occ: 0, related: 0, secondary: 0, occProgression: {}, relatedProgression: {}, secondaryProgression: {} };
      context.system.skillSelection.occ = Number.isFinite(Number(context.system.skillSelection.occ))
        ? Math.max(0, Math.floor(Number(context.system.skillSelection.occ)))
        : 0;
      context.system.skillSelection.related = Number.isFinite(Number(context.system.skillSelection.related))
        ? Math.max(0, Math.floor(Number(context.system.skillSelection.related)))
        : 0;
      context.system.skillSelection.secondary = Number.isFinite(Number(context.system.skillSelection.secondary))
        ? Math.max(0, Math.floor(Number(context.system.skillSelection.secondary)))
        : 0;
      context.system.skillSelection.occProgression = normalizeProgressionMapInput(context.system.skillSelection.occProgression ?? {});
      context.system.skillSelection.relatedProgression = normalizeProgressionMapInput(context.system.skillSelection.relatedProgression ?? {});
      context.system.skillSelection.secondaryProgression = normalizeProgressionMapInput(context.system.skillSelection.secondaryProgression ?? {});
      context.system.startingResources ??= { hp: 0, sdc: 0, isp: 0, ppe: 0 };
      context.system.startingResources.hp = normalizeRollableFieldInput(context.system.startingResources.hp, 0);
      context.system.startingResources.sdc = normalizeRollableFieldInput(context.system.startingResources.sdc, 0);
      context.system.startingResources.isp = normalizeRollableFieldInput(context.system.startingResources.isp, 0);
      context.system.startingResources.ppe = normalizeRollableFieldInput(context.system.startingResources.ppe, 0);
      context.system.resourceProgression ??= { hpPerLevel: "1d6", sdcPerLevel: "1d6", ispPerLevel: "", ppePerLevel: "" };
      context.system.resourceProgression.hpPerLevel = String(context.system.resourceProgression.hpPerLevel ?? "1d6");
      context.system.resourceProgression.sdcPerLevel = String(context.system.resourceProgression.sdcPerLevel ?? "1d6");
      context.system.resourceProgression.ispPerLevel = String(context.system.resourceProgression.ispPerLevel ?? "");
      context.system.resourceProgression.ppePerLevel = String(context.system.resourceProgression.ppePerLevel ?? "");
      context.system.startingPowers ??= { spells: [], psionics: [] };
      context.system.startingPowers.spells = Array.isArray(context.system.startingPowers.spells)
        ? context.system.startingPowers.spells
        : [];
      context.system.startingPowers.psionics = Array.isArray(context.system.startingPowers.psionics)
        ? context.system.startingPowers.psionics
        : [];
      context.system.powerProgression ??= { spellProgression: {}, psionicProgression: {} };
      const legacySpellsPerLevel = Number.isFinite(Number(context.system.powerProgression.spellsPerLevel))
        ? Math.max(0, Math.floor(Number(context.system.powerProgression.spellsPerLevel)))
        : 0;
      const legacyPsionicsPerLevel = Number.isFinite(Number(context.system.powerProgression.psionicsPerLevel))
        ? Math.max(0, Math.floor(Number(context.system.powerProgression.psionicsPerLevel)))
        : 0;
      context.system.powerProgression.spellProgression = normalizeProgressionMapInput(
        context.system.powerProgression.spellProgression ?? (legacySpellsPerLevel > 0 ? { "1": legacySpellsPerLevel } : {})
      );
            const classChoiceProgressionFlags = this.document.getFlag?.(SYSTEM_ID, "choiceProgression") ?? {};
      const classChoicePoolsFlags = this.document.getFlag?.(SYSTEM_ID, "choicePools") ?? {};
      context.system.choiceProgression = mergeClassChoiceProgression(context.system.choiceProgression ?? {}, classChoiceProgressionFlags);
      context.system.choicePools = mergeClassChoicePools(context.system.choicePools ?? {}, classChoicePoolsFlags);
      context.system.startingCredits ??= { credits: 0 };
      context.system.startingCredits.credits = normalizeRollableFieldInput(context.system.startingCredits.credits, 0);
      context.classAttributeRequirements = {};
      for (const key of OCC_ATTRIBUTE_KEYS) {
        const requirementValue = Number(context.system.attributeRequirements[key]);
        context.classAttributeRequirements[key] = Number.isFinite(requirementValue) && requirementValue > 0
          ? Math.floor(requirementValue)
          : "";
      }
      context.classStartingSpellsText = stringifyJson(context.system.startingPowers.spells, []);
      context.classStartingPsionicsText = stringifyJson(context.system.startingPowers.psionics, []);
      context.classOccSkillProgressionText = formatProgressionMapInput(context.system.skillSelection.occProgression);
      context.classRelatedSkillProgressionText = formatProgressionMapInput(context.system.skillSelection.relatedProgression);
      context.classSecondarySkillProgressionText = formatProgressionMapInput(context.system.skillSelection.secondaryProgression);
            context.classChoiceProgressionText = stringifyJson(context.system.choiceProgression, {});
      context.classChoicePoolSpellsText = stringifyJson(context.system.choicePools.spells, []);
      context.classChoicePoolPsionicsText = stringifyJson(context.system.choicePools.psionics, []);
      context.classChoicePoolManeuversText = stringifyJson(context.system.choicePools.maneuvers, []);
      context.classChoicePoolWeaponProficienciesText = stringifyJson(context.system.choicePools.weaponProficiencies, []);
      context.classChoicePoolPackageChoicesText = stringifyJson(context.system.choicePools.packageChoices, []);
      context.classChoicePoolOptionalChoicesText = stringifyJson(context.system.choicePools.optionalChoices, []);
      context.classEffectsText = stringifyJson(context.system.effects, defaultAugmentationEffects());
      context.classGrantedAbilitiesText = stringifyJson(context.system.grantedAbilities, []);
      context.classGrantedSkillsText = stringifyJson(context.system.grantedSkills, []);
      context.classStartingBionicsText = stringifyJson(context.system.startingPackages.bionics, []);
      context.classStartingCyberneticsText = stringifyJson(context.system.startingPackages.cybernetics, []);
      context.classStartingAbilitiesText = stringifyJson(context.system.startingPackages.abilities, []);
      context.classStartingGearText = stringifyJson(context.system.startingPackages.gear, []);
    }

    context.hthApmBonusText = formatProgressionArrayInput(this.document.system?.progression?.apmBonus ?? []);
    context.hthStrikeBonusText = formatProgressionArrayInput(this.document.system?.progression?.strikeBonus ?? []);
    context.hthParryBonusText = formatProgressionArrayInput(this.document.system?.progression?.parryBonus ?? []);
    context.hthDodgeBonusText = formatProgressionArrayInput(this.document.system?.progression?.dodgeBonus ?? []);
    context.hthAutoDodgeLevelText = formatProgressionArrayInput(this.document.system?.progression?.autoDodgeLevel ?? []);
    context.hthDamageBonusText = formatProgressionArrayInput(this.document.system?.progression?.damageBonus ?? []);
    context.hthManeuverPackageText = stringifyJson(this.document.system?.maneuverPackage?.grantedManeuvers ?? [], []);

    if (context.isWeapon) {
      context.system.weapon ??= {};
      context.system.weapon.isBurstCapable = context.system.weapon.isBurstCapable === true;
      context.system.weapon.fireMode = context.system.weapon.fireMode ?? "single";
      context.system.weapon.burstSize = Number.isFinite(Number(context.system.weapon.burstSize))
        ? Number(context.system.weapon.burstSize)
        : 3;
      context.system.weapon.burstStrikeMod = Number.isFinite(Number(context.system.weapon.burstStrikeMod))
        ? Number(context.system.weapon.burstStrikeMod)
        : 1;
      context.system.weapon.burstDamageMultiplier = Number.isFinite(Number(context.system.weapon.burstDamageMultiplier))
        ? Number(context.system.weapon.burstDamageMultiplier)
        : 2;
      context.system.weapon.ammoPerBurst = Number.isFinite(Number(context.system.weapon.ammoPerBurst))
        ? Number(context.system.weapon.ammoPerBurst)
        : 3;
      context.system.weapon.aimedStrikeMod = Number.isFinite(Number(context.system.weapon.aimedStrikeMod))
        ? Number(context.system.weapon.aimedStrikeMod)
        : -3;
      context.system.weapon.supportsAimedShot = context.system.weapon.supportsAimedShot !== false;
      context.system.weapon.canKnockdown = context.system.weapon.canKnockdown === true;
      context.system.weapon.canKnockback = context.system.weapon.canKnockback === true;
      context.system.weapon.knockbackValue = Number.isFinite(Number(context.system.weapon.knockbackValue))
        ? Math.max(0, Number(context.system.weapon.knockbackValue))
        : 0;
      context.system.weapon.impactType = String(context.system.weapon.impactType ?? "").trim().toLowerCase();
    }

    if (context.isArmor) {
      context.system.armor ??= {};
    }

    if (context.isAugmentation) {
      context.system.installed = context.system.installed === true;
      context.system.slot = String(context.system.slot ?? "");
      context.system.notes = String(context.system.notes ?? "");
      try {
        context.system.effects = normalizeAugmentationEffectsInput(context.system.effects ?? defaultAugmentationEffects());
      } catch (_error) {
        context.system.effects = defaultAugmentationEffects();
      }
      context.system.grantedAbilities = Array.isArray(context.system.grantedAbilities)
        ? context.system.grantedAbilities
        : [];

      context.augmentationEffectsText = stringifyJson(context.system.effects, defaultAugmentationEffects());
      context.augmentationGrantedAbilitiesText = stringifyJson(context.system.grantedAbilities, []);
      context.augmentationTypeLabel = context.isCybernetic
        ? game.i18n.localize("RIFTS.Augmentation.Cybernetics")
        : game.i18n.localize("RIFTS.Augmentation.Bionics");
    }

    if (context.isHandToHand) {
      context.system.maneuverPackage ??= {};
      context.system.maneuverPackage.grantedManeuvers ??= [];
      context.system.progression ??= {};
      context.system.selectionProgression ??= { maneuvers: {} };
      const hthSelectionFlags = this.document.getFlag?.(SYSTEM_ID, "selectionProgression") ?? {};
      const systemManeuverSelectionProgression = normalizeProgressionMapInput(context.system.selectionProgression.maneuvers ?? {});
      const flagManeuverSelectionProgression = normalizeProgressionMapInput(hthSelectionFlags?.maneuvers ?? {});
      context.system.selectionProgression.maneuvers = mapHasEntries(systemManeuverSelectionProgression)
        ? systemManeuverSelectionProgression
        : flagManeuverSelectionProgression;
      context.system.active = context.system.active === true;
      context.system.style = String(context.system.style ?? "basic").trim().toLowerCase() || "basic";
      context.handToHandStyleOptions = {
        basic: game.i18n.localize("RIFTS.HandToHand.Basic"),
        expert: game.i18n.localize("RIFTS.HandToHand.Expert"),
        martialArts: game.i18n.localize("RIFTS.HandToHand.MartialArts"),
        assassin: game.i18n.localize("RIFTS.HandToHand.Assassin")
      };
      context.hthManeuverSelectionProgressionText = formatProgressionMapInput(context.system.selectionProgression.maneuvers);
      context.system.notes = context.system.notes ?? "";
    }

    if (context.isSpecialManeuver) {
      const normalizedManeuver = normalizeSpecialManeuverEntry({
        ...context.system,
        name: this.document.name
      });
      context.system.key = normalizedManeuver.key;
      context.system.category = normalizedManeuver.category;
      context.system.description = normalizedManeuver.description;
      context.system.actionCost = normalizedManeuver.actionCost;
      context.system.strikeModifier = normalizedManeuver.strikeModifier;
      context.system.damageFormula = normalizedManeuver.damageFormula;
      context.system.damageMultiplier = Math.max(1, Number(normalizedManeuver.damageMultiplier ?? 1));
      context.system.canKnockdown = normalizedManeuver.canKnockdown === true;
      context.system.canKnockback = normalizedManeuver.canKnockback === true;
      context.system.knockbackValue = Math.max(0, Number(normalizedManeuver.knockbackValue ?? 0));
      context.system.impactType = normalizedManeuver.impactType;
      context.system.isReactive = normalizedManeuver.isReactive === true;
      context.system.requiresTarget = normalizedManeuver.requiresTarget === true;
      context.system.requiresHit = normalizedManeuver.requiresHit === true;
      context.system.minLevel = normalizedManeuver.minLevel;
      context.system.sourceType = normalizedManeuver.sourceType;
      context.system.sourceId = normalizedManeuver.sourceId;
      context.system.sourceName = normalizedManeuver.sourceName;
      context.system.specialRules = normalizedManeuver.specialRules;
      context.system.grantable = normalizedManeuver.grantable !== false;
      context.system.tags = Array.isArray(normalizedManeuver.tags) ? foundry.utils.deepClone(normalizedManeuver.tags) : [];
      context.specialManeuverTagsText = Array.isArray(context.system.tags) ? context.system.tags.join(", ") : "";
      context.system.notes = normalizedManeuver.notes;
      context.specialManeuverCategoryOptions = {
        offensive: game.i18n.localize("RIFTS.Maneuvers.OffensiveManeuver"),
        defensive: game.i18n.localize("RIFTS.Maneuvers.ReactiveManeuver"),
        reactive: game.i18n.localize("RIFTS.Maneuvers.ReactiveManeuver")
      };
    }

    context.isPower = itemType === "power";
    if (context.isPower) {
      context.system.powerType = context.system.powerType ?? (context.system.type || "ability");
      context.system.subType = context.system.subType ?? "";
      context.system.costType = context.system.costType ?? "none";
      context.system.cost = Number.isFinite(Number(context.system.cost)) ? Number(context.system.cost) : 0;
      context.system.range = context.system.range ?? "";
      context.system.duration = context.system.duration ?? "";
      context.system.activationTime = context.system.activationTime ?? "";
      context.system.saveType = context.system.saveType ?? "";
      context.system.damage = context.system.damage ?? "";
      context.system.description = context.system.description ?? "";
      context.system.notes = context.system.notes ?? "";
      context.system.requiresTarget = context.system.requiresTarget === true;
      context.system.requiresAttackRoll = context.system.requiresAttackRoll === true;
      context.system.requiresSave = context.system.requiresSave === true;
      context.system.scale = context.system.scale ?? "";
      context.system.active = context.system.active === true;

      context.powerTypeOptions = {
        psionic: game.i18n.localize("RIFTS.Powers.Psionic"),
        spell: game.i18n.localize("RIFTS.Powers.Spell"),
        ability: game.i18n.localize("RIFTS.Powers.Ability"),
        "techno-wizard": game.i18n.localize("RIFTS.Powers.TechnoWizard"),
        supernatural: game.i18n.localize("RIFTS.Powers.Supernatural")
      };

      context.costTypeOptions = {
        none: game.i18n.localize("RIFTS.Powers.CostTypeNone"),
        isp: game.i18n.localize("RIFTS.Powers.CostTypeISP"),
        ppe: game.i18n.localize("RIFTS.Powers.CostTypePPE"),
        hp: game.i18n.localize("RIFTS.Powers.CostTypeHP"),
        sdc: game.i18n.localize("RIFTS.Powers.CostTypeSDC")
      };
    }

    context.isGear = itemType === "gear";
    context.isFeature = itemType === "feature";

    const parentActor = this.document.parent?.documentName === "Actor" ? this.document.parent : null;
    const linkedArmorChoices = {
      "": game.i18n.localize("RIFTS.Sheet.None")
    };

    if (context.isWeapon && parentActor) {
      const armors = parentActor.items
        .filter((item) => item.type === "armor")
        .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));

      for (const armor of armors) {
        const isPowerArmor = armor.system?.armor?.isPowerArmor === true || armor.system?.isPowerArmor === true;
        const isEquipped = armor.system?.equipped === true || armor.system?.active === true;
        let label = armor.name;
        if (isPowerArmor) label += ` [${game.i18n.localize("RIFTS.PowerArmor.PowerArmor")}]`;
        if (isEquipped) label += ` [${game.i18n.localize("RIFTS.Item.Equipped")}]`;
        linkedArmorChoices[armor.id] = label;
      }
    }

    context.linkedArmorChoices = linkedArmorChoices;
    context.hasLinkedArmorChoices = Object.keys(linkedArmorChoices).length > 1;

    return context;
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

    root.querySelectorAll("input[name], select[name], textarea[name]").forEach((field) => {
      field.addEventListener("change", async (event) => {
        const target = event.currentTarget;
        const path = target.name;
        if (!path) return;

        let value;
        if (target.type === "checkbox") value = target.checked;
        else if (target.type === "number") value = Number(target.value || 0);
        else value = target.value;

        if (path === "system.xp.value" || path === "system.experience") {
          const xpValue = Math.max(0, Number(value || 0));
          await this.document.update({
            "system.xp.value": xpValue,
            "system.experience": xpValue
          });
          return;
        }

        await this.document.update({ [path]: value });
      }, { signal });
    });

    root.querySelectorAll("[data-action='class-progression']").forEach((field) => {
      field.addEventListener("change", async (event) => {
        const raw = String(event.currentTarget.value ?? "").trim();
        if (!raw) {
          await this.document.update({ "system.attacksPerMeleePerLevel": {} });
          return;
        }

        try {
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object") {
            throw new Error("Progression must be an object or array.");
          }

          await this.document.update({ "system.attacksPerMeleePerLevel": parsed });
        } catch (_error) {
          ui.notifications.error(game.i18n.localize("RIFTS.Errors.InvalidProgressionJSON"));
        }
      }, { signal });
    });

    root.querySelectorAll("[data-action='class-xp-table']").forEach((field) => {
      field.addEventListener("change", async (event) => {
        const raw = String(event.currentTarget.value ?? "").trim();

        try {
          const normalizedData = normalizeXPThresholdTable(raw);
          const normalized = normalizedData.xpTable;

          if (raw && normalizedData.ignoredNonNumericCount > 0) {
            throw new Error("XP table contains non-numeric values.");
          }

          if (!isXPTableAscending(normalized)) {
            ui.notifications.warn(game.i18n.localize("RIFTS.Warnings.XPTableNotAscending"));
          }

          await this.document.update({ "system.progression.xpTable": normalized });
          event.currentTarget.value = normalized.join(", ");
        } catch (_error) {
          ui.notifications.error(game.i18n.localize("RIFTS.Errors.InvalidXPTableJSON"));
        }
      }, { signal });
    });

    root.querySelectorAll("[data-action='class-skill-package']").forEach((field) => {
      field.addEventListener("change", async (event) => {
        const packageKey = event.currentTarget.dataset.packageKey;
        if (!["occSkills", "relatedSkills", "secondarySkills"].includes(packageKey)) return;

        const raw = String(event.currentTarget.value ?? "").trim();
        if (!raw) {
          await this.document.update({ [`system.skillPackage.${packageKey}`]: [] });
          return;
        }

        try {
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) {
            throw new Error("Class skill package must be an array.");
          }

          await this.document.update({ [`system.skillPackage.${packageKey}`]: parsed });
        } catch (_error) {
          ui.notifications.error(game.i18n.localize("RIFTS.Errors.InvalidSkillPackageJSON"));
        }
      }, { signal });
    });
    root.querySelectorAll("[data-action='class-skill-selection-progression']").forEach((field) => {
      field.addEventListener("change", async (event) => {
        const progressionKey = event.currentTarget.dataset.progressionKey;
        if (!["occProgression", "relatedProgression", "secondaryProgression"].includes(progressionKey)) return;

        const raw = String(event.currentTarget.value ?? "").trim();
        const normalized = normalizeProgressionMapInput(raw);
        await this.document.update({ [`system.skillSelection.${progressionKey}`]: normalized });
        event.currentTarget.value = stringifyJson(normalized, {});
      }, { signal });
    });

    root.querySelectorAll("[data-action='class-power-progression']").forEach((field) => {
      field.addEventListener("change", async (event) => {
        const progressionKey = event.currentTarget.dataset.progressionKey;
        if (!["spellProgression", "psionicProgression"].includes(progressionKey)) return;

        const raw = String(event.currentTarget.value ?? "").trim();
        const normalized = normalizeProgressionMapInput(raw);
        await this.document.update({ [`system.powerProgression.${progressionKey}`]: normalized });
        event.currentTarget.value = stringifyJson(normalized, {});
      }, { signal });
    });
        root.querySelectorAll("[data-action='class-choice-progression']").forEach((field) => {
      field.addEventListener("change", async (event) => {
        const progressionKey = String(event.currentTarget.dataset.progressionKey ?? "all").trim();
        const raw = String(event.currentTarget.value ?? "").trim();

        const current = mergeClassChoiceProgression(
          this.document.system?.choiceProgression ?? {},
          this.document.getFlag?.(SYSTEM_ID, "choiceProgression") ?? {}
        );
        let next = foundry.utils.deepClone(current);

        try {
          if (!raw) {
            if (progressionKey === "all") next = normalizeClassChoiceProgressionInput({});
            else if (CLASS_CHOICE_PROGRESSION_KEYS.includes(progressionKey)) next[progressionKey] = {};
          } else if (progressionKey === "all") {
            const parsed = parseJsonLenient(raw);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              throw new Error("Choice progression must be a JSON object.");
            }
            next = normalizeClassChoiceProgressionInput(parsed);
          } else if (CLASS_CHOICE_PROGRESSION_KEYS.includes(progressionKey)) {
            next[progressionKey] = normalizeProgressionMapInput(raw);
          } else {
            return;
          }
        } catch (_parseError) {
          ui.notifications.error(game.i18n.localize("RIFTS.Errors.InvalidProgressionJSON"));
          return;
        }

        let flagSaved = false;
        let systemSaved = false;

        try {
          await this.document.setFlag(SYSTEM_ID, "choiceProgression", next);
          flagSaved = true;
        } catch (_flagError) {
          // Fall back to system path if flag write fails.
        }

        try {
          await this.document.update({ "system.choiceProgression": next });
          systemSaved = true;
        } catch (_systemError) {
          // Flag storage is authoritative fallback for schema-mismatch worlds.
        }

        if (!flagSaved && !systemSaved) {
          ui.notifications.error(game.i18n.localize("RIFTS.Errors.ProgressionSaveFailed"));
          return;
        }

        event.currentTarget.value = stringifyJson(next, {});
      }, { signal });
    });
    root.querySelectorAll("[data-action='class-attribute-requirement']").forEach((field) => {
      field.addEventListener("change", async (event) => {
        const attributeKey = event.currentTarget.dataset.attributeKey;
        if (!OCC_ATTRIBUTE_KEYS.includes(attributeKey)) return;

        const raw = String(event.currentTarget.value ?? "").trim();
        const numeric = Number(raw);
        const requirement = Number.isFinite(numeric) && numeric > 0
          ? Math.floor(numeric)
          : null;

        await this.document.update({ [`system.attributeRequirements.${attributeKey}`]: requirement });
        event.currentTarget.value = requirement === null ? "" : String(requirement);
      }, { signal });
    });

    root.querySelectorAll("[data-action='class-starting-powers']").forEach((field) => {
      field.addEventListener("change", async (event) => {
        const powerKey = event.currentTarget.dataset.powerKey;
        if (!["spells", "psionics"].includes(powerKey)) return;

        const raw = String(event.currentTarget.value ?? "").trim();
        if (!raw) {
          await this.document.update({ [`system.startingPowers.${powerKey}`]: [] });
          return;
        }

        try {
          const parsed = parseJsonLenient(raw);
          if (!Array.isArray(parsed)) {
            throw new Error("Starting powers entries must be an array.");
          }

          await this.document.update({ [`system.startingPowers.${powerKey}`]: foundry.utils.deepClone(parsed) });
          event.currentTarget.value = stringifyJson(parsed, []);
        } catch (_error) {
          ui.notifications.error(game.i18n.localize("RIFTS.Errors.InvalidStartingPowersJSON"));
        }
      }, { signal });
    });

    root.querySelectorAll("[data-action='class-starting-package']").forEach((field) => {
      field.addEventListener("change", async (event) => {
        const packageKey = event.currentTarget.dataset.packageKey;
        if (!["bionics", "cybernetics", "abilities", "gear"].includes(packageKey)) return;

        const raw = String(event.currentTarget.value ?? "").trim();
        if (!raw) {
          await this.document.update({ [`system.startingPackages.${packageKey}`]: [] });
          return;
        }

        try {
          const parsed = parseJsonLenient(raw);
          if (!Array.isArray(parsed)) {
            throw new Error("Starting package entries must be an array.");
          }

          await this.document.update({ [`system.startingPackages.${packageKey}`]: foundry.utils.deepClone(parsed) });
          event.currentTarget.value = stringifyJson(parsed, []);
        } catch (_error) {
          ui.notifications.error(game.i18n.localize("RIFTS.Errors.InvalidSkillPackageJSON"));
        }
      }, { signal });
    });

    root.querySelectorAll("[data-action='class-effects']").forEach((field) => {
      field.addEventListener("change", async (event) => {
        const raw = String(event.currentTarget.value ?? "").trim();

        try {
          const normalized = normalizeAugmentationEffectsInput(raw);
          await this.document.update({ "system.effects": normalized });
          event.currentTarget.value = stringifyJson(normalized, defaultAugmentationEffects());
        } catch (_error) {
          ui.notifications.error(game.i18n.localize("RIFTS.Errors.InvalidAugmentationEffectsJSON"));
        }
      }, { signal });
    });

    root.querySelectorAll("[data-action='class-granted-abilities']").forEach((field) => {
      field.addEventListener("change", async (event) => {
        const raw = String(event.currentTarget.value ?? "").trim();

        try {
          const normalized = normalizeGrantedAbilitiesInput(raw);
          await this.document.update({ "system.grantedAbilities": normalized });
          event.currentTarget.value = stringifyJson(normalized, []);
        } catch (_error) {
          ui.notifications.error(game.i18n.localize("RIFTS.Errors.InvalidGrantedAbilitiesJSON"));
        }
      }, { signal });
    });

    root.querySelectorAll("[data-action='class-granted-skills']").forEach((field) => {
      field.addEventListener("change", async (event) => {
        const raw = String(event.currentTarget.value ?? "").trim();

        try {
          const normalized = normalizeGrantedSkillsInput(raw);
          await this.document.update({ "system.grantedSkills": normalized });
          event.currentTarget.value = stringifyJson(normalized, []);
        } catch (_error) {
          ui.notifications.error(game.i18n.localize("RIFTS.Errors.InvalidGrantedSkillsJSON"));
        }
      }, { signal });
    });
    root.querySelectorAll("[data-action='hth-progression-array']").forEach((field) => {
      field.addEventListener("change", async (event) => {
        const progressionKey = event.currentTarget.dataset.progressionKey;
        if (!["apmBonus", "strikeBonus", "parryBonus", "dodgeBonus", "autoDodgeLevel", "damageBonus"].includes(progressionKey)) return;

        const raw = String(event.currentTarget.value ?? "").trim();
        const normalized = normalizeProgressionArrayInput(raw);
        await this.document.update({ [`system.progression.${progressionKey}`]: normalized });
        event.currentTarget.value = normalized.join(", ");
      }, { signal });
    });

    root.querySelectorAll("[data-action='hth-selection-progression']").forEach((field) => {
      field.addEventListener("change", async (event) => {
        const progressionKey = String(event.currentTarget.dataset.progressionKey ?? "").trim();
        if (progressionKey !== "maneuvers") return;

        const raw = String(event.currentTarget.value ?? "").trim();
        const normalized = normalizeProgressionMapInput(raw);
        const currentSelectionFlags = this.document.getFlag?.(SYSTEM_ID, "selectionProgression");
        const nextSelectionFlags = (currentSelectionFlags && typeof currentSelectionFlags === "object" && !Array.isArray(currentSelectionFlags))
          ? foundry.utils.deepClone(currentSelectionFlags)
          : {};
        nextSelectionFlags.maneuvers = normalized;
        await this.document.setFlag(SYSTEM_ID, "selectionProgression", nextSelectionFlags);

        try {
          await this.document.update({ "system.selectionProgression.maneuvers": normalized });
        } catch (_primaryError) {
          // Flag storage is authoritative fallback for schema-mismatch worlds.
        }
        event.currentTarget.value = stringifyJson(normalized, {});
      }, { signal });
    });
    root.querySelectorAll("[data-action='hth-maneuver-package']").forEach((field) => {
      field.addEventListener("change", async (event) => {
        const raw = String(event.currentTarget.value ?? "").trim();
        if (!raw) {
          await this.document.update({ "system.maneuverPackage.grantedManeuvers": [] });
          return;
        }

        try {
          const normalized = normalizeHthManeuverPackageInput(raw);
          await this.document.update({ "system.maneuverPackage.grantedManeuvers": normalized });
          event.currentTarget.value = stringifyJson(normalized, []);
        } catch (_error) {
          ui.notifications.error(game.i18n.localize("RIFTS.Errors.InvalidManeuverPackageJSON"));
        }
      }, { signal });
    });
    root.querySelectorAll("[data-action='special-maneuver-tags']").forEach((field) => {
      field.addEventListener("change", async (event) => {
        const raw = String(event.currentTarget.value ?? "").trim();
        const tags = raw
          .split(/[;,]/)
          .map((entry) => String(entry ?? "").trim())
          .filter((entry, index, list) => entry.length > 0 && list.findIndex((value) => value.toLowerCase() === entry.toLowerCase()) === index);

        await this.document.update({ "system.tags": tags });
        event.currentTarget.value = tags.join(", ");
      }, { signal });
    });
    root.querySelectorAll("[data-action='augmentation-effects']").forEach((field) => {
      field.addEventListener("change", async (event) => {
        const raw = String(event.currentTarget.value ?? "").trim();

        try {
          const normalized = normalizeAugmentationEffectsInput(raw);
          await this.document.update({ "system.effects": normalized });
          event.currentTarget.value = stringifyJson(normalized, defaultAugmentationEffects());
        } catch (_error) {
          const fallback = normalizeAugmentationEffectsInput(this.document.system?.effects ?? defaultAugmentationEffects());
          await this.document.update({ "system.effects": fallback });
          event.currentTarget.value = stringifyJson(fallback, defaultAugmentationEffects());
          ui.notifications.error(game.i18n.localize("RIFTS.Errors.InvalidAugmentationEffectsJSON"));
        }
      }, { signal });
    });

    root.querySelectorAll("[data-action='augmentation-granted-abilities']").forEach((field) => {
      field.addEventListener("change", async (event) => {
        const raw = String(event.currentTarget.value ?? "").trim();

        try {
          const normalized = normalizeGrantedAbilitiesInput(raw);
          await this.document.update({ "system.grantedAbilities": normalized });
          event.currentTarget.value = stringifyJson(normalized, []);
        } catch (_error) {
          ui.notifications.error(game.i18n.localize("RIFTS.Errors.InvalidGrantedAbilitiesJSON"));
        }
      }, { signal });
    });
  }
}











