import { getPhysicalSkillUnarmedRules } from "./skill-automation.mjs";

const UNARMED_PREFIX = "unarmed:";

const UNARMED_MANEUVERS = {
  punch: {
    key: "punch",
    labelKey: "RIFTS.Unarmed.Punch",
    actionCost: 1,
    damageFormula: "1d4",
    strikeModifier: 0,
    canKnockdown: false,
    canKnockback: false,
    knockbackValue: 0,
    impactType: "",
    descriptionKey: "RIFTS.Unarmed.Strike",
    specialRulesKey: ""
  },
  kick: {
    key: "kick",
    labelKey: "RIFTS.Unarmed.Kick",
    actionCost: 1,
    damageFormula: "1d6",
    strikeModifier: 0,
    canKnockdown: false,
    canKnockback: false,
    knockbackValue: 0,
    impactType: "",
    descriptionKey: "RIFTS.Unarmed.Strike",
    specialRulesKey: ""
  },
  bodyThrow: {
    key: "bodyThrow",
    labelKey: "RIFTS.Unarmed.BodyThrow",
    actionCost: 1,
    damageFormula: "1d6",
    strikeModifier: 0,
    canKnockdown: true,
    canKnockback: false,
    knockbackValue: 0,
    impactType: "slammed",
    descriptionKey: "RIFTS.Unarmed.Strike",
    specialRulesKey: "RIFTS.Unarmed.BodyThrowImpactHint",
    requiresRule: "bodyThrow"
  },
  bodyBlock: {
    key: "bodyBlock",
    labelKey: "RIFTS.Unarmed.BodyBlock",
    actionCost: 1,
    damageFormula: "1d4",
    strikeModifier: 0,
    canKnockdown: true,
    canKnockback: true,
    knockbackValue: 1,
    impactType: "slammed",
    descriptionKey: "RIFTS.Unarmed.Strike",
    specialRulesKey: "RIFTS.Unarmed.BodyBlockImpactHint"
  },
  crushSqueeze: {
    key: "crushSqueeze",
    labelKey: "RIFTS.Unarmed.CrushSqueeze",
    actionCost: 1,
    damageFormula: "1d4",
    strikeModifier: 0,
    canKnockdown: false,
    canKnockback: false,
    knockbackValue: 0,
    impactType: "",
    descriptionKey: "RIFTS.Unarmed.Strike",
    specialRulesKey: "RIFTS.Unarmed.CrushSqueezeHint",
    requiresPhysicalRule: "crushSqueeze"
  }
};

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function localize(key, fallback = "") {
  if (!key) return fallback;
  return game?.i18n ? game.i18n.localize(key) : key;
}

function getActiveHandToHandSpecialRules(actor) {
  const derived = actor?.system?.combat?.derived?.handToHandSpecialRules;
  if (derived && typeof derived === "object") return derived;

  const progression = actor?.system?.progression?.handToHandSpecialRules;
  if (progression && typeof progression === "object") return progression;

  return null;
}

export function normalizeManeuverKey(value) {
  const key = String(value ?? "").trim().toLowerCase();
  if (["punch"].includes(key)) return "punch";
  if (["kick"].includes(key)) return "kick";
  if (["bodythrow", "body-throw", "bodyflip", "body-flip", "throw", "flip"].includes(key)) return "bodyThrow";
  if (["bodyblock", "body-block", "tackle", "bodyblocktackle"].includes(key)) return "bodyBlock";
  if (["crushsqueeze", "crush-squeeze", "crush squeeze", "squeeze", "crush"].includes(key)) return "crushSqueeze";
  return key;
}

function formatDamageFormula(base, bonus = 0) {
  const normalizedBase = String(base ?? "1d4").trim() || "1d4";
  const totalBonus = Math.trunc(num(bonus, 0));
  if (!totalBonus) return normalizedBase;
  if (totalBonus > 0) return `${normalizedBase} + ${totalBonus}`;
  return `${normalizedBase} - ${Math.abs(totalBonus)}`;
}

export function getUnarmedManeuver(maneuverKey) {
  const key = normalizeManeuverKey(maneuverKey);
  if (!key) return null;
  return UNARMED_MANEUVERS[key] ?? null;
}

export function getUnarmedManeuvers() {
  return Object.values(UNARMED_MANEUVERS).map((entry) => ({
    ...entry,
    key: normalizeManeuverKey(entry.key),
    label: localize(entry.labelKey, entry.key),
    description: entry.descriptionKey ? localize(entry.descriptionKey) : "",
    specialRules: entry.specialRulesKey ? localize(entry.specialRulesKey) : ""
  }));
}

export function getAvailableUnarmedManeuvers(actor) {
  const rules = getActiveHandToHandSpecialRules(actor);
  const physicalRules = getPhysicalSkillUnarmedRules(actor);

  return getUnarmedManeuvers().filter((entry) => {
    const requiredRule = String(entry?.requiresRule ?? "").trim();
    const requiredPhysicalRule = String(entry?.requiresPhysicalRule ?? "").trim();
    if (!requiredRule && !requiredPhysicalRule) return true;
    if (requiredRule && rules?.[requiredRule] === true) return true;
    if (requiredPhysicalRule && physicalRules?.[requiredPhysicalRule] === true) return true;
    return false;
  });
}

export function getStrengthDamageBonusFromPS(psValue = 0) {
  // Placeholder table for Milestone 16; this will be replaced by a fuller PS model.
  const ps = Math.floor(num(psValue, 0));
  if (ps >= 32) return 5;
  if (ps >= 28) return 4;
  if (ps >= 24) return 3;
  if (ps >= 20) return 2;
  if (ps >= 16) return 1;
  return 0;
}

export function getStrengthDamageBonus(actor) {
  return getStrengthDamageBonusFromPS(actor?.system?.attributes?.ps?.value);
}

export function getHandToHandDamageBonus(actor) {
  return Math.floor(num(
    actor?.system?.combat?.derived?.handToHandDamageBonus,
    num(actor?.system?.progression?.handToHandBonuses?.damageBonus, 0)
  ));
}

function normalizeManeuverData(rawManeuver = null) {
  const key = normalizeManeuverKey(rawManeuver?.key);
  const base = getUnarmedManeuver(key);

  const damageFormula = String(
    rawManeuver?.damageFormula
    ?? base?.damageFormula
    ?? "1d4"
  ).trim() || "1d4";

  return {
    key: key || base?.key || "unarmed",
    labelKey: rawManeuver?.labelKey ?? base?.labelKey ?? "",
    label: String(rawManeuver?.label ?? "").trim() || localize(rawManeuver?.labelKey, localize(base?.labelKey, key || "Unarmed")),
    actionCost: Math.max(1, Math.floor(num(rawManeuver?.actionCost, num(base?.actionCost, 1)))),
    strikeModifier: num(rawManeuver?.strikeModifier, num(base?.strikeModifier, 0)),
    damageFormula,
    canKnockdown: rawManeuver?.canKnockdown === true || base?.canKnockdown === true,
    canKnockback: rawManeuver?.canKnockback === true || base?.canKnockback === true,
    knockbackValue: Math.max(0, Math.floor(num(rawManeuver?.knockbackValue, num(base?.knockbackValue, 0)))),
    impactType: String(rawManeuver?.impactType ?? base?.impactType ?? "").trim().toLowerCase(),
    specialRules: String(rawManeuver?.specialRules ?? "").trim() || localize(rawManeuver?.specialRulesKey, localize(base?.specialRulesKey, "")),
    isReactive: rawManeuver?.isReactive === true
  };
}

function applyHandToHandRuleAdjustments(actor, maneuver) {
  if (!maneuver || typeof maneuver !== "object") return maneuver;

  const rules = getActiveHandToHandSpecialRules(actor);
  const physicalRules = getPhysicalSkillUnarmedRules(actor);
  if ((!rules || typeof rules !== "object") && (!physicalRules || typeof physicalRules !== "object")) return maneuver;

  const adjusted = { ...maneuver };

  // HtH kick unlock/progression upgrades the standard kick damage floor without
  // overriding stronger maneuver-specific kick formulas such as karate kicks.
  if (adjusted.key === "kick") {
    const physicalKickDamage = String(physicalRules?.kickDamageFormula ?? "").trim();
    if (physicalKickDamage) {
      adjusted.damageFormula = physicalKickDamage;
    }

    if (rules?.kickAttack === true || physicalRules?.kickAttack === true) {
    const currentFormula = String(adjusted.damageFormula ?? "").trim().toLowerCase();
    if (!currentFormula || currentFormula === "1d6") {
      adjusted.damageFormula = "1d8";
    }
    }
  }

  if (adjusted.key === "bodyBlock") {
    const bodyBlockDamage = String(physicalRules?.bodyBlockTackleDamage ?? "").trim();
    if (bodyBlockDamage) adjusted.damageFormula = bodyBlockDamage;
  }

  return adjusted;
}

export function buildUnarmedDamageProfileFromData(actor, rawManeuver = null) {
  const maneuver = applyHandToHandRuleAdjustments(actor, normalizeManeuverData(rawManeuver));

  const strengthBonus = getStrengthDamageBonus(actor);
  const handToHandBonus = getHandToHandDamageBonus(actor);
  const totalBonus = strengthBonus + handToHandBonus;

  return {
    maneuver,
    strengthBonus,
    handToHandBonus,
    totalBonus,
    formula: formatDamageFormula(maneuver.damageFormula, totalBonus)
  };
}

export function buildUnarmedDamageProfile(actor, maneuverKey) {
  return buildUnarmedDamageProfileFromData(actor, getUnarmedManeuver(maneuverKey));
}

export function createUnarmedWeaponProfileFromData(actor, rawManeuver = null) {
  const profile = buildUnarmedDamageProfileFromData(actor, rawManeuver);
  if (!profile) return null;

  return {
    id: `${UNARMED_PREFIX}${profile.maneuver.key}`,
    name: profile.maneuver.label,
    type: "weapon",
    system: {
      equipped: true,
      weapon: {
        attackType: "strike",
        damage: profile.formula,
        bonusStrike: 0,
        isMegaDamage: false,
        isBurstCapable: false,
        fireMode: "single",
        burstSize: 0,
        burstStrikeMod: 0,
        burstDamageMultiplier: 1,
        ammoPerBurst: 0,
        aimedStrikeMod: 0,
        supportsAimedShot: false,
        canKnockdown: profile.maneuver.canKnockdown === true,
        canKnockback: profile.maneuver.canKnockback === true,
        knockbackValue: Math.max(0, Math.floor(num(profile.maneuver.knockbackValue, 0))),
        impactType: String(profile.maneuver.impactType ?? "").trim().toLowerCase()
      }
    },
    flags: {
      rifts: {
        isUnarmedManeuver: true,
        maneuverKey: profile.maneuver.key
      }
    }
  };
}

export function createUnarmedWeaponProfile(actor, maneuverKey) {
  return createUnarmedWeaponProfileFromData(actor, getUnarmedManeuver(maneuverKey));
}

export function isUnarmedWeaponId(weaponId) {
  return String(weaponId ?? "").startsWith(UNARMED_PREFIX);
}

export function getManeuverKeyFromWeaponId(weaponId) {
  if (!isUnarmedWeaponId(weaponId)) return "";
  return normalizeManeuverKey(String(weaponId).slice(UNARMED_PREFIX.length));
}
