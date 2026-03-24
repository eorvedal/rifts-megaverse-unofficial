import {
  rollAttribute3d6,
  rollDodge,
  rollInitiative,
  rollParry,
  rollSkill,
  rollStrike
} from "../services/rolls.mjs";
import { attackWithUnarmedManeuver, attackWithWeapon } from "../services/combat.mjs";
import { activatePower, deactivatePower } from "../services/powers.mjs";
import { getActiveClass, getDerivedLevel, getProgressionData } from "../services/progression.mjs";
import {
  addManeuverFromActiveStyle,
  actorHasSpecialManeuver,
  getAvailableCombatManeuverContext,
  getAvailableManeuversFromActiveStyle,
  normalizeSpecialManeuverKey,
  useSpecialManeuver
} from "../services/maneuvers.mjs";
import {
  getArmorProtectionScale,
  getEffectiveActorScale,
  getEquippedArmor,
  getScaleLabelKey,
  hasValidVehicleMdc,
  normalizeScale
} from "../services/scale.mjs";
import {
  aggregatePhysicalSkillAutomation,
  defaultSkillEffects,
  hasSkillRollableEffects,
  getPhysicalSkillRollAdjustments,
  normalizeSkillRollableEffects,
  normalizeSkillEffects,
  resolveWeaponProficiencyBonuses
} from "../services/skill-automation.mjs";
import { normalizeHandToHandSpecialRuleId, HTH_SPECIAL_RULE_IDS } from "../services/hand-to-hand-rules.mjs";
import { effectHasStatus } from "../services/status-effects.mjs";

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value) {
  return value === true;
}

function parsePositiveLevel(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const lvl = Math.floor(n);
  return lvl > 0 ? lvl : null;
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeName(value) {
  return normalizeText(value).toLowerCase();
}

function actorHasControlEffect(actor, { source = "", statuses = [] } = {}) {
  const sourceKey = normalizeText(source);
  const statusIds = Array.isArray(statuses)
    ? statuses.map((entry) => normalizeText(entry)).filter((entry) => entry.length > 0)
    : [];

  return actor?.effects?.some?.((effect) => {
    if (sourceKey && foundry.utils.getProperty(effect, "flags.rifts-megaverse.source") === sourceKey) return true;
    return statusIds.some((statusId) => effectHasStatus(effect, statusId));
  }) === true;
}

function getCombatControlState(actor) {
  const grappled = actorHasControlEffect(actor, {
    source: "advancedGrapple",
    statuses: ["grappled", "restrained", "immobilized"]
  });
  const entangled = actorHasControlEffect(actor, {
    source: "maneuverEntangle",
    statuses: ["restrained", "immobilized"]
  });
  const held = actorHasControlEffect(actor, {
    source: "maneuverHolds",
    statuses: ["restrained", "immobilized"]
  });
  const restrained = grappled || entangled || held;
  return {
    grappled,
    entangled,
    held,
    restrained,
    movementBlocked: restrained,
    dodgeBlocked: restrained
  };
}

function normalizeSizeCategory(value, fallback = "human") {
  const normalized = normalizeText(value).toLowerCase();
  if (["small", "human", "large", "giant"].includes(normalized)) return normalized;
  return fallback;
}

function ensurePool(root, key, defaultValue = 0, defaultMax = defaultValue) {
  root[key] ??= {};
  root[key].value = num(root[key].value, defaultValue);
  root[key].max = num(root[key].max, defaultMax);
}

function getWeaponBonus(item) {
  return num(item?.system?.weapon?.bonusStrike, num(item?.system?.bonusStrike, 0));
}

function getArmorAr(item) {
  return num(item?.system?.armor?.ar, num(item?.system?.ar, 0));
}

function getArmorPool(item, poolKey) {
  const nested = item?.system?.armor?.[poolKey];
  if (nested && typeof nested === "object") {
    const value = num(nested.value, 0);
    const max = num(nested.max, value);
    return { value, max };
  }

  const flat = item?.system?.[poolKey];
  if (flat && typeof flat === "object") {
    const value = num(flat.value, 0);
    const max = num(flat.max, value);
    return { value, max };
  }

  return { value: 0, max: 0 };
}

function getPowerArmorMountedWeapons(actor, armorId) {
  const linkedArmorId = normalizeText(armorId);
  if (!linkedArmorId) return [];

  return actor.items
    .filter((item) => item.type === "weapon")
    .filter((item) => item.system?.weapon?.isMounted === true)
    .filter((item) => normalizeText(item.system?.weapon?.linkedArmorId) === linkedArmorId)
    .map((item) => ({
      id: item.id,
      name: item.name,
      damage: item.system?.weapon?.damage ?? item.system?.damage ?? "1d6",
      isMegaDamage: item.system?.weapon?.isMegaDamage === true,
      mountName: normalizeText(item.system?.weapon?.mountName),
      linkedArmorId: normalizeText(item.system?.weapon?.linkedArmorId),
      requiresPowerArmor: item.system?.weapon?.requiresPowerArmor === true,
      equipped: item.system?.equipped === true,
      active: item.system?.active === true
    }));
}

function getClassItems(actor) {
  return actor.items.filter((item) => item.type === "occ" || item.type === "rcc");
}

function getActiveClassItem(actor) {
  return getActiveClass(actor);
}

function resolveActiveClassByType(actor, classType) {
  const normalizedType = normalizeName(classType);
  if (!normalizedType) return null;

  const classItems = getClassItems(actor)
    .filter((item) => normalizeName(item.type) === normalizedType);
  if (classItems.length <= 0) return null;

  const active = classItems.find((item) => item.system?.active === true);
  if (active) return active;

  const primary = classItems.find((item) => item.system?.isPrimaryClass === true);
  if (primary) return primary;

  return classItems[0] ?? null;
}

function getHandToHandItems(actor) {
  return actor.items.filter((item) => item.type === "handToHand");
}

function resolveActiveHandToHand(actor) {
  const styles = getHandToHandItems(actor);
  if (styles.length <= 0) return null;

  const active = styles.find((item) => item.system?.active === true);
  return active ?? styles[0] ?? null;
}

function getActiveHandToHand(actor) {
  return resolveActiveHandToHand(actor);
}

function getClassCombatBonuses(classItem) {
  return {
    strike: num(classItem?.system?.bonuses?.combat?.strike, 0),
    parry: num(classItem?.system?.bonuses?.combat?.parry, 0),
    dodge: num(classItem?.system?.bonuses?.combat?.dodge, 0),
    initiative: num(classItem?.system?.bonuses?.combat?.initiative, 0)
  };
}

function parseProgressionData(rawProgression) {
  if (!rawProgression) return null;
  if (typeof rawProgression === "string") {
    try {
      return JSON.parse(rawProgression);
    } catch (_error) {
      return null;
    }
  }
  return rawProgression;
}

function parseNumericProgressionInput(rawProgression) {
  if (Array.isArray(rawProgression)) return rawProgression;

  if (typeof rawProgression === "string") {
    const trimmed = rawProgression.trim();
    if (!trimmed) return [];

    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) || (parsed && typeof parsed === "object")) return parsed;
    } catch (_error) {
      return trimmed
        .split(/[\n,;]/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    }

    return [];
  }

  if (rawProgression && typeof rawProgression === "object") return rawProgression;
  return [];
}

function normalizeNumericProgressionArray(rawProgression) {
  const parsed = parseNumericProgressionInput(rawProgression);

  if (Array.isArray(parsed)) {
    return parsed.map((entry) => num(entry, NaN));
  }

  if (parsed && typeof parsed === "object") {
    const values = [];
    for (const [thresholdKey, value] of Object.entries(parsed)) {
      const threshold = parsePositiveLevel(thresholdKey);
      if (!threshold) continue;
      values[threshold - 1] = num(value, NaN);
    }
    return values;
  }

  return [];
}

function getNumericProgressionValueAtLevel(rawProgression, level, fallback = 0) {
  const values = normalizeNumericProgressionArray(rawProgression);
  if (values.length <= 0) return num(fallback, 0);

  const index = Math.max(0, Math.floor(num(level, 1)) - 1);
  const exact = values[index];
  if (Number.isFinite(exact)) return num(exact, num(fallback, 0));

  for (let i = Math.min(index, values.length - 1); i >= 0; i -= 1) {
    if (Number.isFinite(values[i])) return num(values[i], num(fallback, 0));
  }

  return num(fallback, 0);
}

function getAutoDodgeUnlockLevel(rawProgression, level) {
  const directLevel = parsePositiveLevel(rawProgression);
  if (directLevel) return directLevel;

  if (typeof rawProgression === "string") {
    const trimmed = rawProgression.trim();
    const directTextLevel = parsePositiveLevel(trimmed);
    if (directTextLevel) return directTextLevel;
  }

  const current = Math.max(0, Math.floor(getNumericProgressionValueAtLevel(rawProgression, level, 0)));
  if (current > 0) return current;

  const values = normalizeNumericProgressionArray(rawProgression);
  for (const entry of values) {
    const candidate = Math.max(0, Math.floor(num(entry, 0)));
    if (candidate > 0) return candidate;
  }

  return 0;
}

function getHandToHandBonuses(handToHandItem, level) {
  if (!handToHandItem) {
    return {
      apmBonus: 0,
      initiativeBonus: 0,
      disarmBonus: 0,
      entangleBonus: 0,
      strikeBonus: 0,
      parryBonus: 0,
      dodgeBonus: 0,
      damageBonus: 0,
      autoDodgeLevel: 0,
      autoDodgeAvailable: false
    };
  }

  const progression = handToHandItem.system?.progression ?? {};
  const apmBonus = Math.floor(num(getNumericProgressionValueAtLevel(progression.apmBonus, level, 0), 0));
  const initiativeBonus = Math.floor(num(getNumericProgressionValueAtLevel(progression.initiativeBonus, level, 0), 0));
  const disarmBonus = Math.floor(num(getNumericProgressionValueAtLevel(progression.disarmBonus, level, 0), 0));
  const entangleBonus = Math.floor(num(getNumericProgressionValueAtLevel(progression.entangleBonus, level, 0), 0));
  const strikeBonus = Math.floor(num(getNumericProgressionValueAtLevel(progression.strikeBonus, level, 0), 0));
  const parryBonus = Math.floor(num(getNumericProgressionValueAtLevel(progression.parryBonus, level, 0), 0));
  const dodgeBonus = Math.floor(num(getNumericProgressionValueAtLevel(progression.dodgeBonus, level, 0), 0));
  const damageBonus = Math.floor(num(getNumericProgressionValueAtLevel(progression.damageBonus, level, 0), 0));
  const autoDodgeLevel = getAutoDodgeUnlockLevel(progression.autoDodgeLevel, level);

  return {
    apmBonus,
    initiativeBonus,
    disarmBonus,
    entangleBonus,
    strikeBonus,
    parryBonus,
    dodgeBonus,
    damageBonus,
    autoDodgeLevel,
    autoDodgeAvailable: autoDodgeLevel > 0 && level >= autoDodgeLevel
  };
}

function getDefaultHandToHandSpecialRules() {
  return {
    kickAttack: false,
    critRange19: false,
    critRange18: false,
    critRange17: false,
    knockoutStun18: false,
    knockoutStun17: false,
    deathBlow20: false,
    deathBlow19: false,
    bodyThrow: false,
    pullRollBonus: false,
    critRange: 20,
    knockoutStunRange: 0,
    deathBlowRange: 0,
    pullRollBonusValue: 0,
    unlocked: []
  };
}

function normalizeHandToHandSpecialRulesList(rawRules) {
  const source = Array.isArray(rawRules) ? rawRules : [rawRules];
  const normalized = [];

  for (const entry of source) {
    const candidate = entry && typeof entry === "object" && !Array.isArray(entry)
      ? (entry.rule ?? entry.id ?? entry.key ?? entry.name)
      : entry;
    const ruleId = normalizeHandToHandSpecialRuleId(candidate);
    if (!ruleId) continue;
    if (normalized.includes(ruleId)) continue;
    normalized.push(ruleId);
  }

  return normalized;
}

function normalizeHandToHandSpecialRulesProgression(rawProgression) {
  const parsed = parseProgressionData(rawProgression);
  const out = {};

  if (!parsed) return out;

  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const level = parsePositiveLevel(entry.level ?? entry.atLevel ?? entry.lvl ?? entry.threshold);
      if (!level) continue;

      const ruleList = normalizeHandToHandSpecialRulesList(
        entry.rules ?? entry.ruleIds ?? entry.rule ?? entry.id ?? entry.key
      );
      if (ruleList.length <= 0) continue;
      out[String(level)] = ruleList;
    }

    return out;
  }

  if (parsed && typeof parsed === "object") {
    for (const [levelKey, rawRules] of Object.entries(parsed)) {
      const level = parsePositiveLevel(levelKey);
      if (!level) continue;
      const ruleList = normalizeHandToHandSpecialRulesList(rawRules);
      if (ruleList.length <= 0) continue;
      out[String(level)] = ruleList;
    }
  }

  return out;
}

function getUnlockedHandToHandSpecialRuleIds(rawProgression, level) {
  const normalized = normalizeHandToHandSpecialRulesProgression(rawProgression);
  const actorLevel = Math.max(1, Math.floor(num(level, 1)));
  const unlocked = [];

  const sortedLevels = Object.keys(normalized)
    .map((key) => parsePositiveLevel(key))
    .filter((entry) => Number.isFinite(entry) && entry > 0)
    .sort((a, b) => a - b);

  for (const unlockLevel of sortedLevels) {
    if (unlockLevel > actorLevel) continue;
    for (const ruleId of normalized[String(unlockLevel)] ?? []) {
      if (!HTH_SPECIAL_RULE_IDS.includes(ruleId)) continue;
      if (unlocked.includes(ruleId)) continue;
      unlocked.push(ruleId);
    }
  }

  return unlocked;
}

function getHandToHandSpecialRules(handToHandItem, level) {
  const rules = getDefaultHandToHandSpecialRules();
  if (!handToHandItem) return rules;

  const progression = handToHandItem.system?.specialRulesProgression ?? {};
  const unlocked = getUnlockedHandToHandSpecialRuleIds(progression, level);

  for (const ruleId of unlocked) {
    if (Object.prototype.hasOwnProperty.call(rules, ruleId)) {
      rules[ruleId] = true;
    }
  }

  rules.critRange = rules.critRange17 ? 17 : (rules.critRange18 ? 18 : (rules.critRange19 ? 19 : 20));
  rules.knockoutStunRange = rules.knockoutStun17 ? 17 : (rules.knockoutStun18 ? 18 : 0);
  rules.deathBlowRange = rules.deathBlow19 ? 19 : (rules.deathBlow20 ? 20 : 0);
  rules.pullRollBonusValue = rules.pullRollBonus ? 2 : 0;
  rules.unlocked = unlocked;

  return rules;
}
function getAttacksPerMeleeProgressionBonus(rawProgression, actorLevel) {
  const progression = parseProgressionData(rawProgression);
  if (!progression) return 0;

  let total = 0;

  // Supported shapes:
  // - Object mapping level thresholds to additive bonuses, e.g. { "3": 1, "7": 1 }
  // - Array entries as {level, bonus}, [level, bonus], or numeric values (index+1 threshold)
  if (Array.isArray(progression)) {
    for (let i = 0; i < progression.length; i += 1) {
      const entry = progression[i];

      if (typeof entry === "number") {
        const threshold = i + 1;
        if (actorLevel >= threshold) total += num(entry, 0);
        continue;
      }

      if (Array.isArray(entry)) {
        const threshold = parsePositiveLevel(entry[0]);
        const bonus = num(entry[1], 0);
        if (threshold && actorLevel >= threshold) total += bonus;
        continue;
      }

      if (entry && typeof entry === "object") {
        const threshold = parsePositiveLevel(entry.level ?? entry.lvl ?? entry.threshold);
        const bonus = num(entry.bonus ?? entry.value, 0);
        if (threshold && actorLevel >= threshold) total += bonus;
      }
    }

    return total;
  }

  if (typeof progression === "object") {
    for (const [thresholdKey, value] of Object.entries(progression)) {
      const threshold = parsePositiveLevel(thresholdKey);
      if (!threshold || actorLevel < threshold) continue;

      if (typeof value === "number") {
        total += num(value, 0);
      } else if (value && typeof value === "object") {
        total += num(value.bonus ?? value.value, 0);
      }
    }
  }

  return total;
}

function readObjectBonusCaseInsensitive(obj, key) {
  if (!obj || typeof obj !== "object") return 0;
  const normalizedKey = normalizeName(key);
  if (!normalizedKey) return 0;

  for (const [entryKey, entryValue] of Object.entries(obj)) {
    if (normalizeName(entryKey) === normalizedKey) {
      return num(entryValue, 0);
    }
  }

  return 0;
}

function getClassSkillBonus(classItem, skill) {
  const skillBonuses = classItem?.system?.bonuses?.skills;
  if (!skillBonuses) return 0;

  let total = 0;

  if (typeof skillBonuses === "number" || typeof skillBonuses === "string") {
    return num(skillBonuses, 0);
  }

  const skillName = normalizeText(skill?.name);
  const skillCategory = normalizeText(skill?.system?.category);

  total += num(skillBonuses.all, 0);

  if (skill?.system?.isOCCSkill) {
    total += num(skillBonuses.occSkills, num(skillBonuses.occSkill, 0));
  }

  if (skill?.system?.isRelatedSkill) {
    total += num(skillBonuses.relatedSkills, num(skillBonuses.relatedSkill, 0));
  }

  if (skill?.system?.isSecondarySkill) {
    total += num(skillBonuses.secondarySkills, num(skillBonuses.secondarySkill, 0));
  }

  total += readObjectBonusCaseInsensitive(skillBonuses.byName, skillName);
  total += readObjectBonusCaseInsensitive(skillBonuses.byCategory, skillCategory);

  // Flexible fallback for flat map structures.
  total += readObjectBonusCaseInsensitive(skillBonuses, skillName);
  total += readObjectBonusCaseInsensitive(skillBonuses, skillCategory);

  return total;
}

function normalizeSkillPackageEntry(rawEntry) {
  if (typeof rawEntry === "string") {
    return {
      name: normalizeText(rawEntry),
      category: "",
      base: 0,
      perLevel: 0,
      modifier: 0,
      notes: ""
    };
  }

  const entry = rawEntry && typeof rawEntry === "object" ? rawEntry : {};
  return {
    name: normalizeText(entry.name),
    category: normalizeText(entry.category),
    base: num(entry.base, 0),
    perLevel: num(entry.perLevel, 0),
    modifier: num(entry.modifier, 0),
    notes: normalizeText(entry.notes)
  };
}

function normalizeSkillPackageList(rawList) {
  let parsed = rawList;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch (_error) {
      parsed = [];
    }
  }

  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((entry) => normalizeSkillPackageEntry(entry))
    .filter((entry) => entry.name.length > 0);
}

function getClassSkillPackage(classItem) {
  const packageData = classItem?.system?.skillPackage ?? {};
  return {
    occSkills: normalizeSkillPackageList(packageData.occSkills),
    relatedSkills: normalizeSkillPackageList(packageData.relatedSkills),
    secondarySkills: normalizeSkillPackageList(packageData.secondarySkills)
  };
}

const OCC_ATTRIBUTE_KEYS = ["iq", "me", "ma", "ps", "pp", "pe", "pb", "spd"];
const OCC_RESOURCE_KEYS = ["hp", "sdc", "isp", "ppe"];
function normalizeRollableValue(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }

  const textValue = normalizeText(value);
  if (!textValue) return Math.max(0, Math.floor(num(fallback, 0)));

  const numeric = Number(textValue);
  if (Number.isFinite(numeric)) return Math.max(0, Math.floor(numeric));

  return textValue;
}
async function resolveRollableValue(rawValue, { fallback = 0, rollData = null } = {}) {
  const normalized = normalizeRollableValue(rawValue, fallback);
  if (typeof normalized === "number") {
    return {
      mode: "static",
      raw: normalized,
      formula: "",
      value: normalized,
      roll: null
    };
  }

  const formula = normalizeText(normalized);
  if (!formula) {
    return {
      mode: "empty",
      raw: "",
      formula: "",
      value: Math.max(0, Math.floor(num(fallback, 0))),
      roll: null
    };
  }

  try {
    const roll = await (new Roll(formula, rollData ?? {})).evaluate();
    const value = Math.max(0, Math.floor(num(roll.total, 0)));
    return {
      mode: "roll",
      raw: formula,
      formula,
      value,
      roll
    };
  } catch (_error) {
    return {
      mode: "invalid",
      raw: formula,
      formula,
      value: Math.max(0, Math.floor(num(fallback, 0))),
      roll: null
    };
  }
}
function isBlankClassValue(value) {
  if (value === null || value === undefined) return true;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return true;
    return value === 0;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return true;

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric === 0) return true;

    return false;
  }

  return false;
}

function getDefaultOccStartingSdcFormula(classItem) {
  const category = normalizeName(classItem?.system?.category);

  if ((classItem?.type === "rcc" && category.includes("psychic")) || category.includes("psychic rcc")) {
    return "3d6";
  }

  if (
    category.includes("men of arms")
    || category.includes("man of arms")
    || category.includes("man-at-arms")
    || category.includes("men-at-arms")
  ) {
    return "1d4*10";
  }

  if (
    category.includes("practitioner of magic")
    || category.includes("practitioners of magic")
    || category.includes("scholar")
    || category.includes("adventurer")
  ) {
    return "4d6";
  }

  return "4d6";
}

function getOccStartingResourceInput(classItem, actor, key, normalizedValue, resourceProgression = {}) {
  const rawValue = classItem?.system?.startingResources?.[key];
  if (!isBlankClassValue(rawValue)) return normalizedValue;

  if (key === "hp") {
    const peBase = Math.max(0, Math.floor(num(actor?.system?.attributes?.pe?.value, 0)));
    const hpPerLevel = normalizeText(resourceProgression?.hpPerLevel) || "1d6";
    return `${peBase} + (${hpPerLevel})`;
  }

  if (key === "sdc") {
    return getDefaultOccStartingSdcFormula(classItem);
  }

  return normalizedValue;
}

function normalizeOCCAttributeRequirementValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : null;
}
function normalizeOCCAttributeRequirements(rawRequirements) {
  const source = rawRequirements && typeof rawRequirements === "object" && !Array.isArray(rawRequirements)
    ? rawRequirements
    : {};
  const out = {};
  for (const key of OCC_ATTRIBUTE_KEYS) {
    out[key] = normalizeOCCAttributeRequirementValue(source[key]);
  }
  return out;
}
function normalizeLevelProgressionMap(rawMap) {
  const result = {};

  if (Array.isArray(rawMap)) {
    for (let idx = 0; idx < rawMap.length; idx += 1) {
      const value = Math.floor(num(rawMap[idx], 0));
      if (!Number.isFinite(value) || value === 0) continue;
      result[String(idx + 1)] = value;
    }
    return result;
  }

  if (!rawMap || typeof rawMap !== "object") return result;

  for (const [rawLevel, rawValue] of Object.entries(rawMap)) {
    const level = Math.floor(num(rawLevel, 0));
    const value = Math.floor(num(rawValue, 0));
    if (!Number.isFinite(level) || level <= 0) continue;
    if (!Number.isFinite(value) || value === 0) continue;
    result[String(level)] = value;
  }

  return result;
}
function normalizeOCCSkillSelection(rawSelection) {
  const source = rawSelection && typeof rawSelection === "object" && !Array.isArray(rawSelection)
    ? rawSelection
    : {};
  return {
    occ: Math.max(0, Math.floor(num(source.occ, 0))),
    related: Math.max(0, Math.floor(num(source.related, 0))),
    secondary: Math.max(0, Math.floor(num(source.secondary, 0))),
    occProgression: normalizeLevelProgressionMap(source.occProgression),
    relatedProgression: normalizeLevelProgressionMap(source.relatedProgression),
    secondaryProgression: normalizeLevelProgressionMap(source.secondaryProgression)
  };
}
function normalizeOCCStartingResources(rawResources) {
  const source = rawResources && typeof rawResources === "object" && !Array.isArray(rawResources)
    ? rawResources
    : {};
  return {
    hp: normalizeRollableValue(source.hp, 0),
    sdc: normalizeRollableValue(source.sdc, 0),
    isp: normalizeRollableValue(source.isp, 0),
    ppe: normalizeRollableValue(source.ppe, 0)
  };
}
function normalizeOCCResourceProgression(rawProgression) {
  const source = rawProgression && typeof rawProgression === "object" && !Array.isArray(rawProgression)
    ? rawProgression
    : {};
  return {
    hpPerLevel: normalizeText(source.hpPerLevel || "1d6") || "1d6",
    sdcPerLevel: normalizeText(source.sdcPerLevel || "1d6") || "1d6",
    ispPerLevel: normalizeText(source.ispPerLevel),
    ppePerLevel: normalizeText(source.ppePerLevel)
  };
}
function parseSimpleArrayInput(rawValue) {
  if (Array.isArray(rawValue)) return foundry.utils.deepClone(rawValue);
  if (typeof rawValue === "string") {
    const trimmed = rawValue.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_error) {
      return [];
    }
  }
  return [];
}
function normalizeOCCStartingPowers(rawStartingPowers) {
  const source = rawStartingPowers && typeof rawStartingPowers === "object" && !Array.isArray(rawStartingPowers)
    ? rawStartingPowers
    : {};
  return {
    spells: parseSimpleArrayInput(source.spells),
    psionics: parseSimpleArrayInput(source.psionics)
  };
}
function normalizeOCCPowerProgression(rawProgression) {
  const source = rawProgression && typeof rawProgression === "object" && !Array.isArray(rawProgression)
    ? rawProgression
    : {};

  const spellProgression = normalizeLevelProgressionMap(
    source.spellProgression ?? source.spellsProgression ?? source.spellsPerLevelMap
  );
  const psionicProgression = normalizeLevelProgressionMap(
    source.psionicProgression ?? source.psionicsProgression ?? source.psionicsPerLevelMap
  );

  // Backward compatibility for older flat "per level" fields.
  if (Object.keys(spellProgression).length <= 0) {
    const legacySpellsPerLevel = Math.max(0, Math.floor(num(source.spellsPerLevel, 0)));
    if (legacySpellsPerLevel > 0) spellProgression["1"] = legacySpellsPerLevel;
  }

  if (Object.keys(psionicProgression).length <= 0) {
    const legacyPsionicsPerLevel = Math.max(0, Math.floor(num(source.psionicsPerLevel, 0)));
    if (legacyPsionicsPerLevel > 0) psionicProgression["1"] = legacyPsionicsPerLevel;
  }

  return {
    spellProgression,
    psionicProgression
  };
}
function normalizeOCCStartingCredits(rawCredits) {
  const source = rawCredits && typeof rawCredits === "object" && !Array.isArray(rawCredits)
    ? rawCredits
    : {};
  return {
    credits: normalizeRollableValue(source.credits, 0)
  };
}
function evaluateOCCRequirements(actorAttributes, requirements) {
  const attrs = actorAttributes && typeof actorAttributes === "object" ? actorAttributes : {};
  const unmet = [];
  for (const key of OCC_ATTRIBUTE_KEYS) {
    const required = normalizeOCCAttributeRequirementValue(requirements[key]);
    if (!required) continue;
    const actual = Math.floor(num(attrs?.[key]?.value, 0));
    if (actual >= required) continue;
    unmet.push({
      key,
      required,
      actual
    });
  }
  const summary = unmet
    .map((entry) => entry.key.toUpperCase() + " " + entry.actual + "/" + entry.required)
    .join(", ");
  return {
    met: unmet.length <= 0,
    unmet,
    summary
  };
}
function getOCCMechanicalData(classItem, actorAttributes = {}) {
  const requirements = normalizeOCCAttributeRequirements(classItem?.system?.attributeRequirements);
  const skillSelection = normalizeOCCSkillSelection(classItem?.system?.skillSelection);
  const startingResources = normalizeOCCStartingResources(classItem?.system?.startingResources);
  const resourceProgression = normalizeOCCResourceProgression(classItem?.system?.resourceProgression);
  const startingPowers = normalizeOCCStartingPowers(classItem?.system?.startingPowers);
  const powerProgression = normalizeOCCPowerProgression(classItem?.system?.powerProgression);
  const startingCredits = normalizeOCCStartingCredits(classItem?.system?.startingCredits);
  const requirementState = evaluateOCCRequirements(actorAttributes, requirements);
  return {
    requirements,
    requirementsMet: requirementState.met,
    requirementsUnmet: requirementState.unmet,
    requirementsSummary: requirementState.summary,
    skillSelection,
    startingResources,
    resourceProgression,
    startingPowers,
    powerProgression,
    startingCredits
  };
}
function hasDefaultCharacterResourceState(resources) {
  const defaults = {
    hp: 10,
    sdc: 10,
    isp: 0,
    ppe: 0
  };
  for (const key of Object.keys(defaults)) {
    const pool = resources?.[key];
    if (!pool || typeof pool !== "object") return false;
    const expected = defaults[key];
    const currentValue = Math.floor(num(pool.value, expected));
    const currentMax = Math.floor(num(pool.max, expected));
    if (currentValue !== expected || currentMax !== expected) return false;
  }
  return true;
}
function resolveClassSkillType(skillType) {
  const normalized = normalizeName(skillType);
  if (["occ", "occskill", "occskills"].includes(normalized)) {
    return {
      key: "occSkills",
      sourceLabel: "occ"
    };
  }

  if (["related", "relatedskill", "relatedskills"].includes(normalized)) {
    return {
      key: "relatedSkills",
      sourceLabel: "related"
    };
  }

  if (["secondary", "secondaryskill", "secondaryskills"].includes(normalized)) {
    return {
      key: "secondarySkills",
      sourceLabel: "secondary"
    };
  }

  return null;
}

function getMountedWeaponSummaries(actor) {
  return actor.items
    .filter((item) => item.type === "weapon")
    .map((item) => {
      const isMounted = item.system?.weapon?.isMounted === true || actor.type === "vehicle";
      return {
        id: item.id,
        name: item.name,
        damage: item.system?.weapon?.damage ?? item.system?.damage ?? "1d6",
        isMegaDamage: item.system?.weapon?.isMegaDamage === true,
        mountName: normalizeText(item.system?.weapon?.mountName),
        isMounted,
        linkedToVehicle: item.system?.weapon?.linkedToVehicle === true,
        linkedArmorId: normalizeText(item.system?.weapon?.linkedArmorId),
        requiresPowerArmor: item.system?.weapon?.requiresPowerArmor === true,
        requiresCrew: Math.max(1, num(item.system?.weapon?.requiresCrew, 1)),
        equipped: item.system?.equipped === true,
        active: item.system?.active === true
      };
    });
}

const AUGMENT_ATTRIBUTE_KEYS = ["iq", "me", "ma", "ps", "pp", "pe", "pb", "spd"];
const AUGMENT_COMBAT_KEYS = ["strike", "parry", "dodge", "initiative", "apm"];
const AUGMENT_RESOURCE_KEYS = ["hp", "sdc", "mdc", "ppe", "isp"];

function createAugmentationTotals(keys) {
  const out = {};
  for (const key of keys) out[key] = 0;
  return out;
}

function parseGrantedAbilityEntries(raw) {
  let entries = raw;
  if (typeof entries === "string") {
    try {
      entries = JSON.parse(entries);
    } catch (_error) {
      entries = [];
    }
  }

  if (!Array.isArray(entries)) return [];

  return entries
    .map((entry) => {
      if (typeof entry === "string") {
        const name = normalizeText(entry);
        if (!name) return null;
        return {
          name,
          key: normalizeName(name),
          type: "ability",
          notes: ""
        };
      }

      if (!entry || typeof entry !== "object") return null;
      const name = normalizeText(entry.name || entry.label || entry.title || entry.key);
      const key = normalizeName(entry.key || name);
      if (!name && !key) return null;

      return {
        name: name || key,
        key,
        type: normalizeText(entry.type || "ability") || "ability",
        notes: normalizeText(entry.notes),
        data: entry.data && typeof entry.data === "object" ? foundry.utils.deepClone(entry.data) : {}
      };
    })
    .filter((entry) => entry !== null);
}

function parseGrantedSkillEntries(raw) {
  let entries = raw;
  if (typeof entries === "string") {
    try {
      entries = JSON.parse(entries);
    } catch (_error) {
      entries = [];
    }
  }

  if (!Array.isArray(entries)) return [];

  return entries
    .map((entry) => {
      if (typeof entry === "string") {
        const name = normalizeText(entry);
        if (!name) return null;
        return {
          name,
          key: normalizeName(name),
          category: "",
          base: 0,
          perLevel: 0,
          modifier: 0,
          isOCCSkill: false,
          isRelatedSkill: false,
          isSecondarySkill: false,
          notes: ""
        };
      }

      if (!entry || typeof entry !== "object") return null;
      const name = normalizeText(entry.name || entry.label || entry.title || entry.key);
      const key = normalizeName(entry.key || name);
      if (!name && !key) return null;

      return {
        name: name || key,
        key,
        category: normalizeText(entry.category),
        base: num(entry.base, 0),
        perLevel: num(entry.perLevel, 0),
        modifier: num(entry.modifier, 0),
        isOCCSkill: bool(entry.isOCCSkill),
        isRelatedSkill: bool(entry.isRelatedSkill),
        isSecondarySkill: bool(entry.isSecondarySkill),
        notes: normalizeText(entry.notes)
      };
    })
    .filter((entry) => entry !== null);
}

const OCC_STARTING_PACKAGE_KEYS = ["bionics", "cybernetics", "abilities", "gear"];

function resolveAugmentationPackageItemType(packageType) {
  const normalized = normalizeName(packageType);
  if (["bionic", "bionics"].includes(normalized)) return "bionic";
  if (["cybernetic", "cybernetics"].includes(normalized)) return "cybernetic";
  return "";
}

function normalizeStartingPackageEntries(raw) {
  let entries = raw;
  if (typeof entries === "string") {
    try {
      entries = JSON.parse(entries);
    } catch (_error) {
      entries = [];
    }
  }

  if (!Array.isArray(entries)) return [];

  return entries
    .map((entry) => {
      if (typeof entry === "string") {
        const name = normalizeText(entry);
        if (!name) return null;
        return {
          name,
          slot: "",
          notes: "",
          installed: false,
          effects: normalizeSharedEffects({}),
          grantedAbilities: [],
          img: ""
        };
      }

      if (!entry || typeof entry !== "object") return null;
      const name = normalizeText(entry.name || entry.label || entry.title || entry.itemName || entry.key);
      if (!name) return null;

      const rawEffects = entry.effects ?? entry.system?.effects ?? {};
      const rawGranted = entry.grantedAbilities ?? entry.system?.grantedAbilities ?? [];
      const grantedAbilities = parseGrantedAbilityEntries(rawGranted);

      return {
        name,
        slot: normalizeText(entry.slot || entry.system?.slot),
        notes: normalizeText(entry.notes || entry.system?.notes),
        installed: bool(entry.installed ?? entry.system?.installed),
        effects: normalizeSharedEffects(rawEffects),
        grantedAbilities,
        img: normalizeText(entry.img || entry.image || entry.system?.img)
      };
    })
    .filter((entry) => entry !== null);
}

function getClassStartingPackage(classItem) {
  const startingPackages = classItem?.system?.startingPackages ?? {};
  const normalized = {
    bionics: [],
    cybernetics: [],
    abilities: [],
    gear: []
  };

  for (const packageKey of OCC_STARTING_PACKAGE_KEYS) {
    const rawValue = startingPackages?.[packageKey];
    if (packageKey === "bionics" || packageKey === "cybernetics") {
      normalized[packageKey] = normalizeStartingPackageEntries(rawValue);
    } else {
      normalized[packageKey] = Array.isArray(rawValue) ? foundry.utils.deepClone(rawValue) : [];
    }
  }

  return normalized;
}

function findOccAugmentationDuplicate(actor, occItem, itemType, itemName) {
  const normalizedName = normalizeName(itemName);
  if (!normalizedName) return null;

  return actor.items.find((item) => {
    if (item.type !== itemType) return false;
    if (normalizeName(item.name) !== normalizedName) return false;

    const sourceType = normalizeName(item.system?.sourceType);
    const sourceId = normalizeText(item.system?.sourceId);
    if (sourceType === "occ" && sourceId === occItem.id) return true;

    return true;
  }) ?? null;
}

function getOccStartingAugmentationPackageSuggestions(actor, occItem = null) {
  const activeOcc = occItem ?? resolveActiveClassByType(actor, "occ");
  if (!activeOcc) {
    return {
      activeOcc: null,
      sourceType: "",
      sourceId: "",
      bionics: [],
      cybernetics: [],
      abilities: [],
      gear: []
    };
  }

  const pkg = getClassStartingPackage(activeOcc);

  const bionics = pkg.bionics.map((entry, index) => {
    const duplicate = findOccAugmentationDuplicate(actor, activeOcc, "bionic", entry.name);
    return {
      ...entry,
      packageType: "bionics",
      packageIndex: index,
      itemType: "bionic",
      duplicate,
      isAdded: Boolean(duplicate)
    };
  });

  const cybernetics = pkg.cybernetics.map((entry, index) => {
    const duplicate = findOccAugmentationDuplicate(actor, activeOcc, "cybernetic", entry.name);
    return {
      ...entry,
      packageType: "cybernetics",
      packageIndex: index,
      itemType: "cybernetic",
      duplicate,
      isAdded: Boolean(duplicate)
    };
  });

  return {
    activeOcc,
    sourceType: "occ",
    sourceId: activeOcc.id,
    bionics,
    cybernetics,
    abilities: pkg.abilities,
    gear: pkg.gear
  };
}
function normalizeSharedEffects(rawEffects) {
  const effects = rawEffects && typeof rawEffects === "object" && !Array.isArray(rawEffects)
    ? rawEffects
    : {};

  const normalized = {
    attributes: createAugmentationTotals(AUGMENT_ATTRIBUTE_KEYS),
    combat: createAugmentationTotals(AUGMENT_COMBAT_KEYS),
    resources: createAugmentationTotals(AUGMENT_RESOURCE_KEYS),
    flags: {}
  };

  for (const key of AUGMENT_ATTRIBUTE_KEYS) {
    normalized.attributes[key] = num(effects?.attributes?.[key], 0);
  }

  for (const key of AUGMENT_COMBAT_KEYS) {
    normalized.combat[key] = num(effects?.combat?.[key], 0);
  }

  for (const key of AUGMENT_RESOURCE_KEYS) {
    normalized.resources[key] = num(effects?.resources?.[key], 0);
  }

  for (const [flagKey, rawEnabled] of Object.entries(effects?.flags ?? {})) {
    const normalizedFlag = normalizeText(flagKey);
    if (!normalizedFlag) continue;
    const enabled = rawEnabled === true || normalizeName(rawEnabled) === "true" || num(rawEnabled, 0) > 0;
    if (enabled) normalized.flags[normalizedFlag] = true;
  }

  return normalized;
}

function resolveClassCombatBonusValue(classItem, key) {
  const combatEffects = classItem?.system?.effects?.combat;
  const hasEffectValue = combatEffects && typeof combatEffects === "object" && !Array.isArray(combatEffects)
    && Object.prototype.hasOwnProperty.call(combatEffects, key);

  if (hasEffectValue) return num(combatEffects[key], 0);
  return num(classItem?.system?.bonuses?.combat?.[key], 0);
}

function aggregateClassPassiveEffects(classItems) {
  const attributes = createAugmentationTotals(AUGMENT_ATTRIBUTE_KEYS);
  const combat = createAugmentationTotals(AUGMENT_COMBAT_KEYS);
  const resources = createAugmentationTotals(AUGMENT_RESOURCE_KEYS);
  const flags = {};
  const grantedAbilities = [];
  const grantedSkills = [];
  const abilityKeys = new Set();
  const skillKeys = new Set();

  const items = (Array.isArray(classItems) ? classItems : [])
    .filter((item) => item && (item.type === "occ" || item.type === "rcc"));

  for (const item of items) {
    const effects = normalizeSharedEffects(item.system?.effects);

    for (const key of AUGMENT_ATTRIBUTE_KEYS) {
      attributes[key] += num(effects.attributes?.[key], 0);
    }

    combat.strike += resolveClassCombatBonusValue(item, "strike");
    combat.parry += resolveClassCombatBonusValue(item, "parry");
    combat.dodge += resolveClassCombatBonusValue(item, "dodge");
    combat.initiative += resolveClassCombatBonusValue(item, "initiative");
    combat.apm += num(effects.combat?.apm, 0);

    for (const key of AUGMENT_RESOURCE_KEYS) {
      resources[key] += num(effects.resources?.[key], 0);
    }

    for (const [flagKey, enabled] of Object.entries(effects.flags ?? {})) {
      if (enabled === true) flags[flagKey] = true;
    }

    const normalizedAbilities = parseGrantedAbilityEntries(item.system?.grantedAbilities);
    for (const granted of normalizedAbilities) {
      const dedupeKey = `${item.type}::${item.id}::${normalizeName(granted.key || granted.name)}`;
      if (abilityKeys.has(dedupeKey)) continue;
      abilityKeys.add(dedupeKey);

      grantedAbilities.push({
        name: normalizeText(granted.name),
        key: normalizeName(granted.key || granted.name),
        type: normalizeText(granted.type || "ability") || "ability",
        notes: normalizeText(granted.notes),
        sourceType: item.type,
        sourceId: item.id,
        sourceName: item.name,
        data: granted.data && typeof granted.data === "object" ? foundry.utils.deepClone(granted.data) : {}
      });
    }

    const normalizedSkills = parseGrantedSkillEntries(item.system?.grantedSkills);
    for (const granted of normalizedSkills) {
      const dedupeKey = `${item.type}::${item.id}::${normalizeName(granted.key || granted.name)}`;
      if (skillKeys.has(dedupeKey)) continue;
      skillKeys.add(dedupeKey);

      grantedSkills.push({
        name: normalizeText(granted.name),
        key: normalizeName(granted.key || granted.name),
        category: normalizeText(granted.category),
        base: num(granted.base, 0),
        perLevel: num(granted.perLevel, 0),
        modifier: num(granted.modifier, 0),
        isOCCSkill: bool(granted.isOCCSkill),
        isRelatedSkill: bool(granted.isRelatedSkill),
        isSecondarySkill: bool(granted.isSecondarySkill),
        notes: normalizeText(granted.notes),
        sourceType: item.type,
        sourceId: item.id,
        sourceName: item.name
      });
    }
  }

  const totals = {
    attributes,
    combat,
    resources,
    flags,
    grantedAbilities,
    grantedSkills
  };

  return {
    count: items.length,
    items: items.map((item) => ({
      id: item.id,
      name: item.name,
      type: item.type,
      category: normalizeText(item.system?.category),
      active: bool(item.system?.active),
      primary: bool(item.system?.isPrimaryClass)
    })),
    ...totals,
    summary: formatAugmentationSummary(totals)
  };
}

function dedupeGrantedEntries(entries, keyPrefix = "entry") {
  const out = [];
  const seen = new Set();

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object") continue;
    const dedupeKey = `${keyPrefix}::${normalizeName(entry.sourceType)}::${normalizeText(entry.sourceId)}::${normalizeName(entry.key || entry.name)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(entry);
  }

  return out;
}

function combineEffectTotals(primaryTotals, secondaryTotals) {
  const attributes = createAugmentationTotals(AUGMENT_ATTRIBUTE_KEYS);
  const combat = createAugmentationTotals(AUGMENT_COMBAT_KEYS);
  const resources = createAugmentationTotals(AUGMENT_RESOURCE_KEYS);
  const flags = {
    ...(primaryTotals?.flags ?? {}),
    ...(secondaryTotals?.flags ?? {})
  };

  for (const key of AUGMENT_ATTRIBUTE_KEYS) {
    attributes[key] = num(primaryTotals?.attributes?.[key], 0) + num(secondaryTotals?.attributes?.[key], 0);
  }

  for (const key of AUGMENT_COMBAT_KEYS) {
    combat[key] = num(primaryTotals?.combat?.[key], 0) + num(secondaryTotals?.combat?.[key], 0);
  }

  for (const key of AUGMENT_RESOURCE_KEYS) {
    resources[key] = num(primaryTotals?.resources?.[key], 0) + num(secondaryTotals?.resources?.[key], 0);
  }

  const grantedAbilities = dedupeGrantedEntries([
    ...(Array.isArray(primaryTotals?.grantedAbilities) ? primaryTotals.grantedAbilities : []),
    ...(Array.isArray(secondaryTotals?.grantedAbilities) ? secondaryTotals.grantedAbilities : [])
  ], "ability");

  const grantedSkills = dedupeGrantedEntries([
    ...(Array.isArray(primaryTotals?.grantedSkills) ? primaryTotals.grantedSkills : []),
    ...(Array.isArray(secondaryTotals?.grantedSkills) ? secondaryTotals.grantedSkills : [])
  ], "skill");

  return {
    attributes,
    combat,
    resources,
    flags,
    grantedAbilities,
    grantedSkills,
    summary: formatAugmentationSummary({ attributes, combat, resources, flags, grantedAbilities })
  };
}
function formatAugmentationSummary(totals) {
  const parts = [];

  for (const key of AUGMENT_ATTRIBUTE_KEYS) {
    const value = num(totals.attributes?.[key], 0);
    if (!value) continue;
    const label = key.toUpperCase();
    parts.push(`${label} ${value >= 0 ? "+" : ""}${value}`);
  }

  for (const key of AUGMENT_COMBAT_KEYS) {
    const value = num(totals.combat?.[key], 0);
    if (!value) continue;
    const label = key === "apm" ? "APM" : key[0].toUpperCase() + key.slice(1);
    parts.push(`${label} ${value >= 0 ? "+" : ""}${value}`);
  }

  for (const key of AUGMENT_RESOURCE_KEYS) {
    const value = num(totals.resources?.[key], 0);
    if (!value) continue;
    const label = key.toUpperCase();
    parts.push(`${label} ${value >= 0 ? "+" : ""}${value}`);
  }

  const enabledFlags = Object.entries(totals.flags ?? {})
    .filter(([, enabled]) => enabled === true)
    .map(([flag]) => flag);
  if (enabledFlags.length > 0) {
    parts.push(`Flags: ${enabledFlags.join(", ")}`);
  }

  if ((totals.grantedAbilities?.length ?? 0) > 0) {
    parts.push(`Granted: ${totals.grantedAbilities.length}`);
  }

  return parts.join("; ");
}

function aggregateAugmentationEffects(actor, itemType) {
  const attributes = createAugmentationTotals(AUGMENT_ATTRIBUTE_KEYS);
  const combat = createAugmentationTotals(AUGMENT_COMBAT_KEYS);
  const resources = createAugmentationTotals(AUGMENT_RESOURCE_KEYS);
  const flags = {};
  const grantedAbilities = [];
  const abilityKeys = new Set();

  const items = actor.items
    .filter((item) => item.type === itemType)
    .filter((item) => item.system?.installed === true);

  for (const item of items) {
    const effects = item.system?.effects ?? {};
    const effectAttributes = effects.attributes ?? {};
    const effectCombat = effects.combat ?? {};
    const effectResources = effects.resources ?? {};
    const effectFlags = effects.flags ?? {};

    for (const key of AUGMENT_ATTRIBUTE_KEYS) {
      attributes[key] += num(effectAttributes[key], 0);
    }

    for (const key of AUGMENT_COMBAT_KEYS) {
      combat[key] += num(effectCombat[key], 0);
    }

    for (const key of AUGMENT_RESOURCE_KEYS) {
      resources[key] += num(effectResources[key], 0);
    }

    for (const [flagKey, rawEnabled] of Object.entries(effectFlags)) {
      const normalizedFlag = normalizeText(flagKey);
      if (!normalizedFlag) continue;
      const enabled = rawEnabled === true || normalizeName(rawEnabled) === "true" || num(rawEnabled, 0) > 0;
      if (enabled) flags[normalizedFlag] = true;
    }

    const normalizedGranted = parseGrantedAbilityEntries(item.system?.grantedAbilities);
    for (const granted of normalizedGranted) {
      const dedupeKey = `${item.id}::${normalizeName(granted.key || granted.name)}`;
      if (abilityKeys.has(dedupeKey)) continue;
      abilityKeys.add(dedupeKey);

      grantedAbilities.push({
        name: normalizeText(granted.name),
        key: normalizeName(granted.key || granted.name),
        type: normalizeText(granted.type || "ability") || "ability",
        notes: normalizeText(granted.notes),
        sourceType: itemType,
        sourceId: item.id,
        sourceName: item.name,
        data: granted.data && typeof granted.data === "object" ? foundry.utils.deepClone(granted.data) : {}
      });
    }
  }

  const totals = {
    attributes,
    combat,
    resources,
    flags,
    grantedAbilities
  };

  return {
    itemType,
    count: items.length,
    items: items.map((item) => ({
      id: item.id,
      name: item.name,
      slot: normalizeText(item.system?.slot),
      installed: item.system?.installed === true,
      sourceType: normalizeText(item.system?.sourceType),
      sourceId: normalizeText(item.system?.sourceId),
      sourceName: normalizeText(item.system?.sourceName)
    })),
    ...totals,
    summary: formatAugmentationSummary(totals)
  };
}

function combineAugmentationEffects(cyberneticEffects, bionicEffects) {
  return combineEffectTotals(cyberneticEffects, bionicEffects);
}

function aggregateSkillPassiveEffects(actor) {
  const physical = aggregatePhysicalSkillAutomation(actor);
  const totals = {
    attributes: foundry.utils.deepClone(physical.effects?.attributes ?? defaultSkillEffects().attributes),
    combat: foundry.utils.deepClone(physical.effects?.combat ?? defaultSkillEffects().combat),
    resources: foundry.utils.deepClone(physical.effects?.resources ?? defaultSkillEffects().resources),
    flags: foundry.utils.deepClone(physical.effects?.flags ?? {}),
    grantedAbilities: [],
    grantedSkills: []
  };

  return {
    itemType: "skill",
    count: physical.count ?? 0,
    items: foundry.utils.deepClone(physical.items ?? []),
    ...totals,
    physicalRules: foundry.utils.deepClone(physical.rules ?? {}),
    summary: formatAugmentationSummary(totals)
  };
}

function hasResolvedSkillEffects(rawEffects) {
  const effects = normalizeSkillEffects(rawEffects);
  return [
    ...Object.values(effects.attributes ?? {}),
    ...Object.values(effects.combat ?? {}),
    ...Object.values(effects.resources ?? {})
  ].some((value) => num(value, 0) !== 0);
}

function getEffectRollLabel(groupKey, effectKey) {
  if (groupKey === "combat" && effectKey === "apm") return "APM";
  return String(effectKey ?? "").toUpperCase();
}
export class RiftsActor extends Actor {
  prepareDerivedData() {
    super.prepareDerivedData();

    if (!["character", "npc", "vehicle"].includes(this.type)) return;

    const system = this.system;
    let progressionData = {
      level: 1,
      currentXP: 0,
      nextLevelXP: null,
      progressPercent: 0,
      activeClass: null
    };
    let level = Math.max(1, Math.floor(num(system?.details?.level, 1)));
    let activeClass = null;
    let activeOcc = null;
    let activeRcc = null;
    let activeOccEffects = aggregateClassPassiveEffects([]);
    let activeRccEffects = aggregateClassPassiveEffects([]);
    let classPassiveEffects = aggregateClassPassiveEffects([]);
    let cyberneticEffects = aggregateAugmentationEffects(this, "cybernetic");
    let bionicEffects = aggregateAugmentationEffects(this, "bionic");
    let augmentationEffects = combineAugmentationEffects(cyberneticEffects, bionicEffects);
    let skillPassiveEffects = aggregateSkillPassiveEffects(this);
    let combinedPassiveEffects = combineEffectTotals(combineEffectTotals(classPassiveEffects, augmentationEffects), skillPassiveEffects);
    let classBonuses = { strike: 0, parry: 0, dodge: 0, initiative: 0 };
    let classSkillPackage = { occSkills: [], relatedSkills: [], secondarySkills: [] };
    let activeHandToHand = null;
    let handToHandBonuses = {
      apmBonus: 0,
      strikeBonus: 0,
      parryBonus: 0,
      dodgeBonus: 0,
      damageBonus: 0,
      autoDodgeLevel: 0,
      autoDodgeAvailable: false
    };
    let handToHandSpecialRules = getDefaultHandToHandSpecialRules();
    let classBaseAttacks = 0;
    let classProgressionBonus = 0;
    let attacksPerMelee = Math.max(1, Math.floor(num(system?.combat?.apmTotal, 1)));
    let activeClassExperience = 0;
    let occStartingPackage = {
      activeOcc: null,
      sourceType: "",
      sourceId: "",
      bionics: [],
      cybernetics: [],
      abilities: [],
      gear: []
    };
    let occMechanicalData = getOCCMechanicalData(null, system?.attributes ?? {});

    system.combat ??= {};

    system.combat.ar = num(system.combat.ar, 0);
    system.combat.mdcEnabled = bool(system.combat.mdcEnabled);
    system.combat.scale = normalizeScale(system.combat.scale, this.type === "vehicle" ? "mdc" : "sdc");
    system.combat.isMdcEntity = bool(system.combat.isMdcEntity);
    system.combat.isVehicleScale = bool(system.combat.isVehicleScale);
    system.combat.isPowerArmorUser = bool(system.combat.isPowerArmorUser);
    system.combat.damageMode = system.combat.damageMode ?? (this.type === "vehicle" ? "MDC" : "SDC");
    system.combat.lastTargetId = String(system.combat.lastTargetId ?? "");
    system.combat.lastTargetTokenId = String(system.combat.lastTargetTokenId ?? "");
    system.combat.strikeMod = num(system.combat.strikeMod, 0);
    system.combat.parryMod = num(system.combat.parryMod, 0);
    system.combat.dodgeMod = num(system.combat.dodgeMod, 0);
    system.combat.initiativeMod = num(system.combat.initiativeMod, 0);
    system.combat.pilotBonus = num(system.combat.pilotBonus, 0);
    system.combat.apmTotal = Math.max(0, Math.floor(num(system.combat.apmTotal, 0)));
    system.combat.apmRemaining = Math.max(0, Math.floor(num(system.combat.apmRemaining, 0)));
    system.combat.apmSpent = Math.max(0, Math.floor(num(system.combat.apmSpent, 0)));
    system.combat.lastActionType = normalizeText(system.combat.lastActionType);
    system.combat.reactionAvailable = bool(system.combat.reactionAvailable);
    system.combat.autoDodgeAvailable = bool(system.combat.autoDodgeAvailable);
    system.combat.heldAction = bool(system.combat.heldAction);
    system.combat.heldActionCount = Math.max(0, Math.floor(num(system.combat.heldActionCount, 0)));
    system.combat.heldActionReady = bool(system.combat.heldActionReady);
    system.combat.lastAdvancedAction = normalizeText(system.combat.lastAdvancedAction);
    system.combat.movementUsedThisAction = Math.max(0, num(system.combat.movementUsedThisAction, 0));
    system.combat.movementActionKey = normalizeText(system.combat.movementActionKey);
    system.combat.derived ??= {};
    system.combat.derived.hasActivePowerArmor = false;
    system.combat.derived.activePowerArmorId = "";
    system.combat.derived.activePowerArmorName = "";
    system.combat.derived.activePowerArmorClass = "";
    system.combat.derived.activePowerArmorMountCapacity = 0;
    system.combat.derived.activePowerArmorHandlingMod = 0;
    system.combat.derived.activePowerArmorSpeedMod = 0;
    system.combat.derived.activePowerArmorNotes = "";
    system.combat.derived.activePowerArmorSdcValue = 0;
    system.combat.derived.activePowerArmorSdcMax = 0;
    system.combat.derived.activePowerArmorMdcValue = 0;
    system.combat.derived.activePowerArmorMdcMax = 0;
    system.combat.derived.mountedWeaponsOnPowerArmor = [];
    system.combat.derived.powerArmorMountedWeaponCount = 0;
    system.combat.derived.outOfCombatMovement = 0;
    system.combat.derived.movementPerAction = 0;
    system.combat.derived.movementUsedThisAction = 0;
    system.combat.derived.movementRemainingThisAction = 0;
    system.combat.derived.physicalSkillRollWithPunchBonus = 0;
    system.combat.derived.physicalSkillKickAttack = false;
    system.combat.derived.physicalSkillKickDamageFormula = "";
    system.combat.derived.physicalSkillCrushSqueeze = false;
    system.combat.derived.physicalSkillAutomaticKnockoutOn20 = false;
    system.combat.derived.physicalSkillBodyBlockTackleDamage = "";
    system.combat.derived.effectiveDurability = normalizeScale(system.combat.derived.effectiveDurability ?? system.combat.derived.effectiveScale, system.combat.scale);
    system.combat.derived.effectiveDurabilityLabelKey = getScaleLabelKey(system.combat.derived.effectiveDurability);
    system.combat.derived.activeArmorDurability = "sdc";
    system.combat.derived.activeArmorDurabilityLabelKey = getScaleLabelKey("sdc");
    // Backward compatibility keys retained for existing templates/macros.
    system.combat.derived.effectiveScale = system.combat.derived.effectiveDurability;
    system.combat.derived.effectiveScaleLabelKey = system.combat.derived.effectiveDurabilityLabelKey;
    system.combat.derived.activeArmorProtectionScale = system.combat.derived.activeArmorDurability;
    system.combat.derived.activeArmorProtectionScaleLabelKey = system.combat.derived.activeArmorDurabilityLabelKey;
    system.combat.derived.hasValidVehicleMdc = true;

    const activeWeapon = this.items.find((item) => item.type === "weapon" && (item.system?.active === true || item.system?.equipped === true))
      ?? this.items.find((item) => item.type === "weapon" && item.system?.equipped === true)
      ?? this.items.find((item) => item.type === "weapon" && item.system?.active === true)
      ?? null;
    const activeArmor = getEquippedArmor(this)
      ?? this.items.find((item) => item.type === "armor" && item.system?.equipped === true)
      ?? null;
    const equippedWeaponStrikeBonus = getWeaponBonus(activeWeapon);
    const equippedArmorAR = getArmorAr(activeArmor);
    const activeArmorDurability = getArmorProtectionScale(activeArmor);


    if (this.type === "character" || this.type === "npc") {
      system.details ??= {};
      system.details.level = Math.max(1, Math.floor(num(system.details.level, 1)));
      system.details.experience = num(system.details.experience, 0);
      system.details.credits = Math.max(0, Math.floor(num(system.details.credits, 0)));
      system.details.sizeCategory = normalizeSizeCategory(system.details.sizeCategory, "human");

      system.derived ??= {};
      system.derived.level = Math.max(1, Math.floor(num(system.derived.level, system.details.level)));
      system.derived.currentXP = Math.max(0, Math.floor(num(system.derived.currentXP, system.details.experience)));
      system.derived.nextLevelXP = system.derived.nextLevelXP ?? null;
      system.derived.xpProgress = Math.max(0, Math.min(100, Math.floor(num(system.derived.xpProgress, 0))));

      system.debug ??= {};
      system.debug.useLevelOverride = bool(system.debug.useLevelOverride);
      system.debug.overrideLevel = Math.max(1, Math.floor(num(system.debug.overrideLevel, 1)));

      const attributeKeys = ["iq", "me", "ma", "ps", "pp", "pe", "pb", "spd"];
      for (const key of attributeKeys) {
        system.attributes ??= {};
        system.attributes[key] ??= {};
        system.attributes[key].value = num(system.attributes[key].value, 10);
        system.attributes[key].mod = num(system.attributes[key].mod, 0);
      }

      system.resources ??= {};
      ensurePool(system.resources, "hp", 10, 10);
      ensurePool(system.resources, "sdc", 10, 10);
      ensurePool(system.resources, "mdc", 0, 0);
      ensurePool(system.resources, "ppe", 0, 0);
      ensurePool(system.resources, "isp", 0, 0);

      system.skills ??= {};
      system.skills.derived ??= {};
      system.skills.derived.physical ??= {};

      system.progression ??= {};
    }

    if (this.type === "vehicle") {
      system.details ??= {};
      system.details.level = Math.max(1, Math.floor(num(system.details.level, 1)));

      system.vehicle ??= {};
      system.vehicle.classification = normalizeText(system.vehicle.classification);
      system.vehicle.crewRequired = Math.max(1, Math.floor(num(system.vehicle.crewRequired, 1)));
      system.vehicle.passengerCapacity = Math.max(0, Math.floor(num(system.vehicle.passengerCapacity, 0)));
      system.vehicle.speedGround = num(system.vehicle.speedGround, num(system.stats?.speed, 0));
      system.vehicle.speedAir = num(system.vehicle.speedAir, 0);
      system.vehicle.speedWater = num(system.vehicle.speedWater, 0);
      system.vehicle.handling = num(system.vehicle.handling, num(system.stats?.handling, 0));
      system.vehicle.sizeCategory = normalizeSizeCategory(system.vehicle.sizeCategory, "large");
      system.vehicle.notes = normalizeText(system.vehicle.notes);
      system.vehicle.derived ??= {};

      // Backward-compatible mirrors for earlier test data that used `system.stats`.
      system.stats ??= {};
      system.stats.speed = num(system.stats.speed, system.vehicle.speedGround);
      system.stats.handling = num(system.stats.handling, system.vehicle.handling);

      system.details.sizeCategory = normalizeSizeCategory(system.details.sizeCategory || system.vehicle.sizeCategory, "large");
      system.vehicle.sizeCategory = system.details.sizeCategory;

      system.resources ??= {};
      ensurePool(system.resources, "mdc", 100, 100);
      ensurePool(system.resources, "sdc", 0, 0);
      ensurePool(system.resources, "fuel", 100, 100);

      system.combat.scale = "mdc";
      system.combat.isMdcEntity = true;
      system.combat.isVehicleScale = true;

      system.progression ??= {};
    }

    if (this.type === "character" || this.type === "npc") {
      progressionData = getProgressionData(this);
      level = progressionData.level;

      activeClass = progressionData.activeClass ?? getActiveClassItem(this);
      activeOcc = resolveActiveClassByType(this, "occ");
      activeRcc = resolveActiveClassByType(this, "rcc");
      occStartingPackage = getOccStartingAugmentationPackageSuggestions(this, activeOcc);
      occMechanicalData = getOCCMechanicalData(activeOcc, system.attributes ?? {});

      activeOccEffects = aggregateClassPassiveEffects(activeOcc ? [activeOcc] : []);
      activeRccEffects = aggregateClassPassiveEffects(activeRcc ? [activeRcc] : []);
      classPassiveEffects = aggregateClassPassiveEffects([activeOcc, activeRcc]);

      cyberneticEffects = aggregateAugmentationEffects(this, "cybernetic");
      bionicEffects = aggregateAugmentationEffects(this, "bionic");
      augmentationEffects = combineAugmentationEffects(cyberneticEffects, bionicEffects);
      skillPassiveEffects = aggregateSkillPassiveEffects(this);
      combinedPassiveEffects = combineEffectTotals(combineEffectTotals(classPassiveEffects, augmentationEffects), skillPassiveEffects);

      for (const key of AUGMENT_ATTRIBUTE_KEYS) {
        if (!system.attributes?.[key]) continue;
        system.attributes[key].value = num(system.attributes[key].value, 0) + num(combinedPassiveEffects.attributes?.[key], 0);
      }

      for (const key of AUGMENT_RESOURCE_KEYS) {
        const pool = system.resources?.[key];
        if (!pool) continue;
        const bonus = num(combinedPassiveEffects.resources?.[key], 0);
        if (!bonus) continue;

        const nextMax = Math.max(0, num(pool.max, 0) + bonus);
        const nextValue = Math.max(0, Math.min(nextMax, num(pool.value, 0) + bonus));
        pool.max = nextMax;
        pool.value = nextValue;
      }

      classBonuses = {
        strike: num(classPassiveEffects.combat?.strike, 0),
        parry: num(classPassiveEffects.combat?.parry, 0),
        dodge: num(classPassiveEffects.combat?.dodge, 0),
        initiative: num(classPassiveEffects.combat?.initiative, 0)
      };

      classSkillPackage = getClassSkillPackage(activeClass);
      activeHandToHand = getActiveHandToHand(this);
      handToHandBonuses = getHandToHandBonuses(activeHandToHand, level);
      handToHandSpecialRules = getHandToHandSpecialRules(activeHandToHand, level);

      classBaseAttacks = activeClass ? num(activeClass.system?.baseAttacksPerMelee, 2) : 0;
      classProgressionBonus = activeClass
        ? getAttacksPerMeleeProgressionBonus(activeClass.system?.attacksPerMeleePerLevel, level)
        : 0;

      // Placeholder pipeline hook for future item/effect modifiers.
      const modifierHookBonus = 0;
      attacksPerMelee = Math.max(
        0,
        classBaseAttacks + classProgressionBonus + handToHandBonuses.apmBonus + num(combinedPassiveEffects.combat?.apm, 0) + modifierHookBonus
      );
      if (attacksPerMelee <= 0) {
        attacksPerMelee = Math.max(1, Math.floor(num(system.combat.apmTotal, 1)));
      }
      activeClassExperience = progressionData.currentXP;

      const ppValue = num(system.attributes?.pp?.value, 0);
      // Placeholder baseline from PP. Deterministic and intentionally simple.
      const ppBaseline = ppValue > 10 ? Math.floor((ppValue - 10) / 2) : 0;
      const combatControl = getCombatControlState(this);

      system.combat.derived.strikeTotal = ppBaseline + system.combat.strikeMod + handToHandBonuses.strikeBonus + num(combinedPassiveEffects.combat?.strike, 0);
      system.combat.derived.parryTotal = ppBaseline + system.combat.parryMod + handToHandBonuses.parryBonus + num(combinedPassiveEffects.combat?.parry, 0);
      system.combat.derived.dodgeTotal = ppBaseline + system.combat.dodgeMod + handToHandBonuses.dodgeBonus + num(combinedPassiveEffects.combat?.dodge, 0);
      system.combat.derived.initiativeTotal = ppBaseline + system.combat.initiativeMod + handToHandBonuses.initiativeBonus + num(combinedPassiveEffects.combat?.initiative, 0);
      system.combat.autoDodgeAvailable = handToHandBonuses.autoDodgeAvailable && combatControl.dodgeBlocked !== true;

      system.progression.activeClassId = activeClass?.id ?? "";
      system.progression.activeClassType = activeClass?.type ?? "";
      system.progression.activeClassName = activeClass?.name ?? "";
      system.progression.activeClassCategory = activeClass?.system?.category ?? "";
      system.progression.activeOccId = activeOcc?.id ?? "";
      system.progression.activeOccName = activeOcc?.name ?? "";
      system.progression.activeOccCategory = activeOcc?.system?.category ?? "";
      system.progression.activeRccId = activeRcc?.id ?? "";
      system.progression.activeRccName = activeRcc?.name ?? "";
      system.progression.activeRccCategory = activeRcc?.system?.category ?? "";
      system.progression.activeClassExperience = activeClassExperience;
      system.progression.nextLevelXP = progressionData.nextLevelXP;
      system.progression.xpProgress = progressionData.progressPercent;
      system.progression.attacksPerMelee = attacksPerMelee;
      system.progression.attacksPerMeleeBase = classBaseAttacks;
      system.progression.attacksPerMeleeProgressionBonus = classProgressionBonus;
      system.progression.attacksPerMeleeModifierBonus = handToHandBonuses.apmBonus + num(combinedPassiveEffects.combat?.apm, 0);
      system.progression.classBonuses = classBonuses;
      system.progression.classEffectsSummary = classPassiveEffects.summary;
      system.progression.skillEffectsSummary = skillPassiveEffects.summary;
      system.progression.occEffectsSummary = activeOccEffects.summary;
      system.progression.rccEffectsSummary = activeRccEffects.summary;
      system.progression.classGrantedAbilities = foundry.utils.deepClone(classPassiveEffects.grantedAbilities ?? []);
      system.progression.classGrantedSkills = foundry.utils.deepClone(classPassiveEffects.grantedSkills ?? []);
      system.progression.occStartingBionics = foundry.utils.deepClone((occStartingPackage.bionics ?? []).map((entry) => ({
        name: entry.name,
        slot: entry.slot,
        isAdded: entry.isAdded === true
      })));
      system.progression.occStartingCybernetics = foundry.utils.deepClone((occStartingPackage.cybernetics ?? []).map((entry) => ({
        name: entry.name,
        slot: entry.slot,
        isAdded: entry.isAdded === true
      })));
      system.progression.occStartingAbilities = foundry.utils.deepClone(occStartingPackage.abilities ?? []);
      system.progression.occStartingGear = foundry.utils.deepClone(occStartingPackage.gear ?? []);
      system.progression.occStartingBionicsCount = Math.max(0, Math.floor(num(occStartingPackage.bionics?.length, 0)));
      system.progression.occStartingCyberneticsCount = Math.max(0, Math.floor(num(occStartingPackage.cybernetics?.length, 0)));
      system.progression.occAttributeRequirements = foundry.utils.deepClone(occMechanicalData.requirements);
      system.progression.occRequirementsMet = occMechanicalData.requirementsMet;
      system.progression.occRequirementsUnmet = foundry.utils.deepClone(occMechanicalData.requirementsUnmet);
      system.progression.occRequirementsSummary = normalizeText(occMechanicalData.requirementsSummary);
      system.progression.occSkillSelection = foundry.utils.deepClone(occMechanicalData.skillSelection);
      system.progression.occStartingResources = foundry.utils.deepClone(occMechanicalData.startingResources);
      system.progression.occResourceProgression = foundry.utils.deepClone(occMechanicalData.resourceProgression);
      system.progression.occStartingPowers = foundry.utils.deepClone(occMechanicalData.startingPowers);
      system.progression.occPowerProgression = foundry.utils.deepClone(occMechanicalData.powerProgression);
      system.progression.occStartingCredits = foundry.utils.deepClone(occMechanicalData.startingCredits);
      system.progression.occStartingResourcesInitializedForOccId = normalizeText(system.progression.occStartingResourcesInitializedForOccId);
      system.progression.occSkillsFromClass = classSkillPackage.occSkills;
      system.progression.relatedSkillsFromClass = classSkillPackage.relatedSkills;
      system.progression.secondarySkillsFromClass = classSkillPackage.secondarySkills;
      system.progression.activeHandToHandId = activeHandToHand?.id ?? "";
      system.progression.activeHandToHandName = activeHandToHand?.name ?? "";
      system.progression.handToHandBonuses = {
        apmBonus: handToHandBonuses.apmBonus,
        initiativeBonus: handToHandBonuses.initiativeBonus,
        disarmBonus: handToHandBonuses.disarmBonus,
        entangleBonus: handToHandBonuses.entangleBonus,
        strikeBonus: handToHandBonuses.strikeBonus,
        parryBonus: handToHandBonuses.parryBonus,
        dodgeBonus: handToHandBonuses.dodgeBonus,
        damageBonus: handToHandBonuses.damageBonus,
        autoDodgeLevel: handToHandBonuses.autoDodgeLevel,
        autoDodgeAvailable: handToHandBonuses.autoDodgeAvailable
      };
      system.progression.handToHandSpecialRules = foundry.utils.deepClone(handToHandSpecialRules);

      // Mirror for compatibility while class item remains source-of-truth.
      system.details.level = level;
      system.details.experience = activeClassExperience;

      system.derived ??= {};
      system.derived.level = level;
      system.derived.currentXP = activeClassExperience;
      system.derived.nextLevelXP = progressionData.nextLevelXP;
      system.derived.xpProgress = progressionData.progressPercent;
      system.derived.classEffectsSummary = classPassiveEffects.summary;
      system.derived.skillEffectsSummary = skillPassiveEffects.summary;
      system.derived.occEffectsSummary = activeOccEffects.summary;
      system.derived.rccEffectsSummary = activeRccEffects.summary;
      system.derived.cyberneticEffectsSummary = cyberneticEffects.summary;
      system.derived.bionicEffectsSummary = bionicEffects.summary;
      system.derived.actorGrantedFlags = foundry.utils.deepClone(combinedPassiveEffects.flags ?? {});
      system.derived.classGrantedAbilities = foundry.utils.deepClone(classPassiveEffects.grantedAbilities ?? []);
      system.derived.classGrantedSkills = foundry.utils.deepClone(classPassiveEffects.grantedSkills ?? []);
      system.derived.grantedAbilities = foundry.utils.deepClone(combinedPassiveEffects.grantedAbilities ?? []);
      system.derived.grantedSkills = foundry.utils.deepClone(combinedPassiveEffects.grantedSkills ?? []);
      system.derived.cyberneticsInstalled = Math.max(0, Math.floor(num(cyberneticEffects.count, 0)));
      system.derived.bionicsInstalled = Math.max(0, Math.floor(num(bionicEffects.count, 0)));
      system.derived.occPackageBionicsCount = Math.max(0, Math.floor(num(occStartingPackage.bionics?.length, 0)));
      system.derived.occPackageCyberneticsCount = Math.max(0, Math.floor(num(occStartingPackage.cybernetics?.length, 0)));
      system.derived.augmentationEffects = {
        attributes: foundry.utils.deepClone(augmentationEffects.attributes ?? {}),
        combat: foundry.utils.deepClone(augmentationEffects.combat ?? {}),
        resources: foundry.utils.deepClone(augmentationEffects.resources ?? {})
      };
      system.derived.skillEffects = {
        attributes: foundry.utils.deepClone(skillPassiveEffects.attributes ?? {}),
        combat: foundry.utils.deepClone(skillPassiveEffects.combat ?? {}),
        resources: foundry.utils.deepClone(skillPassiveEffects.resources ?? {})
      };
      system.derived.classEffects = {
        attributes: foundry.utils.deepClone(classPassiveEffects.attributes ?? {}),
        combat: foundry.utils.deepClone(classPassiveEffects.combat ?? {}),
        resources: foundry.utils.deepClone(classPassiveEffects.resources ?? {})
      };

      system.skills.derived.level = level;
      system.skills.derived.levelOffset = Math.max(0, level - 1);
      system.skills.derived.physical = {
        count: Math.max(0, Math.floor(num(skillPassiveEffects.count, 0))),
        summary: String(skillPassiveEffects.summary ?? ""),
        passiveEffects: foundry.utils.deepClone({
          attributes: skillPassiveEffects.attributes ?? {},
          combat: skillPassiveEffects.combat ?? {},
          resources: skillPassiveEffects.resources ?? {}
        }),
        rules: foundry.utils.deepClone(skillPassiveEffects.physicalRules ?? {})
      };
      const climbSkill = this.items.find((item) => item.type === "skill" && normalizeName(item.name).includes("climb")) ?? null;
      const prowlSkill = this.items.find((item) => item.type === "skill" && normalizeName(item.name).includes("prowl")) ?? null;
      const climbBreakdown = climbSkill ? this.getSkillTarget(climbSkill) : null;
      const prowlBreakdown = prowlSkill ? this.getSkillTarget(prowlSkill) : null;
      system.skills.derived.physical.rollWithPunchBonus = Math.max(0, Math.floor(num(skillPassiveEffects.physicalRules?.rollWithPunchBonus, 0)));
      system.skills.derived.physical.climbBonus = Math.max(0, Math.floor(num(skillPassiveEffects.physicalRules?.climbBonus, 0)));
      system.skills.derived.physical.climbBaseGrant = Math.max(0, Math.floor(num(skillPassiveEffects.physicalRules?.climbBaseGrant, 0)));
      system.skills.derived.physical.prowlBonus = Math.max(0, Math.floor(num(skillPassiveEffects.physicalRules?.prowlBonus, 0)));
      system.skills.derived.physical.prowlBaseGrant = Math.max(0, Math.floor(num(skillPassiveEffects.physicalRules?.prowlBaseGrant, 0)));
      system.skills.derived.physical.kickAttack = skillPassiveEffects.physicalRules?.kickAttack === true;
      system.skills.derived.physical.kickDamageFormula = normalizeText(skillPassiveEffects.physicalRules?.kickDamageFormula);
      system.skills.derived.physical.crushSqueeze = skillPassiveEffects.physicalRules?.crushSqueeze === true;
      system.skills.derived.physical.automaticKnockoutOn20 = skillPassiveEffects.physicalRules?.automaticKnockoutOn20 === true;
      system.skills.derived.physical.bodyBlockTackleDamage = normalizeText(skillPassiveEffects.physicalRules?.bodyBlockTackleDamage);
      system.skills.derived.physical.climbTarget = climbBreakdown?.target ?? system.skills.derived.physical.climbBaseGrant;
      system.skills.derived.physical.prowlTarget = prowlBreakdown?.target ?? system.skills.derived.physical.prowlBaseGrant;

      const activePowerArmor = (activeArmor?.system?.armor?.isPowerArmor === true || activeArmor?.system?.isPowerArmor === true) ? activeArmor : null;
      const powerArmorSdc = getArmorPool(activePowerArmor, "sdc");
      const powerArmorMdc = getArmorPool(activePowerArmor, "mdc");
      const mountedWeaponsOnPowerArmor = activePowerArmor
        ? getPowerArmorMountedWeapons(this, activePowerArmor.id)
        : [];

      system.combat.derived.hasActivePowerArmor = Boolean(activePowerArmor);
      system.combat.derived.activePowerArmorId = activePowerArmor?.id ?? "";
      system.combat.derived.activePowerArmorName = activePowerArmor?.name ?? "";
      system.combat.derived.activePowerArmorClass = normalizeText(activePowerArmor?.system?.armor?.powerArmorClass);
      system.combat.derived.activePowerArmorMountCapacity = Math.max(0, num(activePowerArmor?.system?.armor?.mountCapacity, 0));
      system.combat.derived.activePowerArmorHandlingMod = num(activePowerArmor?.system?.armor?.handlingMod, 0);
      system.combat.derived.activePowerArmorSpeedMod = num(activePowerArmor?.system?.armor?.speedMod, 0);
      system.combat.derived.activePowerArmorNotes = normalizeText(activePowerArmor?.system?.armor?.notes);
      system.combat.derived.activePowerArmorSdcValue = powerArmorSdc.value;
      system.combat.derived.activePowerArmorSdcMax = powerArmorSdc.max;
      system.combat.derived.activePowerArmorMdcValue = powerArmorMdc.value;
      system.combat.derived.activePowerArmorMdcMax = powerArmorMdc.max;
      system.combat.derived.mountedWeaponsOnPowerArmor = mountedWeaponsOnPowerArmor;
      system.combat.derived.powerArmorMountedWeaponCount = mountedWeaponsOnPowerArmor.length;

      const maneuverContext = getAvailableCombatManeuverContext(this, {
        grantedAbilities: combinedPassiveEffects.grantedAbilities
      });
      system.combat.derived.activeHthStyleName = normalizeText(maneuverContext.activeHthStyleName);
      system.combat.derived.availableManeuverKeys = foundry.utils.deepClone(maneuverContext.availableManeuverKeys ?? []);
      system.combat.derived.availableManeuvers = foundry.utils.deepClone(maneuverContext.availableManeuvers ?? []);
      system.combat.derived.grantedManeuvers = foundry.utils.deepClone(maneuverContext.grantedManeuvers ?? []);
      system.combat.derived.frameworkGrantedManeuvers = foundry.utils.deepClone(maneuverContext.frameworkGrantedManeuvers ?? []);
    }

    if (this.type === "vehicle") {
      const handlingBaseline = num(system.vehicle?.handling, num(system.stats?.handling, 0));

      system.combat.derived.strikeTotal = system.combat.strikeMod;
      system.combat.derived.parryTotal = system.combat.parryMod;
      system.combat.derived.dodgeTotal = system.combat.dodgeMod;
      system.combat.derived.initiativeTotal = handlingBaseline + system.combat.initiativeMod + system.combat.pilotBonus;

      attacksPerMelee = Math.max(1, Math.floor(num(system.combat.apmTotal, 1)));

      system.progression.activeClassId = "";
      system.progression.activeClassType = "";
      system.progression.activeClassName = "";
      system.progression.activeClassCategory = "";
      system.progression.activeOccId = "";
      system.progression.activeOccName = "";
      system.progression.activeOccCategory = "";
      system.progression.activeRccId = "";
      system.progression.activeRccName = "";
      system.progression.activeRccCategory = "";
      system.progression.activeClassExperience = 0;
      system.progression.attacksPerMelee = attacksPerMelee;
      system.progression.attacksPerMeleeBase = attacksPerMelee;
      system.progression.attacksPerMeleeProgressionBonus = 0;
      system.progression.attacksPerMeleeModifierBonus = 0;
      system.progression.classBonuses = { strike: 0, parry: 0, dodge: 0, initiative: 0 };
      system.progression.classEffectsSummary = "";
      system.progression.occEffectsSummary = "";
      system.progression.rccEffectsSummary = "";
      system.progression.classGrantedAbilities = [];
      system.progression.classGrantedSkills = [];
      system.progression.occStartingBionics = [];
      system.progression.occStartingCybernetics = [];
      system.progression.occStartingAbilities = [];
      system.progression.occStartingGear = [];
      system.progression.occStartingBionicsCount = 0;
      system.progression.occStartingCyberneticsCount = 0;
      system.progression.occAttributeRequirements = {};
      system.progression.occRequirementsMet = true;
      system.progression.occRequirementsUnmet = [];
      system.progression.occRequirementsSummary = "";
      system.progression.occSkillSelection = { occ: 0, related: 0, secondary: 0, occProgression: {}, relatedProgression: {}, secondaryProgression: {} };
      system.progression.occStartingResources = { hp: 0, sdc: 0, isp: 0, ppe: 0 };
      system.progression.occResourceProgression = { hpPerLevel: "", sdcPerLevel: "", ispPerLevel: "", ppePerLevel: "" };
      system.progression.occStartingPowers = { spells: [], psionics: [] };
      system.progression.occPowerProgression = { spellProgression: {}, psionicProgression: {} };
      system.progression.occStartingCredits = { credits: 0 };
      system.progression.occStartingResourcesInitializedForOccId = "";
      system.progression.occSkillsFromClass = [];
      system.progression.relatedSkillsFromClass = [];
      system.progression.secondarySkillsFromClass = [];
      system.progression.activeHandToHandId = "";
      system.progression.activeHandToHandName = "";
      system.progression.handToHandBonuses = {
        apmBonus: 0,
        initiativeBonus: 0,
        disarmBonus: 0,
        entangleBonus: 0,
        strikeBonus: 0,
        parryBonus: 0,
        dodgeBonus: 0,
        damageBonus: 0,
        autoDodgeLevel: 0,
        autoDodgeAvailable: false
      };
      system.progression.handToHandSpecialRules = foundry.utils.deepClone(getDefaultHandToHandSpecialRules());
      system.combat.autoDodgeAvailable = false;

      const mountedWeapons = getMountedWeaponSummaries(this);
      system.combat.derived.mountedWeapons = mountedWeapons;
      system.combat.derived.mountedWeaponCount = mountedWeapons.length;
      system.vehicle.derived.mountedWeapons = mountedWeapons;
      system.vehicle.derived.mountedWeaponCount = mountedWeapons.length;
    }

    system.combat.derived.equippedWeaponStrikeBonus = equippedWeaponStrikeBonus;
    system.combat.derived.equippedArmorAR = equippedArmorAR;
    system.combat.derived.activeWeaponId = activeWeapon?.id ?? "";
    system.combat.derived.activeArmorId = activeArmor?.id ?? "";
    system.combat.derived.classStrikeBonus = classBonuses.strike;
    system.combat.derived.classParryBonus = classBonuses.parry;
    system.combat.derived.classDodgeBonus = classBonuses.dodge;
    system.combat.derived.classInitiativeBonus = classBonuses.initiative;
    system.combat.derived.handToHandStyleId = activeHandToHand?.id ?? "";
    system.combat.derived.handToHandStyleName = activeHandToHand?.name ?? "";
    system.combat.derived.handToHandApmBonus = handToHandBonuses.apmBonus;
    system.combat.derived.handToHandInitiativeBonus = handToHandBonuses.initiativeBonus;
    system.combat.derived.handToHandDisarmBonus = handToHandBonuses.disarmBonus;
    system.combat.derived.handToHandEntangleBonus = handToHandBonuses.entangleBonus;
    system.combat.derived.handToHandStrikeBonus = handToHandBonuses.strikeBonus;
    system.combat.derived.handToHandParryBonus = handToHandBonuses.parryBonus;
    system.combat.derived.handToHandDodgeBonus = handToHandBonuses.dodgeBonus;
    system.combat.derived.handToHandDamageBonus = handToHandBonuses.damageBonus;
    system.combat.derived.handToHandAutoDodgeLevel = handToHandBonuses.autoDodgeLevel;
    system.combat.derived.handToHandSpecialRules = foundry.utils.deepClone(handToHandSpecialRules);
    system.combat.derived.handToHandCritRange = Math.max(17, Math.floor(num(handToHandSpecialRules.critRange, 20)));
    system.combat.derived.handToHandKnockoutStunRange = Math.max(0, Math.floor(num(handToHandSpecialRules.knockoutStunRange, 0)));
    system.combat.derived.handToHandDeathBlowRange = Math.max(0, Math.floor(num(handToHandSpecialRules.deathBlowRange, 0)));
    system.combat.derived.handToHandPullRollBonus = Math.max(0, Math.floor(num(handToHandSpecialRules.pullRollBonusValue, 0)));
    system.combat.derived.physicalSkillRollWithPunchBonus = Math.max(0, Math.floor(num(system.skills?.derived?.physical?.rollWithPunchBonus, 0)));
    system.combat.derived.physicalSkillKickAttack = system.skills?.derived?.physical?.kickAttack === true;
    system.combat.derived.physicalSkillKickDamageFormula = normalizeText(system.skills?.derived?.physical?.kickDamageFormula);
    system.combat.derived.physicalSkillCrushSqueeze = system.skills?.derived?.physical?.crushSqueeze === true;
    system.combat.derived.physicalSkillAutomaticKnockoutOn20 = system.skills?.derived?.physical?.automaticKnockoutOn20 === true;
    system.combat.derived.physicalSkillBodyBlockTackleDamage = normalizeText(system.skills?.derived?.physical?.bodyBlockTackleDamage);
    system.combat.derived.control = foundry.utils.deepClone(getCombatControlState(this));
    system.combat.derived.attacksPerMelee = attacksPerMelee;

    const effectiveDurability = getEffectiveActorScale(this, { activeArmor });
    system.combat.derived.effectiveDurability = effectiveDurability;
    system.combat.derived.effectiveDurabilityLabelKey = getScaleLabelKey(effectiveDurability);
    system.combat.derived.activeArmorDurability = normalizeScale(activeArmorDurability, "sdc");
    system.combat.derived.activeArmorDurabilityLabelKey = getScaleLabelKey(system.combat.derived.activeArmorDurability);
    // Backward compatibility keys retained for existing templates/macros.
    system.combat.derived.effectiveScale = system.combat.derived.effectiveDurability;
    system.combat.derived.effectiveScaleLabelKey = system.combat.derived.effectiveDurabilityLabelKey;
    system.combat.derived.activeArmorProtectionScale = system.combat.derived.activeArmorDurability;
    system.combat.derived.activeArmorProtectionScaleLabelKey = system.combat.derived.activeArmorDurabilityLabelKey;
    system.combat.derived.hasValidVehicleMdc = hasValidVehicleMdc(this);

    if (this.type === "vehicle") {
      system.combat.scale = "mdc";
      system.combat.isVehicleScale = true;
      system.combat.isMdcEntity = true;
    } else {
      system.combat.scale = normalizeScale(system.combat.scale, effectiveDurability);
      if (effectiveDurability === "mdc") system.combat.isMdcEntity = true;

    }

    const derivedApmTotal = Math.max(0, Math.floor(num(attacksPerMelee, num(system.combat.apmTotal, 0))));
    system.combat.apmTotal = derivedApmTotal;
    if (system.combat.apmSpent === 0 && system.combat.apmRemaining <= 0 && derivedApmTotal > 0) {
      system.combat.apmRemaining = derivedApmTotal;
    }

    system.combat.apmRemaining = Math.max(0, Math.floor(num(system.combat.apmRemaining, 0)));
    system.combat.apmSpent = Math.max(0, Math.floor(num(system.combat.apmSpent, 0)));
    if (system.combat.apmRemaining <= 0) {
      system.combat.reactionAvailable = false;
    }

    system.combat.derived.apmTotal = system.combat.apmTotal;
    system.combat.derived.apmRemaining = system.combat.apmRemaining;
    system.combat.derived.autoDodgeAvailable = system.combat.autoDodgeAvailable;
    system.combat.derived.heldAction = system.combat.heldAction;
    system.combat.derived.heldActionCount = system.combat.heldActionCount;
    system.combat.derived.heldActionReady = system.combat.heldActionReady;

    const spdValue = num(system.attributes?.spd?.value, 0);
    let outOfCombatMovement = Math.max(0, spdValue * 5);
    const movementApm = Math.max(1, num(system.combat.apmTotal, num(system.combat.derived.attacksPerMelee, 1)));
    let movementPerAction = outOfCombatMovement / movementApm;
    const movementUsedThisAction = Math.max(0, num(system.combat.movementUsedThisAction, 0));
    const combatControl = foundry.utils.getProperty(system, "combat.derived.control") ?? {};

    if (combatControl.movementBlocked === true) {
      outOfCombatMovement = 0;
      movementPerAction = 0;
    }

    system.combat.derived.outOfCombatMovement = outOfCombatMovement;
    system.combat.derived.movementPerAction = movementPerAction;
    system.combat.derived.movementUsedThisAction = movementUsedThisAction;
    system.combat.derived.movementRemainingThisAction = Math.max(0, movementPerAction - movementUsedThisAction);

    system.derived ??= {};
    if (this.type === "vehicle") {
      system.derived.occPackageBionicsCount = 0;
      system.derived.occPackageCyberneticsCount = 0;
    }
  }

  getActiveClass() {
    return getActiveClass(this);
  }

  getActiveClassItem() {
    return this.getActiveClass();
  }

  getActiveHandToHand() {
    return resolveActiveHandToHand(this);
  }

  getActiveHandToHandItem() {
    return this.getActiveHandToHand();
  }

  getActiveHandToHandSpecialRules(level = null) {
    const resolvedLevel = level === null || level === undefined
      ? Math.max(1, Math.floor(num(this.system?.derived?.level, num(this.system?.details?.level, 1))))
      : Math.max(1, Math.floor(num(level, 1)));
    return getHandToHandSpecialRules(this.getActiveHandToHandItem(), resolvedLevel);
  }


  getDerivedLevel() {
    return getDerivedLevel(this);
  }

  getClassSkillPackageSuggestions() {
    const activeClass = this.getActiveClassItem();
    if (!activeClass) {
      return {
        activeClass: null,
        sourceType: "",
        sourceId: "",
        occSkillsFromClass: [],
        relatedSkillsFromClass: [],
        secondarySkillsFromClass: []
      };
    }

    const packageData = getClassSkillPackage(activeClass);
    return {
      activeClass,
      sourceType: activeClass.type,
      sourceId: activeClass.id,
      occSkillsFromClass: packageData.occSkills,
      relatedSkillsFromClass: packageData.relatedSkills,
      secondarySkillsFromClass: packageData.secondarySkills
    };
  }

  getOccStartingAugmentationPackageSuggestions() {
    return getOccStartingAugmentationPackageSuggestions(this);
  }

  async addAugmentationFromOccPackage(packageType, index) {
    const itemType = resolveAugmentationPackageItemType(packageType);
    if (!itemType) return { status: "invalid-type" };

    const context = this.getOccStartingAugmentationPackageSuggestions();
    const activeOcc = context.activeOcc;
    if (!activeOcc) return { status: "no-occ" };

    const list = itemType === "bionic" ? context.bionics : context.cybernetics;
    const entry = list?.[Number(index)] ?? null;
    if (!entry) return { status: "invalid-index" };

    if (entry.duplicate) {
      return {
        status: "duplicate",
        duplicate: entry.duplicate
      };
    }

    const created = await this.createEmbeddedDocuments("Item", [{
      name: entry.name,
      type: itemType,
      img: entry.img || undefined,
      system: {
        installed: entry.installed === true,
        slot: normalizeText(entry.slot),
        sourceType: "occ",
        sourceId: activeOcc.id,
        sourceName: activeOcc.name,
        notes: normalizeText(entry.notes),
        effects: foundry.utils.deepClone(entry.effects ?? normalizeSharedEffects({})),
        grantedAbilities: foundry.utils.deepClone(entry.grantedAbilities ?? [])
      }
    }]);

    return {
      status: "created",
      created: created?.[0] ?? null,
      sourceType: "occ",
      sourceId: activeOcc.id,
      sourceName: activeOcc.name
    };
  }

  getMountedWeaponsSummary() {
    return getMountedWeaponSummaries(this);
  }

  async addSkillFromClassPackage(skillType, index) {
    const resolvedType = resolveClassSkillType(skillType);
    if (!resolvedType) return { status: "invalid-type" };

    const packageContext = this.getClassSkillPackageSuggestions();
    const activeClass = packageContext.activeClass;
    if (!activeClass) return { status: "no-class" };

    const list = packageContext[`${resolvedType.key}FromClass`] ?? packageContext[resolvedType.key] ?? [];
    const entry = list?.[Number(index)] ?? null;
    if (!entry) return { status: "invalid-index" };

    const sourceType = activeClass.type;
    const sourceId = activeClass.id;
    const skillName = normalizeText(entry.name);
    if (!skillName) return { status: "invalid-entry" };

    const duplicate = this.items.find((item) => {
      if (item.type !== "skill") return false;
      if (normalizeName(item.name) !== normalizeName(skillName)) return false;
      const itemSourceType = normalizeName(item.system?.sourceType);
      const itemSourceId = normalizeText(item.system?.sourceId);
      return itemSourceType === normalizeName(sourceType) && itemSourceId === sourceId;
    });

    if (duplicate) {
      return {
        status: "duplicate",
        duplicate
      };
    }

    const base = num(entry.base, 0);
    const perLevel = num(entry.perLevel, 0);
    const modifier = num(entry.modifier, 0);

    const itemData = {
      name: skillName,
      type: "skill",
      system: {
        description: "",
        category: normalizeText(entry.category),
        base,
        perLevel,
        modifier,
        isOCCSkill: resolvedType.key === "occSkills",
        isRelatedSkill: resolvedType.key === "relatedSkills",
        isSecondarySkill: resolvedType.key === "secondarySkills",
        sourceType,
        sourceId,
        notes: normalizeText(entry.notes)
      }
    };

    const created = await this.createEmbeddedDocuments("Item", [itemData]);
    return {
      status: "created",
      created: created[0] ?? null
    };
  }

  async applyOccStartingResources(occIdOrItem = null, options = {}) {
    if (!["character", "npc"].includes(this.type)) return { status: "invalid-actor" };
    let occItem = null;
    if (typeof occIdOrItem === "string") {
      occItem = this.items.get(occIdOrItem) ?? null;
    } else if (occIdOrItem && typeof occIdOrItem === "object") {
      occItem = occIdOrItem;
    }
    if (!occItem || occItem.type !== "occ") {
      occItem = resolveActiveClassByType(this, "occ");
    }
    if (!occItem || occItem.type !== "occ") return { status: "no-occ" };
    const initializedForOccId = normalizeText(this.system?.progression?.occStartingResourcesInitializedForOccId);
    if (initializedForOccId) {
      return { status: "already-initialized", occId: initializedForOccId };
    }
    const mechanical = getOCCMechanicalData(occItem, this.system?.attributes ?? {});
    const onlyWhenDefault = options.onlyWhenDefault !== false;
    if (onlyWhenDefault && !hasDefaultCharacterResourceState(this.system?.resources ?? {})) {
      return { status: "skipped-existing" };
    }
    const updates = {};
    const appliedPools = [];
    let appliedCredits = 0;
    const rollData = this.getRollData?.() ?? {};
    for (const key of OCC_RESOURCE_KEYS) {
      const rawStartValue = occItem?.system?.startingResources?.[key];
      const usedDefaultRule = isBlankClassValue(rawStartValue);
      const defaultFallback = key === "hp" && usedDefaultRule
        ? Math.max(0, Math.floor(num(this.system?.attributes?.pe?.value, 0)))
        : 0;
      const resourceInput = getOccStartingResourceInput(occItem, this, key, mechanical.startingResources?.[key], mechanical.resourceProgression ?? {});
      const resolved = await resolveRollableValue(resourceInput, { fallback: defaultFallback, rollData });
      const value = Math.max(0, Math.floor(num(resolved.value, 0)));
      if (resolved.mode === "invalid") {
        ui.notifications?.warn?.(`Invalid OCC ${String(key).toUpperCase()} formula on ${occItem.name}; treated as 0.`);
      }
      if (value <= 0) continue;
      updates["system.resources." + key + ".value"] = value;
      updates["system.resources." + key + ".max"] = value;
      appliedPools.push(key);
    }

    const resolvedCredits = await resolveRollableValue(mechanical.startingCredits?.credits, { fallback: 0, rollData });
    const creditsValue = Math.max(0, Math.floor(num(resolvedCredits.value, 0)));
    const currentCredits = Math.max(0, Math.floor(num(this.system?.details?.credits, 0)));
    if (resolvedCredits.mode === "invalid") {
      ui.notifications?.warn?.(`Invalid OCC starting credits formula on ${occItem.name}; treated as 0.`);
    } else if (creditsValue > 0 && (currentCredits <= 0 || options.overrideCredits === true)) {
      updates["system.details.credits"] = creditsValue;
      appliedCredits = creditsValue;
    }

    if (appliedPools.length <= 0 && appliedCredits <= 0) {
      return { status: "no-starting-resources" };
    }
    updates["system.progression.occStartingResourcesInitializedForOccId"] = occItem.id;
    await this.update(updates);
    return {
      status: "applied",
      occId: occItem.id,
      occName: occItem.name,
      appliedPools,
      appliedCredits
    };
  }
  async setClassXP(value = 0, options = {}) {
    const next = Math.max(0, Math.floor(num(value, 0)));
    const activeClass = this.getActiveClassItem();
    if (!activeClass) return null;

    const previousData = getProgressionData(this);
    const previous = Math.max(0, Math.floor(num(activeClass.system?.xp?.value, num(activeClass.system?.experience, 0))));

    await activeClass.update({
      "system.xp.value": next,
      "system.experience": next
    });

    await this.update({ "system.details.experience": next });

    const updatedLevel = getDerivedLevel(this);
    const levelUp = updatedLevel > previousData.level;

    if (options.announce === true) {
      const content = [
        `<p>${game.i18n.localize("RIFTS.Progression.XP")}: ${previous} -> ${next}</p>`,
        `<p>${game.i18n.localize("RIFTS.Progression.Level")}: ${updatedLevel}</p>`
      ];

      if (levelUp) {
        content.unshift(`<p><strong>${game.i18n.localize("RIFTS.Progression.LevelUp")}</strong></p>`);
      }

      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: this }),
        content: content.join("")
      });
    }

    return {
      classItemId: activeClass.id,
      classItemName: activeClass.name,
      previous,
      next,
      level: updatedLevel,
      levelUp
    };
  }

  async awardExperience(amount = 0) {
    const delta = Math.floor(num(amount, 0));
    if (!delta) return null;

    const activeClass = this.getActiveClassItem();
    if (!activeClass) return null;

    const current = Math.max(0, Math.floor(num(activeClass.system?.xp?.value, num(activeClass.system?.experience, 0))));
    const result = await this.setClassXP(current + delta, { announce: true });
    if (!result) return null;

    return {
      classItemId: result.classItemId,
      classItemName: result.classItemName,
      previous: current,
      next: result.next,
      delta,
      level: result.level,
      levelUp: result.levelUp
    };
  }

  getSkillTarget(skillOrId) {
    const skill = typeof skillOrId === "string" ? this.items.get(skillOrId) : skillOrId;
    const level = Math.max(1, Math.floor(num(this.system?.derived?.level, num(this.system?.details?.level, 1))));

    if (!skill) {
      return {
        level,
        base: 0,
        modifier: 0,
        classBonus: 0,
        automationBonus: 0,
        baseGrant: 0,
        perLevel: 0,
        target: 0,
        category: "",
        sourceType: ""
      };
    }

    const base = num(skill.system?.base, 0);
    const modifier = num(skill.system?.modifier, 0);
    const classBonus = getClassSkillBonus(this.getActiveClassItem(), skill);
    const automation = getPhysicalSkillRollAdjustments(this, skill);
    const perLevel = num(skill.system?.perLevel, 0);
    const levelBonus = perLevel * Math.max(level - 1, 0);
    const effectiveBase = Math.max(base, num(automation.baseGrant, 0));
    const automationBonus = num(automation.bonus, 0);
    const rawTarget = effectiveBase + modifier + classBonus + levelBonus + automationBonus;
    const target = Math.max(0, Math.floor(num(rawTarget, 0)));

    return {
      level,
      base: effectiveBase,
      originalBase: base,
      modifier,
      classBonus,
      automationBonus,
      baseGrant: num(automation.baseGrant, 0),
      perLevel,
      levelBonus,
      target,
      category: normalizeText(skill.system?.category),
      sourceType: normalizeText(skill.system?.sourceType)
    };
  }

  getWeaponProficiencyContext(weaponOrId, options = {}) {
    const weapon = typeof weaponOrId === "string" ? this.items.get(weaponOrId) : weaponOrId;
    return resolveWeaponProficiencyBonuses(this, weapon, options);
  }

  getEffectiveDurability() {
    return getEffectiveActorScale(this);
  }

  getEffectiveScale() {
    return this.getEffectiveDurability();
  }

  getApmTotal() {
    const derived = num(
      this.system?.combat?.derived?.attacksPerMelee,
      num(this.system?.progression?.attacksPerMelee, num(this.system?.combat?.apmTotal, 0))
    );

    return Math.max(0, Math.floor(derived));
  }

  hasAutoDodge() {
    return bool(this.system?.combat?.autoDodgeAvailable);
  }

  getHeldActionCount() {
    return Math.max(0, Math.floor(num(this.system?.combat?.heldActionCount, 0)));
  }

  canSpendAttack(amount = 1) {
    const spend = Math.max(1, Math.floor(num(amount, 1)));
    const total = Math.max(0, Math.floor(num(this.system?.combat?.apmTotal, this.getApmTotal())));
    const spent = Math.max(0, Math.floor(num(this.system?.combat?.apmSpent, 0)));
    let remaining = Math.max(0, Math.floor(num(this.system?.combat?.apmRemaining, 0)));

    if (remaining <= 0 && spent === 0 && total > 0) {
      remaining = total;
    }

    return remaining >= spend;
  }

  async spendAttack(actionType = "action", amount = 1) {
    const spend = Math.max(1, Math.floor(num(amount, 1)));
    const total = Math.max(0, Math.floor(num(this.system?.combat?.apmTotal, this.getApmTotal())));
    let spent = Math.max(0, Math.floor(num(this.system?.combat?.apmSpent, 0)));
    let remaining = Math.max(0, Math.floor(num(this.system?.combat?.apmRemaining, 0)));

    if (remaining <= 0 && spent === 0 && total > 0) {
      remaining = total;
    }

    if (remaining < spend) {
      return {
        ok: false,
        total,
        remaining,
        spent,
        actionType: normalizeText(actionType) || "action"
      };
    }

    remaining -= spend;
    spent += spend;
    const normalizedActionType = normalizeText(actionType) || "action";

    await this.update({
      "system.combat.apmTotal": total,
      "system.combat.apmRemaining": remaining,
      "system.combat.apmSpent": spent,
      "system.combat.lastActionType": normalizedActionType,
      "system.combat.reactionAvailable": remaining > 0
    });

    return {
      ok: true,
      total,
      remaining,
      spent,
      actionType: normalizedActionType
    };
  }

  async resetAPM() {
    const total = this.getApmTotal();
    await this.update({
      "system.combat.apmTotal": total,
      "system.combat.apmRemaining": total,
      "system.combat.apmSpent": 0,
      "system.combat.lastActionType": "reset",
      "system.combat.reactionAvailable": true
    });

    return {
      total,
      remaining: total,
      spent: 0
    };
  }

  async addAPM(amount = 1) {
    if (!this._canUseGMRecoveryControls()) {
      return {
        ok: false,
        total: this.getApmTotal(),
        remaining: Math.max(0, Math.floor(num(this.system?.combat?.apmRemaining, 0))),
        spent: Math.max(0, Math.floor(num(this.system?.combat?.apmSpent, 0))),
        added: 0
      };
    }

    const delta = Math.max(1, Math.floor(num(amount, 1)));
    const total = Math.max(0, Math.floor(num(this.system?.combat?.apmTotal, this.getApmTotal())));
    let spent = Math.max(0, Math.floor(num(this.system?.combat?.apmSpent, 0)));
    let remaining = Math.max(0, Math.floor(num(this.system?.combat?.apmRemaining, 0)));

    if (remaining <= 0 && spent === 0 && total > 0) {
      remaining = total;
    }

    remaining += delta;
    if (total > 0) {
      spent = Math.max(0, total - remaining);
    }

    await this.update({
      "system.combat.apmTotal": total,
      "system.combat.apmRemaining": remaining,
      "system.combat.apmSpent": spent,
      "system.combat.lastActionType": "add-apm",
      "system.combat.reactionAvailable": remaining > 0
    });

    return {
      ok: true,
      total,
      remaining,
      spent,
      added: delta
    };
  }

  _canUseGMRecoveryControls() {
    if (game.user?.isGM) return true;
    ui.notifications.warn(game.i18n.localize("RIFTS.Recovery.GMOnly"));
    return false;
  }

  _getRestorableResourcePools() {
    const keys = ["hp", "sdc", "mdc", "ppe", "isp"];
    const pools = [];

    for (const key of keys) {
      const value = num(this.system?.resources?.[key]?.value, NaN);
      const max = num(this.system?.resources?.[key]?.max, NaN);
      if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) continue;
      pools.push({ key, value: Math.max(0, value), max: Math.max(0, max) });
    }

    return pools;
  }

  async applyShortRest() {
    if (!this._canUseGMRecoveryControls()) return { ok: false, reason: "gm-only" };

    const updates = {};
    let changed = 0;

    for (const pool of this._getRestorableResourcePools()) {
      const restore = Math.max(0, Math.floor(pool.max / 2));
      if (restore <= 0) continue;

      const after = Math.min(pool.max, pool.value + restore);
      if (after === pool.value) continue;

      updates[`system.resources.${pool.key}.value`] = after;
      changed += 1;
    }

    if (changed <= 0) {
      ui.notifications.info(game.i18n.localize("RIFTS.Recovery.NoChanges"));
      return { ok: true, changed: 0 };
    }

    await this.update(updates);
    ui.notifications.info(game.i18n.format("RIFTS.Recovery.ShortRestApplied", {
      actor: this.name,
      count: changed
    }));

    return { ok: true, changed };
  }

  async applyFullRest() {
    if (!this._canUseGMRecoveryControls()) return { ok: false, reason: "gm-only" };

    const updates = {};
    let changed = 0;

    for (const pool of this._getRestorableResourcePools()) {
      if (pool.value >= pool.max) continue;
      updates[`system.resources.${pool.key}.value`] = pool.max;
      changed += 1;
    }

    if (changed <= 0) {
      ui.notifications.info(game.i18n.localize("RIFTS.Recovery.NoChanges"));
      return { ok: true, changed: 0 };
    }

    await this.update(updates);
    ui.notifications.info(game.i18n.format("RIFTS.Recovery.FullRestApplied", {
      actor: this.name,
      count: changed
    }));

    return { ok: true, changed };
  }

  async repairAllArmor() {
    if (!this._canUseGMRecoveryControls()) return { ok: false, reason: "gm-only" };

    const armorItems = this.items.filter((item) => item.type === "armor");
    if (armorItems.length === 0) {
      ui.notifications.info(game.i18n.localize("RIFTS.Sheet.NoArmor"));
      return { ok: true, items: 0, pools: 0 };
    }

    const updates = [];
    let repairedItems = 0;
    let repairedPools = 0;

    for (const armor of armorItems) {
      const itemUpdate = {};

      for (const poolKey of ["sdc", "mdc"]) {
        const nestedPath = `system.armor.${poolKey}`;
        const flatPath = `system.${poolKey}`;

        const nestedValue = foundry.utils.getProperty(armor, `${nestedPath}.value`);
        const nestedMax = foundry.utils.getProperty(armor, `${nestedPath}.max`);
        const hasNested = nestedValue !== undefined || nestedMax !== undefined;

        const current = hasNested
          ? num(nestedValue, 0)
          : num(foundry.utils.getProperty(armor, `${flatPath}.value`), 0);
        const max = hasNested
          ? num(nestedMax, current)
          : num(foundry.utils.getProperty(armor, `${flatPath}.max`), current);

        if (!Number.isFinite(max) || max <= 0) continue;
        if (current >= max) continue;

        const updatePath = hasNested ? `${nestedPath}.value` : `${flatPath}.value`;
        itemUpdate[updatePath] = max;
        repairedPools += 1;
      }

      if (Object.keys(itemUpdate).length > 0) {
        repairedItems += 1;
        updates.push(armor.update(itemUpdate));
      }
    }

    if (updates.length <= 0) {
      ui.notifications.info(game.i18n.localize("RIFTS.Recovery.NoChanges"));
      return { ok: true, items: 0, pools: 0 };
    }

    await Promise.all(updates);
    ui.notifications.info(game.i18n.format("RIFTS.Recovery.ArmorRepairApplied", {
      actor: this.name,
      items: repairedItems,
      pools: repairedPools
    }));

    return { ok: true, items: repairedItems, pools: repairedPools };
  }

  async activatePower(powerId, options = {}) {
    const powerItem = this.items.get(powerId);
    return activatePower(this, powerItem, options);
  }

  async deactivatePower(powerId) {
    const powerItem = this.items.get(powerId);
    return deactivatePower(this, powerItem);
  }
  async rollAttribute3d6(attributeKey) {
    const mod = num(this.system?.attributes?.[attributeKey]?.mod, 0);
    return rollAttribute3d6(attributeKey, { actor: this, mod });
  }

  async rollStrike() {
    return rollStrike({ actor: this });
  }

  async rollParry() {
    return rollParry({ actor: this });
  }

  async rollDodge() {
    return rollDodge({ actor: this });
  }

  async rollInitiative(options = {}) {
    return rollInitiative({
      actor: this,
      preferCombat: options.preferCombat ?? false,
      tokenId: options.tokenId ?? ""
    });
  }

  async rollSkill(skillId) {
    return rollSkill(skillId, {
      actor: this,
      breakdown: this.getSkillTarget(skillId)
    });
  }

  async rollPhysicalSkillBonuses(skillId, { reroll = false } = {}) {
    const skill = typeof skillId === "string" ? this.items.get(skillId) : skillId;
    if (!skill || skill.type !== "skill") return null;

    const automationType = String(skill.system?.automationType ?? "").trim();
    if (automationType !== "physical") return null;

    const rollableEffects = normalizeSkillRollableEffects(skill.system?.rollableEffects);
    if (!hasSkillRollableEffects(rollableEffects)) return null;

    const alreadyResolved = hasResolvedSkillEffects(skill.system?.resolvedEffects);
    if (alreadyResolved && reroll !== true) {
      ui.notifications.warn(game.i18n.localize("RIFTS.Skills.BonusesAlreadyRolled"));
      return null;
    }

    const resolvedEffects = defaultSkillEffects();
    const rollSummaries = [];
    const rollData = this.getRollData?.() ?? {};

    for (const [groupKey, groupValues] of Object.entries(rollableEffects)) {
      if (!groupValues || typeof groupValues !== "object") continue;

      for (const [effectKey, rawFormula] of Object.entries(groupValues)) {
        const formula = normalizeText(rawFormula);
        if (!formula) continue;

        const result = await resolveRollableValue(formula, { fallback: 0, rollData });
        resolvedEffects[groupKey][effectKey] = Math.max(0, Math.floor(num(result.value, 0)));
        rollSummaries.push({
          label: getEffectRollLabel(groupKey, effectKey),
          formula,
          value: Math.max(0, Math.floor(num(result.value, 0)))
        });
      }
    }

    await skill.update({ "system.resolvedEffects": resolvedEffects });

    const summary = formatAugmentationSummary(resolvedEffects) || game.i18n.localize("RIFTS.Sheet.None");
    const content = [
      `<h3>${game.i18n.localize("RIFTS.Skills.RollBonuses")}: ${skill.name}</h3>`,
      ...rollSummaries.map((entry) => `<p><strong>${entry.label}</strong>: ${entry.formula} = ${entry.value}</p>`),
      `<p><strong>${game.i18n.localize("RIFTS.Sheet.PassiveEffects")}:</strong> ${summary}</p>`
    ];

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: this }),
      content: content.join("")
    });

    return {
      skillId: skill.id,
      skillName: skill.name,
      resolvedEffects,
      summary
    };
  }

  async attackWithWeapon(weaponId, options = {}) {
    return attackWithWeapon({
      attacker: this,
      weaponId,
      attackAction: options.attackAction ?? "standard",
      tokenId: options.tokenId ?? ""
    });
  }

  async rollWeaponAttack(weaponId, options = {}) {
    return this.attackWithWeapon(weaponId, options);
  }

  async rollUnarmedManeuver(maneuverKey, options = {}) {
    return attackWithUnarmedManeuver({
      attacker: this,
      maneuverKey,
      tokenId: options.tokenId ?? ""
    });
  }
  getHandToHandManeuverContext() {
    return getAvailableManeuversFromActiveStyle(this);
  }

  getAvailableCombatManeuverContext() {
    const explicitGranted = Array.isArray(this.system?.derived?.grantedAbilities)
      ? this.system.derived.grantedAbilities
      : null;

    return getAvailableCombatManeuverContext(this, {
      grantedAbilities: explicitGranted
    });
  }

  async addManeuverFromHandToHandPackage(packageIndex) {
    return addManeuverFromActiveStyle(this, packageIndex);
  }

  hasSpecialManeuver(maneuverKey) {
    return actorHasSpecialManeuver(this, maneuverKey);
  }

  getSpecialManeuverByKey(maneuverKey) {
    const normalized = normalizeSpecialManeuverKey(maneuverKey);
    if (!normalized) return null;

    return this.items.find((item) => {
      if (item.type !== "specialManeuver") return false;
      const itemKey = normalizeSpecialManeuverKey(item.system?.key ?? item.name);
      return itemKey === normalized;
    }) ?? null;
  }

  getGrantedManeuverByKey(maneuverKey) {
    const normalized = normalizeSpecialManeuverKey(maneuverKey);
    if (!normalized) return null;

    const context = this.getAvailableCombatManeuverContext();
    return context.availableManeuvers.find((entry) => {
      if (entry.isOwned === true) return false;
      const itemKey = normalizeSpecialManeuverKey(entry.key ?? entry.name);
      return itemKey === normalized;
    }) ?? null;
  }

  async useSpecialManeuver(maneuverIdOrItem, options = {}) {
    return useSpecialManeuver(this, maneuverIdOrItem, options);
  }

  async useSpecialManeuverByKey(maneuverKey, options = {}) {
    const maneuverItem = this.getSpecialManeuverByKey(maneuverKey);
    if (maneuverItem) return this.useSpecialManeuver(maneuverItem, options);

    const granted = this.getGrantedManeuverByKey(maneuverKey);
    if (!granted) return { status: "not-available" };
    return this.useSpecialManeuver(granted, options);
  }
}














