const EFFECT_ATTRIBUTE_KEYS = ["iq", "me", "ma", "ps", "pp", "pe", "pb", "spd"];
const EFFECT_COMBAT_KEYS = ["strike", "parry", "dodge", "initiative", "apm"];
const EFFECT_RESOURCE_KEYS = ["hp", "sdc", "mdc", "ppe", "isp"];

export const SKILL_AUTOMATION_TYPES = Object.freeze({
  none: "",
  physical: "physical",
  weaponProficiency: "weaponProficiency"
});

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function text(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function normalizeName(value) {
  return text(value).toLowerCase();
}

function bool(value) {
  return value === true || normalizeName(value) === "true" || num(value, 0) > 0;
}

function getActorLevel(actor) {
  return Math.max(1, Math.floor(num(actor?.system?.derived?.level, num(actor?.system?.details?.level, 1))));
}

function createEffectTotals(keys = []) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function parseProgressionInput(rawProgression) {
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
  }

  if (rawProgression && typeof rawProgression === "object") return rawProgression;
  return [];
}

function normalizeNumericProgressionArray(rawProgression) {
  const parsed = parseProgressionInput(rawProgression);

  if (Array.isArray(parsed)) {
    return parsed.map((entry) => num(entry, NaN));
  }

  if (parsed && typeof parsed === "object") {
    const values = [];
    for (const [thresholdKey, value] of Object.entries(parsed)) {
      const threshold = Math.max(1, Math.floor(num(thresholdKey, 0)));
      if (!Number.isFinite(threshold) || threshold <= 0) continue;
      values[threshold - 1] = num(value, NaN);
    }
    return values;
  }

  return [];
}

function compareSimpleDamageFormula(a = "", b = "") {
  const pattern = /^(\d+)d(\d+)(?:\s*([+-])\s*(\d+))?$/i;
  const matchA = text(a).match(pattern);
  const matchB = text(b).match(pattern);
  if (!matchA || !matchB) return 0;

  const average = (match) => {
    const dice = num(match[1], 0);
    const faces = num(match[2], 0);
    const sign = match[3] === "-" ? -1 : 1;
    const flat = num(match[4], 0) * sign;
    return dice * ((faces + 1) / 2) + flat;
  };

  return average(matchA) - average(matchB);
}

export function resolveNumericProgressionValueAtLevel(rawProgression, level, fallback = 0) {
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

export function defaultSkillEffects() {
  return {
    attributes: createEffectTotals(EFFECT_ATTRIBUTE_KEYS),
    combat: createEffectTotals(EFFECT_COMBAT_KEYS),
    resources: createEffectTotals(EFFECT_RESOURCE_KEYS),
    flags: {}
  };
}

export function defaultSkillRollableEffects() {
  return {
    attributes: Object.fromEntries(EFFECT_ATTRIBUTE_KEYS.map((key) => [key, ""])),
    combat: Object.fromEntries(EFFECT_COMBAT_KEYS.map((key) => [key, ""])),
    resources: Object.fromEntries(EFFECT_RESOURCE_KEYS.map((key) => [key, ""]))
  };
}

export function normalizeSkillEffects(rawEffects) {
  let effects = rawEffects;
  if (typeof effects === "string") {
    const trimmed = effects.trim();
    if (trimmed) {
      try {
        effects = JSON.parse(trimmed);
      } catch (_error) {
        effects = {};
      }
    }
  }

  effects = effects && typeof effects === "object" && !Array.isArray(effects)
    ? effects
    : {};

  const normalized = defaultSkillEffects();

  for (const key of EFFECT_ATTRIBUTE_KEYS) {
    normalized.attributes[key] = num(effects?.attributes?.[key], 0);
  }

  for (const key of EFFECT_COMBAT_KEYS) {
    normalized.combat[key] = num(effects?.combat?.[key], 0);
  }

  for (const key of EFFECT_RESOURCE_KEYS) {
    normalized.resources[key] = num(effects?.resources?.[key], 0);
  }

  for (const [flagKey, rawEnabled] of Object.entries(effects?.flags ?? {})) {
    const normalizedFlag = text(flagKey);
    if (!normalizedFlag) continue;
    if (bool(rawEnabled)) normalized.flags[normalizedFlag] = true;
  }

  return normalized;
}

export function normalizeSkillRollableEffects(rawEffects) {
  let effects = rawEffects;
  if (typeof effects === "string") {
    const trimmed = effects.trim();
    if (trimmed) {
      try {
        effects = JSON.parse(trimmed);
      } catch (_error) {
        effects = {};
      }
    }
  }

  effects = effects && typeof effects === "object" && !Array.isArray(effects)
    ? effects
    : {};

  const normalized = defaultSkillRollableEffects();

  for (const key of EFFECT_ATTRIBUTE_KEYS) {
    normalized.attributes[key] = text(effects?.attributes?.[key]);
  }

  for (const key of EFFECT_COMBAT_KEYS) {
    normalized.combat[key] = text(effects?.combat?.[key]);
  }

  for (const key of EFFECT_RESOURCE_KEYS) {
    normalized.resources[key] = text(effects?.resources?.[key]);
  }

  return normalized;
}

export function hasSkillRollableEffects(rawEffects) {
  const effects = normalizeSkillRollableEffects(rawEffects);
  for (const group of [effects.attributes, effects.combat, effects.resources]) {
    for (const value of Object.values(group ?? {})) {
      if (text(value).length > 0) return true;
    }
  }
  return false;
}

export function defaultPhysicalSkillRules() {
  return {
    rollWithPunchBonus: 0,
    climbBonus: 0,
    climbBaseGrant: 0,
    prowlBonus: 0,
    prowlBaseGrant: 0,
    kickAttack: false,
    kickDamageFormula: "",
    crushSqueeze: false,
    automaticKnockoutOn20: false,
    bodyBlockTackleDamage: ""
  };
}

export function normalizePhysicalSkillRules(rawRules) {
  let rules = rawRules;
  if (typeof rules === "string") {
    const trimmed = rules.trim();
    if (trimmed) {
      try {
        rules = JSON.parse(trimmed);
      } catch (_error) {
        rules = {};
      }
    }
  }

  rules = rules && typeof rules === "object" && !Array.isArray(rules)
    ? rules
    : {};

  return {
    rollWithPunchBonus: Math.max(0, Math.floor(num(rules.rollWithPunchBonus, 0))),
    climbBonus: Math.max(0, Math.floor(num(rules.climbBonus, 0))),
    climbBaseGrant: Math.max(0, Math.floor(num(rules.climbBaseGrant, 0))),
    prowlBonus: Math.max(0, Math.floor(num(rules.prowlBonus, 0))),
    prowlBaseGrant: Math.max(0, Math.floor(num(rules.prowlBaseGrant, 0))),
    kickAttack: rules.kickAttack === true,
    kickDamageFormula: text(rules.kickDamageFormula),
    crushSqueeze: rules.crushSqueeze === true,
    automaticKnockoutOn20: rules.automaticKnockoutOn20 === true,
    bodyBlockTackleDamage: text(rules.bodyBlockTackleDamage)
  };
}

export function normalizeSkillAutomationType(value) {
  const normalized = normalizeName(value);
  if (["physical", "physicalskill", "physicalskills"].includes(normalized)) return SKILL_AUTOMATION_TYPES.physical;
  if (["weaponproficiency", "weaponproficiencies", "wp", "proficiency"].includes(normalized)) return SKILL_AUTOMATION_TYPES.weaponProficiency;
  return SKILL_AUTOMATION_TYPES.none;
}

export function normalizeWeaponProficiencyKey(value) {
  const normalized = normalizeName(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) return "";
  return normalized.startsWith("wp-") ? normalized : `wp-${normalized}`;
}

export function defaultWeaponProficiencyData() {
  return {
    proficiencyKey: "",
    classification: "modern",
    allowedParry: false,
    strikeProgression: [],
    parryProgression: [],
    thrownProgression: [],
    rangeProgression: []
  };
}

export function normalizeWeaponProficiencyData(rawValue) {
  let value = rawValue;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      try {
        value = JSON.parse(trimmed);
      } catch (_error) {
        value = {};
      }
    }
  }

  value = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};

  const classification = ["ancient", "modern"].includes(normalizeName(value.classification))
    ? normalizeName(value.classification)
    : "modern";
  const explicitAllowedParry = value.allowedParry !== undefined ? bool(value.allowedParry) : null;

  return {
    proficiencyKey: normalizeWeaponProficiencyKey(value.proficiencyKey ?? value.key),
    classification,
    allowedParry: explicitAllowedParry === null ? classification === "ancient" : explicitAllowedParry,
    strikeProgression: normalizeNumericProgressionArray(value.strikeProgression),
    parryProgression: normalizeNumericProgressionArray(value.parryProgression),
    thrownProgression: normalizeNumericProgressionArray(value.thrownProgression),
    rangeProgression: normalizeNumericProgressionArray(value.rangeProgression)
  };
}

export function isPhysicalSkill(skill) {
  return normalizeSkillAutomationType(skill?.system?.automationType) === SKILL_AUTOMATION_TYPES.physical;
}

export function isWeaponProficiencySkill(skill) {
  return normalizeSkillAutomationType(skill?.system?.automationType) === SKILL_AUTOMATION_TYPES.weaponProficiency;
}

function choosePreferredBodyBlockDamage(current = "", candidate = "") {
  const currentText = text(current);
  const candidateText = text(candidate);
  if (!candidateText) return currentText;
  if (!currentText) return candidateText;
  return compareSimpleDamageFormula(candidateText, currentText) > 0 ? candidateText : currentText;
}

function choosePreferredKickDamage(current = "", candidate = "") {
  const currentText = text(current);
  const candidateText = text(candidate);
  if (!candidateText) return currentText;
  if (!currentText) return candidateText;
  return compareSimpleDamageFormula(candidateText, currentText) > 0 ? candidateText : currentText;
}

export function aggregatePhysicalSkillAutomation(actor) {
  const effects = defaultSkillEffects();
  const rules = defaultPhysicalSkillRules();
  const items = [];

  const skills = actor?.items?.filter?.((item) => item.type === "skill" && isPhysicalSkill(item)) ?? [];
  for (const item of skills) {
    const normalizedEffects = normalizeSkillEffects(item.system?.effects);
    const resolvedEffects = normalizeSkillEffects(item.system?.resolvedEffects);
    const normalizedRules = normalizePhysicalSkillRules(item.system?.physical);
    const hasResolvedRolls = [
      ...Object.values(resolvedEffects.attributes ?? {}),
      ...Object.values(resolvedEffects.combat ?? {}),
      ...Object.values(resolvedEffects.resources ?? {})
    ].some((value) => num(value, 0) !== 0);

    for (const key of EFFECT_ATTRIBUTE_KEYS) {
      effects.attributes[key] += num(normalizedEffects.attributes?.[key], 0) + num(resolvedEffects.attributes?.[key], 0);
    }
    for (const key of EFFECT_COMBAT_KEYS) {
      effects.combat[key] += num(normalizedEffects.combat?.[key], 0) + num(resolvedEffects.combat?.[key], 0);
    }
    for (const key of EFFECT_RESOURCE_KEYS) {
      effects.resources[key] += num(normalizedEffects.resources?.[key], 0) + num(resolvedEffects.resources?.[key], 0);
    }
    for (const [flagKey, enabled] of Object.entries(normalizedEffects.flags ?? {})) {
      if (enabled === true) effects.flags[flagKey] = true;
    }

    rules.rollWithPunchBonus += normalizedRules.rollWithPunchBonus;
    rules.climbBonus += normalizedRules.climbBonus;
    rules.climbBaseGrant = Math.max(rules.climbBaseGrant, normalizedRules.climbBaseGrant);
    rules.prowlBonus += normalizedRules.prowlBonus;
    rules.prowlBaseGrant = Math.max(rules.prowlBaseGrant, normalizedRules.prowlBaseGrant);
    rules.kickAttack ||= normalizedRules.kickAttack === true;
    rules.kickDamageFormula = choosePreferredKickDamage(rules.kickDamageFormula, normalizedRules.kickDamageFormula);
    rules.crushSqueeze ||= normalizedRules.crushSqueeze === true;
    rules.automaticKnockoutOn20 ||= normalizedRules.automaticKnockoutOn20 === true;
    rules.bodyBlockTackleDamage = choosePreferredBodyBlockDamage(rules.bodyBlockTackleDamage, normalizedRules.bodyBlockTackleDamage);

    items.push({
      id: item.id,
      name: item.name,
      category: text(item.system?.category),
      hasRollableEffects: hasSkillRollableEffects(item.system?.rollableEffects),
      rollableEffectsApplied: hasResolvedRolls
    });
  }

  return {
    count: items.length,
    items,
    effects,
    rules
  };
}

function getDerivedPhysicalSkillRules(actor) {
  const derived = actor?.system?.skills?.derived?.physical?.rules;
  return derived && typeof derived === "object"
    ? normalizePhysicalSkillRules(derived)
    : aggregatePhysicalSkillAutomation(actor).rules;
}

export function getPhysicalSkillRollWithPunchBonus(actor) {
  return Math.max(0, Math.floor(num(getDerivedPhysicalSkillRules(actor).rollWithPunchBonus, 0)));
}

export function getPhysicalSkillUnarmedRules(actor) {
  const rules = getDerivedPhysicalSkillRules(actor);
  return {
    kickAttack: rules.kickAttack === true,
    kickDamageFormula: text(rules.kickDamageFormula),
    crushSqueeze: rules.crushSqueeze === true,
    automaticKnockoutOn20: rules.automaticKnockoutOn20 === true,
    bodyBlockTackleDamage: text(rules.bodyBlockTackleDamage)
  };
}

export function getPhysicalSkillRollAdjustments(actor, skill) {
  const rules = getDerivedPhysicalSkillRules(actor);
  const skillName = normalizeName(skill?.name);

  if (skillName.includes("climb")) {
    return {
      matchType: "climb",
      bonus: Math.max(0, Math.floor(num(rules.climbBonus, 0))),
      baseGrant: Math.max(0, Math.floor(num(rules.climbBaseGrant, 0)))
    };
  }

  if (skillName.includes("prowl")) {
    return {
      matchType: "prowl",
      bonus: Math.max(0, Math.floor(num(rules.prowlBonus, 0))),
      baseGrant: Math.max(0, Math.floor(num(rules.prowlBaseGrant, 0)))
    };
  }

  return {
    matchType: "",
    bonus: 0,
    baseGrant: 0
  };
}

export function resolveWeaponProficiencyBonuses(actor, weapon, { level = null, useParry = false } = {}) {
  const proficiencyKey = normalizeWeaponProficiencyKey(weapon?.system?.weapon?.proficiencyKey);
  const actorLevel = Math.max(1, Math.floor(num(level, getActorLevel(actor))));

  const base = {
    proficiencyKey,
    matched: false,
    skillId: "",
    skillName: "",
    classification: "",
    allowedParry: false,
    strikeBonus: 0,
    parryBonus: 0,
    thrownBonus: 0,
    rangeBonus: 0,
    appliedStrikeBonus: 0,
    appliedParryBonus: 0
  };

  if (!proficiencyKey || !actor) return base;

  const candidates = actor.items
    .filter((item) => item.type === "skill" && isWeaponProficiencySkill(item))
    .map((item) => ({
      item,
      data: normalizeWeaponProficiencyData(item.system?.weaponProficiency)
    }))
    .filter((entry) => entry.data.proficiencyKey === proficiencyKey);

  if (candidates.length <= 0) return base;

  const resolved = candidates
    .map((entry) => {
      const strikeBonus = Math.floor(num(resolveNumericProgressionValueAtLevel(entry.data.strikeProgression, actorLevel, 0), 0));
      const parryBonus = Math.floor(num(resolveNumericProgressionValueAtLevel(entry.data.parryProgression, actorLevel, 0), 0));
      const thrownBonus = Math.floor(num(resolveNumericProgressionValueAtLevel(entry.data.thrownProgression, actorLevel, 0), 0));
      const rangeBonus = Math.floor(num(resolveNumericProgressionValueAtLevel(entry.data.rangeProgression, actorLevel, 0), 0));
      const attackType = normalizeName(weapon?.system?.weapon?.attackType);
      const appliedStrikeBonus = strikeBonus + (attackType === "thrown" ? thrownBonus : 0);
      const appliedParryBonus = entry.data.allowedParry ? parryBonus : 0;

      return {
        item: entry.item,
        data: entry.data,
        strikeBonus,
        parryBonus,
        thrownBonus,
        rangeBonus,
        appliedStrikeBonus,
        appliedParryBonus,
        rating: (useParry ? appliedParryBonus : appliedStrikeBonus) + rangeBonus
      };
    })
    .sort((a, b) => b.rating - a.rating || String(a.item.name ?? "").localeCompare(String(b.item.name ?? "")));

  const best = resolved[0];
  return {
    proficiencyKey,
    matched: true,
    skillId: best.item.id,
    skillName: best.item.name,
    classification: best.data.classification,
    allowedParry: best.data.allowedParry === true,
    strikeBonus: best.strikeBonus,
    parryBonus: best.parryBonus,
    thrownBonus: best.thrownBonus,
    rangeBonus: best.rangeBonus,
    appliedStrikeBonus: best.appliedStrikeBonus,
    appliedParryBonus: best.appliedParryBonus
  };
}
