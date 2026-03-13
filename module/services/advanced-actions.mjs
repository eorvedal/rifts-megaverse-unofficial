const DEFAULT_ACTION_KEY = "standard";

export const ADVANCED_ACTION_DEFINITIONS = {
  standard: {
    key: "standard",
    labelKey: "RIFTS.Advanced.StandardAttack",
    consumesAttack: true,
    isReactive: false,
    queueBehavior: "normal",
    strikeModifier: 0,
    damageMultiplier: 1,
    restrictions: []
  },
  aimedShot: {
    key: "aimedShot",
    labelKey: "RIFTS.Advanced.AimedShot",
    consumesAttack: true,
    isReactive: false,
    queueBehavior: "normal",
    strikeModifier: -3,
    damageMultiplier: 1,
    restrictions: ["ranged-or-thrown-preferred"]
  },
  burstFire: {
    key: "burstFire",
    labelKey: "RIFTS.Advanced.BurstFire",
    consumesAttack: true,
    isReactive: false,
    queueBehavior: "normal",
    strikeModifier: 1,
    damageMultiplier: 2,
    restrictions: ["burst-capable-weapon"]
  },
  holdAction: {
    key: "holdAction",
    labelKey: "RIFTS.Advanced.HoldAction",
    consumesAttack: false,
    isReactive: false,
    queueBehavior: "consume-current-slot-and-hold",
    strikeModifier: 0,
    damageMultiplier: 1,
    restrictions: ["must-be-current-queue-action"]
  },
  releaseHeldAction: {
    key: "releaseHeldAction",
    labelKey: "RIFTS.Advanced.ReleaseHeldAction",
    consumesAttack: false,
    isReactive: false,
    queueBehavior: "out-of-sequence-allowed-if-held",
    strikeModifier: 0,
    damageMultiplier: 1,
    restrictions: ["requires-held-action"]
  },
  grapple: {
    key: "grapple",
    labelKey: "RIFTS.Advanced.GrapplePlaceholder",
    consumesAttack: true,
    isReactive: false,
    queueBehavior: "normal",
    strikeModifier: -1,
    damageMultiplier: 0,
    restrictions: ["placeholder-no-damage-automation"]
  },
  dodge: {
    key: "dodge",
    labelKey: "RIFTS.Rolls.Dodge",
    consumesAttack: true,
    isReactive: true,
    queueBehavior: "reaction",
    strikeModifier: 0,
    damageMultiplier: 1,
    restrictions: []
  },
  autoDodge: {
    key: "autoDodge",
    labelKey: "RIFTS.Advanced.AutoDodge",
    consumesAttack: false,
    isReactive: true,
    queueBehavior: "reaction",
    strikeModifier: 0,
    damageMultiplier: 1,
    restrictions: ["requires-auto-dodge-capability"]
  },
  allOutDodge: {
    key: "allOutDodge",
    labelKey: "RIFTS.Advanced.AllOutDodge",
    consumesAttack: true,
    isReactive: true,
    queueBehavior: "reaction",
    strikeModifier: 0,
    damageMultiplier: 1,
    dodgeModifier: 2,
    restrictions: ["placeholder-modifier"]
  },
  parry: {
    key: "parry",
    labelKey: "RIFTS.Rolls.Parry",
    consumesAttack: false,
    isReactive: true,
    queueBehavior: "reaction",
    strikeModifier: 0,
    damageMultiplier: 1,
    restrictions: []
  }
};

function bool(value) {
  return value === true;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeActionKey(actionKey) {
  const value = String(actionKey ?? "").trim();
  if (!value) return DEFAULT_ACTION_KEY;

  const lower = value.toLowerCase();
  if (["standard", "strike", "single", "single-shot", "singleShot"].includes(lower)) return "standard";
  if (["aimed", "aimed-shot", "aimedshot"].includes(lower)) return "aimedShot";
  if (["burst", "burst-fire", "burstfire"].includes(lower)) return "burstFire";
  if (["hold", "hold-action", "holdaction"].includes(lower)) return "holdAction";
  if (["release", "release-held", "release-held-action", "releaseheldaction"].includes(lower)) return "releaseHeldAction";
  if (["grapple", "grapple-placeholder"].includes(lower)) return "grapple";
  if (["dodge"].includes(lower)) return "dodge";
  if (["auto-dodge", "autododge"].includes(lower)) return "autoDodge";
  if (["all-out-dodge", "alloutdodge"].includes(lower)) return "allOutDodge";
  if (["parry"].includes(lower)) return "parry";

  return DEFAULT_ACTION_KEY;
}

export function getAdvancedActionDefinition(actionKey) {
  const normalized = normalizeActionKey(actionKey);
  return ADVANCED_ACTION_DEFINITIONS[normalized] ?? ADVANCED_ACTION_DEFINITIONS[DEFAULT_ACTION_KEY];
}

export function getWeaponAimedModifier(weapon) {
  const fromWeapon = num(weapon?.system?.weapon?.aimedStrikeMod, null);
  if (fromWeapon !== null) return fromWeapon;
  return getAdvancedActionDefinition("aimedShot").strikeModifier;
}

export function getWeaponBurstModifier(weapon) {
  const fromWeapon = num(weapon?.system?.weapon?.burstStrikeMod, null);
  if (fromWeapon !== null) return fromWeapon;
  return getAdvancedActionDefinition("burstFire").strikeModifier;
}

export function getWeaponBurstDamageMultiplier(weapon) {
  const fromWeapon = Math.max(1, Math.floor(num(weapon?.system?.weapon?.burstDamageMultiplier, 2)));
  return fromWeapon;
}

export function getWeaponBurstAmmoCost(weapon) {
  return Math.max(1, Math.floor(num(weapon?.system?.weapon?.ammoPerBurst, 3)));
}

export function weaponSupportsBurst(weapon) {
  return bool(weapon?.system?.weapon?.isBurstCapable);
}

export function weaponSupportsAimedShot(weapon) {
  return weapon?.system?.weapon?.supportsAimedShot !== false;
}

export function getAttackActionContext({ actionKey = DEFAULT_ACTION_KEY, weapon = null } = {}) {
  const definition = getAdvancedActionDefinition(actionKey);

  let strikeModifier = definition.strikeModifier ?? 0;
  let damageMultiplier = definition.damageMultiplier ?? 1;
  let ammoCost = 0;
  let fireMode = "single";
  let burstSize = 0;
  const notes = [];

  if (definition.key === "aimedShot") {
    strikeModifier = getWeaponAimedModifier(weapon);
    fireMode = "single";
    notes.push("aimed-shot-placeholder");
  }

  if (definition.key === "burstFire") {
    burstSize = Math.max(1, Math.floor(num(weapon?.system?.weapon?.burstSize, 3)));
    strikeModifier = getWeaponBurstModifier(weapon);
    damageMultiplier = getWeaponBurstDamageMultiplier(weapon);
    ammoCost = Math.max(getWeaponBurstAmmoCost(weapon), burstSize);
    fireMode = "burst";
    notes.push("burst-placeholder");
  }

  if (definition.key === "grapple") {
    damageMultiplier = 0;
    fireMode = "special";
    notes.push("grapple-placeholder");
  }

  return {
    key: definition.key,
    labelKey: definition.labelKey,
    consumesAttack: definition.consumesAttack === true,
    isReactive: definition.isReactive === true,
    queueBehavior: definition.queueBehavior,
    strikeModifier,
    damageMultiplier,
    ammoCost,
    fireMode,
    burstSize,
    notes
  };
}

export function getAvailableAttackActions({ weapon = null } = {}) {
  const actions = ["standard"];

  if (weaponSupportsAimedShot(weapon)) {
    actions.push("aimedShot");
  }

  if (weaponSupportsBurst(weapon)) {
    actions.push("burstFire");
  }

  actions.push("grapple");
  return actions;
}

export function getAvailableDefenseActions({ defender = null } = {}) {
  const actions = ["parry", "dodge", "allOutDodge"];
  if (defender?.system?.combat?.autoDodgeAvailable === true) {
    actions.push("autoDodge");
  }
  return actions;
}

export function localizeAdvancedAction(actionKey) {
  const definition = getAdvancedActionDefinition(actionKey);
  return game.i18n.localize(definition.labelKey);
}

