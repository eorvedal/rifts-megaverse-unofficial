import {
  advanceMeleeAction,
  canActorTakeMeleeAction,
  consumeHeldAction
} from "./melee-sequencer.mjs";
import {
  getAttackActionContext,
  getAvailableDefenseActions,
  localizeAdvancedAction,
  weaponSupportsBurst
} from "./advanced-actions.mjs";
import {
  getArmorProtectionScale,
  getDamageScaleMode,
  getEffectiveActorScale,
  getEquippedArmor as getEquippedArmorItem,
  getWeaponScaleWarnings,
  hasValidVehicleMdc,
  isMdcScale,
  resolveScaleInteraction
} from "./scale.mjs";
import {
  buildUnarmedDamageProfile,
  buildUnarmedDamageProfileFromData,
  createUnarmedWeaponProfile,
  createUnarmedWeaponProfileFromData,
  getManeuverKeyFromWeaponId,
  getUnarmedManeuver
} from "./unarmed.mjs";
import { resolveImpactResult } from "./impact.mjs";
import { effectHasStatus, getConfiguredStatusDefinition } from "./status-effects.mjs";
import { getDeathBlowEdition, useAutomaticDeathBlow, useAutomaticKnockoutStun } from "./rules-settings.mjs";
import { getPhysicalSkillRollWithPunchBonus, resolveWeaponProficiencyBonuses } from "./skill-automation.mjs";

const ATTACK_TEMPLATE = "systems/rifts-megaverse/templates/chat/attack-card.hbs";
const DAMAGE_TEMPLATE = "systems/rifts-megaverse/templates/chat/damage-card.hbs";

let chatListenersRegistered = false;
let combatRoundHooksRegistered = false;
const roundResetByCombat = new Map();
const CATASTROPHIC_SDC_DAMAGE = 10000;
const CRITICAL_DAMAGE_MULTIPLIER = 2;

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getWeaponData(weapon) {
  return {
    attackType: weapon?.system?.weapon?.attackType ?? "strike",
    damage: weapon?.system?.weapon?.damage ?? weapon?.system?.damage ?? "1d6",
    bonusStrike: num(weapon?.system?.weapon?.bonusStrike, num(weapon?.system?.bonusStrike, 0)),
    isMegaDamage: weapon?.system?.weapon?.isMegaDamage === true,
    proficiencyKey: String(weapon?.system?.weapon?.proficiencyKey ?? "").trim(),
    isBurstCapable: weapon?.system?.weapon?.isBurstCapable === true,
    fireMode: weapon?.system?.weapon?.fireMode ?? "single",
    burstSize: Math.max(1, Math.floor(num(weapon?.system?.weapon?.burstSize, 3))),
    burstStrikeMod: num(weapon?.system?.weapon?.burstStrikeMod, 1),
    burstDamageMultiplier: Math.max(1, Math.floor(num(weapon?.system?.weapon?.burstDamageMultiplier, 2))),
    ammoPerBurst: Math.max(1, Math.floor(num(weapon?.system?.weapon?.ammoPerBurst, 3))),
    aimedStrikeMod: num(weapon?.system?.weapon?.aimedStrikeMod, -3),
    supportsAimedShot: weapon?.system?.weapon?.supportsAimedShot !== false
  };
}

function getArmorData(armor) {
  return {
    ar: num(armor?.system?.armor?.ar, num(armor?.system?.ar, 0)),
    isMegaDamageArmor: armor?.system?.armor?.isMegaDamageArmor === true,
    sdcValue: num(armor?.system?.armor?.sdc?.value, num(armor?.system?.sdc?.value, 0)),
    mdcValue: num(armor?.system?.armor?.mdc?.value, num(armor?.system?.mdc?.value, 0))
  };
}

function getNaturalD20(roll) {
  const die = roll?.dice?.[0];
  const result = die?.results?.[0]?.result;
  return num(result, 0);
}

function getAttackManeuverKey(weapon = null) {
  return String(
    weapon?.flags?.rifts?.maneuverKey
    ?? getManeuverKeyFromWeaponId(weapon?.id ?? "")
    ?? ""
  ).trim();
}

function getAttackCriticalRange(attacker, { weapon = null, attackContext = null } = {}) {
  const actionKey = String(attackContext?.key ?? "standard").trim().toLowerCase();
  if (actionKey === "grapple") return null;

  const isUnarmedAttack = weapon?.flags?.rifts?.isUnarmedManeuver === true
    || Boolean(getManeuverKeyFromWeaponId(weapon?.id ?? ""));
  if (!isUnarmedAttack) return 20;

  const derivedRange = Math.max(
    2,
    Math.floor(num(
      attacker?.system?.combat?.derived?.handToHandCritRange,
      num(attacker?.system?.progression?.handToHandSpecialRules?.critRange, 20)
    ))
  );

  return Math.min(20, derivedRange);
}

function getAttackBaseHitNumber({ weapon = null, attackContext = null } = {}) {
  const actionKey = String(attackContext?.key ?? "standard").trim().toLowerCase();
  const attackType = weapon?.system?.weapon?.attackType ?? "strike";
  const isRangedAttack = attackType !== "strike" || ["aimedshot", "burstfire"].includes(actionKey);
  return isRangedAttack ? 8 : 5;
}

function getAttackKnockoutStunRange(attacker, { weapon = null, attackContext = null } = {}) {
  const actionKey = String(attackContext?.key ?? "standard").trim().toLowerCase();
  if (actionKey === "grapple") return null;

  const isUnarmedAttack = weapon?.flags?.rifts?.isUnarmedManeuver === true
    || Boolean(getManeuverKeyFromWeaponId(weapon?.id ?? ""));
  if (!isUnarmedAttack) return null;

  const derivedRange = Math.max(
    0,
    Math.floor(num(
      attacker?.system?.combat?.derived?.handToHandKnockoutStunRange,
      num(attacker?.system?.progression?.handToHandSpecialRules?.knockoutStunRange, 0)
    ))
  );

  if (derivedRange <= 0) return null;
  const maneuverKey = getAttackManeuverKey(weapon).toLowerCase();
  if (!useAutomaticKnockoutStun() && maneuverKey !== "knockoutstun") return null;
  return Math.min(20, derivedRange);
}

function getAttackDeathBlowRange(attacker, { weapon = null, attackContext = null } = {}) {
  const actionKey = String(attackContext?.key ?? "standard").trim().toLowerCase();
  if (actionKey === "grapple") return null;

  const isUnarmedAttack = weapon?.flags?.rifts?.isUnarmedManeuver === true
    || Boolean(getManeuverKeyFromWeaponId(weapon?.id ?? ""));
  if (!isUnarmedAttack) return null;

  const derivedRange = Math.max(
    0,
    Math.floor(num(
      attacker?.system?.combat?.derived?.handToHandDeathBlowRange,
      num(attacker?.system?.progression?.handToHandSpecialRules?.deathBlowRange, 0)
    ))
  );

  if (derivedRange <= 0) return null;
  const maneuverKey = getAttackManeuverKey(weapon).toLowerCase();
  if (!useAutomaticDeathBlow() && maneuverKey !== "deathblow") return null;
  return Math.min(20, derivedRange);
}

function getAttackDeclaredFinisher({ weapon = null } = {}) {
  const maneuverKey = getAttackManeuverKey(weapon).toLowerCase();
  if (maneuverKey === "knockoutstun") return "knockoutStun";
  if (maneuverKey === "deathblow") return "deathBlow";
  return "";
}

function getKnockoutStunStatusDefinition() {
  return getConfiguredStatusDefinition(["stunned", "dazed"]);
}

function getDeathBlowStatusDefinition() {
  return getConfiguredStatusDefinition(["defeated", "dead", "unconscious"]);
}

function getControlEffectDefinition(effectKey) {
  const key = String(effectKey ?? "").trim().toLowerCase();
  if (key === "grapple") {
    return {
      source: "advancedGrapple",
      statusCandidates: ["grappled", "restrained", "immobilized"],
      fallbackStatusId: "grappled",
      fallbackIcon: "icons/svg/net.svg",
      label: game.i18n.localize("RIFTS.Advanced.GrapplePlaceholder")
    };
  }

  if (key === "entangle") {
    return {
      source: "maneuverEntangle",
      statusCandidates: ["restrained", "immobilized", "grappled"],
      fallbackStatusId: "restrained",
      fallbackIcon: "icons/svg/net.svg",
      label: game.i18n.localize("RIFTS.Maneuvers.Entangle")
    };
  }

  if (["holds", "hold"].includes(key)) {
    return {
      source: "maneuverHolds",
      statusCandidates: ["restrained", "immobilized", "grappled"],
      fallbackStatusId: "restrained",
      fallbackIcon: "icons/svg/net.svg",
      label: game.i18n.localize("RIFTS.Maneuvers.Holds")
    };
  }

  return null;
}

async function applyControlEffect(target, effectKey) {
  const definition = getControlEffectDefinition(effectKey);
  if (!definition) return null;

  if (!target) {
    return {
      triggered: false,
      applied: false,
      pending: false,
      label: definition.label,
      source: definition.source
    };
  }

  const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  const canApply = game.user?.isGM || target.testUserPermission(game.user, ownerLevel);
  const statusDef = getConfiguredStatusDefinition(definition.statusCandidates);
  const statusId = String(statusDef?.id ?? definition.fallbackStatusId);
  const label = statusDef?.name
    ? game.i18n.localize(statusDef.name)
    : definition.label;
  const icon = String(statusDef?.img ?? definition.fallbackIcon);

  if (!canApply) {
    return {
      triggered: true,
      applied: false,
      pending: true,
      statusId,
      label,
      source: definition.source
    };
  }

  const existing = target.effects?.find?.((effect) =>
    effectHasStatus(effect, statusId)
    || foundry.utils.getProperty(effect, "flags.rifts-megaverse.source") === definition.source
  ) ?? null;

  const effectData = {
    name: definition.label,
    img: icon,
    statuses: statusId ? [statusId] : [],
    disabled: false,
    flags: {
      core: {
        statusId
      },
      "rifts-megaverse": {
        generatedStatus: statusId,
        source: definition.source,
        controlEffect: effectKey
      }
    }
  };

  if (existing && typeof existing.update === "function") {
    await existing.update(effectData);
    return {
      triggered: true,
      applied: true,
      pending: false,
      refreshed: true,
      statusId,
      label,
      source: definition.source
    };
  }

  await target.createEmbeddedDocuments("ActiveEffect", [effectData]);
  return {
    triggered: true,
    applied: true,
    pending: false,
    refreshed: false,
    statusId,
    label,
    source: definition.source
  };
}

function getWeaponProficiencyContext(actor, weapon, options = {}) {
  return resolveWeaponProficiencyBonuses(actor, weapon, options);
}

async function applyKnockoutStunEffect(target) {
  if (!target) {
    return {
      triggered: false,
      applied: false,
      pending: false,
      statusId: "",
      label: game.i18n.localize("RIFTS.Combat.KnockoutStun")
    };
  }

  const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  const canApply = game.user?.isGM || target.testUserPermission(game.user, ownerLevel);
  const statusDef = getKnockoutStunStatusDefinition();
  const statusId = String(statusDef?.id ?? "stunned");
  const label = statusDef?.name
    ? game.i18n.localize(statusDef.name)
    : game.i18n.localize("RIFTS.Combat.KnockoutStun");
  const icon = String(statusDef?.img ?? "icons/svg/daze.svg");

  if (!canApply) {
    return {
      triggered: true,
      applied: false,
      pending: true,
      statusId,
      label
    };
  }

  const existing = target.effects?.find?.((effect) =>
    effectHasStatus(effect, statusId)
    || foundry.utils.getProperty(effect, "flags.rifts-megaverse.source") === "handToHandKnockoutStun"
  ) ?? null;

  const duration = {
    rounds: 1,
    startRound: Math.max(0, Math.floor(num(game.combat?.round, 0))),
    startTurn: Math.max(0, Math.floor(num(game.combat?.turn, 0)))
  };

  const effectData = {
    name: game.i18n.localize("RIFTS.Combat.KnockoutStun"),
    img: icon,
    statuses: statusId ? [statusId] : [],
    disabled: false,
    duration,
    flags: {
      core: {
        statusId
      },
      "rifts-megaverse": {
        generatedStatus: statusId,
        source: "handToHandKnockoutStun"
      }
    }
  };

  if (existing && typeof existing.update === "function") {
    await existing.update(effectData);
    return {
      triggered: true,
      applied: true,
      pending: false,
      refreshed: true,
      statusId,
      label
    };
  }

  await target.createEmbeddedDocuments("ActiveEffect", [effectData]);
  return {
    triggered: true,
    applied: true,
    pending: false,
    refreshed: false,
    statusId,
      label
  };
}

async function applyDeathBlowEffect(target) {
  if (!target) {
    return {
      triggered: false,
      applied: false,
      pending: false,
      statusId: "",
      label: game.i18n.localize("RIFTS.Combat.DeathBlow")
    };
  }

  const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  const canApply = game.user?.isGM || target.testUserPermission(game.user, ownerLevel);
  const statusDef = getDeathBlowStatusDefinition();
  const statusId = String(statusDef?.id ?? "defeated");
  const label = statusDef?.name
    ? game.i18n.localize(statusDef.name)
    : game.i18n.localize("RIFTS.Combat.DeathBlow");
  const icon = String(statusDef?.img ?? "icons/svg/skull.svg");

  if (!canApply) {
    return {
      triggered: true,
      applied: false,
      pending: true,
      statusId,
      label
    };
  }

  const existing = target.effects?.find?.((effect) =>
    effectHasStatus(effect, statusId)
    || foundry.utils.getProperty(effect, "flags.rifts-megaverse.source") === "handToHandDeathBlow"
  ) ?? null;

  const effectData = {
    name: game.i18n.localize("RIFTS.Combat.DeathBlow"),
    img: icon,
    statuses: statusId ? [statusId] : [],
    disabled: false,
    flags: {
      core: {
        statusId
      },
      "rifts-megaverse": {
        generatedStatus: statusId,
        source: "handToHandDeathBlow"
      }
    }
  };

  if (existing && typeof existing.update === "function") {
    await existing.update(effectData);
  } else {
    await target.createEmbeddedDocuments("ActiveEffect", [effectData]);
  }

  if (game.combat) {
    const relatedCombatants = game.combat.combatants.filter((combatant) => combatant?.actorId === target.id);
    for (const combatant of relatedCombatants) {
      if (combatant?.defeated === true || combatant?.isDefeated === true) continue;
      await combatant.update({ defeated: true });
    }
  }

  return {
    triggered: true,
    applied: true,
    pending: false,
    statusId,
    label
  };
}

function getTargetAr(targetActor) {
  const combatAr = num(targetActor?.system?.combat?.ar, 0);
  const armorAr = num(targetActor?.system?.combat?.derived?.equippedArmorAR, 0);
  return Math.max(combatAr, armorAr);
}

function getActorBodyPoolMode(targetActor, effectiveScale) {
  if (!targetActor) return "NONE";
  return isMdcScale(effectiveScale) ? "MDC" : "SDC_HP";
}

function getEquippedArmor(targetActor) {
  return getEquippedArmorItem(targetActor);
}

function getDurabilityLabelKey(value) {
  return isMdcScale(value) ? "RIFTS.Combat.MDC" : "RIFTS.Combat.SDC";
}

function getScaleContext({ attacker = null, target = null, weapon = null } = {}) {
  const attackerScale = getEffectiveActorScale(attacker);
  const targetScale = getEffectiveActorScale(target);
  const weaponScale = getDamageScaleMode(weapon, attacker);

  return {
    attackerScale,
    targetScale,
    weaponScale,
    attackerScaleLabelKey: getDurabilityLabelKey(attackerScale),
    targetScaleLabelKey: getDurabilityLabelKey(targetScale),
    weaponScaleLabelKey: getDurabilityLabelKey(weaponScale)
  };
}

function getTokenById(tokenId) {
  if (!tokenId) return null;
  return canvas.tokens?.get?.(tokenId)
    ?? canvas.tokens?.placeables?.find((entry) => entry.id === tokenId)
    ?? null;
}

function resolveActorFromTokenOrActor({ tokenId = "", actorId = "" } = {}) {
  const token = getTokenById(tokenId);
  const tokenActor = token?.actor ?? null;
  const worldActor = actorId ? game.actors.get(actorId) : null;

  return {
    token,
    actor: tokenActor ?? worldActor
  };
}


function getActorContextToken(actor, preferredTokenId = "") {
  const preferred = getTokenById(preferredTokenId);
  if (preferred?.actor) return preferred;

  const actorTokenId = String(actor?.token?.id ?? actor?.parent?.id ?? "");
  const actorToken = getTokenById(actorTokenId);
  if (actorToken?.actor) return actorToken;

  if (actor?.token?.object?.actor) return actor.token.object;

  if (game.combat) {
    const combatantMatches = game.combat.combatants.filter((combatant) => combatant?.actor?.id === actor?.id);
    if (combatantMatches.length === 1) {
      const matchTokenId = combatantMatches[0].tokenId ?? combatantMatches[0].token?.id ?? "";
      const matchToken = getTokenById(matchTokenId);
      if (matchToken?.actor) return matchToken;
    }
  }

  return null;
}

function getTargetFromLastSaved(attacker) {
  const tokenId = String(attacker?.system?.combat?.lastTargetTokenId ?? "");
  const actorId = String(attacker?.system?.combat?.lastTargetId ?? "");

  const resolved = resolveActorFromTokenOrActor({ tokenId, actorId });
  if (resolved.actor) return resolved;

  if (!actorId) return null;

  const actor = game.actors.get(actorId);
  if (!actor) return null;

  const token = canvas.tokens?.placeables?.find((entry) => entry.actor?.id === actor.id) ?? null;
  return { actor, token };
}

function hasPath(doc, path) {
  return foundry.utils.getProperty(doc, path) !== undefined;
}

function getUpdatePathForPool(poolPath) {
  return `${poolPath}.value`;
}

function applyToPool(updateData, doc, poolPath, amount) {
  const current = num(foundry.utils.getProperty(doc, getUpdatePathForPool(poolPath)), 0);
  const applied = Math.min(current, amount);
  const remaining = amount - applied;
  updateData[getUpdatePathForPool(poolPath)] = Math.max(0, current - applied);
  return { applied, remaining, before: current, after: Math.max(0, current - applied) };
}

function getArmorPoolPath(armorItem, pool) {
  const nested = `system.armor.${pool}.value`;
  if (hasPath(armorItem, nested)) return `system.armor.${pool}`;
  return `system.${pool}`;
}

async function postReactionLog({ defender, actionType, remaining }) {
  if (!defender) return null;

  const key = actionType === "dodge"
    ? "RIFTS.Combat.ReactionDodgeLog"
    : "RIFTS.Combat.ReactionParryLog";

  const content = game.i18n.format(key, {
    defender: defender.name,
    remaining: Math.max(0, num(remaining, 0))
  });

  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: defender }),
    content
  });
}

function localizeFireMode(fireMode) {
  if (fireMode === "burst") return game.i18n.localize("RIFTS.Advanced.BurstFire");
  return game.i18n.localize("RIFTS.Advanced.SingleShot");
}

function getDamageModeLabel(mode, attackDurability = "sdc") {
  switch (mode) {
    case "direct-hp":
      return game.i18n.localize("RIFTS.Combat.Mode.DirectHp");
    case "sdc-vs-mdc":
      return game.i18n.localize("RIFTS.Combat.Mode.SdcVsMdc");
    case "mdc-vs-sdc":
    case "mdc-vs-sdc-catastrophic":
      return game.i18n.localize("RIFTS.Combat.Mode.MdcVsSdc");
    case "same-scale":
    default:
      return isMdcScale(attackDurability)
        ? game.i18n.localize("RIFTS.Combat.Mode.MdcVsMdc")
        : game.i18n.localize("RIFTS.Combat.Mode.SdcVsSdc");
  }
}

function getBodyScaleForActor(targetActor, _effectiveScale) {
  if (!targetActor) return "sdc";
  if (targetActor.type === "vehicle") return "mdc";

  const hasBodyMdc = num(targetActor.system?.resources?.mdc?.max, 0) > 0
    || num(targetActor.system?.resources?.mdc?.value, 0) > 0
    || targetActor.system?.combat?.isMdcEntity === true;

  return hasBodyMdc ? "mdc" : "sdc";
}

function getWeaponFromCardData({ attacker = null, weaponId = "", maneuverKey = "" } = {}) {
  if (attacker && weaponId) {
    const ownedWeapon = attacker.items?.get?.(weaponId) ?? null;
    if (ownedWeapon) return ownedWeapon;
  }

  const resolvedManeuverKey = maneuverKey || getManeuverKeyFromWeaponId(weaponId);
  if (!attacker || !resolvedManeuverKey) return null;
  return createUnarmedWeaponProfile(attacker, resolvedManeuverKey);
}
async function applyWeaponAmmoCost(weapon, amount = 0) {
  if (!weapon || amount <= 0) return null;

  const ammoPath = "system.weapon.ammo.value";
  const ammoMaxPath = "system.weapon.ammo.max";
  const current = num(foundry.utils.getProperty(weapon, ammoPath), 0);
  const max = num(foundry.utils.getProperty(weapon, ammoMaxPath), 0);

  // If ammo capacity is unset, treat ammo as untracked for this weapon.
  if (max <= 0) {
    return { before: current, after: current, spent: 0, insufficient: false, untracked: true };
  }

  if (current <= 0) return { before: current, after: current, spent: 0, insufficient: true, untracked: false };

  const spent = Math.min(current, Math.max(0, Math.floor(num(amount, 0))));
  const after = Math.max(0, current - spent);
  await weapon.update({ [ammoPath]: after });

  return {
    before: current,
    after,
    spent,
    insufficient: spent < amount,
    untracked: false
  };
}

function actorCanUseSpecialManeuver(actor, key) {
  if (!actor) return false;

  if (typeof actor.hasSpecialManeuver === "function") {
    if (actor.hasSpecialManeuver(key) === true) return true;
  }

  const normalized = String(key ?? "").trim().toLowerCase();
  if (!normalized) return false;

  const ownedMatch = actor.items?.find?.((item) => {
    if (item?.type !== "specialManeuver") return false;
    const itemKey = String(item.system?.key ?? item.name ?? "").trim().toLowerCase().replace(/[\s-]+/g, "");
    return itemKey === normalized.replace(/[\s-]+/g, "");
  }) ?? null;
  if (ownedMatch) return true;

  const derivedKeys = Array.isArray(actor.system?.combat?.derived?.availableManeuverKeys)
    ? actor.system.combat.derived.availableManeuverKeys
    : [];

  return derivedKeys.some((entry) => String(entry ?? "").trim().toLowerCase() === normalized);
}

function getDefenseAvailability(defender, { weapon = null, attackContext = null } = {}) {
  const actions = getAvailableDefenseActions({ defender });
  const attackType = weapon?.system?.weapon?.attackType ?? "strike";
  const isRangedAttack = attackType !== "strike" || ["aimedShot", "burstFire"].includes(attackContext?.key);
  const control = defender?.system?.combat?.derived?.control ?? {};
  const dodgeBlocked = control?.dodgeBlocked === true;

  return {
    canParry: actions.includes("parry") && !isRangedAttack,
    canDodge: actions.includes("dodge") && !dodgeBlocked,
    canAutoDodge: actions.includes("autoDodge") && !dodgeBlocked,
    canAllOutDodge: actions.includes("allOutDodge") && !dodgeBlocked,
    canRollWithPunch: actorCanUseSpecialManeuver(defender, "rollWithPunch") && !isRangedAttack && !dodgeBlocked
  };
}

function getActiveDefenseWeapon(defender) {
  return defender?.items?.find?.((item) => item.type === "weapon" && (item.system?.active === true || item.system?.equipped === true))
    ?? defender?.items?.find?.((item) => item.type === "weapon" && item.system?.equipped === true)
    ?? null;
}

function getParryContestBonus(defender) {
  const baseParry = num(defender?.system?.combat?.derived?.parryTotal, num(defender?.system?.combat?.parryMod, 0));
  const defenseWeapon = getActiveDefenseWeapon(defender);
  const wp = getWeaponProficiencyContext(defender, defenseWeapon, { useParry: true });
  return {
    totalBonus: baseParry + num(wp?.appliedParryBonus, 0),
    weaponProficiency: wp
  };
}

function getActorApmState(actor) {
  const total = Math.max(
    0,
    Math.floor(num(
      actor?.system?.combat?.apmTotal,
      num(
        actor?.system?.combat?.derived?.apmTotal,
        num(
          actor?.system?.combat?.derived?.attacksPerMelee,
          num(actor?.system?.progression?.attacksPerMelee, 0)
        )
      )
    ))
  );
  const spent = Math.max(0, Math.floor(num(actor?.system?.combat?.apmSpent, 0)));
  let remaining = Math.max(0, Math.floor(num(actor?.system?.combat?.apmRemaining, 0)));
  const actorTokenId = String(actor?.token?.id ?? actor?.parent?.id ?? "");
  const isCombatant = Boolean(game.combat?.combatants?.find((entry) => {
    const combatantTokenId = String(entry?.tokenId ?? entry?.token?.id ?? "");
    return entry?.actorId === actor?.id || (actorTokenId && combatantTokenId === actorTokenId);
  }));

  if (remaining <= 0 && spent === 0 && total > 0) {
    remaining = total;
  }

  // Outside active combat tracking, stale spent/remaining values should not disable
  // reaction buttons. Default to the actor's full current APM budget.
  if (!game.combat || !isCombatant) {
    remaining = total;
  }

  return {
    total,
    spent,
    remaining,
    canSpendAttack: remaining > 0
  };
}

function canUserResolveReaction(defender) {
  if (!defender || !game.user) return false;
  if (game.user.isGM) return true;

  const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  return defender.testUserPermission(game.user, ownerLevel);
}

function notifyReactionPermissionDenied(defender) {
  const defenderName = defender?.name ?? game.i18n.localize("RIFTS.Combat.UnknownActor");
  ui.notifications.warn(game.i18n.format("RIFTS.Combat.ReactionPermissionDenied", { defender: defenderName }));
}

function notifyCannotDodge(defender, spend = null) {
  const apm = getActorApmState(defender);
  const remaining = Math.max(0, Math.floor(num(spend?.remaining, apm.remaining)));
  const total = Math.max(0, Math.floor(num(spend?.total, apm.total)));
  const defenderName = defender?.name ?? game.i18n.localize("RIFTS.Combat.UnknownActor");

  ui.notifications.warn(game.i18n.format("RIFTS.Combat.CannotDodgeDetailed", {
    defender: defenderName,
    remaining,
    total
  }));
}

function getRollWithPunchBonus(defender) {
  const handToHandBonus = Math.max(
    0,
    Math.floor(num(
      defender?.system?.combat?.derived?.handToHandPullRollBonus,
      num(defender?.system?.progression?.handToHandSpecialRules?.pullRollBonusValue, 0)
    ))
  );
  return handToHandBonus + getPhysicalSkillRollWithPunchBonus(defender);
}

function appendReactionOutcome(root, label, text, success = false) {
  if (!(root instanceof HTMLElement)) return;

  root.querySelector(".rifts-reaction-outcome")?.remove();

  const paragraph = document.createElement("p");
  paragraph.className = `rifts-reaction-outcome ${success ? "is-success" : "is-failure"}`;
  paragraph.innerHTML = `<strong>${label}:</strong> ${text}`;
  root.append(paragraph);
}

function hasAvailableDefense(defense = null) {
  if (!defense) return false;
  return defense.canParry === true
    || defense.canDodge === true
    || defense.canAutoDodge === true
    || defense.canAllOutDodge === true
    || defense.canRollWithPunch === true;
}

function shouldAwaitReaction({ target = null, resolution = null, defense = null } = {}) {
  if (!target || !resolution?.hitLocation) return false;
  return hasAvailableDefense(defense);
}

async function renderAttackCardContent(data = {}) {
  return foundry.applications.handlebars.renderTemplate(ATTACK_TEMPLATE, data);
}

function getAttackCardData(message) {
  const data = foundry.utils.getProperty(message, "flags.rifts.attackCardData");
  return data ? foundry.utils.deepClone(data) : null;
}

async function updateAttackCardMessage(message, data) {
  if (!message || !data) return null;

  const content = await renderAttackCardContent(data);
  const existingFlags = foundry.utils.deepClone(message.flags?.rifts ?? {});
  existingFlags.attackCardData = data;
  return message.update({
    content,
    "flags.rifts": existingFlags
  });
}

function canUserFinalizePendingAttack(data = {}) {
  if (!game.user) return false;
  if (game.user.isGM) return true;

  const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  const defenderId = String(data.defenderId ?? "");
  const attackerId = String(data.attackerId ?? "");
  const defender = defenderId ? game.actors.get(defenderId) : null;
  const attacker = attackerId ? game.actors.get(attackerId) : null;

  return Boolean(
    defender?.testUserPermission?.(game.user, ownerLevel)
    || attacker?.testUserPermission?.(game.user, ownerLevel)
  );
}

async function postDefenseContestRoll({
  defender,
  label,
  totalBonus = 0,
  flavorSuffix = ""
} = {}) {
  const roll = await (new Roll(`1d20 + ${totalBonus}`)).evaluate();
  const flavor = flavorSuffix
    ? `<p>${label} ${flavorSuffix}</p>`
    : `<p>${label}</p>`;

  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor: defender }),
    flavor
  });

  return roll;
}

async function applyPendingAttackEffects(data = {}) {
  const targetRef = resolveActorFromTokenOrActor({
    tokenId: data.targetTokenId,
    actorId: data.targetId
  });
  const target = targetRef.actor;
  const deathBlowEdition = getDeathBlowEdition();

  return {
    knockoutStunResult: data.knockoutStunTriggered === true
      ? await applyKnockoutStunEffect(target)
      : null,
    deathBlowResult: data.deathBlowTriggered === true
      ? (deathBlowEdition === "r1e"
        ? await applyDeathBlowEffect(target)
        : {
          triggered: true,
          applied: false,
          pending: false,
          directHp: true,
          directHpMultiplier: 2,
          label: game.i18n.localize("RIFTS.Combat.DeathBlow")
        })
      : null,
    controlEffectResult: data.controlEffectTriggered === true && data.pendingControlEffectKey
      ? await applyControlEffect(target, data.pendingControlEffectKey)
      : null
  };
}

async function finalizePendingAttackMessage(message, {
  finalHit = true,
  resolutionLabel = "",
  resolutionText = "",
  resolutionSuccess = false,
  reactionDamageMultiplier = 1,
  reactionOutcomeText = ""
} = {}) {
  const data = getAttackCardData(message);
  if (!data || data.resolutionSettled === true) return data;

  let knockoutStunResult = null;
  let deathBlowResult = null;
  let controlEffectResult = null;

  if (finalHit) {
    const applied = await applyPendingAttackEffects(data);
    knockoutStunResult = applied.knockoutStunResult;
    deathBlowResult = applied.deathBlowResult;
    controlEffectResult = applied.controlEffectResult;
  }

  data.resolutionPending = false;
  data.resolutionSettled = true;
  data.showReactionOptions = false;
  data.showResolveHitButton = false;
  data.showDamageButton = finalHit && data.baseCanRollDamage === true;
  data.damageButtonDisabled = !finalHit;
  data.canRollDamage = finalHit && data.baseCanRollDamage === true;
  data.noDamageText = finalHit
    ? game.i18n.localize("RIFTS.Combat.NoDamageWithoutTarget")
    : game.i18n.localize("RIFTS.Combat.NoDamageAfterDefense");
  data.reactionDamageMultiplier = finalHit ? Math.max(0, num(reactionDamageMultiplier, 1)) : 1;
  data.reactionOutcomeText = finalHit ? String(reactionOutcomeText ?? "") : "";
  data.resolutionSummaryLabel = String(resolutionLabel ?? "").trim();
  data.resolutionSummaryText = String(resolutionText ?? "").trim();
  data.resolutionSummarySuccess = resolutionSuccess === true;
  data.resolutionSummaryPending = false;
  data.deathBlowDirectHp = false;
  data.deathBlowDirectHpMultiplier = 1;

  if (!finalHit) {
    data.outcomeLabel = game.i18n.localize("RIFTS.Combat.AttackOutcome.defended");
    data.hitLocation = "none";
    data.hitLocationLabel = game.i18n.localize("RIFTS.Combat.HitLocation.none");
    data.knockoutStunApplied = false;
    data.knockoutStunPending = false;
    data.knockoutStunAwaiting = false;
    data.deathBlowApplied = false;
    data.deathBlowPending = false;
    data.deathBlowAwaiting = false;
    data.controlEffectApplied = false;
    data.controlEffectPending = false;
    data.controlEffectAwaiting = false;
  } else {
    data.knockoutStunApplied = knockoutStunResult?.applied === true;
    data.knockoutStunPending = knockoutStunResult?.pending === true;
    data.knockoutStunAwaiting = false;
    data.deathBlowApplied = deathBlowResult?.applied === true;
    data.deathBlowPending = deathBlowResult?.pending === true;
    data.deathBlowAwaiting = false;
    data.deathBlowDirectHp = deathBlowResult?.directHp === true;
    data.deathBlowDirectHpMultiplier = Math.max(1, Math.floor(num(deathBlowResult?.directHpMultiplier, 1)));
    data.controlEffectApplied = controlEffectResult?.applied === true;
    data.controlEffectPending = controlEffectResult?.pending === true;
    data.controlEffectAwaiting = false;
  }

  if (data.queueAdvancePending === true && data.queueAdvanced !== true) {
    const combatId = String(data.combatId ?? "");
    const combat = combatId ? game.combats?.get?.(combatId) ?? null : game.combat ?? null;
    if (combat) {
      await advanceMeleeAction(combat, { announce: true });
      data.queueAdvanced = true;
    }
  }

  await updateAttackCardMessage(message, data);
  return data;
}

function cloneReactionDamageButton(sourceButton, {
  label,
  reactionDamageMultiplier = "1",
  reactionOutcomeText = "",
  isRecommended = false,
  disabled = false
} = {}) {
  if (!(sourceButton instanceof HTMLElement)) return null;

  const button = document.createElement("button");
  button.type = "button";
  button.dataset.action = "roll-damage";
  button.textContent = label;
  button.className = isRecommended ? "is-recommended" : "is-alternative";
  button.disabled = disabled === true;

  for (const [key, value] of Object.entries(sourceButton.dataset ?? {})) {
    if (key === "action") continue;
    button.dataset[key] = String(value ?? "");
  }

  button.dataset.reactionDamageMultiplier = String(reactionDamageMultiplier);
  button.dataset.reactionOutcomeText = String(reactionOutcomeText ?? "");
  return button;
}

function buildRollWithPunchFollowupFlavor({
  sourceDamageButton = null,
  success = false,
  attackTotal = 0,
  reactionTotal = 0,
  pullRollBonus = 0
} = {}) {
  const wrapper = document.createElement("div");
  wrapper.className = "rifts-reaction-followup-card";

  const summary = document.createElement("p");
  summary.innerHTML = `<strong>${game.i18n.localize("RIFTS.Maneuvers.RollWithPunch")}:</strong> ${game.i18n.format(
    success ? "RIFTS.Maneuvers.RollWithPunchSuccess" : "RIFTS.Maneuvers.RollWithPunchFailure",
    { attackTotal, reactionTotal, bonus: pullRollBonus }
  )}`;
  wrapper.append(summary);

  const damageOutcome = document.createElement("p");
  damageOutcome.innerHTML = `<strong>${game.i18n.localize("RIFTS.Rolls.Outcome")}:</strong> ${game.i18n.localize(
    success ? "RIFTS.Maneuvers.RollWithPunchDamageHalved" : "RIFTS.Maneuvers.RollWithPunchDamageNormal"
  )}`;
  wrapper.append(damageOutcome);

  if (sourceDamageButton instanceof HTMLElement) {
    const buttonRow = document.createElement("div");
    buttonRow.className = "reaction-row";

    const normalButton = cloneReactionDamageButton(sourceDamageButton, {
      label: game.i18n.localize("RIFTS.Combat.RollDamage"),
      reactionDamageMultiplier: "1",
      reactionOutcomeText: game.i18n.localize("RIFTS.Maneuvers.RollWithPunchDamageNormal"),
      isRecommended: !success,
      disabled: success
    });

    const halfButton = cloneReactionDamageButton(sourceDamageButton, {
      label: game.i18n.localize("RIFTS.Combat.RollHalfDamage"),
      reactionDamageMultiplier: "0.5",
      reactionOutcomeText: game.i18n.localize("RIFTS.Maneuvers.RollWithPunchDamageHalved"),
      isRecommended: success,
      disabled: !success
    });

    if (normalButton) buttonRow.append(normalButton);
    if (halfButton) buttonRow.append(halfButton);
    wrapper.append(buttonRow);
  }

  return wrapper.outerHTML;
}

function disableReactionButtons(root) {
  root.querySelectorAll("[data-action='react-parry'], [data-action='react-dodge'], [data-action='react-auto-dodge'], [data-action='react-roll-with-punch'], [data-action='react-all-out-dodge'], [data-action='resolve-hit']").forEach((entry) => {
    entry.disabled = true;
  });
}

async function resetCombatRoundAPM(combat, source = "combatRound") {
  if (!game.user?.isGM || !combat) return;

  const round = Math.max(0, Math.floor(num(combat.round, 0)));
  const previous = roundResetByCombat.get(combat.id);
  if (previous === round && source !== "combatStart") return;

  roundResetByCombat.set(combat.id, round);

  for (const combatant of combat.combatants) {
    const actor = combatant?.actor;
    if (!actor) continue;

    if (typeof actor.resetAPM === "function") {
      await actor.resetAPM();
      continue;
    }

    const apmTotal = Math.max(0, Math.floor(num(actor.system?.combat?.apmTotal, 0)));
    await actor.update({
      "system.combat.apmRemaining": apmTotal,
      "system.combat.apmSpent": 0,
      "system.combat.lastActionType": "reset",
      "system.combat.reactionAvailable": true
    });
  }
}

async function postAttackCard({
  attacker,
  attackerToken = null,
  weapon,
  target,
  targetToken = null,
  resolution,
  apmState = null,
  queueState = null,
  attackContext = null,
  usedHeldAction = false,
  ammoResult = null,
  unarmed = null,
  advancedActionLabelOverride = "",
  impactResult = null,
  defense = null,
  resolutionPending = false,
  queueAdvancePending = false,
  pendingControlEffectKey = "",
  knockoutStunResult = null,
  deathBlowResult = null,
  controlEffectResult = null
}) {
  const weaponData = getWeaponData(weapon);
  const weaponProficiency = getWeaponProficiencyContext(attacker, weapon, { useParry: false });
  const defenseState = defense ?? getDefenseAvailability(target, { weapon, attackContext });
  const defenderApm = getActorApmState(target);
  const scaleContext = getScaleContext({ attacker, target, weapon });
  const speaker = ChatMessage.getSpeaker({ actor: attacker });
  const pendingControlDefinition = pendingControlEffectKey
    ? getControlEffectDefinition(pendingControlEffectKey)
    : null;

  const costsAttackLabel = attackContext?.consumesAttack
    ? game.i18n.localize("RIFTS.Advanced.CostsAttack")
    : game.i18n.localize("RIFTS.Advanced.Reaction");

  const advancedActionLabel = String(advancedActionLabelOverride ?? "").trim()
    || localizeAdvancedAction(attackContext?.key ?? "standard");

  const renderData = {
    attackerName: attacker.name,
    weaponName: weapon?.name ?? game.i18n.localize("RIFTS.Combat.Unarmed"),
    targetName: target?.name ?? game.i18n.localize("RIFTS.Combat.NoTarget"),
    formula: resolution.attackRoll.formula,
    total: resolution.attackRoll.total,
    natural: resolution.naturalRoll,
    strikeTotal: resolution.strikeTotal,
    weaponBonus: resolution.weaponBonus,
    weaponBaseBonus: weaponData.bonusStrike,
    weaponProficiencyMatched: weaponProficiency.matched === true,
    weaponProficiencyName: String(weaponProficiency.skillName ?? ""),
    weaponProficiencyKey: String(weaponProficiency.proficiencyKey ?? ""),
    weaponProficiencyClassification: String(weaponProficiency.classification ?? ""),
    weaponProficiencyStrikeBonus: Math.max(0, Math.floor(num(weaponProficiency.strikeBonus, 0))),
    weaponProficiencyThrownBonus: Math.max(0, Math.floor(num(weaponProficiency.thrownBonus, 0))),
    weaponProficiencyRangeBonus: Math.max(0, Math.floor(num(weaponProficiency.rangeBonus, 0))),
    weaponProficiencyAppliedStrikeBonus: Math.max(0, Math.floor(num(weaponProficiency.appliedStrikeBonus, 0))),
    attackModifier: resolution.attackModifier,
    outcomeLabel: game.i18n.localize(`RIFTS.Combat.${resolution.outcomeLabel}`),
    isCritical: resolution.isCritical === true,
    criticalRange: Math.max(2, Math.floor(num(resolution.criticalRange, 20))),
    criticalDamageMultiplier: Math.max(1, Math.floor(num(resolution.criticalDamageMultiplier, 1))),
    knockoutStunTriggered: resolution.knockoutStunTriggered === true,
    knockoutStunRange: Math.max(0, Math.floor(num(resolution.knockoutStunRange, 0))),
    knockoutStunApplied: knockoutStunResult?.applied === true,
    knockoutStunPending: knockoutStunResult?.pending === true,
    knockoutStunAwaiting: resolutionPending && resolution.knockoutStunTriggered === true,
    knockoutStunLabel: String(knockoutStunResult?.label ?? game.i18n.localize("RIFTS.Combat.KnockoutStun")),
    deathBlowTriggered: resolution.deathBlowTriggered === true,
    deathBlowRange: Math.max(0, Math.floor(num(resolution.deathBlowRange, 0))),
    deathBlowApplied: deathBlowResult?.applied === true,
    deathBlowPending: deathBlowResult?.pending === true,
    deathBlowAwaiting: resolutionPending && resolution.deathBlowTriggered === true,
    deathBlowDirectHp: deathBlowResult?.directHp === true,
    deathBlowDirectHpMultiplier: Math.max(1, Math.floor(num(deathBlowResult?.directHpMultiplier, 1))),
    deathBlowLabel: String(deathBlowResult?.label ?? game.i18n.localize("RIFTS.Combat.DeathBlow")),
    controlEffectTriggered: Boolean(pendingControlEffectKey) || controlEffectResult?.triggered === true,
    controlEffectApplied: controlEffectResult?.applied === true,
    controlEffectPending: controlEffectResult?.pending === true,
    controlEffectAwaiting: resolutionPending && Boolean(pendingControlEffectKey),
    controlEffectLabel: String(controlEffectResult?.label ?? pendingControlDefinition?.label ?? ""),
    hitLocationLabel: resolution.hitLocation
      ? game.i18n.localize(`RIFTS.Combat.HitLocation.${resolution.hitLocation}`)
      : game.i18n.localize("RIFTS.Combat.HitLocation.none"),
    showDamageButton: resolution.canRollDamage,
    damageButtonDisabled: resolutionPending,
    canRollDamage: resolution.canRollDamage && !resolutionPending,
    showReactionOptions: resolutionPending,
    showResolveHitButton: resolutionPending,
    canParry: defenseState.canParry,
    canDodge: defenseState.canDodge,
    canDodgeNow: defenseState.canDodge && defenderApm.canSpendAttack,
    canAutoDodge: defenseState.canAutoDodge,
    canAllOutDodge: defenseState.canAllOutDodge,
    canRollWithPunch: defenseState.canRollWithPunch,
    canAllOutDodgeNow: defenseState.canAllOutDodge && defenderApm.canSpendAttack,
    defenderApmRemaining: defenderApm.remaining,
    defenderApmTotal: defenderApm.total,
    attackerId: attacker.id,
    attackerTokenId: attackerToken?.id ?? "",
    defenderId: target?.id ?? "",
    defenderTokenId: targetToken?.id ?? "",
    weaponId: weapon?.id ?? "",
    targetId: target?.id ?? "",
    targetTokenId: targetToken?.id ?? "",
    hitLocation: resolution.hitLocation ?? "none",
    isMegaDamage: weaponData.isMegaDamage,
    attackerApmRemaining: num(apmState?.remaining, num(attacker?.system?.combat?.apmRemaining, 0)),
    queuePosition: num(queueState?.queuePosition, 0),
    queueLength: num(queueState?.queueLength, 0),
    meleePass: num(queueState?.meleePass, 0),
    actionIndex: num(queueState?.actionIndex, 0),
    advancedActionLabel,
    advancedActionKey: attackContext?.key ?? "standard",
    advancedActionModifier: num(attackContext?.strikeModifier, 0),
    advancedActionCostLabel: costsAttackLabel,
    fireModeLabel: localizeFireMode(attackContext?.fireMode ?? "single"),
    attackerScaleLabel: game.i18n.localize(scaleContext.attackerScaleLabelKey),
    targetScaleLabel: game.i18n.localize(scaleContext.targetScaleLabelKey),
    weaponScaleLabel: game.i18n.localize(scaleContext.weaponScaleLabelKey),
    burstSize: num(attackContext?.burstSize, 0),
    usedHeldAction,
    ammoSpent: num(ammoResult?.spent, 0),
    ammoAfter: num(ammoResult?.after, num(weapon?.system?.weapon?.ammo?.value, 0)),
    isUnarmedManeuver: unarmed?.isUnarmedManeuver === true,
    unarmedManeuverLabel: unarmed?.label ?? "",
    unarmedManeuverSource: String(unarmed?.sourceName ?? unarmed?.sourceType ?? ""),
    unarmedSpecialRules: unarmed?.specialRules ?? "",
    unarmedActionCost: Math.max(0, Math.floor(num(unarmed?.actionCost, 1))),
    unarmedStrikeModifier: num(unarmed?.strikeModifier, 0),
    unarmedDamageMultiplier: Math.max(1, Math.floor(num(unarmed?.damageMultiplier, 1))),
    unarmedRequiresHit: unarmed?.requiresHit === true,
    unarmedStrengthBonus: num(unarmed?.strengthBonus, 0),
    unarmedHandToHandBonus: num(unarmed?.handToHandBonus, 0),
    unarmedDamageFormula: String(unarmed?.damageFormula ?? ""),
    unarmedManeuverKey: String(unarmed?.key ?? ""),
    hasImpactResult: impactResult?.attempted === true,
    impactSizeSummary: String(impactResult?.summary?.size ?? ""),
    impactKnockdownSummary: String(impactResult?.summary?.knockdown ?? ""),
    impactKnockbackSummary: String(impactResult?.summary?.knockback ?? ""),
    impactResistanceSummary: String(impactResult?.summary?.resistance ?? ""),
    impactTypeSummary: String(impactResult?.summary?.impact ?? ""),
    resolutionPending,
    resolutionSettled: !resolutionPending,
    resolutionSummaryLabel: "",
    resolutionSummaryText: resolutionPending ? game.i18n.localize("RIFTS.Combat.ReactionPending") : "",
    resolutionSummarySuccess: false,
    resolutionSummaryPending: resolutionPending,
    baseCanRollDamage: resolution.canRollDamage,
    reactionDamageMultiplier: 1,
    reactionOutcomeText: "",
    noDamageText: game.i18n.localize("RIFTS.Combat.NoDamageWithoutTarget"),
    deathBlowDirectHp: false,
    deathBlowDirectHpMultiplier: 1,
    pendingControlEffectKey: String(pendingControlEffectKey ?? ""),
    combatId: game.combat?.id ?? "",
    queueAdvancePending: queueAdvancePending === true,
    queueAdvanced: false
  };

  const content = await renderAttackCardContent(renderData);

  return ChatMessage.create({
    speaker,
    content,
    flags: {
      rifts: {
        attackCardData: renderData,
        type: "attack-card",
        attackerId: attacker.id,
        attackerTokenId: attackerToken?.id ?? "",
        weaponId: weapon?.id ?? "",
        weaponProficiencyKey: String(weaponProficiency.proficiencyKey ?? ""),
        weaponProficiencyName: String(weaponProficiency.skillName ?? ""),
        targetId: target?.id ?? "",
        targetTokenId: targetToken?.id ?? "",
        hitLocation: resolution.hitLocation ?? "none",
        isMegaDamage: weaponData.isMegaDamage,
        attackActionKey: attackContext?.key ?? "standard",
        fireMode: attackContext?.fireMode ?? "single",
        attackerScale: scaleContext.attackerScale,
        targetScale: scaleContext.targetScale,
        weaponScale: scaleContext.weaponScale,
        unarmedManeuverKey: String(unarmed?.key ?? ""),
        unarmedDamageFormula: String(unarmed?.damageFormula ?? ""),
        unarmedManeuverSource: String(unarmed?.sourceName ?? unarmed?.sourceType ?? ""),
        unarmedActionCost: Math.max(0, Math.floor(num(unarmed?.actionCost, 1))),
        unarmedStrikeModifier: num(unarmed?.strikeModifier, 0),
        unarmedDamageMultiplier: Math.max(1, Math.floor(num(unarmed?.damageMultiplier, 1))),
        unarmedRequiresHit: unarmed?.requiresHit === true,
        impactResult: impactResult ?? null,
        knockoutStunRange: renderData.knockoutStunRange,
        knockoutStunTriggered: renderData.knockoutStunTriggered,
        knockoutStunApplied: renderData.knockoutStunApplied,
        knockoutStunPending: renderData.knockoutStunPending,
        deathBlowRange: renderData.deathBlowRange,
        deathBlowTriggered: renderData.deathBlowTriggered,
        deathBlowApplied: renderData.deathBlowApplied,
        deathBlowPending: renderData.deathBlowPending,
        deathBlowDirectHp: renderData.deathBlowDirectHp,
        deathBlowDirectHpMultiplier: renderData.deathBlowDirectHpMultiplier,
        controlEffectTriggered: renderData.controlEffectTriggered,
        controlEffectApplied: renderData.controlEffectApplied,
        controlEffectPending: renderData.controlEffectPending,
        controlEffectLabel: renderData.controlEffectLabel,
        resolutionPending,
        pendingControlEffectKey: String(pendingControlEffectKey ?? "")
      }
    }
  });
}

async function postDamageCard({
  attacker,
  target,
  weapon,
  hitLocation,
  isMegaDamage,
  roll,
  scaleContext = null,
  damageModeLabel = "",
  scaleReasonLabel = "",
  attackerToken = null,
  targetToken = null,
  unarmedManeuverKey = "",
  unarmedDamageFormula = "",
  outcomeText = "",
  deathBlowDirectHp = false,
  deathBlowDirectHpMultiplier = 1
}) {
  const speaker = ChatMessage.getSpeaker({ actor: attacker });
  const flavor = await foundry.applications.handlebars.renderTemplate(DAMAGE_TEMPLATE, {
    attackerName: attacker?.name ?? game.i18n.localize("RIFTS.Combat.UnknownActor"),
    targetName: target?.name ?? game.i18n.localize("RIFTS.Combat.NoTarget"),
    weaponName: weapon?.name ?? game.i18n.localize("RIFTS.Combat.Unarmed"),
    formula: roll.formula,
    total: roll.total,
    hitLocationLabel: game.i18n.localize(`RIFTS.Combat.HitLocation.${hitLocation ?? "none"}`),
    attackerScaleLabel: scaleContext ? game.i18n.localize(scaleContext.attackerScaleLabelKey) : "",
    targetScaleLabel: scaleContext ? game.i18n.localize(scaleContext.targetScaleLabelKey) : "",
    weaponScaleLabel: scaleContext ? game.i18n.localize(scaleContext.weaponScaleLabelKey) : "",
    damageModeLabel,
    scaleReasonLabel,
    canApplyDamage: Boolean(target),
    attackerId: attacker?.id ?? "",
    attackerTokenId: attackerToken?.id ?? "",
    targetId: target?.id ?? "",
    targetTokenId: targetToken?.id ?? "",
    weaponId: weapon?.id ?? "",
    hitLocation: hitLocation ?? "none",
    isMegaDamage,
    amount: roll.total,
    unarmedManeuverKey,
    unarmedDamageFormula,
    outcomeText,
    deathBlowDirectHp,
    deathBlowDirectHpMultiplier
  });

  return roll.toMessage({
    speaker,
    flavor,
    flags: {
      rifts: {
        type: "damage-card",
        attackerId: attacker?.id ?? "",
        attackerTokenId: attackerToken?.id ?? "",
        targetId: target?.id ?? "",
        targetTokenId: targetToken?.id ?? "",
        weaponId: weapon?.id ?? "",
        hitLocation: hitLocation ?? "none",
        isMegaDamage,
        amount: roll.total,
        attackerScale: scaleContext?.attackerScale ?? "",
        targetScale: scaleContext?.targetScale ?? "",
        weaponScale: scaleContext?.weaponScale ?? "",
        damageModeLabel,
        scaleReasonLabel,
        unarmedManeuverKey,
        unarmedDamageFormula,
        outcomeText,
        deathBlowDirectHp,
        deathBlowDirectHpMultiplier
      }
    }
  });
}

export function getTargetFromUI() {
  const targets = Array.from(game.user?.targets ?? []);
  if (targets.length !== 1) return null;

  const token = targets[0];
  if (!token?.actor) return null;

  return {
    actor: token.actor,
    token
  };
}

export async function resolveAttack({ attacker, target = null, weapon = null, attackContext = null }) {
  const strikeTotal = num(attacker?.system?.combat?.derived?.strikeTotal, num(attacker?.system?.combat?.strikeMod, 0));
  const weaponData = getWeaponData(weapon);
  const weaponProficiency = getWeaponProficiencyContext(attacker, weapon, { useParry: false });
  const weaponBonus = weaponData.bonusStrike + num(weaponProficiency?.appliedStrikeBonus, 0);
  const attackModifier = num(attackContext?.strikeModifier, 0);
  const totalBonus = strikeTotal + weaponBonus + attackModifier;
  const attackRoll = await (new Roll(`1d20 + ${totalBonus}`)).evaluate();
  const naturalRoll = getNaturalD20(attackRoll);
  const isGrapple = attackContext?.key === "grapple";
  const baseHitNumber = getAttackBaseHitNumber({ weapon, attackContext });
  const criticalRange = getAttackCriticalRange(attacker, { weapon, attackContext });
  const knockoutStunRange = getAttackKnockoutStunRange(attacker, { weapon, attackContext });
  const deathBlowRange = getAttackDeathBlowRange(attacker, { weapon, attackContext });
  const declaredFinisher = getAttackDeclaredFinisher({ weapon, attackContext });
  const maneuverKey = getAttackManeuverKey(weapon).toLowerCase();
  const boxingAutoKnockout = attacker?.system?.combat?.derived?.physicalSkillAutomaticKnockoutOn20 === true
    && maneuverKey === "punch";
  const effectiveKnockoutStunRange = knockoutStunRange ?? (boxingAutoKnockout ? 20 : null);
  const isCritical = criticalRange !== null && naturalRoll >= criticalRange && naturalRoll !== 1;
  const criticalDamageMultiplier = isCritical ? CRITICAL_DAMAGE_MULTIPLIER : 1;

  if (!target) {
    return {
      attackRoll,
      naturalRoll,
      strikeTotal,
      weaponBonus,
      attackModifier,
      totalBonus,
      targetAr: 0,
      outcomeLabel: "AttackOutcome.noTarget",
      hitLocation: null,
      canRollDamage: false,
      baseHitNumber,
      criticalRange,
      isCritical,
      criticalDamageMultiplier,
      declaredFinisher,
      knockoutStunRange: effectiveKnockoutStunRange,
      knockoutStunTriggered: false,
      deathBlowRange,
      deathBlowTriggered: false
    };
  }

  const targetAr = getTargetAr(target);
  if (naturalRoll === 1 || attackRoll.total < baseHitNumber) {
    return {
      attackRoll,
      naturalRoll,
      strikeTotal,
      weaponBonus,
      attackModifier,
      totalBonus,
      targetAr,
      outcomeLabel: "AttackOutcome.miss",
      hitLocation: null,
      canRollDamage: false,
      baseHitNumber,
      criticalRange,
      isCritical: false,
      criticalDamageMultiplier: 1,
      declaredFinisher,
      knockoutStunRange: effectiveKnockoutStunRange,
      knockoutStunTriggered: false,
      deathBlowRange,
      deathBlowTriggered: false
    };
  }

  if (declaredFinisher === "knockoutStun" && effectiveKnockoutStunRange !== null && naturalRoll < effectiveKnockoutStunRange) {
    return {
      attackRoll,
      naturalRoll,
      strikeTotal,
      weaponBonus,
      attackModifier,
      totalBonus,
      targetAr,
      outcomeLabel: "AttackOutcome.calledShotFailed",
      hitLocation: null,
      canRollDamage: false,
      baseHitNumber,
      criticalRange,
      isCritical: false,
      criticalDamageMultiplier: 1,
      declaredFinisher,
      knockoutStunRange: effectiveKnockoutStunRange,
      knockoutStunTriggered: false,
      deathBlowRange,
      deathBlowTriggered: false
    };
  }

  if (declaredFinisher === "deathBlow" && deathBlowRange !== null && naturalRoll < deathBlowRange) {
    return {
      attackRoll,
      naturalRoll,
      strikeTotal,
      weaponBonus,
      attackModifier,
      totalBonus,
      targetAr,
      outcomeLabel: "AttackOutcome.calledShotFailed",
      hitLocation: null,
      canRollDamage: false,
      baseHitNumber,
      criticalRange,
      isCritical: false,
      criticalDamageMultiplier: 1,
      declaredFinisher,
      knockoutStunRange: effectiveKnockoutStunRange,
      knockoutStunTriggered: false,
      deathBlowRange,
      deathBlowTriggered: false
    };
  }

  // Milestone 8: vehicles currently resolve to body/MDC directly (subsystem hit locations deferred).
  if (target.type === "vehicle") {
    return {
      attackRoll,
      naturalRoll,
      strikeTotal,
      weaponBonus,
      attackModifier,
      totalBonus,
      targetAr,
      outcomeLabel: isGrapple ? "AttackOutcome.grappleSuccess" : "AttackOutcome.hitBody",
      hitLocation: "body",
      canRollDamage: !isGrapple,
      baseHitNumber,
      criticalRange,
      isCritical,
      criticalDamageMultiplier,
      declaredFinisher,
      knockoutStunRange: effectiveKnockoutStunRange,
      knockoutStunTriggered: false,
      deathBlowRange,
      deathBlowTriggered: false
    };
  }

  const hitLocation = isGrapple ? "body" : (targetAr > 0 && naturalRoll >= targetAr ? "armor" : "body");
  const knockoutStunTriggered = !isGrapple
    && hitLocation === "body"
    && effectiveKnockoutStunRange !== null
    && naturalRoll >= effectiveKnockoutStunRange
    && naturalRoll !== 1;
  const deathBlowTriggered = !isGrapple
    && hitLocation === "body"
    && deathBlowRange !== null
    && naturalRoll >= deathBlowRange
    && naturalRoll !== 1;

  return {
    attackRoll,
    naturalRoll,
    strikeTotal,
    weaponBonus,
    attackModifier,
    totalBonus,
    targetAr,
    outcomeLabel: isGrapple
      ? "AttackOutcome.grappleSuccess"
      : (hitLocation === "armor" ? "AttackOutcome.hitArmor" : "AttackOutcome.hitBody"),
    hitLocation,
    canRollDamage: !isGrapple,
    baseHitNumber,
    criticalRange,
    isCritical,
    criticalDamageMultiplier,
    declaredFinisher,
    knockoutStunRange: effectiveKnockoutStunRange,
    knockoutStunTriggered,
    deathBlowRange,
    deathBlowTriggered
  };
}

export async function rollDamage({
  attacker = null,
  weapon = null,
  isMegaDamage = false,
  attackContext = null,
  formulaOverride = "",
  criticalDamageMultiplier = 1,
  reactionDamageMultiplier = 1,
  directHpDamageMultiplier = 1
} = {}) {
  const weaponData = getWeaponData(weapon);
  let formula = String(formulaOverride ?? "").trim();

  if (!formula) {
    formula = weaponData.damage;

    if (attackContext?.key === "burstFire") {
      const multiplier = Math.max(1, Math.floor(num(attackContext?.damageMultiplier, weaponData.burstDamageMultiplier)));
      formula = multiplier > 1 ? `(${formula}) * ${multiplier}` : formula;
    }

    if (attackContext?.key === "grapple") {
      formula = "0";
    }
  }

  const critMultiplier = Math.max(1, Math.floor(num(criticalDamageMultiplier, 1)));
  if (critMultiplier > 1) {
    formula = `(${formula}) * ${critMultiplier}`;
  }

  const reactionMultiplier = Math.max(0, num(reactionDamageMultiplier, 1));
  if (reactionMultiplier > 0 && reactionMultiplier !== 1) {
    formula = reactionMultiplier < 1
      ? `floor((${formula}) * ${reactionMultiplier})`
      : `((${formula}) * ${reactionMultiplier})`;
  }

  const hpMultiplier = Math.max(1, Math.floor(num(directHpDamageMultiplier, 1)));
  if (hpMultiplier > 1) {
    formula = `((${formula}) * ${hpMultiplier})`;
  }

  const roll = await (new Roll(formula)).evaluate();
  roll.options ??= {};
  roll.options.isMegaDamage = isMegaDamage;
  roll.options.attackActionKey = attackContext?.key ?? "standard";
  return roll;
}
export async function applyDamage({
  targetActor,
  amount,
  isMegaDamage = false,
  hitLocation = "body",
  armorItem = null,
  attacker = null,
  weapon = null,
  directToHp = false,
  directHpMultiplier = 1
}) {
  if (!game.user.isGM) {
    throw new Error(game.i18n.localize("RIFTS.Errors.ApplyDamageGMOnly"));
  }

  if (!targetActor) {
    throw new Error(game.i18n.localize("RIFTS.Errors.TargetNotFound"));
  }

  if (targetActor.type === "vehicle" && !hasValidVehicleMdc(targetActor)) {
    ui.notifications.warn(game.i18n.localize("RIFTS.Combat.Warning.VehicleNoMdc"));
  }

  const baseAmount = Math.max(0, num(amount, 0));
  const actorUpdates = {};
  const result = {
    originalAmount: baseAmount,
    convertedAmount: baseAmount,
    appliedAmount: 0,
    remaining: baseAmount,
    hitLocation,
    armor: null,
    body: [],
    scale: {
      attackerScale: "sdc",
      targetScale: "sdc",
      bodyScale: "sdc",
      weaponScale: isMegaDamage ? "mdc" : "sdc",
      mode: "same-scale",
      reasonKey: "RIFTS.Combat.Durability.SdcVsSdc",
      multiplier: 1,
      noEffect: false,
      catastrophic: false
    }
  };

  let selectedArmor = targetActor.type === "vehicle" ? null : armorItem;
  if (!selectedArmor && hitLocation === "armor" && targetActor.type !== "vehicle") {
    selectedArmor = getEquippedArmor(targetActor);
  }

  const baseScaleContext = getScaleContext({ attacker, target: targetActor, weapon });
  if (!weapon) {
    baseScaleContext.weaponScale = isMegaDamage ? "mdc" : "sdc";
    baseScaleContext.weaponScaleLabelKey = getDurabilityLabelKey(baseScaleContext.weaponScale);
  }

  const effectiveTargetScale = getEffectiveActorScale(targetActor, { activeArmor: selectedArmor ?? getEquippedArmor(targetActor) });
  const bodyScale = getBodyScaleForActor(targetActor, effectiveTargetScale);

  result.scale.attackerScale = baseScaleContext.attackerScale;
  result.scale.targetScale = effectiveTargetScale;
  result.scale.bodyScale = bodyScale;
  result.scale.weaponScale = baseScaleContext.weaponScale;

  let remainingAttackUnits = baseAmount;

  if (directToHp) {
    const actorUpdates = {};
    const hpDamage = Math.max(0, Math.floor(baseAmount));
    const hpStep = applyToPool(actorUpdates, targetActor, "system.resources.hp", hpDamage);

    if (Object.keys(actorUpdates).length) {
      await targetActor.update(actorUpdates);
    }

    result.convertedAmount = hpDamage;
    result.appliedAmount = hpStep.applied;
    result.remaining = hpStep.remaining;
    result.hitLocation = "body";
    result.scale.mode = "direct-hp";
    result.scale.reasonKey = "RIFTS.Combat.Durability.DirectHp";
    result.scale.multiplier = Math.max(1, Math.floor(num(directHpMultiplier, 1)));
    result.body.push({ pool: "HP", ...hpStep, direct: true });
    return result;
  }

  if (hitLocation === "armor" && selectedArmor) {
    const armorData = getArmorData(selectedArmor);
    const armorUpdates = {};
    const armorScale = getArmorProtectionScale(selectedArmor);

    const armorInteraction = resolveScaleInteraction({
      attackScale: baseScaleContext.weaponScale,
      targetScale: armorScale,
      baseDamage: remainingAttackUnits
    });

    if (armorInteraction.noEffect) {
      result.convertedAmount = 0;
      result.remaining = 0;
      result.scale.mode = armorInteraction.mode;
      result.scale.reasonKey = armorInteraction.reasonKey;
      result.scale.multiplier = armorInteraction.multiplier;
      result.scale.noEffect = true;
      result.armor = {
        itemName: selectedArmor.name,
        pool: isMdcScale(armorScale) ? "MDC" : "SDC",
        applied: 0,
        before: isMdcScale(armorScale) ? armorData.mdcValue : armorData.sdcValue,
        after: isMdcScale(armorScale) ? armorData.mdcValue : armorData.sdcValue,
        scale: armorScale,
        reasonKey: armorInteraction.reasonKey,
        noEffect: true
      };
      return result;
    }

    let armorDamageAmount = Math.max(0, num(armorInteraction.convertedDamage, 0));
    if (armorInteraction.mode === "mdc-vs-sdc-catastrophic") {
      armorDamageAmount = Math.max(armorDamageAmount, CATASTROPHIC_SDC_DAMAGE);
      result.scale.catastrophic = true;
    }
    result.convertedAmount = armorDamageAmount;

    const shouldUseMdcArmorPool = isMdcScale(armorScale) && armorData.mdcValue > 0;
    const armorPool = shouldUseMdcArmorPool ? "mdc" : "sdc";
    const armorPath = getArmorPoolPath(selectedArmor, armorPool);
    const armorStep = applyToPool(armorUpdates, selectedArmor, armorPath, armorDamageAmount);

    if (Object.keys(armorUpdates).length) {
      await selectedArmor.update(armorUpdates);
    }

    result.armor = {
      itemName: selectedArmor.name,
      pool: shouldUseMdcArmorPool ? "MDC" : "SDC",
      applied: armorStep.applied,
      before: armorStep.before,
      after: armorStep.after,
      scale: armorScale,
      reasonKey: armorInteraction.reasonKey,
      noEffect: false
    };

    const reverseMultiplier = Math.max(1, num(armorInteraction.multiplier, 1));
    remainingAttackUnits = Math.max(0, num(armorStep.remaining, 0)) / reverseMultiplier;
  }

  const bodyInteraction = resolveScaleInteraction({
    attackScale: baseScaleContext.weaponScale,
    targetScale: bodyScale,
    baseDamage: remainingAttackUnits
  });

  result.scale.mode = bodyInteraction.mode;
  result.scale.reasonKey = bodyInteraction.reasonKey;
  result.scale.multiplier = bodyInteraction.multiplier;
  result.scale.noEffect = bodyInteraction.noEffect;

  if (bodyInteraction.noEffect) {
    result.remaining = 0;
    result.appliedAmount = num(result.armor?.applied, 0);
    return result;
  }

  let remainingBodyDamage = Math.max(0, num(bodyInteraction.convertedDamage, 0));
  if (bodyInteraction.mode === "mdc-vs-sdc-catastrophic") {
    remainingBodyDamage = Math.max(remainingBodyDamage, CATASTROPHIC_SDC_DAMAGE);
    result.scale.catastrophic = true;
  }
  result.convertedAmount = Math.max(result.convertedAmount, remainingBodyDamage);

  const bodyMode = getActorBodyPoolMode(targetActor, bodyScale);

  if (remainingBodyDamage > 0 && bodyMode === "MDC") {
    const bodyStep = applyToPool(actorUpdates, targetActor, "system.resources.mdc", remainingBodyDamage);
    remainingBodyDamage = bodyStep.remaining;
    result.body.push({ pool: "MDC", ...bodyStep });
  }

  if (remainingBodyDamage > 0 && bodyMode === "SDC_HP") {
    const sdcStep = applyToPool(actorUpdates, targetActor, "system.resources.sdc", remainingBodyDamage);
    remainingBodyDamage = sdcStep.remaining;
    result.body.push({ pool: "SDC", ...sdcStep });

    if (remainingBodyDamage > 0) {
      const hpStep = applyToPool(actorUpdates, targetActor, "system.resources.hp", remainingBodyDamage);
      remainingBodyDamage = hpStep.remaining;
      result.body.push({ pool: "HP", ...hpStep });
    }
  }

  if (Object.keys(actorUpdates).length) {
    await targetActor.update(actorUpdates);
  }

  result.remaining = remainingBodyDamage;
  result.appliedAmount = num(result.armor?.applied, 0) + result.body.reduce((sum, step) => sum + num(step.applied, 0), 0);
  return result;
}

export async function attackWithWeapon({ attacker, weaponId, attackAction = "standard", tokenId = "" }) {
  if (!attacker) return null;

  const weapon = attacker?.items?.get(weaponId) ?? null;
  const attackContext = getAttackActionContext({ actionKey: attackAction, weapon });

  if (attackContext.key === "burstFire" && weapon && !weaponSupportsBurst(weapon)) {
    ui.notifications.warn(game.i18n.localize("RIFTS.Advanced.NotAvailable"));
    return null;
  }

  if (attackContext.key === "aimedShot" && weapon?.system?.weapon?.supportsAimedShot === false) {
    ui.notifications.warn(game.i18n.localize("RIFTS.Advanced.NotAvailable"));
    return null;
  }

  const scaleWarnings = getWeaponScaleWarnings(weapon);
  if (scaleWarnings.length > 0) {
    ui.notifications.warn(game.i18n.localize(scaleWarnings[0]));
  }

  const combat = game.combat ?? null;
  const attackerToken = getActorContextToken(attacker, tokenId);
  const actionGate = await canActorTakeMeleeAction(combat, attacker, {
    allowGMOverride: true,
    tokenId: attackerToken?.id ?? ""
  });
  let usedHeldAction = false;

  if (!actionGate.ok) {
    const heldCount = Math.max(0, Math.floor(num(attacker?.system?.combat?.heldActionCount, 0)));
    const heldReady = attacker?.system?.combat?.heldActionReady === true;

    if (heldCount > 0 && heldReady) {
      const heldSpend = await consumeHeldAction(attacker, {
        announce: true,
        reasonKey: "RIFTS.Advanced.ReleaseHeldActionLog"
      });

      if (!heldSpend?.ok) {
        ui.notifications.warn(game.i18n.localize("RIFTS.Advanced.NotAvailable"));
        return null;
      }

      usedHeldAction = true;
    } else {
      const currentActorName = actionGate.currentActorName || game.i18n.localize("RIFTS.Combat.UnknownActor");
      if (heldCount > 0 && !heldReady) {
        ui.notifications.warn(game.i18n.localize("RIFTS.Advanced.ReleaseHeldRequired"));
      } else {
        ui.notifications.warn(game.i18n.format("RIFTS.Melee.NotYourActionActor", {
          actor: currentActorName
        }));
      }
      return null;
    }
  }

  if (actionGate.gmOverride) {
    const currentActorName = actionGate.currentActorName || game.i18n.localize("RIFTS.Combat.UnknownActor");
    ui.notifications.warn(game.i18n.format("RIFTS.Melee.GMOverride", {
      actor: currentActorName
    }));
  }

  let spend = { ok: true, remaining: num(attacker?.system?.combat?.apmRemaining, 0) };
  if (attackContext.consumesAttack) {
    spend = typeof attacker.spendAttack === "function"
      ? await attacker.spendAttack("strike")
      : spend;

    if (!spend?.ok) {
      ui.notifications.warn(game.i18n.localize("RIFTS.Combat.NoAttacksRemaining"));
      return null;
    }
  }

  // Quality-of-life: attacking with a weapon marks it equipped if it was not already.
  if (weapon && typeof weapon.update === "function" && weapon.system?.equipped !== true) {
    await weapon.update({ "system.equipped": true });
  }

  if (weapon && typeof weapon.update === "function" && ["single", "burst"].includes(attackContext.fireMode)) {
    await weapon.update({ "system.weapon.fireMode": attackContext.fireMode });
  }

  let ammoResult = null;
  if (weapon && typeof weapon.update === "function" && attackContext.key === "burstFire") {
    ammoResult = await applyWeaponAmmoCost(weapon, attackContext.ammoCost);
    if (ammoResult?.insufficient) {
      ui.notifications.warn(game.i18n.localize("RIFTS.Advanced.NotAvailable"));
      return null;
    }
  }

  const targetFromUi = getTargetFromUI();
  const savedTarget = getTargetFromLastSaved(attacker);
  const targetContext = targetFromUi ?? savedTarget ?? null;
  const target = targetContext?.actor ?? null;
  const targetToken = targetContext?.token ?? null;

  if (attackContext.key === "grapple" && !target) {
    ui.notifications.warn(game.i18n.localize("RIFTS.Errors.TargetNotFound"));
    return null;
  }

  if (target) {
    await attacker.update({
      "system.combat.lastTargetId": target.id,
      "system.combat.lastTargetTokenId": targetToken?.id ?? ""
    });
  }

  const resolution = await resolveAttack({
    attacker,
    target,
    weapon,
    attackContext
  });

  await attacker.update({ "system.combat.lastAdvancedAction": attackContext.key });

  const impactResult = resolveImpactResult({
    attacker,
    target,
    weapon,
    maneuver: weapon?.system?.weapon ?? null,
    resolution
  });

  const defense = getDefenseAvailability(target, { weapon, attackContext });
  const resolutionPending = shouldAwaitReaction({ target, resolution, defense });
  const pendingControlEffectKey = attackContext.key === "grapple" && resolution.hitLocation
    ? "grapple"
    : "";

  const knockoutStunResult = !resolutionPending && resolution.knockoutStunTriggered === true
    ? await applyKnockoutStunEffect(target)
    : null;
  const deathBlowResult = !resolutionPending && resolution.deathBlowTriggered === true
    ? await applyDeathBlowEffect(target)
    : null;
  const controlEffectResult = !resolutionPending && pendingControlEffectKey
    ? await applyControlEffect(target, pendingControlEffectKey)
    : null;

  const message = await postAttackCard({
    attacker,
    attackerToken,
    weapon,
    target,
    targetToken,
    resolution,
    apmState: spend,
    queueState: actionGate.current,
    attackContext,
    usedHeldAction,
    ammoResult,
    impactResult,
    defense,
    resolutionPending,
    queueAdvancePending: Boolean(combat && actionGate.isCurrent),
    pendingControlEffectKey,
    knockoutStunResult,
    deathBlowResult,
    controlEffectResult
  });

  if (!resolutionPending && combat && actionGate.isCurrent) {
    await advanceMeleeAction(combat, { announce: true });
  }

  return message;
}

export async function attackWithUnarmedManeuver({
  attacker,
  maneuverKey = "punch",
  tokenId = "",
  maneuverData = null,
  advancedActionLabelOverride = ""
} = {}) {
  if (!attacker) return null;

  const fallbackManeuver = getUnarmedManeuver(maneuverKey);
  const maneuverInput = maneuverData ?? fallbackManeuver;
  if (!maneuverInput) {
    ui.notifications.warn(game.i18n.localize("RIFTS.Advanced.NotAvailable"));
    return null;
  }

  const unarmedProfile = maneuverData
    ? buildUnarmedDamageProfileFromData(attacker, maneuverInput)
    : buildUnarmedDamageProfile(attacker, fallbackManeuver.key);

  const weapon = maneuverData
    ? createUnarmedWeaponProfileFromData(attacker, maneuverInput)
    : createUnarmedWeaponProfile(attacker, fallbackManeuver.key);

  const maneuver = unarmedProfile?.maneuver ?? fallbackManeuver;
  if (!unarmedProfile || !weapon || !maneuver) {
    ui.notifications.warn(game.i18n.localize("RIFTS.Advanced.NotAvailable"));
    return null;
  }

  const maneuverDamageMultiplier = Math.max(1, Math.floor(num(maneuver?.damageMultiplier, 1)));
  const finalUnarmedDamageFormula = maneuverDamageMultiplier > 1
    ? "(" + unarmedProfile.formula + ") * " + maneuverDamageMultiplier
    : unarmedProfile.formula;

  const attackContext = {
    ...getAttackActionContext({ actionKey: "standard", weapon }),
    strikeModifier: num(maneuver.strikeModifier, 0),
    damageMultiplier: maneuverDamageMultiplier
  };

  const combat = game.combat ?? null;
  const attackerToken = getActorContextToken(attacker, tokenId);
  const actionGate = await canActorTakeMeleeAction(combat, attacker, {
    allowGMOverride: true,
    tokenId: attackerToken?.id ?? ""
  });
  let usedHeldAction = false;

  if (!actionGate.ok) {
    const heldCount = Math.max(0, Math.floor(num(attacker?.system?.combat?.heldActionCount, 0)));
    const heldReady = attacker?.system?.combat?.heldActionReady === true;

    if (heldCount > 0 && heldReady) {
      const heldSpend = await consumeHeldAction(attacker, {
        announce: true,
        reasonKey: "RIFTS.Advanced.ReleaseHeldActionLog"
      });

      if (!heldSpend?.ok) {
        ui.notifications.warn(game.i18n.localize("RIFTS.Advanced.NotAvailable"));
        return null;
      }

      usedHeldAction = true;
    } else {
      const currentActorName = actionGate.currentActorName || game.i18n.localize("RIFTS.Combat.UnknownActor");
      if (heldCount > 0 && !heldReady) {
        ui.notifications.warn(game.i18n.localize("RIFTS.Advanced.ReleaseHeldRequired"));
      } else {
        ui.notifications.warn(game.i18n.format("RIFTS.Melee.NotYourActionActor", {
          actor: currentActorName
        }));
      }
      return null;
    }
  }

  if (actionGate.gmOverride) {
    const currentActorName = actionGate.currentActorName || game.i18n.localize("RIFTS.Combat.UnknownActor");
    ui.notifications.warn(game.i18n.format("RIFTS.Melee.GMOverride", {
      actor: currentActorName
    }));
  }

  const maneuverCost = Math.max(1, Math.floor(num(maneuver.actionCost, 1)));
  let spend = { ok: true, remaining: num(attacker?.system?.combat?.apmRemaining, 0) };
  if (attackContext.consumesAttack) {
    spend = typeof attacker.spendAttack === "function"
      ? await attacker.spendAttack(`unarmed-${maneuver.key}`, maneuverCost)
      : spend;

    if (!spend?.ok) {
      ui.notifications.warn(game.i18n.localize("RIFTS.Combat.NoAttacksRemaining"));
      return null;
    }
  }

  const targetFromUi = getTargetFromUI();
  const savedTarget = getTargetFromLastSaved(attacker);
  const targetContext = targetFromUi ?? savedTarget ?? null;
  const target = targetContext?.actor ?? null;
  const targetToken = targetContext?.token ?? null;

  if (maneuver?.requiresTarget === true && !target) {
    ui.notifications.warn(game.i18n.localize("RIFTS.Errors.TargetNotFound"));
    return null;
  }

  if (target) {
    await attacker.update({
      "system.combat.lastTargetId": target.id,
      "system.combat.lastTargetTokenId": targetToken?.id ?? ""
    });
  }

  const resolution = await resolveAttack({
    attacker,
    target,
    weapon,
    attackContext
  });

  await attacker.update({ "system.combat.lastAdvancedAction": `unarmed-${maneuver.key}` });

  const impactResult = resolveImpactResult({
    attacker,
    target,
    weapon,
    maneuver,
    resolution
  });

  const controlEffectKeys = new Set(["entangle", "holds", "hold"]);
  const defense = getDefenseAvailability(target, { weapon, attackContext });
  const resolutionPending = shouldAwaitReaction({ target, resolution, defense });
  const pendingControlEffectKey = resolution.hitLocation && controlEffectKeys.has(String(maneuver.key ?? "").trim().toLowerCase())
    ? String(maneuver.key ?? "")
    : "";

  const knockoutStunResult = !resolutionPending && resolution.knockoutStunTriggered === true
    ? await applyKnockoutStunEffect(target)
    : null;
  const deathBlowResult = !resolutionPending && resolution.deathBlowTriggered === true
    ? await applyDeathBlowEffect(target)
    : null;
  const controlEffectResult = !resolutionPending && pendingControlEffectKey
    ? await applyControlEffect(target, pendingControlEffectKey)
    : null;

  const message = await postAttackCard({
    attacker,
    attackerToken,
    weapon,
    target,
    targetToken,
    resolution,
    apmState: spend,
    queueState: actionGate.current,
    attackContext,
    usedHeldAction,
    ammoResult: null,
    unarmed: {
      isUnarmedManeuver: true,
      key: maneuver.key,
      label: String(maneuver.label ?? "").trim() || (maneuver.labelKey ? game.i18n.localize(maneuver.labelKey) : maneuver.key),
      sourceType: String(maneuver.sourceType ?? ""),
      sourceName: String(maneuver.sourceName ?? ""),
      actionCost: Math.max(0, Math.floor(num(maneuver.actionCost, 1))),
      strikeModifier: num(maneuver.strikeModifier, 0),
      damageMultiplier: maneuverDamageMultiplier,
      requiresHit: maneuver.requiresHit === true,
      specialRules: String(maneuver.specialRules ?? "").trim() || (maneuver.specialRulesKey ? game.i18n.localize(maneuver.specialRulesKey) : ""),
      strengthBonus: unarmedProfile.strengthBonus,
      handToHandBonus: unarmedProfile.handToHandBonus,
      damageFormula: finalUnarmedDamageFormula
    },
    advancedActionLabelOverride: String(advancedActionLabelOverride ?? "").trim() || game.i18n.localize("RIFTS.Unarmed.Strike"),
    impactResult,
    defense,
    resolutionPending,
    queueAdvancePending: Boolean(combat && actionGate.isCurrent),
    pendingControlEffectKey,
    knockoutStunResult,
    deathBlowResult,
    controlEffectResult
  });

  if (!resolutionPending && combat && actionGate.isCurrent) {
    await advanceMeleeAction(combat, { announce: true });
  }

  return message;
}

export function registerCombatRoundHooks() {
  if (combatRoundHooksRegistered) return;
  combatRoundHooksRegistered = true;

  Hooks.on("combatStart", async (combat) => {
    await resetCombatRoundAPM(combat, "combatStart");
  });

  Hooks.on("combatRound", async (combat) => {
    await resetCombatRoundAPM(combat, "combatRound");
  });

  Hooks.on("deleteCombat", (combat) => {
    if (!combat?.id) return;
    roundResetByCombat.delete(combat.id);
  });
}
export function registerCombatChatListeners() {
  if (chatListenersRegistered) return;
  chatListenersRegistered = true;

  Hooks.on("renderChatMessageHTML", (message, html) => {
    const root = html instanceof HTMLElement ? html : (html?.[0] ?? null);
    if (!(root instanceof HTMLElement)) return;

    root.querySelectorAll("[data-action='react-parry']").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.preventDefault();

        if (root.dataset.riftsReactionResolved === "true") return;

        const clickButton = event.currentTarget;
        const defenderId = clickButton.dataset.defenderId;
        const defenderTokenId = clickButton.dataset.defenderTokenId;
        const defenderRef = resolveActorFromTokenOrActor({ tokenId: defenderTokenId, actorId: defenderId });
        const defender = defenderRef.actor;
        if (!defender) {
          ui.notifications.warn(game.i18n.localize("RIFTS.Errors.TargetNotFound"));
          return;
        }

        if (!canUserResolveReaction(defender)) {
          notifyReactionPermissionDenied(defender);
          return;
        }

        const attackData = getAttackCardData(message);
        const attackTotal = num(attackData?.total, 0);
        const parryContext = getParryContestBonus(defender);

        root.dataset.riftsReactionResolved = "true";
        disableReactionButtons(root);
        const roll = await postDefenseContestRoll({
          defender,
          label: game.i18n.localize("RIFTS.Rolls.Parry"),
          totalBonus: parryContext.totalBonus
        });
        const success = roll.total >= attackTotal;
        await defender.update({
          "system.combat.lastActionType": "parry",
          "system.combat.lastAdvancedAction": "parry",
          "system.combat.reactionAvailable": num(defender.system?.combat?.apmRemaining, 0) > 0
        });

        const remaining = num(defender.system?.combat?.apmRemaining, 0);
        await postReactionLog({
          defender,
          actionType: "parry",
          remaining
        });

        await finalizePendingAttackMessage(message, {
          finalHit: !success,
          resolutionLabel: game.i18n.localize("RIFTS.Rolls.Parry"),
          resolutionText: game.i18n.localize(
            success
              ? "RIFTS.Combat.ParrySucceeded"
              : "RIFTS.Combat.ParryFailed"
          ),
          resolutionSuccess: success
        });
      });
    });

    root.querySelectorAll("[data-action='react-dodge']").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.preventDefault();

        if (root.dataset.riftsReactionResolved === "true") return;

        const clickButton = event.currentTarget;
        const defenderId = clickButton.dataset.defenderId;
        const defenderTokenId = clickButton.dataset.defenderTokenId;
        const defenderRef = resolveActorFromTokenOrActor({ tokenId: defenderTokenId, actorId: defenderId });
        const defender = defenderRef.actor;
        if (!defender) {
          ui.notifications.warn(game.i18n.localize("RIFTS.Errors.TargetNotFound"));
          return;
        }

        if (!canUserResolveReaction(defender)) {
          notifyReactionPermissionDenied(defender);
          return;
        }

        const spend = typeof defender.spendAttack === "function"
          ? await defender.spendAttack("dodge")
          : { ok: false, remaining: num(defender.system?.combat?.apmRemaining, 0) };

        if (!spend?.ok) {
          notifyCannotDodge(defender, spend);
          return;
        }

        const attackData = getAttackCardData(message);
        const attackTotal = num(attackData?.total, 0);
        const dodgeBonus = num(defender.system?.combat?.derived?.dodgeTotal, num(defender.system?.combat?.dodgeMod, 0));

        root.dataset.riftsReactionResolved = "true";
        disableReactionButtons(root);
        const roll = await postDefenseContestRoll({
          defender,
          label: game.i18n.localize("RIFTS.Rolls.Dodge"),
          totalBonus: dodgeBonus
        });
        const success = roll.total >= attackTotal;
        await defender.update({
          "system.combat.lastAdvancedAction": "dodge"
        });
        await postReactionLog({
          defender,
          actionType: "dodge",
          remaining: spend.remaining
        });

        await finalizePendingAttackMessage(message, {
          finalHit: !success,
          resolutionLabel: game.i18n.localize("RIFTS.Rolls.Dodge"),
          resolutionText: game.i18n.localize(
            success
              ? "RIFTS.Combat.DodgeSucceeded"
              : "RIFTS.Combat.DodgeFailed"
          ),
          resolutionSuccess: success
        });
      });
    });

    root.querySelectorAll("[data-action='react-auto-dodge']").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.preventDefault();

        if (root.dataset.riftsReactionResolved === "true") return;

        const clickButton = event.currentTarget;
        const defenderId = clickButton.dataset.defenderId;
        const defenderTokenId = clickButton.dataset.defenderTokenId;
        const defenderRef = resolveActorFromTokenOrActor({ tokenId: defenderTokenId, actorId: defenderId });
        const defender = defenderRef.actor;
        if (!defender) {
          ui.notifications.warn(game.i18n.localize("RIFTS.Errors.TargetNotFound"));
          return;
        }

        if (!canUserResolveReaction(defender)) {
          notifyReactionPermissionDenied(defender);
          return;
        }

        if (defender.system?.combat?.autoDodgeAvailable !== true) {
          ui.notifications.warn(game.i18n.localize("RIFTS.Advanced.NotAvailable"));
          return;
        }

        const attackData = getAttackCardData(message);
        const attackTotal = num(attackData?.total, 0);
        const dodgeBonus = num(defender.system?.combat?.derived?.dodgeTotal, num(defender.system?.combat?.dodgeMod, 0));

        root.dataset.riftsReactionResolved = "true";
        disableReactionButtons(root);

        const roll = await postDefenseContestRoll({
          defender,
          label: game.i18n.localize("RIFTS.Advanced.AutoDodge"),
          totalBonus: dodgeBonus
        });
        const success = roll.total >= attackTotal;
        await defender.update({
          "system.combat.lastActionType": "auto-dodge",
          "system.combat.lastAdvancedAction": "autoDodge",
          "system.combat.reactionAvailable": true
        });

        await postReactionLog({
          defender,
          actionType: "dodge",
          remaining: num(defender.system?.combat?.apmRemaining, 0)
        });

        await finalizePendingAttackMessage(message, {
          finalHit: !success,
          resolutionLabel: game.i18n.localize("RIFTS.Advanced.AutoDodge"),
          resolutionText: game.i18n.localize(
            success
              ? "RIFTS.Combat.AutoDodgeSucceeded"
              : "RIFTS.Combat.AutoDodgeFailed"
          ),
          resolutionSuccess: success
        });
      });
    });

    root.querySelectorAll("[data-action='react-roll-with-punch']").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.preventDefault();

        if (root.dataset.riftsReactionResolved === "true") return;

        const clickButton = event.currentTarget;
        const defenderId = clickButton.dataset.defenderId;
        const defenderTokenId = clickButton.dataset.defenderTokenId;
        const defenderRef = resolveActorFromTokenOrActor({ tokenId: defenderTokenId, actorId: defenderId });
        const defender = defenderRef.actor;
        if (!defender) {
          ui.notifications.warn(game.i18n.localize("RIFTS.Errors.TargetNotFound"));
          return;
        }

        if (!canUserResolveReaction(defender)) {
          notifyReactionPermissionDenied(defender);
          return;
        }

        const result = typeof defender.useSpecialManeuverByKey === "function"
          ? await defender.useSpecialManeuverByKey("rollWithPunch", { tokenId: defenderTokenId })
          : { status: "not-available" };

        if (!["reactive", "used"].includes(String(result?.status ?? ""))) {
          ui.notifications.warn(game.i18n.localize("RIFTS.Advanced.NotAvailable"));
          return;
        }

        root.dataset.riftsReactionResolved = "true";
        disableReactionButtons(root);

        const attackData = getAttackCardData(message);
        const attackTotal = num(attackData?.total, num(clickButton.dataset.attackTotal, 0));
        const dodgeTotal = num(defender.system?.combat?.derived?.dodgeTotal, num(defender.system?.combat?.dodgeMod, 0));
        const pullRollBonus = getRollWithPunchBonus(defender);
        const totalBonus = dodgeTotal + pullRollBonus;
        const roll = await (new Roll(`1d20 + ${totalBonus}`)).evaluate();
        const success = roll.total > attackTotal;
        const sourceDamageButton = root.querySelector("[data-action='roll-damage']");

        await roll.toMessage({
          speaker: ChatMessage.getSpeaker({ actor: defender }),
          flavor: buildRollWithPunchFollowupFlavor({
            sourceDamageButton,
            success,
            attackTotal,
            reactionTotal: roll.total,
            pullRollBonus
          })
        });

        root.querySelectorAll("[data-action='roll-damage']").forEach((damageButton) => {
          damageButton.dataset.reactionDamageMultiplier = success ? "0.5" : "1";
          damageButton.dataset.reactionOutcomeText = success
            ? game.i18n.localize("RIFTS.Maneuvers.RollWithPunchDamageHalved")
            : game.i18n.localize("RIFTS.Maneuvers.RollWithPunchDamageNormal");
        });

        appendReactionOutcome(
          root,
          game.i18n.localize("RIFTS.Maneuvers.RollWithPunch"),
          success
            ? game.i18n.localize("RIFTS.Maneuvers.RollWithPunchDamageHalved")
            : game.i18n.localize("RIFTS.Maneuvers.RollWithPunchDamageNormal"),
          success
        );

        await defender.update({
          "system.combat.lastActionType": "roll-with-punch",
          "system.combat.lastAdvancedAction": "rollWithPunch"
        });

        await finalizePendingAttackMessage(message, {
          finalHit: true,
          resolutionLabel: game.i18n.localize("RIFTS.Maneuvers.RollWithPunch"),
          resolutionText: game.i18n.localize(
            success
              ? "RIFTS.Maneuvers.RollWithPunchDamageHalved"
              : "RIFTS.Maneuvers.RollWithPunchDamageNormal"
          ),
          resolutionSuccess: success,
          reactionDamageMultiplier: success ? 0.5 : 1,
          reactionOutcomeText: game.i18n.localize(
            success
              ? "RIFTS.Maneuvers.RollWithPunchDamageHalved"
              : "RIFTS.Maneuvers.RollWithPunchDamageNormal"
          )
        });
      });
    });

    root.querySelectorAll("[data-action='react-all-out-dodge']").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.preventDefault();

        if (root.dataset.riftsReactionResolved === "true") return;

        const clickButton = event.currentTarget;
        const defenderId = clickButton.dataset.defenderId;
        const defenderTokenId = clickButton.dataset.defenderTokenId;
        const defenderRef = resolveActorFromTokenOrActor({ tokenId: defenderTokenId, actorId: defenderId });
        const defender = defenderRef.actor;
        if (!defender) {
          ui.notifications.warn(game.i18n.localize("RIFTS.Errors.TargetNotFound"));
          return;
        }

        if (!canUserResolveReaction(defender)) {
          notifyReactionPermissionDenied(defender);
          return;
        }

        const spend = typeof defender.spendAttack === "function"
          ? await defender.spendAttack("all-out-dodge")
          : { ok: false, remaining: num(defender.system?.combat?.apmRemaining, 0) };

        if (!spend?.ok) {
          notifyCannotDodge(defender, spend);
          return;
        }

        const attackData = getAttackCardData(message);
        const attackTotal = num(attackData?.total, 0);

        root.dataset.riftsReactionResolved = "true";
        disableReactionButtons(root);

        const dodgeTotal = num(defender.system?.combat?.derived?.dodgeTotal, num(defender.system?.combat?.dodgeMod, 0)) + 2;
        const roll = await postDefenseContestRoll({
          defender,
          label: game.i18n.localize("RIFTS.Advanced.AllOutDodge"),
          totalBonus: dodgeTotal,
          flavorSuffix: "(+2)"
        });
        const success = roll.total >= attackTotal;

        await defender.update({
          "system.combat.lastActionType": "all-out-dodge",
          "system.combat.lastAdvancedAction": "allOutDodge",
          "system.combat.reactionAvailable": spend.remaining > 0
        });

        await postReactionLog({
          defender,
          actionType: "dodge",
          remaining: spend.remaining
        });

        await finalizePendingAttackMessage(message, {
          finalHit: !success,
          resolutionLabel: game.i18n.localize("RIFTS.Advanced.AllOutDodge"),
          resolutionText: game.i18n.localize(
            success
              ? "RIFTS.Combat.AllOutDodgeSucceeded"
              : "RIFTS.Combat.AllOutDodgeFailed"
          ),
          resolutionSuccess: success
        });
      });
    });

    root.querySelectorAll("[data-action='resolve-hit']").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.preventDefault();

        if (root.dataset.riftsReactionResolved === "true") return;

        const attackData = getAttackCardData(message);
        if (!canUserFinalizePendingAttack(attackData ?? {})) {
          ui.notifications.warn(game.i18n.localize("RIFTS.Combat.ReactionPermissionDeniedGeneric"));
          return;
        }

        root.dataset.riftsReactionResolved = "true";
        disableReactionButtons(root);

        await finalizePendingAttackMessage(message, {
          finalHit: true,
          resolutionLabel: game.i18n.localize("RIFTS.Combat.NoReaction"),
          resolutionText: game.i18n.localize("RIFTS.Combat.NoReactionHitConfirmed"),
          resolutionSuccess: false
        });
      });
    });

    root.querySelectorAll("[data-action='gm-reset-apm']").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.preventDefault();

        if (!game.user?.isGM) {
          ui.notifications.warn(game.i18n.localize("RIFTS.Recovery.GMOnly"));
          return;
        }

        const clickButton = event.currentTarget;
        const defenderId = clickButton.dataset.defenderId;
        const defenderTokenId = clickButton.dataset.defenderTokenId;
        const defenderRef = resolveActorFromTokenOrActor({ tokenId: defenderTokenId, actorId: defenderId });
        const defender = defenderRef.actor;
        if (!defender) {
          ui.notifications.warn(game.i18n.localize("RIFTS.Errors.TargetNotFound"));
          return;
        }

        if (typeof defender.resetAPM === "function") {
          await defender.resetAPM();
        } else {
          const apmTotal = Math.max(0, Math.floor(num(defender.system?.combat?.apmTotal, 0)));
          await defender.update({
            "system.combat.apmRemaining": apmTotal,
            "system.combat.apmSpent": 0,
            "system.combat.lastActionType": "reset",
            "system.combat.reactionAvailable": true
          });
        }

        const apm = getActorApmState(defender);
        ui.notifications.info(game.i18n.format("RIFTS.Combat.ResetAPMApplied", {
          defender: defender.name,
          remaining: apm.remaining,
          total: apm.total
        }));
      });
    });

    root.querySelectorAll("[data-action='gm-add-apm']").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.preventDefault();

        if (!game.user?.isGM) {
          ui.notifications.warn(game.i18n.localize("RIFTS.Recovery.GMOnly"));
          return;
        }

        const clickButton = event.currentTarget;
        const defenderId = clickButton.dataset.defenderId;
        const defenderTokenId = clickButton.dataset.defenderTokenId;
        const defenderRef = resolveActorFromTokenOrActor({ tokenId: defenderTokenId, actorId: defenderId });
        const defender = defenderRef.actor;
        if (!defender) {
          ui.notifications.warn(game.i18n.localize("RIFTS.Errors.TargetNotFound"));
          return;
        }

        if (typeof defender.addAPM === "function") {
          await defender.addAPM(1);
        } else {
          const remaining = Math.max(0, Math.floor(num(defender.system?.combat?.apmRemaining, 0))) + 1;
          await defender.update({
            "system.combat.apmRemaining": remaining,
            "system.combat.lastActionType": "add-apm",
            "system.combat.reactionAvailable": remaining > 0
          });
        }

        const apm = getActorApmState(defender);
        ui.notifications.info(game.i18n.format("RIFTS.Combat.AddAPMApplied", {
          defender: defender.name,
          remaining: apm.remaining,
          total: apm.total
        }));
      });
    });
    root.querySelectorAll("[data-action='roll-damage']").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.preventDefault();

        const clickButton = event.currentTarget;
        const attackData = getAttackCardData(message);
        if (attackData?.resolutionPending === true) {
          ui.notifications.warn(game.i18n.localize("RIFTS.Combat.RollDamagePendingReaction"));
          return;
        }
        if (clickButton.dataset.riftsProcessed === "true") return;
        clickButton.dataset.riftsProcessed = "true";
        clickButton.disabled = true;

        const attackerId = clickButton.dataset.attackerId;
        const attackerTokenId = clickButton.dataset.attackerTokenId;
        const weaponId = clickButton.dataset.weaponId;
        const targetId = clickButton.dataset.targetId;
        const targetTokenId = clickButton.dataset.targetTokenId;
        const hitLocation = clickButton.dataset.hitLocation ?? "none";
        const isMegaDamage = clickButton.dataset.isMegaDamage === "true";
        const attackActionKey = clickButton.dataset.attackActionKey ?? "standard";
        const unarmedManeuverKey = clickButton.dataset.unarmedManeuverKey ?? "";
        const unarmedDamageFormula = clickButton.dataset.unarmedDamageFormula ?? "";
        const criticalDamageMultiplier = Math.max(1, Math.floor(num(clickButton.dataset.criticalDamageMultiplier, 1)));
        const reactionDamageMultiplier = Math.max(0, num(clickButton.dataset.reactionDamageMultiplier, 1));
        const reactionOutcomeText = String(clickButton.dataset.reactionOutcomeText ?? "");
        const deathBlowDirectHp = clickButton.dataset.deathBlowDirectHp === "true";
        const deathBlowDirectHpMultiplier = Math.max(1, Math.floor(num(clickButton.dataset.deathBlowDirectHpMultiplier, 1)));

        const attackerRef = resolveActorFromTokenOrActor({ tokenId: attackerTokenId, actorId: attackerId });
        const targetRef = resolveActorFromTokenOrActor({ tokenId: targetTokenId, actorId: targetId });
        const attacker = attackerRef.actor;
        const target = targetRef.actor;
        const weapon = getWeaponFromCardData({
          attacker,
          weaponId,
          maneuverKey: unarmedManeuverKey
        });
        const attackContext = getAttackActionContext({ actionKey: attackActionKey, weapon });

        const roll = await rollDamage({
          attacker,
          weapon,
          isMegaDamage,
          attackContext,
          formulaOverride: unarmedDamageFormula,
          criticalDamageMultiplier,
          reactionDamageMultiplier,
          directHpDamageMultiplier: deathBlowDirectHp ? deathBlowDirectHpMultiplier : 1
        });

        const scaleContext = getScaleContext({ attacker, target, weapon });
        const previewArmor = hitLocation === "armor" && target ? getEquippedArmor(target) : null;
        const targetScaleForDamage = previewArmor
          ? getArmorProtectionScale(previewArmor)
          : getBodyScaleForActor(target, getEffectiveActorScale(target, { activeArmor: getEquippedArmor(target) }));

        const interaction = resolveScaleInteraction({
          attackScale: scaleContext.weaponScale,
          targetScale: targetScaleForDamage,
          baseDamage: roll.total
        });

        const cardScaleContext = {
          ...scaleContext,
          targetScale: targetScaleForDamage,
          targetScaleLabelKey: getDurabilityLabelKey(targetScaleForDamage)
        };

        await postDamageCard({
          attacker,
          target,
          weapon,
          hitLocation,
          isMegaDamage,
          roll,
          scaleContext: cardScaleContext,
          damageModeLabel: getDamageModeLabel(interaction.mode, scaleContext.weaponScale),
          scaleReasonLabel: game.i18n.localize(interaction.reasonKey),
          attackerToken: attackerRef.token ?? attacker?.token ?? null,
          targetToken: targetRef.token ?? target?.token ?? null,
          unarmedManeuverKey,
          unarmedDamageFormula,
          outcomeText: reactionOutcomeText,
          deathBlowDirectHp,
          deathBlowDirectHpMultiplier: deathBlowDirectHp ? deathBlowDirectHpMultiplier : 1
        });
      });
    });

    root.querySelectorAll("[data-action='apply-damage']").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.preventDefault();

        const clickButton = event.currentTarget;
        if (clickButton.dataset.riftsProcessed === "true") return;
        clickButton.dataset.riftsProcessed = "true";
        clickButton.disabled = true;

        if (!game.user.isGM) {
          ui.notifications.warn(game.i18n.localize("RIFTS.Errors.ApplyDamageGMOnly"));
          return;
        }

        const targetId = clickButton.dataset.targetId;
        const targetTokenId = clickButton.dataset.targetTokenId;
        const attackerId = clickButton.dataset.attackerId;
        const attackerTokenId = clickButton.dataset.attackerTokenId;
        const weaponId = clickButton.dataset.weaponId;
        const unarmedManeuverKey = clickButton.dataset.unarmedManeuverKey ?? "";
        const amount = num(clickButton.dataset.amount, 0);
        const hitLocation = clickButton.dataset.hitLocation ?? "body";
        const isMegaDamage = clickButton.dataset.isMegaDamage === "true";
        const deathBlowDirectHp = clickButton.dataset.deathBlowDirectHp === "true";
        const deathBlowDirectHpMultiplier = Math.max(1, Math.floor(num(clickButton.dataset.deathBlowDirectHpMultiplier, 1)));

        const targetRef = resolveActorFromTokenOrActor({ tokenId: targetTokenId, actorId: targetId });
        const targetActor = targetRef.actor;
        if (!targetActor) {
          ui.notifications.warn(game.i18n.localize("RIFTS.Errors.TargetNotFound"));
          return;
        }

        const attackerRef = resolveActorFromTokenOrActor({ tokenId: attackerTokenId, actorId: attackerId });
        const attacker = attackerRef.actor;
        const weapon = getWeaponFromCardData({
          attacker,
          weaponId,
          maneuverKey: unarmedManeuverKey
        });
        const armorItem = hitLocation === "armor" ? getEquippedArmor(targetActor) : null;

        const result = await applyDamage({
          targetActor,
          amount,
          isMegaDamage,
          hitLocation,
          armorItem,
          attacker,
          weapon,
          directToHp: deathBlowDirectHp,
          directHpMultiplier: deathBlowDirectHp ? deathBlowDirectHpMultiplier : 1
        });

        const summary = await foundry.applications.handlebars.renderTemplate(DAMAGE_TEMPLATE, {
          attackerName: attacker?.name ?? game.i18n.localize("RIFTS.Combat.UnknownActor"),
          targetName: targetActor.name,
          weaponName: weapon?.name ?? game.i18n.localize("RIFTS.Combat.Unarmed"),
          formula: game.i18n.localize("RIFTS.Combat.DamageApplied"),
          total: result.appliedAmount,
          hitLocationLabel: game.i18n.localize(`RIFTS.Combat.HitLocation.${hitLocation}`),
          attackerScaleLabel: game.i18n.localize(getDurabilityLabelKey(result.scale?.attackerScale ?? "sdc")),
          targetScaleLabel: game.i18n.localize(getDurabilityLabelKey(result.scale?.targetScale ?? "sdc")),
          weaponScaleLabel: game.i18n.localize(getDurabilityLabelKey(result.scale?.weaponScale ?? "sdc")),
          damageModeLabel: getDamageModeLabel(result.scale?.mode ?? "same-scale", result.scale?.weaponScale ?? "sdc"),
          scaleReasonLabel: game.i18n.localize(result.scale?.reasonKey ?? "RIFTS.Combat.Durability.SdcVsSdc"),
          canApplyDamage: false,
          outcomeText: `${game.i18n.localize("RIFTS.Combat.DamageRemaining")}: ${result.remaining}`,
          deathBlowDirectHp
        });

        await ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor: attacker ?? targetActor }),
          content: summary
        });
      });
    });
  });
}






















































