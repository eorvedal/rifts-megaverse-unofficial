const SIZE_RANKS = {
  small: 0,
  human: 1,
  large: 2,
  giant: 3
};

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSizeCategory(value, fallback = "human") {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (Object.hasOwn(SIZE_RANKS, normalized)) return normalized;
  return fallback;
}

function normalizeImpactType(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["slam", "slammed", "ground"].includes(normalized)) return "slammed";
  if (["collision", "wall", "impact"].includes(normalized)) return "collision";
  return normalized;
}

function localize(key, fallback = "") {
  if (!key) return fallback;
  return game?.i18n ? game.i18n.localize(key) : (fallback || key);
}

function localizeSizeCategory(category) {
  const normalized = normalizeSizeCategory(category);
  const key = `RIFTS.Size.${normalized[0].toUpperCase()}${normalized.slice(1)}`;
  return localize(key, normalized);
}

export function getSizeCategory(actor) {
  if (!actor) return "human";

  const detailSize = normalizeSizeCategory(actor?.system?.details?.sizeCategory, "");
  if (detailSize) return detailSize;

  const vehicleSize = normalizeSizeCategory(actor?.system?.vehicle?.sizeCategory, "");
  if (vehicleSize) return vehicleSize;

  return actor?.type === "vehicle" ? "large" : "human";
}

export function compareSizeCategories(attacker, target) {
  const attackerSize = getSizeCategory(attacker);
  const targetSize = getSizeCategory(target);
  const attackerRank = SIZE_RANKS[attackerSize] ?? SIZE_RANKS.human;
  const targetRank = SIZE_RANKS[targetSize] ?? SIZE_RANKS.human;
  const delta = attackerRank - targetRank;

  return {
    attackerSize,
    targetSize,
    attackerRank,
    targetRank,
    delta,
    attackerLabel: localizeSizeCategory(attackerSize),
    targetLabel: localizeSizeCategory(targetSize)
  };
}

export function getImpactModifiers(attacker, target) {
  const size = compareSizeCategories(attacker, target);
  const strikeImpactModifier = size.delta * 2;
  const knockbackModifier = size.delta;
  const resistanceModifier = Math.max(0, (size.targetRank - size.attackerRank) * 2);

  let sizeNoteKey = "RIFTS.Impact.SizeEven";
  if (size.delta > 0) sizeNoteKey = "RIFTS.Impact.SizeAdvantageAttacker";
  if (size.delta < 0) sizeNoteKey = "RIFTS.Impact.SizeAdvantageTarget";

  return {
    ...size,
    strikeImpactModifier,
    knockbackModifier,
    resistanceModifier,
    sizeNoteKey
  };
}

function getImpactMetadata({ weapon = null, maneuver = null } = {}) {
  const weaponImpact = weapon?.system?.weapon ?? {};
  const source = maneuver && typeof maneuver === "object" ? maneuver : {};

  const canKnockdown = source.canKnockdown === true || weaponImpact.canKnockdown === true;
  const canKnockback = source.canKnockback === true || weaponImpact.canKnockback === true;

  const knockbackValue = Math.max(
    0,
    Math.floor(num(source.knockbackValue, num(weaponImpact.knockbackValue, 0)))
  );

  const impactType = normalizeImpactType(
    source.impactType
    ?? weaponImpact.impactType
    ?? (canKnockdown || canKnockback ? "slammed" : "")
  );

  return {
    canKnockdown,
    canKnockback,
    knockbackValue,
    impactType
  };
}

export function canBeKnockedDown(attacker, target, maneuver = null) {
  if (!target) return false;

  const metadata = getImpactMetadata({ maneuver });
  if (metadata.canKnockdown !== true) return false;

  const modifiers = getImpactModifiers(attacker, target);
  if (modifiers.delta <= -3) return false;
  return true;
}

export function canBeKnockedBack(attacker, target, maneuver = null) {
  if (!target) return false;

  const metadata = getImpactMetadata({ maneuver });
  if (metadata.canKnockback !== true && metadata.knockbackValue <= 0) return false;

  const modifiers = getImpactModifiers(attacker, target);
  if (modifiers.delta <= -3 && metadata.knockbackValue <= 1) return false;
  return true;
}

function getImpactTypeLabelKey(impactType) {
  if (impactType === "slammed") return "RIFTS.Impact.Slammed";
  if (impactType === "collision") return "RIFTS.Impact.Collision";
  return "";
}

export function resolveImpactResult({
  attacker,
  target,
  weapon = null,
  maneuver = null,
  resolution = null
} = {}) {
  if (!attacker || !target || !resolution?.canRollDamage) {
    return {
      attempted: false,
      hit: false,
      knockdown: { attempted: false, knockedDown: false, resisted: false, score: 0, threshold: 0 },
      knockback: { attempted: false, squares: 0, feet: 0 },
      impactType: "",
      impactTypeKey: "",
      modifiers: getImpactModifiers(attacker, target),
      summary: {
        size: "",
        knockdown: localize("RIFTS.Impact.NoKnockdown"),
        knockback: localize("RIFTS.Impact.NoKnockback"),
        resistance: "",
        impact: ""
      }
    };
  }

  const metadata = getImpactMetadata({ weapon, maneuver });
  const modifiers = getImpactModifiers(attacker, target);
  const hit = ["AttackOutcome.hitArmor", "AttackOutcome.hitBody"].includes(String(resolution?.outcomeLabel ?? ""));

  const knockdownAttempted = hit && metadata.canKnockdown && canBeKnockedDown(attacker, target, metadata);
  const targetPp = Math.max(1, Math.floor(num(target?.system?.attributes?.pp?.value, 10)));
  const knockdownThreshold = 12 + Math.floor(targetPp / 4) + modifiers.resistanceModifier;
  const knockdownScore = Math.floor(num(resolution?.attackRoll?.total, 0) + modifiers.strikeImpactModifier + Math.floor(metadata.knockbackValue / 2));

  const knockedDown = knockdownAttempted ? knockdownScore >= knockdownThreshold : false;
  const resisted = knockdownAttempted && !knockedDown;

  const knockbackAttempted = hit && (metadata.canKnockback || metadata.knockbackValue > 0) && canBeKnockedBack(attacker, target, metadata);
  let knockbackSquares = 0;
  if (knockbackAttempted) {
    const baseKnockback = metadata.knockbackValue > 0 ? metadata.knockbackValue : 1;
    knockbackSquares = Math.max(0, baseKnockback + modifiers.knockbackModifier + (knockedDown ? 1 : 0));
  }

  const knockbackFeet = knockbackSquares * 5;
  const impactType = metadata.impactType || (knockedDown || knockbackSquares > 0 ? "slammed" : "");
  const impactTypeKey = getImpactTypeLabelKey(impactType);

  const sizeText = game?.i18n
    ? game.i18n.format(modifiers.sizeNoteKey, {
      attackerSize: modifiers.attackerLabel,
      targetSize: modifiers.targetLabel
    })
    : `${modifiers.attackerLabel} vs ${modifiers.targetLabel}`;

  const knockdownText = !knockdownAttempted
    ? localize("RIFTS.Impact.NoKnockdown")
    : knockedDown
      ? localize("RIFTS.Impact.KnockedDown")
      : localize("RIFTS.Impact.ResistsKnockdown");

  const knockbackText = knockbackFeet > 0
    ? game.i18n.format("RIFTS.Impact.KnockedBack", { distance: knockbackFeet })
    : localize("RIFTS.Impact.NoKnockback");

  const resistanceText = knockdownAttempted
    ? game.i18n.format("RIFTS.Impact.ResistanceCheck", {
      score: knockdownScore,
      threshold: knockdownThreshold
    })
    : "";

  return {
    attempted: hit && (metadata.canKnockdown || metadata.canKnockback || Boolean(impactType)),
    hit,
    metadata,
    modifiers,
    knockdown: {
      attempted: knockdownAttempted,
      knockedDown,
      resisted,
      score: knockdownScore,
      threshold: knockdownThreshold
    },
    knockback: {
      attempted: knockbackAttempted,
      squares: knockbackSquares,
      feet: knockbackFeet
    },
    impactType,
    impactTypeKey,
    summary: {
      size: sizeText,
      knockdown: knockdownText,
      knockback: knockbackText,
      resistance: resistanceText,
      impact: impactTypeKey ? localize(impactTypeKey) : ""
    }
  };
}