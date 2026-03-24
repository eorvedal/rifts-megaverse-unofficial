export const RULES_SETTINGS = {
  automaticKnockoutStun: "automaticKnockoutStun",
  automaticDeathBlow: "automaticDeathBlow",
  deathBlowEdition: "deathBlowEdition",
  skillHighRollSuccess: "skillHighRollSuccess"
};

function settingValue(key, fallback = null) {
  try {
    return game.settings.get("rifts-megaverse", key);
  } catch (_error) {
    return fallback;
  }
}

export function registerRulesSettings(systemId = "rifts-megaverse") {
  game.settings.register(systemId, RULES_SETTINGS.automaticKnockoutStun, {
    name: "RIFTS.Settings.AutomaticKnockoutStun",
    hint: "RIFTS.Settings.AutomaticKnockoutStunHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(systemId, RULES_SETTINGS.automaticDeathBlow, {
    name: "RIFTS.Settings.AutomaticDeathBlow",
    hint: "RIFTS.Settings.AutomaticDeathBlowHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(systemId, RULES_SETTINGS.deathBlowEdition, {
    name: "RIFTS.Settings.DeathBlowEdition",
    hint: "RIFTS.Settings.DeathBlowEditionHint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      r1e: "RIFTS.Settings.DeathBlowEditionR1E",
      rue: "RIFTS.Settings.DeathBlowEditionRUE"
    },
    default: "rue"
  });

  game.settings.register(systemId, RULES_SETTINGS.skillHighRollSuccess, {
    name: "RIFTS.Settings.SkillHighRollSuccess",
    hint: "RIFTS.Settings.SkillHighRollSuccessHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
}

export function useAutomaticKnockoutStun() {
  return settingValue(RULES_SETTINGS.automaticKnockoutStun, false) === true;
}

export function useAutomaticDeathBlow() {
  return settingValue(RULES_SETTINGS.automaticDeathBlow, false) === true;
}

export function getDeathBlowEdition() {
  const value = String(settingValue(RULES_SETTINGS.deathBlowEdition, "rue") ?? "rue").trim().toLowerCase();
  return value === "r1e" ? "r1e" : "rue";
}

export function getDeathBlowAttackCost() {
  return getDeathBlowEdition() === "r1e" ? 1 : 2;
}

export function useHighRollSkillSuccess() {
  return settingValue(RULES_SETTINGS.skillHighRollSuccess, false) === true;
}
