const DURABILITY_VALUES = ["sdc", "mdc"];

export const RIFTS_SCALE = Object.freeze({
  SDC: "sdc",
  MDC: "mdc"
});

// Kept for compatibility with existing imports; conversion policies were intentionally removed.
export const DEFAULT_SCALE_POLICY = Object.freeze({
  mode: "rifts-first"
});

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeText(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeScale(value, fallback = RIFTS_SCALE.SDC) {
  const normalized = normalizeText(value);
  return DURABILITY_VALUES.includes(normalized) ? normalized : fallback;
}

function bool(value) {
  return value === true;
}

function hasMeaningfulMdcPool(actor) {
  const current = num(actor?.system?.resources?.mdc?.value, 0);
  const max = num(actor?.system?.resources?.mdc?.max, 0);
  return current > 0 || max > 0;
}

function getArmorPoolValue(armorItem, poolKey, valueKey = "value") {
  const nested = armorItem?.system?.armor?.[poolKey]?.[valueKey];
  if (nested !== undefined) return num(nested, 0);
  const flat = armorItem?.system?.[poolKey]?.[valueKey];
  return num(flat, 0);
}

function getArmorProtectionScale(armorItem) {
  const hasArmorMdc = getArmorPoolValue(armorItem, "mdc", "max") > 0
    || getArmorPoolValue(armorItem, "mdc", "value") > 0;

  if (bool(armorItem?.system?.armor?.isMegaDamageArmor) || hasArmorMdc) {
    return RIFTS_SCALE.MDC;
  }

  return RIFTS_SCALE.SDC;
}

function getEquippedArmor(actor) {
  if (!actor?.items) return null;
  const activeArmor = actor.items.find((item) => item.type === "armor" && item.system?.active === true);
  if (activeArmor) return activeArmor;
  return actor.items.find((item) => item.type === "armor" && item.system?.equipped === true) ?? null;
}

function getEffectiveActorScale(actor, options = {}) {
  if (!actor) return RIFTS_SCALE.SDC;

  if (actor.type === "vehicle") return RIFTS_SCALE.MDC;

  const combat = actor.system?.combat ?? {};
  if (bool(combat.isMdcEntity)) return RIFTS_SCALE.MDC;

  const activeArmor = options.activeArmor ?? getEquippedArmor(actor);
  if (activeArmor && getArmorProtectionScale(activeArmor) === RIFTS_SCALE.MDC) {
    return RIFTS_SCALE.MDC;
  }

  if (hasMeaningfulMdcPool(actor)) return RIFTS_SCALE.MDC;
  return RIFTS_SCALE.SDC;
}

function isMdcScale(scale) {
  const resolved = normalizeScale(scale, RIFTS_SCALE.SDC);
  return resolved === RIFTS_SCALE.MDC;
}

function getDamageScaleMode(weapon, attacker = null) {
  if (weapon?.system?.weapon?.isMegaDamage === true) return RIFTS_SCALE.MDC;

  // For unarmed or placeholder flows, fallback to attacker's inherent durability if needed.
  if (!weapon && getEffectiveActorScale(attacker) === RIFTS_SCALE.MDC) return RIFTS_SCALE.MDC;
  return RIFTS_SCALE.SDC;
}

function resolveScaleInteraction({ attackScale, targetScale, baseDamage }) {
  const base = Math.max(0, num(baseDamage, 0));
  const attack = normalizeScale(attackScale, RIFTS_SCALE.SDC);
  const target = normalizeScale(targetScale, RIFTS_SCALE.SDC);

  if (attack === RIFTS_SCALE.SDC && target === RIFTS_SCALE.MDC) {
    return {
      attackScale: attack,
      targetScale: target,
      baseDamage: base,
      convertedDamage: 0,
      multiplier: 0,
      mode: "sdc-vs-mdc",
      noEffect: true,
      reasonKey: "RIFTS.Combat.Durability.SdcVsMdc"
    };
  }

  if (attack === RIFTS_SCALE.MDC && target === RIFTS_SCALE.SDC) {
    return {
      attackScale: attack,
      targetScale: target,
      baseDamage: base,
      convertedDamage: base,
      multiplier: 1,
      mode: "mdc-vs-sdc-catastrophic",
      noEffect: false,
      reasonKey: "RIFTS.Combat.Durability.MdcVsSdc"
    };
  }

  return {
    attackScale: attack,
    targetScale: target,
    baseDamage: base,
    convertedDamage: base,
    multiplier: 1,
    mode: "same-scale",
    noEffect: false,
    reasonKey: attack === RIFTS_SCALE.MDC
      ? "RIFTS.Combat.Durability.MdcVsMdc"
      : "RIFTS.Combat.Durability.SdcVsSdc"
  };
}

function getScaleLabelKey(scale) {
  return isMdcScale(scale)
    ? "RIFTS.Combat.MDC"
    : "RIFTS.Combat.SDC";
}

function getWeaponScaleWarnings(_weapon) {
  return [];
}

function hasValidVehicleMdc(actor) {
  if (!actor || actor.type !== "vehicle") return true;
  return hasMeaningfulMdcPool(actor);
}

export {
  getDamageScaleMode,
  getEffectiveActorScale,
  getEquippedArmor,
  getArmorProtectionScale,
  getScaleLabelKey,
  getWeaponScaleWarnings,
  hasValidVehicleMdc,
  isMdcScale,
  normalizeScale,
  resolveScaleInteraction
};
