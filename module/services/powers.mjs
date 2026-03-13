const POWER_TEMPLATE = "systems/rifts-megaverse/templates/chat/power-card.hbs";

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeKey(value, fallback = "") {
  const key = normalizeText(value).toLowerCase();
  return key || fallback;
}

function localizePowerType(powerType) {
  switch (normalizeKey(powerType, "ability")) {
    case "psionic":
      return game.i18n.localize("RIFTS.Powers.Psionic");
    case "spell":
      return game.i18n.localize("RIFTS.Powers.Spell");
    case "techno-wizard":
      return game.i18n.localize("RIFTS.Powers.TechnoWizard");
    case "supernatural":
      return game.i18n.localize("RIFTS.Powers.Supernatural");
    default:
      return game.i18n.localize("RIFTS.Powers.Ability");
  }
}

function localizeCostType(costType) {
  switch (normalizeKey(costType, "none")) {
    case "isp":
      return game.i18n.localize("RIFTS.Powers.CostTypeISP");
    case "ppe":
      return game.i18n.localize("RIFTS.Powers.CostTypePPE");
    case "hp":
      return game.i18n.localize("RIFTS.Powers.CostTypeHP");
    case "sdc":
      return game.i18n.localize("RIFTS.Powers.CostTypeSDC");
    default:
      return game.i18n.localize("RIFTS.Powers.CostTypeNone");
  }
}

function localizeScaleLabel(scale) {
  switch (normalizeKey(scale, "")) {
    case "sdc":
      return game.i18n.localize("RIFTS.Combat.SDC");
    case "mdc":
      return game.i18n.localize("RIFTS.Combat.MDC");
    case "powerarmor":
      return game.i18n.localize("RIFTS.PowerArmor.PowerArmor");
    case "vehicle":
      return game.i18n.localize("RIFTS.Sheet.Vehicle");
    case "giantcreature":
      return game.i18n.localize("RIFTS.Size.Giant");
    default:
      return normalizeText(scale);
  }
}
function getResourcePathForCostType(costType) {
  switch (normalizeKey(costType, "none")) {
    case "isp":
      return "system.resources.isp.value";
    case "ppe":
      return "system.resources.ppe.value";
    case "hp":
      return "system.resources.hp.value";
    case "sdc":
      return "system.resources.sdc.value";
    default:
      return "";
  }
}

function buildPowerContext(actor, powerItem) {
  const system = powerItem?.system ?? {};
  const powerType = normalizeKey(system.powerType || system.type, "ability");
  const costType = normalizeKey(system.costType, "none");
  const cost = Math.max(0, num(system.cost, 0));
  const resourcePath = getResourcePathForCostType(costType);
  const currentResource = resourcePath ? num(foundry.utils.getProperty(actor, resourcePath), 0) : null;

  return {
    powerType,
    costType,
    cost,
    resourcePath,
    currentResource,
    name: powerItem?.name ?? game.i18n.localize("RIFTS.Powers.Power"),
    subType: normalizeText(system.subType),
    range: normalizeText(system.range),
    duration: normalizeText(system.duration),
    activationTime: normalizeText(system.activationTime),
    saveType: normalizeText(system.saveType),
    damage: normalizeText(system.damage),
    description: normalizeText(system.description),
    notes: normalizeText(system.notes),
    requiresTarget: system.requiresTarget === true,
    requiresAttackRoll: system.requiresAttackRoll === true,
    requiresSave: system.requiresSave === true,
    scale: normalizeText(system.scale),
    active: system.active === true
  };
}

export function getPowerCost(actor, powerItem) {
  const power = buildPowerContext(actor, powerItem);
  return {
    cost: power.cost,
    costType: power.costType,
    costTypeLabel: localizeCostType(power.costType),
    resourcePath: power.resourcePath,
    currentResource: power.currentResource
  };
}

export function canUsePower(actor, powerItem) {
  if (!actor || !powerItem || powerItem.type !== "power") {
    return {
      ok: false,
      reason: "invalid-power",
      details: null
    };
  }

  const details = getPowerCost(actor, powerItem);
  if (!details.resourcePath || details.cost <= 0) {
    return {
      ok: true,
      reason: "no-cost",
      details
    };
  }

  const current = num(details.currentResource, 0);
  if (current < details.cost) {
    return {
      ok: false,
      reason: "insufficient-resource",
      details
    };
  }

  return {
    ok: true,
    reason: "ok",
    details
  };
}

export async function spendPowerResource(actor, powerItem) {
  const check = canUsePower(actor, powerItem);
  if (!check.ok) return check;

  const details = check.details;
  if (!details.resourcePath || details.cost <= 0) {
    return {
      ok: true,
      spent: 0,
      remaining: details.currentResource,
      details
    };
  }

  const before = num(details.currentResource, 0);
  const remaining = Math.max(0, before - details.cost);
  await actor.update({ [details.resourcePath]: remaining });

  return {
    ok: true,
    spent: details.cost,
    remaining,
    details
  };
}

function getAttackBonus(actor) {
  return num(actor?.system?.combat?.derived?.strikeTotal, num(actor?.system?.combat?.strikeMod, 0));
}

async function postPowerMessage({
  actor,
  powerItem,
  power,
  spendResult,
  attackRoll = null,
  deactivated = false
}) {
  const speaker = ChatMessage.getSpeaker({ actor });
  const flavor = await foundry.applications.handlebars.renderTemplate(POWER_TEMPLATE, {
    actorName: actor?.name ?? game.i18n.localize("RIFTS.Combat.UnknownActor"),
    powerName: power.name,
    powerType: power.powerType,
    powerTypeLabel: localizePowerType(power.powerType),
    subType: power.subType,
    cost: power.cost,
    costType: power.costType,
    costTypeLabel: localizeCostType(power.costType),
    spent: num(spendResult?.spent, 0),
    remaining: spendResult?.remaining,
    hasResourceSpend: Boolean(spendResult?.details?.resourcePath) && power.cost > 0,
    resourceLabel: power.costType === "ppe"
      ? game.i18n.localize("RIFTS.Powers.RemainingPPE")
      : power.costType === "isp"
        ? game.i18n.localize("RIFTS.Powers.RemainingISP")
        : game.i18n.localize("RIFTS.Powers.RemainingResource"),
    range: power.range,
    duration: power.duration,
    activationTime: power.activationTime,
    saveType: power.saveType,
    damage: power.damage,
    requiresTarget: power.requiresTarget,
    requiresAttackRoll: power.requiresAttackRoll,
    requiresSave: power.requiresSave,
    scale: power.scale,
    scaleLabel: localizeScaleLabel(power.scale),
    isActive: power.active,
    deactivated,
    attackFormula: attackRoll?.formula ?? "",
    attackTotal: attackRoll?.total ?? null
  });

  const flags = {
    rifts: {
      type: "power-card",
      actorId: actor?.id ?? "",
      powerId: powerItem?.id ?? "",
      powerType: power.powerType,
      costType: power.costType,
      cost: power.cost,
      deactivated
    }
  };

  if (attackRoll) {
    return attackRoll.toMessage({
      speaker,
      flavor,
      flags
    });
  }

  return ChatMessage.create({
    speaker,
    content: flavor,
    flags
  });
}

export async function activatePower(actor, powerItem, options = {}) {
  if (!actor || !powerItem || powerItem.type !== "power") {
    return {
      ok: false,
      reason: "invalid-power"
    };
  }

  const power = buildPowerContext(actor, powerItem);
  const canUse = canUsePower(actor, powerItem);
  if (!canUse.ok) {
    ui.notifications.warn(game.i18n.localize("RIFTS.Powers.InsufficientResources"));
    return {
      ok: false,
      reason: canUse.reason,
      details: canUse.details
    };
  }

  const spendResult = options.spendResource === false
    ? {
      ok: true,
      spent: 0,
      remaining: canUse.details?.currentResource,
      details: canUse.details
    }
    : await spendPowerResource(actor, powerItem);

  if (!spendResult.ok) {
    ui.notifications.warn(game.i18n.localize("RIFTS.Powers.InsufficientResources"));
    return {
      ok: false,
      reason: spendResult.reason,
      details: spendResult.details
    };
  }

  let attackRoll = null;
  if (power.requiresAttackRoll) {
    const strikeBonus = getAttackBonus(actor);
    attackRoll = await (new Roll(`1d20 + ${strikeBonus}`)).evaluate();
  }

  if (options.setActive !== false) {
    await powerItem.update({ "system.active": true });
    power.active = true;
  }

  const message = await postPowerMessage({
    actor,
    powerItem,
    power,
    spendResult,
    attackRoll
  });

  return {
    ok: true,
    actorId: actor.id,
    powerId: powerItem.id,
    spendResult,
    attackRoll,
    message
  };
}

export async function deactivatePower(actor, powerItem) {
  if (!actor || !powerItem || powerItem.type !== "power") {
    return {
      ok: false,
      reason: "invalid-power"
    };
  }

  await powerItem.update({ "system.active": false });
  const power = buildPowerContext(actor, powerItem);
  power.active = false;

  const costDetails = getPowerCost(actor, powerItem);
  const message = await postPowerMessage({
    actor,
    powerItem,
    power,
    spendResult: {
      ok: true,
      spent: 0,
      remaining: costDetails.currentResource,
      details: costDetails
    },
    deactivated: true
  });

  return {
    ok: true,
    actorId: actor.id,
    powerId: powerItem.id,
    message
  };
}


