import { useHighRollSkillSuccess } from "./rules-settings.mjs";

const CHAT_TEMPLATE = "systems/rifts-megaverse/templates/chat/roll-card.hbs";

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function getCombatTotal(actor, derivedKey, fallbackKey, override = null) {
  if (override !== null && override !== undefined) {
    return asNumber(override) ?? 0;
  }

  const derived = asNumber(actor?.system?.combat?.derived?.[derivedKey]);
  if (derived !== null) return derived;

  return asNumber(actor?.system?.combat?.[fallbackKey]) ?? 0;
}

async function postRollCard({
  actor,
  title,
  subtitle,
  roll,
  showBonus = false,
  bonus = 0,
  showTarget = false,
  target = 0,
  outcome = null,
  showCategory = false,
  category = "",
  showSource = false,
  source = ""
}) {
  const speaker = ChatMessage.getSpeaker({ actor });
  const flavor = await foundry.applications.handlebars.renderTemplate(CHAT_TEMPLATE, {
    actorName: actor?.name,
    title,
    subtitle,
    formula: roll.formula,
    total: roll.total,
    showBonus,
    bonus,
    showTarget,
    target,
    outcome,
    showCategory,
    category,
    showSource,
    source
  });

  return roll.toMessage({
    speaker,
    flavor
  });
}

export async function rollAttribute3d6(attributeKey, { actor = null, mod = 0, label = null } = {}) {
  const safeMod = asNumber(mod) ?? 0;
  const roll = await (new Roll(`3d6 + ${safeMod}`)).evaluate();
  const attributeLabel = label ?? attributeKey?.toUpperCase() ?? game.i18n.localize("RIFTS.Rolls.Attribute");

  return postRollCard({
    actor,
    title: game.i18n.localize("RIFTS.Rolls.Attribute"),
    subtitle: attributeLabel,
    roll,
    showBonus: true,
    bonus: safeMod
  });
}

async function rollCombat(actionLabel, derivedKey, fallbackKey, { actor = null, mod = null } = {}) {
  const totalBonus = getCombatTotal(actor, derivedKey, fallbackKey, mod);
  const roll = await (new Roll(`1d20 + ${totalBonus}`)).evaluate();

  return postRollCard({
    actor,
    title: actionLabel,
    subtitle: game.i18n.localize("RIFTS.Rolls.UsingDerived"),
    roll,
    showBonus: true,
    bonus: totalBonus
  });
}

export function rollStrike(options = {}) {
  return rollCombat(game.i18n.localize("RIFTS.Rolls.Strike"), "strikeTotal", "strikeMod", options);
}

export function rollParry(options = {}) {
  return rollCombat(game.i18n.localize("RIFTS.Rolls.Parry"), "parryTotal", "parryMod", options);
}

export function rollDodge(options = {}) {
  return rollCombat(game.i18n.localize("RIFTS.Rolls.Dodge"), "dodgeTotal", "dodgeMod", options);
}

export async function rollInitiative({ actor = null, preferCombat = false, mod = null, tokenId = "" } = {}) {
  const totalBonus = getCombatTotal(actor, "initiativeTotal", "initiativeMod", mod);
  const formula = `1d20 + ${totalBonus}`;

  if (preferCombat && actor && game.combat) {
    const requestedTokenId = normalizeText(tokenId);
    const actorTokenId = requestedTokenId || normalizeText(actor?.token?.id ?? actor?.parent?.id);

    const byTokenId = (id) => game.combat.combatants.find(
      (entry) => normalizeText(entry?.tokenId ?? entry?.token?.id) === id
    );

    let combatant = actorTokenId ? byTokenId(actorTokenId) : null;
    if (!combatant) {
      combatant = game.combat.combatants.find((entry) => entry.actorId === actor.id);
    }

    if (combatant) {
      const roll = await (new Roll(formula)).evaluate();
      await game.combat.setInitiative(combatant.id, roll.total);

      return postRollCard({
        actor,
        title: game.i18n.localize("RIFTS.Rolls.InitiativeCombat"),
        subtitle: game.i18n.localize("RIFTS.Rolls.UsingDerived"),
        roll,
        showBonus: true,
        bonus: totalBonus
      });
    }
  }

  const roll = await (new Roll(formula)).evaluate();
  return postRollCard({
    actor,
    title: game.i18n.localize("RIFTS.Rolls.Initiative"),
    subtitle: game.i18n.localize("RIFTS.Rolls.UsingDerived"),
    roll,
    showBonus: true,
    bonus: totalBonus
  });
}

export async function rollSkill(skillId, { actor = null, label = null, breakdown = null } = {}) {
  const skill = actor?.items?.get(skillId);
  const computed = breakdown ?? actor?.getSkillTarget?.(skill) ?? {
    level: Math.max(1, asNumber(actor?.system?.details?.level) ?? 1),
    base: asNumber(skill?.system?.base) ?? 0,
    modifier: asNumber(skill?.system?.modifier) ?? 0,
    classBonus: 0,
    perLevel: asNumber(skill?.system?.perLevel) ?? 0,
    target: (asNumber(skill?.system?.base) ?? 0) + (asNumber(skill?.system?.modifier) ?? 0),
    category: normalizeText(skill?.system?.category),
    sourceType: normalizeText(skill?.system?.sourceType)
  };

  const target = Math.max(0, asNumber(computed.target) ?? 0);
  const roll = await (new Roll("1d100")).evaluate();
  const highRollMode = useHighRollSkillSuccess();
  const effectiveTarget = highRollMode
    ? Math.max(0, 100 - target)
    : target;
  const isSuccess = highRollMode
    ? roll.total > effectiveTarget
    : roll.total <= target;
  const outcome = isSuccess
    ? game.i18n.localize("RIFTS.Rolls.Success")
    : game.i18n.localize("RIFTS.Rolls.Failure");

  const category = normalizeText(computed.category ?? skill?.system?.category);
  const source = normalizeText(computed.sourceType ?? skill?.system?.sourceType);

  return postRollCard({
    actor,
    title: game.i18n.localize("RIFTS.Rolls.Skill"),
    subtitle: label ?? skill?.name ?? skillId ?? game.i18n.localize("RIFTS.Rolls.UnnamedSkill"),
    roll,
    showTarget: true,
    target: effectiveTarget,
    outcome,
    showCategory: category.length > 0,
    category,
    showSource: source.length > 0,
    source: source.toUpperCase()
  });
}


