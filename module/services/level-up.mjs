import { normalizeSpecialManeuverEntry, normalizeSpecialManeuverKey } from "./maneuvers.mjs";

const SYSTEM_ID = "rifts-megaverse";
const SESSION_FLAG = "levelUpSession";

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeText(value) {
  return String(value ?? "").trim();
}
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
function hasRollableValue(value) {
  const normalized = normalizeRollableValue(value, 0);
  if (typeof normalized === "number") return normalized > 0;
  return normalizeText(normalized).length > 0;
}
async function resolveRollableValue(rawValue, actor, fallback = 0) {
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
    const roll = await (new Roll(formula, actor?.getRollData?.() ?? {})).evaluate();
    return {
      mode: "roll",
      raw: formula,
      formula,
      value: Math.max(0, Math.floor(num(roll.total, 0))),
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

function normalizeName(value) {
  return normalizeText(value).toLowerCase();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clone(value) {
  return foundry.utils.deepClone(value);
}

function localize(key, fallback = "") {
  const localized = game?.i18n?.localize?.(key);
  return localized || fallback || key;
}

function getActorLevel(actor) {
  return Math.max(1, Math.floor(num(actor?.system?.derived?.level, num(actor?.system?.details?.level, 1))));
}

function getSessionState(actor) {
  return asObject(actor?.getFlag?.(SYSTEM_ID, SESSION_FLAG));
}

async function setSessionState(actor, state) {
  if (!actor) return;
  await actor.setFlag(SYSTEM_ID, SESSION_FLAG, state);
}

function normalizeMap(rawMap) {
  if (Array.isArray(rawMap)) {
    const out = {};
    for (let i = 0; i < rawMap.length; i += 1) {
      const v = Math.floor(num(rawMap[i], 0));
      if (!v) continue;
      out[String(i + 1)] = v;
    }
    return out;
  }

  const map = asObject(rawMap);
  const out = {};
  for (const [k, v] of Object.entries(map)) {
    const level = Math.floor(num(k, 0));
    const value = Math.floor(num(v, 0));
    if (level <= 0 || !value) continue;
    out[String(level)] = value;
  }
  return out;
}

function mapAt(rawMap, level) {
  const map = normalizeMap(rawMap);
  return Math.max(0, Math.floor(num(map[String(level)], 0)));
}

function toChoiceId(sourceType, sourceId, level, choiceType, category) {
  return ["choice", normalizeName(sourceType), normalizeText(sourceId), level, normalizeName(choiceType), normalizeName(category)].join(":");
}

function toAutoId(sourceType, sourceId, level, kind, key) {
  return ["auto", normalizeName(sourceType), normalizeText(sourceId), level, normalizeName(kind), normalizeName(key)].join(":");
}


function getActiveHth(actor) {
  return actor?.getActiveHandToHandItem?.() ?? actor?.getActiveHandToHand?.() ?? null;
}

function hasOwnerPermission(actor, user = game.user) {
  if (!actor || !user) return false;
  if (user.isGM) return true;
  const owner = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  return actor.testUserPermission(user, owner);
}

function getSkillPool(actor, skillType) {
  const ctx = actor?.getClassSkillPackageSuggestions?.() ?? {};
  const map = {
    occ: asArray(ctx.occSkillsFromClass),
    related: asArray(ctx.relatedSkillsFromClass),
    secondary: asArray(ctx.secondarySkillsFromClass)
  };
  return map[skillType].map((entry, index) => ({
    entryId: `${skillType}:${index}`,
    name: normalizeText(entry?.name),
    category: normalizeText(entry?.category),
    detail: "",
    source: localize("RIFTS.Skills.ClassSkills"),
    payload: {
      skillType,
      skillIndex: index
    }
  })).filter((entry) => entry.name.length > 0);
}

function getChoicePoolEntries(activeClass, key) {
  const flagPools = asObject(activeClass?.getFlag?.(SYSTEM_ID, "choicePools"));
  const flagged = asArray(flagPools[key]);
  if (flagged.length > 0) return flagged;

  const classPools = asObject(activeClass?.system?.choicePools);
  return asArray(classPools[key]);
}

function getClassChoiceProgression(activeClass) {
  const classProgression = asObject(activeClass?.system?.choiceProgression);
  const flagProgression = asObject(activeClass?.getFlag?.(SYSTEM_ID, "choiceProgression"));
  const keys = ["spells", "psionics", "maneuvers", "weaponProficiencies", "packageChoices", "optionalChoices"];
  const out = {};

  for (const key of keys) {
    const systemMap = normalizeMap(classProgression[key]);
    const flagMap = normalizeMap(flagProgression[key]);
    out[key] = Object.keys(flagMap).length > 0 ? flagMap : systemMap;
  }

  return out;
}

function getHthSelectionProgression(activeHth) {
  const systemSelection = normalizeMap(asObject(activeHth?.system?.selectionProgression).maneuvers);
  const flagSelection = normalizeMap(asObject(asObject(activeHth?.getFlag?.(SYSTEM_ID, "selectionProgression")).maneuvers));
  return Object.keys(flagSelection).length > 0 ? flagSelection : systemSelection;
}

function normalizeClassPoolEntry(entry) {
  if (typeof entry === "string") return { name: normalizeText(entry) };
  return asObject(entry);
}

function getPowerPool(activeClass, category) {
  const type = normalizeName(category) === "spell" ? "spell" : "psionic";
  const classPoolKey = type === "spell" ? "spells" : "psionics";
  const classEntries = getChoicePoolEntries(activeClass, classPoolKey);

  if (classEntries.length > 0) {
    return classEntries
      .map((entry, idx) => {
        const item = normalizeClassPoolEntry(entry);
        const itemId = normalizeText(item.itemId || item.id);
        const worldItem = itemId ? game?.items?.get?.(itemId) : null;
        const name = normalizeText(item.name || worldItem?.name);
        if (!name) return null;

        return {
          entryId: `power:${classPoolKey}:${idx}`,
          name,
          category: normalizeText(item.category || worldItem?.system?.subType),
          detail: normalizeText(item.detail || item.description),
          source: activeClass?.name || localize("RIFTS.Sheet.ActiveClass"),
          payload: {
            itemId: worldItem?.id || itemId,
            powerType: type,
            costType: normalizeText(item.costType || worldItem?.system?.costType),
            cost: num(item.cost, worldItem?.system?.cost),
            range: normalizeText(item.range || worldItem?.system?.range),
            duration: normalizeText(item.duration || worldItem?.system?.duration),
            activationTime: normalizeText(item.activationTime || worldItem?.system?.activationTime),
            saveType: normalizeText(item.saveType || worldItem?.system?.saveType),
            damage: normalizeText(item.damage || worldItem?.system?.damage),
            notes: normalizeText(item.notes),
            description: normalizeText(item.description || worldItem?.system?.description)
          }
        };
      })
      .filter((entry) => entry && entry.name.length > 0);
  }

  return (game?.items?.filter?.((item) => item.type === "power") ?? [])
    .filter((item) => normalizeName(item.system?.powerType) === type)
    .map((item) => ({
      entryId: `power:world:${item.id}`,
      name: item.name,
      category: normalizeText(item.system?.subType),
      detail: "",
      source: localize("RIFTS.Importer.WorldImport"),
      payload: {
        itemId: item.id,
        powerType: type
      }
    }));
}

function getManeuverPool(actor, activeClass, hth, level) {
  const stylePool = hth
    ? asArray(hth.system?.maneuverPackage?.grantedManeuvers)
      .map((entry, index) => ({ normalized: normalizeSpecialManeuverEntry(entry), index }))
      .filter((entry) => entry.normalized.name && level >= Math.max(1, Math.floor(num(entry.normalized.minLevel, 1))))
      .map((entry) => ({
        entryId: `hth:${entry.index}`,
        name: entry.normalized.name,
        category: normalizeText(entry.normalized.category),
        detail: `${localize("RIFTS.Maneuvers.ActionCost")}: ${entry.normalized.actionCost}`,
        source: hth.name,
        payload: {
          packageIndex: entry.index,
          maneuver: clone(entry.normalized)
        }
      }))
    : [];

  const classPool = getChoicePoolEntries(activeClass, "maneuvers")
    .map((entry, idx) => {
      const item = normalizeClassPoolEntry(entry);
      const itemId = normalizeText(item.itemId || item.id);
      const worldItem = itemId ? game?.items?.get?.(itemId) : null;
      const normalized = worldItem?.type === "specialManeuver"
        ? normalizeSpecialManeuverEntry({
          ...worldItem.system,
          name: worldItem.name
        })
        : normalizeSpecialManeuverEntry(item);

      if (!normalized.name) return null;
      if (level < Math.max(1, Math.floor(num(normalized.minLevel, 1)))) return null;

      return {
        entryId: `maneuver:${idx}`,
        name: normalized.name,
        category: normalizeText(normalized.category),
        detail: `${localize("RIFTS.Maneuvers.ActionCost")}: ${normalized.actionCost}`,
        source: activeClass?.name || localize("RIFTS.Sheet.ActiveClass"),
        payload: {
          itemId: worldItem?.id || itemId,
          maneuver: clone(normalized)
        }
      };
    })
    .filter((entry) => entry && entry.name.length > 0);

  const merged = [...stylePool, ...classPool];
  const seen = new Set();
  return merged.filter((entry) => {
    const key = normalizeSpecialManeuverKey(entry?.payload?.maneuver?.key || entry?.name);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getProficiencyPool(activeClass) {
  return getChoicePoolEntries(activeClass, "weaponProficiencies")
    .map((entry, idx) => {
      const item = normalizeClassPoolEntry(entry);
      const name = normalizeText(item.name);
      if (!name) return null;

      return {
        entryId: `wp:${idx}`,
        name,
        category: normalizeText(item.category),
        detail: normalizeText(item.description),
        source: activeClass?.name || localize("RIFTS.Sheet.ActiveClass"),
        payload: {
          itemType: "feature",
          name,
          description: normalizeText(item.description)
        }
      };
    })
    .filter((entry) => entry && entry.name.length > 0);
}

function getPackagePool(activeClass, key = "packageChoices") {
  return getChoicePoolEntries(activeClass, key)
    .map((entry, idx) => {
      const item = normalizeClassPoolEntry(entry);
      const name = normalizeText(item.name);
      if (!name) return null;

      return {
        entryId: `pkg:${key}:${idx}`,
        name,
        category: normalizeText(item.category),
        detail: normalizeText(item.detail || item.description),
        source: activeClass?.name || localize("RIFTS.Sheet.ActiveClass"),
        payload: {
          itemType: normalizeText(item.itemType || "feature") || "feature",
          name,
          description: normalizeText(item.description),
          system: item.system && typeof item.system === "object" ? clone(item.system) : {}
        }
      };
    })
    .filter((entry) => entry && entry.name.length > 0);
}

function alreadyKnown(actor, choiceType, entry) {
  const name = normalizeName(entry?.name);
  if (!name) return false;

  if (choiceType === "maneuver") {
    const key = normalizeSpecialManeuverKey(entry?.payload?.maneuver?.key || entry?.name);
    return Boolean(key && actor?.hasSpecialManeuver?.(key));
  }

  if (choiceType === "spell" || choiceType === "psionic") {
    return Boolean(actor.items.find((item) => item.type === "power" && normalizeName(item.name) === name));
  }

  if (choiceType === "skill") {
    return Boolean(actor.items.find((item) => item.type === "skill" && normalizeName(item.name) === name));
  }

  if (choiceType === "weaponProficiency") {
    return Boolean(actor.items.find((item) => item.type === "feature" && normalizeName(item.name) === name));
  }

  if (choiceType === "package") {
    const targetType = normalizeText(entry?.payload?.itemType || "feature") || "feature";
    return Boolean(actor.items.find((item) => item.type === targetType && normalizeName(item.name) === name));
  }

  return false;
}

function buildChoice(actor, state, { sourceType, sourceId, sourceName, level, choiceType, category, count, label, optional, pool }) {
  const id = toChoiceId(sourceType, sourceId, level, choiceType, category);
  const selected = asArray(asObject(state.choices)[id]).map((entry) => normalizeText(entry)).filter((entry) => entry.length > 0);
  const manualDone = asObject(state.manualCompleted)[id] === true;
  const completedCount = manualDone ? count : Math.min(count, selected.length);
  const remainingCount = Math.max(0, count - completedCount);

  const preparedPool = asArray(pool).map((entry) => {
    const known = alreadyKnown(actor, choiceType, entry);
    return {
      ...entry,
      disabled: known,
      status: known ? localize("RIFTS.LevelUp.AlreadyKnown") : ""
    };
  });

  return {
    id,
    sourceType,
    sourceId,
    sourceName,
    level,
    choiceType,
    category,
    count,
    label,
    optional: optional === true,
    poolDefinition: {
      sourceType,
      sourceId,
      choiceType,
      category,
      poolSize: preparedPool.length
    },
    pool: preparedPool,
    selected,
    manualDone,
    completedCount,
    remainingCount,
    isComplete: remainingCount <= 0
  };
}

function initializeState(actor, rawState, targetLevel, activeClassId, activeHthId) {
  const state = clone(rawState);
  state.choices = asObject(state.choices);
  state.manualCompleted = asObject(state.manualCompleted);
  state.automaticApplied = asObject(state.automaticApplied);

  state.lastCompletedLevel = Math.max(0, Math.floor(num(state.lastCompletedLevel, targetLevel - 1)));
  state.activeClassId = normalizeText(state.activeClassId);
  state.activeHthId = normalizeText(state.activeHthId);

  if (state.activeClassId !== activeClassId || state.activeHthId !== activeHthId) {
    state.choices = {};
    state.manualCompleted = {};
    state.automaticApplied = {};
    state.lastCompletedLevel = Math.max(0, Math.min(state.lastCompletedLevel, targetLevel - 1));
  }

  state.activeClassId = activeClassId;
  state.activeHthId = activeHthId;
  state.targetLevel = targetLevel;

  if (state.lastCompletedLevel > targetLevel) state.lastCompletedLevel = targetLevel;
  return state;
}

function buildSession(actor, rawState) {
  const level = getActorLevel(actor);
  const activeClass = actor?.getActiveClassItem?.() ?? actor?.getActiveClass?.() ?? null;
  const activeHth = getActiveHth(actor);
  const state = initializeState(actor, rawState, level, normalizeText(activeClass?.id), normalizeText(activeHth?.id));

  const levels = [];
  for (let l = state.lastCompletedLevel + 1; l <= level; l += 1) levels.push(l);

  const requiredChoices = [];
  const optionalChoices = [];
  const classSkillSelection = asObject(activeClass?.system?.skillSelection);
  const classPowerProgression = asObject(activeClass?.system?.powerProgression);
  const classResourceProgression = asObject(activeClass?.system?.resourceProgression);
  const classChoiceProgression = getClassChoiceProgression(activeClass);
  const hthSelectionProgression = getHthSelectionProgression(activeHth);

  for (const l of levels) {
    const occ = (l === 1 ? Math.floor(num(classSkillSelection.occ, 0)) : 0) + mapAt(classSkillSelection.occProgression, l);
    if (occ > 0) requiredChoices.push(buildChoice(actor, state, { sourceType: activeClass?.type || "occ", sourceId: activeClass?.id || "", sourceName: activeClass?.name || "", level: l, choiceType: "skill", category: "occ", count: occ, label: localize("RIFTS.SelectionDialog.AvailableOccSkills"), optional: false, pool: getSkillPool(actor, "occ") }));

    const related = (l === 1 ? Math.floor(num(classSkillSelection.related, 0)) : 0) + mapAt(classSkillSelection.relatedProgression, l);
    if (related > 0) requiredChoices.push(buildChoice(actor, state, { sourceType: activeClass?.type || "occ", sourceId: activeClass?.id || "", sourceName: activeClass?.name || "", level: l, choiceType: "skill", category: "related", count: related, label: localize("RIFTS.SelectionDialog.AvailableRelatedSkills"), optional: false, pool: getSkillPool(actor, "related") }));

    const secondary = (l === 1 ? Math.floor(num(classSkillSelection.secondary, 0)) : 0) + mapAt(classSkillSelection.secondaryProgression, l);
    if (secondary > 0) requiredChoices.push(buildChoice(actor, state, { sourceType: activeClass?.type || "occ", sourceId: activeClass?.id || "", sourceName: activeClass?.name || "", level: l, choiceType: "skill", category: "secondary", count: secondary, label: localize("RIFTS.SelectionDialog.AvailableSecondarySkills"), optional: false, pool: getSkillPool(actor, "secondary") }));

    const spells = mapAt(classPowerProgression.spellProgression, l) + mapAt(classChoiceProgression.spells, l);
    if (spells > 0) requiredChoices.push(buildChoice(actor, state, { sourceType: activeClass?.type || "occ", sourceId: activeClass?.id || "", sourceName: activeClass?.name || "", level: l, choiceType: "spell", category: "spell", count: spells, label: localize("RIFTS.LevelUp.Spells"), optional: false, pool: getPowerPool(activeClass, "spell") }));

    const psionics = mapAt(classPowerProgression.psionicProgression, l) + mapAt(classChoiceProgression.psionics, l);
    if (psionics > 0) requiredChoices.push(buildChoice(actor, state, { sourceType: activeClass?.type || "occ", sourceId: activeClass?.id || "", sourceName: activeClass?.name || "", level: l, choiceType: "psionic", category: "psionic", count: psionics, label: localize("RIFTS.LevelUp.Psionics"), optional: false, pool: getPowerPool(activeClass, "psionic") }));

    const maneuvers = mapAt(hthSelectionProgression, l) + mapAt(classChoiceProgression.maneuvers, l);
    if (maneuvers > 0) requiredChoices.push(buildChoice(actor, state, { sourceType: "handToHand", sourceId: activeHth?.id || "", sourceName: activeHth?.name || "", level: l, choiceType: "maneuver", category: "specialManeuver", count: maneuvers, label: localize("RIFTS.LevelUp.Maneuvers"), optional: false, pool: getManeuverPool(actor, activeClass, activeHth, l) }));

    const proficiencies = mapAt(classChoiceProgression.weaponProficiencies, l);
    if (proficiencies > 0) requiredChoices.push(buildChoice(actor, state, { sourceType: activeClass?.type || "occ", sourceId: activeClass?.id || "", sourceName: activeClass?.name || "", level: l, choiceType: "weaponProficiency", category: "weaponProficiency", count: proficiencies, label: localize("RIFTS.LevelUp.WeaponProficiencies"), optional: false, pool: getProficiencyPool(activeClass) }));

    const packages = mapAt(classChoiceProgression.packageChoices, l);
    if (packages > 0) requiredChoices.push(buildChoice(actor, state, { sourceType: activeClass?.type || "occ", sourceId: activeClass?.id || "", sourceName: activeClass?.name || "", level: l, choiceType: "package", category: "package", count: packages, label: localize("RIFTS.LevelUp.PackageChoices"), optional: false, pool: getPackagePool(activeClass) }));

    const optional = mapAt(classChoiceProgression.optionalChoices, l);
    if (optional > 0) optionalChoices.push(buildChoice(actor, state, { sourceType: activeClass?.type || "occ", sourceId: activeClass?.id || "", sourceName: activeClass?.name || "", level: l, choiceType: "package", category: "optional", count: optional, label: localize("RIFTS.LevelUp.OptionalChoices"), optional: true, pool: getPackagePool(activeClass, "optionalChoices") }));
  }

  const automaticGains = [];
  for (const l of levels) {
    automaticGains.push({
      id: toAutoId(activeClass?.type || "class", activeClass?.id || "", l, "level", "reached"),
      label: `${localize("RIFTS.Progression.Level")} ${l}`,
      description: localize("RIFTS.LevelUp.AutomaticLevelAdvancement"),
      level: l,
      applied: asObject(state.automaticApplied)[toAutoId(activeClass?.type || "class", activeClass?.id || "", l, "level", "reached")] === true
    });

    if (l > 1) {
      const resourceGainDefs = [
        { key: "hp", label: localize("RIFTS.Powers.CostTypeHP", "HP"), formula: classResourceProgression.hpPerLevel },
        { key: "sdc", label: localize("RIFTS.Powers.CostTypeSDC", "SDC"), formula: classResourceProgression.sdcPerLevel },
        { key: "isp", label: localize("RIFTS.Powers.CostTypeISP", "ISP"), formula: classResourceProgression.ispPerLevel },
        { key: "ppe", label: localize("RIFTS.Powers.CostTypePPE", "PPE"), formula: classResourceProgression.ppePerLevel }
      ];

      for (const resourceGain of resourceGainDefs) {
        if (!hasRollableValue(resourceGain.formula)) continue;
        const formulaText = normalizeText(resourceGain.formula || "0") || "0";
        const id = toAutoId(activeClass?.type || "class", activeClass?.id || "", l, "resource", `${resourceGain.key}:${formulaText}`);
        automaticGains.push({
          id,
          label: `${resourceGain.label} ${localize("RIFTS.Sheet.ResourceProgression")}`,
          description: `+${formulaText}`,
          level: l,
          kind: "resourceProgression",
          resourceKey: resourceGain.key,
          formula: resourceGain.formula,
          applied: asObject(state.automaticApplied)[id] === true
        });
      }
    }

    const unlocked = getManeuverPool(actor, activeClass, activeHth, l).filter((entry) => {
      const idx = Number(String(entry.entryId).split(":")[1]);
      const raw = asArray(activeHth?.system?.maneuverPackage?.grantedManeuvers)[idx];
      return Math.max(1, Math.floor(num(raw?.minLevel, 1))) === l;
    }).map((entry) => entry.name);

    if (unlocked.length > 0) {
      const id = toAutoId("handToHand", activeHth?.id || "", l, "maneuverUnlock", unlocked.join("|"));
      automaticGains.push({ id, label: localize("RIFTS.Maneuvers.SpecialManeuvers"), description: `${localize("RIFTS.LevelUp.ManeuverUnlock")}: ${unlocked.join(", ")}`, level: l, applied: asObject(state.automaticApplied)[id] === true });
    }
  }

  const reqTotal = requiredChoices.reduce((sum, entry) => sum + entry.count, 0);
  const reqDone = requiredChoices.reduce((sum, entry) => sum + entry.completedCount, 0);
  const reqRemain = requiredChoices.reduce((sum, entry) => sum + entry.remainingCount, 0);
  const optTotal = optionalChoices.reduce((sum, entry) => sum + entry.count, 0);
  const optDone = optionalChoices.reduce((sum, entry) => sum + entry.completedCount, 0);
  const optRemain = optionalChoices.reduce((sum, entry) => sum + entry.remainingCount, 0);

  return {
    actorId: actor.id,
    actorName: actor.name,
    currentLevel: level,
    nextLevel: level + 1,
    lastCompletedLevel: state.lastCompletedLevel,
    pendingLevels: levels,
    activeClassId: activeClass?.id || "",
    activeClassName: activeClass?.name || "",
    activeHthId: activeHth?.id || "",
    activeHthName: activeHth?.name || "",
    hasActiveClass: Boolean(activeClass),
    automaticGains,
    requiredChoices,
    optionalChoices,
    totals: {
      requiredTotal: reqTotal,
      requiredCompleted: reqDone,
      requiredRemaining: reqRemain,
      optionalTotal: optTotal,
      optionalCompleted: optDone,
      optionalRemaining: optRemain,
      pendingChoices: reqRemain,
      isComplete: reqRemain <= 0
    },
    state
  };
}

function findChoice(session, choiceId) {
  return [...session.requiredChoices, ...session.optionalChoices].find((entry) => entry.id === choiceId) ?? null;
}

export function canUserManageLevelUp(actor, user = game.user) {
  return hasOwnerPermission(actor, user);
}

export async function getLevelUpSession(actor, { persist = false } = {}) {
  const rawState = getSessionState(actor);
  const session = buildSession(actor, rawState);

  if (persist) {
    const same = JSON.stringify(rawState ?? {}) === JSON.stringify(session.state ?? {});
    if (!same) await setSessionState(actor, session.state);
  }

  return session;
}

export async function getLevelUpSummary(actor, { persist = false } = {}) {
  const session = await getLevelUpSession(actor, { persist });
  return {
    hasActiveClass: session.hasActiveClass,
    currentLevel: session.currentLevel,
    lastCompletedLevel: session.lastCompletedLevel,
    pendingChoices: session.totals.pendingChoices,
    requiredCompleted: session.totals.requiredCompleted,
    requiredTotal: session.totals.requiredTotal,
    requiredRemaining: session.totals.requiredRemaining,
    optionalCompleted: session.totals.optionalCompleted,
    optionalTotal: session.totals.optionalTotal,
    optionalRemaining: session.totals.optionalRemaining,
    isComplete: session.totals.isComplete,
    labelKey: session.totals.isComplete ? "RIFTS.LevelUp.LevelUpComplete" : "RIFTS.LevelUp.LevelUpIncomplete"
  };
}

async function applySkillChoice(actor, choice, poolEntry) {
  const payload = asObject(poolEntry?.payload);
  const skillType = normalizeName(payload.skillType);
  const skillIndex = Number(payload.skillIndex);

  if (["occ", "related", "secondary"].includes(skillType) && Number.isFinite(skillIndex) && typeof actor.addSkillFromClassPackage === "function") {
    return actor.addSkillFromClassPackage(skillType, skillIndex);
  }

  const name = normalizeText(poolEntry?.name || payload.name);
  if (!name) return { status: "invalid-entry" };

  const duplicate = actor.items.find((item) => item.type === "skill" && normalizeName(item.name) === normalizeName(name));
  if (duplicate) return { status: "duplicate", duplicate };

  const itemData = {
    name,
    type: "skill",
    system: {
      category: normalizeText(poolEntry?.category || payload.category),
      base: num(payload.base, 0),
      perLevel: num(payload.perLevel, 0),
      modifier: num(payload.modifier, 0),
      sourceType: normalizeText(choice.sourceType),
      sourceId: normalizeText(choice.sourceId),
      notes: normalizeText(payload.notes)
    }
  };

  const created = await actor.createEmbeddedDocuments("Item", [itemData]);
  return { status: "created", created: created?.[0] ?? null };
}

async function applyPowerChoice(actor, choice, poolEntry) {
  const payload = asObject(poolEntry?.payload);
  const itemId = normalizeText(payload.itemId);
  const source = itemId ? game?.items?.get?.(itemId) : null;

  const name = normalizeText(poolEntry?.name || payload.name || source?.name);
  if (!name) return { status: "invalid-entry" };

  const duplicate = actor.items.find((item) => item.type === "power" && normalizeName(item.name) === normalizeName(name));
  if (duplicate) return { status: "duplicate", duplicate };

  const itemData = source ? source.toObject() : {
    name,
    type: "power",
    system: {
      powerType: normalizeName(choice.choiceType) === "spell" ? "spell" : "psionic",
      subType: normalizeText(poolEntry?.category || payload.category),
      costType: normalizeName(payload.costType || "none") || "none",
      cost: Math.max(0, Math.floor(num(payload.cost, 0))),
      range: normalizeText(payload.range),
      duration: normalizeText(payload.duration),
      activationTime: normalizeText(payload.activationTime),
      saveType: normalizeText(payload.saveType),
      damage: normalizeText(payload.damage),
      description: normalizeText(payload.description || payload.detail),
      notes: normalizeText(payload.notes)
    }
  };

  delete itemData._id;
  itemData.name = name;
  itemData.type = "power";
  itemData.system ??= {};
  itemData.system.powerType = normalizeName(choice.choiceType) === "spell" ? "spell" : "psionic";
  itemData.system.sourceType = normalizeText(choice.sourceType);
  itemData.system.sourceId = normalizeText(choice.sourceId);

  const created = await actor.createEmbeddedDocuments("Item", [itemData]);
  return { status: "created", created: created?.[0] ?? null };
}

async function applyManeuverChoice(actor, choice, poolEntry) {
  const payload = asObject(poolEntry?.payload);
  const packageIndex = Number(payload.packageIndex);

  if (Number.isFinite(packageIndex) && packageIndex >= 0 && typeof actor.addManeuverFromHandToHandPackage === "function") {
    return actor.addManeuverFromHandToHandPackage(packageIndex);
  }

  const itemId = normalizeText(payload.itemId);
  const source = itemId ? game?.items?.get?.(itemId) : null;
  const maneuver = source?.type === "specialManeuver"
    ? normalizeSpecialManeuverEntry({ ...source.system, name: source.name })
    : normalizeSpecialManeuverEntry(payload.maneuver ?? {});

  if (!maneuver.name) return { status: "invalid-entry" };

  const maneuverKey = normalizeSpecialManeuverKey(maneuver.key || maneuver.name);
  const duplicate = actor.items.find((item) => {
    if (item.type !== "specialManeuver") return false;
    const itemKey = normalizeSpecialManeuverKey(item.system?.key || item.name);
    if (maneuverKey && itemKey) return maneuverKey === itemKey;
    return normalizeName(item.name) === normalizeName(maneuver.name);
  });
  if (duplicate) return { status: "duplicate", duplicate };

  const itemData = source ? source.toObject() : {
    name: maneuver.name,
    type: "specialManeuver",
    system: clone(maneuver)
  };

  delete itemData._id;
  itemData.name = maneuver.name;
  itemData.type = "specialManeuver";
  itemData.system ??= {};
  itemData.system = {
    ...itemData.system,
    ...clone(maneuver),
    sourceType: normalizeText(choice.sourceType),
    sourceId: normalizeText(choice.sourceId),
    sourceName: normalizeText(choice.sourceName)
  };

  const created = await actor.createEmbeddedDocuments("Item", [itemData]);
  return { status: "created", created: created?.[0] ?? null };
}

async function applyWeaponProficiencyChoice(actor, poolEntry) {
  const payload = asObject(poolEntry?.payload);
  const name = normalizeText(poolEntry?.name || payload.name);
  if (!name) return { status: "invalid-entry" };

  const duplicate = actor.items.find((item) => item.type === "feature" && normalizeName(item.name) === normalizeName(name));
  if (duplicate) return { status: "duplicate", duplicate };

  const created = await actor.createEmbeddedDocuments("Item", [{
    name,
    type: "feature",
    system: {
      description: normalizeText(payload.description || poolEntry?.detail || "Weapon proficiency")
    }
  }]);

  return { status: "created", created: created?.[0] ?? null };
}

async function applyPackageChoice(actor, poolEntry) {
  const payload = asObject(poolEntry?.payload);
  const itemType = normalizeText(payload.itemType || "feature") || "feature";
  const type = CONFIG?.RIFTS?.itemTypes?.includes?.(itemType) ? itemType : "feature";
  const name = normalizeText(poolEntry?.name || payload.name);
  if (!name) return { status: "invalid-entry" };

  const duplicate = actor.items.find((item) => item.type === type && normalizeName(item.name) === normalizeName(name));
  if (duplicate) return { status: "duplicate", duplicate };

  const created = await actor.createEmbeddedDocuments("Item", [{
    name,
    type,
    system: payload.system && typeof payload.system === "object" ? clone(payload.system) : {}
  }]);

  return { status: "created", created: created?.[0] ?? null };
}

async function applyChoice(actor, choice, poolEntry) {
  if (choice.choiceType === "skill") return applySkillChoice(actor, choice, poolEntry);
  if (choice.choiceType === "spell" || choice.choiceType === "psionic") return applyPowerChoice(actor, choice, poolEntry);
  if (choice.choiceType === "maneuver") return applyManeuverChoice(actor, choice, poolEntry);
  if (choice.choiceType === "weaponProficiency") return applyWeaponProficiencyChoice(actor, poolEntry);
  if (choice.choiceType === "package") return applyPackageChoice(actor, poolEntry);
  return { status: "unsupported-choice-type" };
}

export async function applyLevelUpChoice(actor, choiceId, entryId) {
  if (!hasOwnerPermission(actor)) return { status: "permission-denied" };

  const session = await getLevelUpSession(actor, { persist: true });
  const choice = findChoice(session, choiceId);
  if (!choice) return { status: "choice-not-found" };

  if (!choice.optional && choice.remainingCount <= 0 && !choice.manualDone) {
    return { status: "choice-already-complete" };
  }

  const poolEntry = asArray(choice.pool).find((entry) => normalizeText(entry.entryId) === normalizeText(entryId));
  if (!poolEntry) return { status: "entry-not-found" };
  if (poolEntry.disabled) return { status: "already-known" };

  const result = await applyChoice(actor, choice, poolEntry);
  if (!result || String(result.status) !== "created") return result ?? { status: "failed" };

  const nextState = clone(session.state);
  nextState.choices ??= {};
  nextState.choices[choice.id] = asArray(nextState.choices[choice.id]);
  nextState.choices[choice.id].push(poolEntry.entryId);
  nextState.choices[choice.id] = [...new Set(nextState.choices[choice.id].map((entry) => normalizeText(entry)).filter((entry) => entry.length > 0))];
  delete asObject(nextState.manualCompleted)[choice.id];

  await setSessionState(actor, nextState);
  return {
    status: "selected",
    result,
    session: await getLevelUpSession(actor, { persist: false })
  };
}

export async function markLevelUpChoiceComplete(actor, choiceId, completed = true) {
  if (!actor || !game.user?.isGM) return { status: "permission-denied" };

  const session = await getLevelUpSession(actor, { persist: true });
  const choice = findChoice(session, choiceId);
  if (!choice) return { status: "choice-not-found" };

  const nextState = clone(session.state);
  nextState.manualCompleted ??= {};
  if (completed) nextState.manualCompleted[choice.id] = true;
  else delete nextState.manualCompleted[choice.id];

  await setSessionState(actor, nextState);
  return { status: "ok", session: await getLevelUpSession(actor, { persist: false }) };
}

export async function clearLevelUpChoiceSelections(actor, choiceId) {
  if (!hasOwnerPermission(actor)) return { status: "permission-denied" };

  const session = await getLevelUpSession(actor, { persist: true });
  const choice = findChoice(session, choiceId);
  if (!choice) return { status: "choice-not-found" };

  const nextState = clone(session.state);
  delete asObject(nextState.choices)[choice.id];
  delete asObject(nextState.manualCompleted)[choice.id];

  await setSessionState(actor, nextState);
  return { status: "ok", session: await getLevelUpSession(actor, { persist: false }) };
}

export async function applyAutomaticLevelUpGains(actor) {
  if (!hasOwnerPermission(actor)) return { status: "permission-denied" };

  const session = await getLevelUpSession(actor, { persist: true });
  const nextState = clone(session.state);
  nextState.automaticApplied ??= {};

  const resourceDeltas = {};
  const warnings = [];

  let applied = 0;
  for (const gain of session.automaticGains) {
    if (nextState.automaticApplied[gain.id] === true) continue;

    if (normalizeName(gain.kind) === "resourceprogression") {
      const resourceKey = normalizeName(gain.resourceKey);
      if (!["hp", "sdc", "isp", "ppe"].includes(resourceKey)) {
        nextState.automaticApplied[gain.id] = true;
        applied += 1;
        continue;
      }

      const resolved = await resolveRollableValue(gain.formula, actor, 0);
      if (resolved.mode === "invalid") {
        warnings.push(`${resourceKey.toUpperCase()}: ${normalizeText(gain.formula)}`);
        continue;
      }

      const delta = Math.max(0, Math.floor(num(resolved.value, 0)));
      if (delta > 0) {
        resourceDeltas[resourceKey] = Math.max(0, Math.floor(num(resourceDeltas[resourceKey], 0))) + delta;
      }

      nextState.automaticApplied[gain.id] = true;
      applied += 1;
      continue;
    }

    nextState.automaticApplied[gain.id] = true;
    applied += 1;
  }

  const updates = {};
  for (const [resourceKey, deltaRaw] of Object.entries(resourceDeltas)) {
    const delta = Math.max(0, Math.floor(num(deltaRaw, 0)));
    if (delta <= 0) continue;

    const pool = asObject(actor.system?.resources?.[resourceKey]);
    const currentValue = Math.max(0, Math.floor(num(pool.value, 0)));
    const currentMax = Math.max(currentValue, Math.floor(num(pool.max, currentValue)));
    const nextMax = currentMax + delta;
    const nextValue = Math.min(nextMax, currentValue + delta);

    updates[`system.resources.${resourceKey}.max`] = nextMax;
    updates[`system.resources.${resourceKey}.value`] = nextValue;
  }

  if (Object.keys(updates).length > 0) {
    await actor.update(updates);
  }

  await setSessionState(actor, nextState);

  if (warnings.length > 0) {
    ui.notifications?.warn?.(`Invalid resource progression formula(s): ${warnings.join(", ")}`);
  }

  return {
    status: "ok",
    applied,
    resourceDeltas,
    session: await getLevelUpSession(actor, { persist: false })
  };
}

export async function finalizeLevelUpSession(actor, { force = false } = {}) {
  if (!hasOwnerPermission(actor)) return { status: "permission-denied" };

  const session = await getLevelUpSession(actor, { persist: true });
  if (!force && session.totals.requiredRemaining > 0) {
    return { status: "incomplete", session };
  }

  const nextState = clone(session.state);
  nextState.lastCompletedLevel = session.currentLevel;
  nextState.choices = {};
  nextState.manualCompleted = {};
  nextState.automaticApplied = {};

  await setSessionState(actor, nextState);
  return { status: "complete", session: await getLevelUpSession(actor, { persist: false }) };
}







