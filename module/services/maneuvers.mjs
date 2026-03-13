import { attackWithUnarmedManeuver, getTargetFromUI } from "./combat.mjs";
import { normalizeManeuverKey } from "./unarmed.mjs";

const SPECIAL_MANEUVER_DEFINITIONS = {
  disarm: {
    key: "disarm",
    labelKey: "RIFTS.Maneuvers.Disarm",
    category: "offensive",
    actionCost: 1,
    strikeModifier: 0,
    damageFormula: "0",
    damageMultiplier: 1,
    canKnockdown: false,
    canKnockback: false,
    knockbackValue: 0,
    impactType: "",
    isReactive: false,
    requiresTarget: true,
    requiresHit: true,
    minLevel: 1,
    specialRules: "",
    tags: [],
    grantable: true,
    description: "Disarm attempt.",
    notes: "No automatic item-drop yet; resolve manually from chat outcome."
  },
  entangle: {
    key: "entangle",
    labelKey: "RIFTS.Maneuvers.Entangle",
    category: "offensive",
    actionCost: 1,
    strikeModifier: 0,
    damageFormula: "0",
    damageMultiplier: 1,
    canKnockdown: false,
    canKnockback: false,
    knockbackValue: 0,
    impactType: "",
    isReactive: false,
    requiresTarget: true,
    requiresHit: true,
    minLevel: 1,
    specialRules: "",
    tags: [],
    grantable: true,
    description: "Entangle attempt.",
    notes: "No immobilization engine yet; resolve manually from chat outcome."
  },
  pullPunch: {
    key: "pullPunch",
    labelKey: "RIFTS.Maneuvers.PullPunch",
    category: "offensive",
    actionCost: 1,
    strikeModifier: 0,
    damageFormula: "1d4",
    damageMultiplier: 1,
    canKnockdown: false,
    canKnockback: false,
    knockbackValue: 0,
    impactType: "",
    isReactive: false,
    requiresTarget: true,
    requiresHit: true,
    minLevel: 1,
    specialRules: "Controlled/non-lethal intent.",
    tags: ["non-lethal"],
    grantable: true,
    description: "Controlled/non-lethal strike intent.",
    notes: "Damage control is placeholder; apply final non-lethal intent manually as needed."
  },
  rollWithPunch: {
    key: "rollWithPunch",
    labelKey: "RIFTS.Maneuvers.RollWithPunch",
    category: "defensive",
    actionCost: 0,
    strikeModifier: 0,
    damageFormula: "0",
    damageMultiplier: 1,
    canKnockdown: false,
    canKnockback: false,
    knockbackValue: 0,
    impactType: "",
    isReactive: true,
    requiresTarget: false,
    requiresHit: false,
    minLevel: 1,
    specialRules: "Reduce incoming impact severity.",
    tags: ["reactive"],
    grantable: true,
    description: "Reactive impact mitigation.",
    notes: "Damage reduction is placeholder; treat impact as reduced (recommended: half)."
  }
};

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeName(value) {
  return normalizeText(value).toLowerCase();
}

function localize(key, fallback = "") {
  if (!key) return fallback;
  if (!game?.i18n) return key;
  const localized = game.i18n.localize(key);
  return localized || fallback || key;
}

function parseManeuverPackage(rawList) {
  let parsed = rawList;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch (_error) {
      parsed = [];
    }
  }

  if (!Array.isArray(parsed)) return [];
  return parsed;
}

function getDefinitionByKey(key) {
  if (!key) return null;
  return SPECIAL_MANEUVER_DEFINITIONS[key] ?? null;
}

function normalizeTags(rawTags) {
  let values = rawTags;
  if (typeof values === "string") {
    const trimmed = values.trim();
    if (!trimmed) return [];

    try {
      const parsed = JSON.parse(trimmed);
      values = Array.isArray(parsed) ? parsed : [trimmed];
    } catch (_error) {
      values = trimmed.split(/[;,]/).map((entry) => entry.trim());
    }
  }

  if (!Array.isArray(values)) return [];

  const seen = new Set();
  const tags = [];
  for (const entry of values) {
    const tag = normalizeText(entry);
    const key = normalizeName(tag);
    if (!tag || !key || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }

  return tags;
}

function hasTrackedTarget(actor) {
  if (!actor) return false;

  const current = getTargetFromUI();
  if (current?.actor) return true;

  const lastTokenId = normalizeText(actor.system?.combat?.lastTargetTokenId);
  const lastActorId = normalizeText(actor.system?.combat?.lastTargetId);
  if (lastTokenId || lastActorId) return true;

  return false;
}

function dedupeBySourceAndKey(entries = []) {
  const out = [];
  const seen = new Set();

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const dedupeKey = [
      normalizeName(entry.sourceType),
      normalizeText(entry.sourceId),
      normalizeName(entry.key || entry.name)
    ].join("::");

    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(entry);
  }

  return out;
}

function isGrantedAbilityManeuver(rawGranted) {
  if (!rawGranted || typeof rawGranted !== "object") return false;

  const grantedType = normalizeName(rawGranted.type);
  if (["specialmaneuver", "maneuver", "hthmaneuver", "combatmaneuver"].includes(grantedType)) return true;

  const grantedData = rawGranted.data;
  if (!grantedData || typeof grantedData !== "object") return false;

  const itemType = normalizeName(
    grantedData.itemType
    ?? grantedData.documentType
    ?? grantedData.documentName
    ?? grantedData.type
  );

  if (itemType === "specialmaneuver") return true;
  if (grantedData.maneuver && typeof grantedData.maneuver === "object") return true;
  if (grantedData.specialManeuver && typeof grantedData.specialManeuver === "object") return true;

  return false;
}

function normalizeGrantedAbilityManeuverEntry(rawGranted) {
  if (!isGrantedAbilityManeuver(rawGranted)) return null;

  const grantedData = rawGranted?.data && typeof rawGranted.data === "object"
    ? rawGranted.data
    : {};

  const maneuverPayload = grantedData.maneuver
    ?? grantedData.specialManeuver
    ?? grantedData;

  const normalized = normalizeSpecialManeuverEntry({
    ...maneuverPayload,
    name: maneuverPayload?.name ?? rawGranted.name,
    key: maneuverPayload?.key ?? rawGranted.key,
    notes: maneuverPayload?.notes ?? rawGranted.notes,
    sourceType: maneuverPayload?.sourceType ?? rawGranted.sourceType,
    sourceId: maneuverPayload?.sourceId ?? rawGranted.sourceId,
    sourceName: maneuverPayload?.sourceName ?? rawGranted.sourceName
  });

  if (!normalized.key || !normalized.name) return null;

  return {
    ...normalized,
    sourceType: normalizeText(normalized.sourceType || rawGranted.sourceType || "granted"),
    sourceId: normalizeText(normalized.sourceId || rawGranted.sourceId),
    sourceName: normalizeText(normalized.sourceName || rawGranted.sourceName),
    grantedType: normalizeText(rawGranted.type || "maneuver")
  };
}

function getActorLevel(actor) {
  return Math.max(1, Math.floor(num(actor?.system?.derived?.level, num(actor?.system?.details?.level, 1))));
}

function isManeuverDuplicate(actor, entry, sourceType = "", sourceId = "") {
  const key = normalizeSpecialManeuverKey(entry.key);
  const name = normalizeName(entry.name);
  const normalizedSourceType = normalizeName(sourceType);
  const normalizedSourceId = normalizeText(sourceId);

  return getOwnedSpecialManeuverItems(actor).find((item) => {
    const itemKey = normalizeSpecialManeuverKey(item.system?.key ?? item.name);
    const itemName = normalizeName(item.name);
    const itemSourceType = normalizeName(item.system?.sourceType);
    const itemSourceId = normalizeText(item.system?.sourceId);

    if (key && itemKey === key) {
      if (normalizedSourceId && itemSourceId === normalizedSourceId && itemSourceType === normalizedSourceType) return true;
      if (!normalizedSourceId) return true;
    }

    if (name && itemName === name) {
      if (normalizedSourceId && itemSourceId === normalizedSourceId && itemSourceType === normalizedSourceType) return true;
      if (!normalizedSourceId) return true;
    }

    return false;
  }) ?? null;
}

export function normalizeSpecialManeuverKey(value) {
  const normalized = normalizeName(value);
  if (["disarm"].includes(normalized)) return "disarm";
  if (["entangle"].includes(normalized)) return "entangle";
  if (["pullpunch", "pull-punch", "pull punch"].includes(normalized)) return "pullPunch";
  if (["rollwithpunch", "roll-with-punch", "roll with punch"].includes(normalized)) return "rollWithPunch";
  return normalizeManeuverKey(value) || normalized;
}

export function normalizeSpecialManeuverEntry(rawEntry = {}) {
  const key = normalizeSpecialManeuverKey(rawEntry.key ?? rawEntry.name ?? "");
  const base = getDefinitionByKey(key);
  const label = normalizeText(rawEntry.name) || localize(rawEntry.labelKey ?? base?.labelKey, key);

  return {
    key,
    name: label,
    category: normalizeText(rawEntry.category || base?.category || "offensive"),
    description: normalizeText(rawEntry.description || base?.description || ""),
    actionCost: Math.max(0, Math.floor(num(rawEntry.actionCost, num(base?.actionCost, 1)))),
    strikeModifier: num(rawEntry.strikeModifier, num(base?.strikeModifier, 0)),
    damageFormula: normalizeText(rawEntry.damageFormula || base?.damageFormula || "0") || "0",
    damageMultiplier: Math.max(1, Math.floor(num(rawEntry.damageMultiplier, num(base?.damageMultiplier, 1)))),
    canKnockdown: rawEntry.canKnockdown === true || base?.canKnockdown === true,
    canKnockback: rawEntry.canKnockback === true || base?.canKnockback === true,
    knockbackValue: Math.max(0, Math.floor(num(rawEntry.knockbackValue, num(base?.knockbackValue, 0)))),
    impactType: normalizeText(rawEntry.impactType || base?.impactType || "").toLowerCase(),
    isReactive: rawEntry.isReactive === true || base?.isReactive === true,
    requiresTarget: rawEntry.requiresTarget === true || base?.requiresTarget === true,
    requiresHit: rawEntry.requiresHit !== undefined
      ? rawEntry.requiresHit === true
      : (base?.requiresHit !== false),
    minLevel: Math.max(1, Math.floor(num(rawEntry.minLevel, num(base?.minLevel, 1)))),
    sourceType: normalizeText(rawEntry.sourceType),
    sourceId: normalizeText(rawEntry.sourceId),
    sourceName: normalizeText(rawEntry.sourceName),
    notes: normalizeText(rawEntry.notes || base?.notes || ""),
    specialRules: normalizeText(rawEntry.specialRules || base?.specialRules || ""),
    tags: normalizeTags(rawEntry.tags ?? base?.tags ?? []),
    grantable: rawEntry.grantable !== undefined ? rawEntry.grantable === true : (base?.grantable !== false),
    labelKey: normalizeText(rawEntry.labelKey || base?.labelKey)
  };
}

export function normalizeManeuverPackageEntries(rawList = []) {
  return parseManeuverPackage(rawList)
    .map((entry) => normalizeSpecialManeuverEntry(entry))
    .filter((entry) => entry.key.length > 0 && entry.name.length > 0);
}

export function getDefaultSpecialManeuverDefinitions() {
  return Object.values(SPECIAL_MANEUVER_DEFINITIONS).map((entry) => normalizeSpecialManeuverEntry(entry));
}

export function getOwnedSpecialManeuverItems(actor) {
  return actor?.items
    ?.filter((item) => item.type === "specialManeuver")
    ?.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")))
    ?? [];
}

export function getAvailableManeuversFromActiveStyle(actor) {
  const activeStyle = actor?.getActiveHandToHandItem?.() ?? null;
  const level = getActorLevel(actor);

  if (!activeStyle) {
    return {
      activeStyle: null,
      activeHthStyleName: "",
      level,
      availableHthManeuversFromStyle: [],
      ownedHthManeuvers: getOwnedSpecialManeuverItems(actor)
    };
  }

  const sourceType = "handToHand";
  const sourceId = activeStyle.id;
  const sourceName = activeStyle.name;
  const entries = normalizeManeuverPackageEntries(activeStyle.system?.maneuverPackage?.grantedManeuvers ?? []);
  const available = entries
    .map((entry, index) => ({
      ...entry,
      packageIndex: index,
      sourceType,
      sourceId,
      sourceName,
      grantOrigin: "handToHand",
      unlocked: level >= entry.minLevel,
      duplicate: isManeuverDuplicate(actor, entry, sourceType, sourceId)
    }))
    .filter((entry) => entry.unlocked);

  return {
    activeStyle,
    activeHthStyleName: activeStyle.name,
    level,
    availableHthManeuversFromStyle: available,
    ownedHthManeuvers: getOwnedSpecialManeuverItems(actor)
  };
}

function getGrantedManeuversFromEffects(actor, explicitGrantedAbilities = null) {
  const grantedAbilities = Array.isArray(explicitGrantedAbilities)
    ? explicitGrantedAbilities
    : (Array.isArray(actor?.system?.derived?.grantedAbilities) ? actor.system.derived.grantedAbilities : []);

  const parsed = grantedAbilities
    .map((entry) => normalizeGrantedAbilityManeuverEntry(entry))
    .filter((entry) => entry !== null)
    .map((entry) => ({
      ...entry,
      duplicate: isManeuverDuplicate(actor, entry, entry.sourceType, entry.sourceId),
      grantOrigin: "framework"
    }));

  return dedupeBySourceAndKey(parsed);
}

export function getAvailableCombatManeuverContext(actor, options = {}) {
  const ownedItems = getOwnedSpecialManeuverItems(actor);
  const ownedEntries = ownedItems.map((item) => {
    const normalized = normalizeSpecialManeuverEntry({
      ...item.system,
      name: item.name,
      sourceType: item.system?.sourceType,
      sourceId: item.system?.sourceId,
      sourceName: item.system?.sourceName
    });

    return {
      ...normalized,
      itemId: item.id,
      sourceType: normalizeText(normalized.sourceType || "item"),
      sourceId: normalizeText(normalized.sourceId || item.id),
      sourceName: normalizeText(normalized.sourceName || item.name),
      grantOrigin: "owned",
      isOwned: true,
      isGranted: false,
      duplicate: null
    };
  });

  const hthContext = getAvailableManeuversFromActiveStyle(actor);
  const hthGranted = (hthContext.availableHthManeuversFromStyle ?? []).map((entry) => ({
    ...normalizeSpecialManeuverEntry(entry),
    sourceType: normalizeText(entry.sourceType || "handToHand"),
    sourceId: normalizeText(entry.sourceId),
    sourceName: normalizeText(entry.sourceName || hthContext.activeHthStyleName),
    packageIndex: Number(entry.packageIndex ?? -1),
    grantOrigin: "handToHand",
    isOwned: Boolean(entry.duplicate),
    isGranted: true,
    duplicate: entry.duplicate ?? null
  }));

  const frameworkGranted = getGrantedManeuversFromEffects(actor, options.grantedAbilities).map((entry) => ({
    ...entry,
    sourceType: normalizeText(entry.sourceType || "granted"),
    sourceId: normalizeText(entry.sourceId),
    sourceName: normalizeText(entry.sourceName),
    grantOrigin: "framework",
    isOwned: Boolean(entry.duplicate),
    isGranted: true
  }));

  const availableMap = new Map();
  const addAvailable = (entry) => {
    const key = normalizeSpecialManeuverKey(entry?.key || entry?.name);
    if (!key) return;

    const existing = availableMap.get(key);
    const next = { ...entry, key };

    if (!existing) {
      availableMap.set(key, next);
      return;
    }

    // Prefer owned definitions over granted definitions for execution.
    if (existing.isOwned !== true && next.isOwned === true) {
      availableMap.set(key, next);
    }
  };

  ownedEntries.forEach(addAvailable);
  hthGranted.forEach(addAvailable);
  frameworkGranted.forEach(addAvailable);

  const availableManeuvers = Array.from(availableMap.values())
    .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));

  const availableManeuverKeys = availableManeuvers.map((entry) => normalizeSpecialManeuverKey(entry.key));

  return {
    activeStyle: hthContext.activeStyle ?? null,
    activeHthStyleName: hthContext.activeHthStyleName ?? "",
    level: hthContext.level ?? getActorLevel(actor),
    ownedManeuverItems: ownedItems,
    ownedManeuverEntries: ownedEntries,
    hthGrantedManeuvers: hthGranted,
    frameworkGrantedManeuvers: frameworkGranted,
    grantedManeuvers: [...hthGranted, ...frameworkGranted],
    availableManeuvers,
    availableManeuverKeys,
    availableManeuverByKey: Object.fromEntries(availableManeuvers.map((entry) => [entry.key, entry]))
  };
}

function resolveManeuverFromInput(actor, maneuverOrId, options = {}) {
  if (!actor) return null;

  if (typeof maneuverOrId === "string") {
    const asItem = actor.items?.get?.(maneuverOrId) ?? null;
    if (asItem?.type === "specialManeuver") {
      return {
        maneuver: normalizeSpecialManeuverEntry({ ...asItem.system, name: asItem.name }),
        item: asItem,
        source: "item"
      };
    }

    const byKey = normalizeSpecialManeuverKey(maneuverOrId);
    if (byKey) {
      const context = getAvailableCombatManeuverContext(actor, options);
      const entry = context.availableManeuvers.find((maneuver) => normalizeSpecialManeuverKey(maneuver.key) === byKey) ?? null;
      if (entry) {
        return {
          maneuver: normalizeSpecialManeuverEntry(entry),
          item: entry.itemId ? actor.items.get(entry.itemId) : null,
          source: entry.isOwned ? "item" : "granted"
        };
      }
    }

    return null;
  }

  if (maneuverOrId?.type === "specialManeuver") {
    return {
      maneuver: normalizeSpecialManeuverEntry({ ...maneuverOrId.system, name: maneuverOrId.name }),
      item: maneuverOrId,
      source: "item"
    };
  }

  if (maneuverOrId && typeof maneuverOrId === "object") {
    const normalized = normalizeSpecialManeuverEntry(maneuverOrId);
    if (!normalized.key && !normalized.name) return null;

    const possibleItemId = normalizeText(maneuverOrId.itemId);
    const possibleItem = possibleItemId ? actor.items.get(possibleItemId) : null;

    return {
      maneuver: normalized,
      item: possibleItem,
      source: possibleItem ? "item" : "granted"
    };
  }

  return null;
}

export async function addManeuverFromActiveStyle(actor, packageIndex) {
  const activeStyle = actor?.getActiveHandToHandItem?.() ?? null;
  if (!activeStyle) return { status: "no-hth" };

  const level = getActorLevel(actor);
  const entries = normalizeManeuverPackageEntries(activeStyle.system?.maneuverPackage?.grantedManeuvers ?? []);
  const entry = entries[Number(packageIndex)] ?? null;
  if (!entry) return { status: "invalid-index" };
  if (level < entry.minLevel) return { status: "locked" };

  const sourceType = "handToHand";
  const sourceId = activeStyle.id;
  const duplicate = isManeuverDuplicate(actor, entry, sourceType, sourceId);
  if (duplicate) return { status: "duplicate", duplicate };

  const itemData = {
    name: entry.name,
    type: "specialManeuver",
    system: {
      key: entry.key,
      category: entry.category,
      description: entry.description,
      actionCost: entry.actionCost,
      strikeModifier: entry.strikeModifier,
      damageFormula: entry.damageFormula,
      damageMultiplier: entry.damageMultiplier,
      isReactive: entry.isReactive,
      requiresTarget: entry.requiresTarget,
      requiresHit: entry.requiresHit,
      minLevel: entry.minLevel,
      sourceType,
      sourceId,
      sourceName: activeStyle.name,
      specialRules: entry.specialRules,
      tags: foundry.utils.deepClone(entry.tags ?? []),
      grantable: entry.grantable !== false,
      notes: entry.notes,
      canKnockdown: entry.canKnockdown === true,
      canKnockback: entry.canKnockback === true,
      knockbackValue: Math.max(0, Math.floor(num(entry.knockbackValue, 0))),
      impactType: normalizeText(entry.impactType).toLowerCase()
    }
  };

  const created = await actor.createEmbeddedDocuments("Item", [itemData]);
  return { status: "created", created: created[0] ?? null };
}

function buildManeuverChatContent(actor, maneuver, isReactive = false) {
  const typeLabel = isReactive
    ? game.i18n.localize("RIFTS.Maneuvers.ReactiveManeuver")
    : game.i18n.localize("RIFTS.Maneuvers.OffensiveManeuver");

  const sourceText = normalizeText(maneuver.sourceName)
    || normalizeText(maneuver.sourceType)
    || game.i18n.localize("RIFTS.Sheet.None");

  const tagsText = Array.isArray(maneuver.tags) && maneuver.tags.length > 0
    ? maneuver.tags.join(", ")
    : "-";

  return [
    `<p><strong>${game.i18n.localize("RIFTS.Maneuvers.SpecialManeuvers")}</strong></p>`,
    `<p><strong>${game.i18n.localize("RIFTS.Item.Name")}:</strong> ${maneuver.name}</p>`,
    `<p><strong>${game.i18n.localize("RIFTS.Item.Category")}:</strong> ${maneuver.category || "-"}</p>`,
    `<p><strong>${game.i18n.localize("RIFTS.Maneuvers.ActionCost")}:</strong> ${maneuver.actionCost}</p>`,
    `<p><strong>${game.i18n.localize("RIFTS.Maneuvers.StrikeModifier")}:</strong> ${maneuver.strikeModifier}</p>`,
    `<p><strong>${game.i18n.localize("RIFTS.Maneuvers.DamageMultiplier")}:</strong> x${maneuver.damageMultiplier}</p>`,
    `<p><strong>${game.i18n.localize("RIFTS.Maneuvers.ManeuverSource")}:</strong> ${sourceText}</p>`,
    `<p><strong>${game.i18n.localize("RIFTS.Maneuvers.Tags")}:</strong> ${tagsText}</p>`,
    `<p><strong>${typeLabel}</strong></p>`,
    maneuver.description ? `<p>${maneuver.description}</p>` : "",
    maneuver.specialRules ? `<p><strong>${game.i18n.localize("RIFTS.Maneuvers.SpecialRules")}:</strong> ${maneuver.specialRules}</p>` : "",
    maneuver.notes ? `<p>${maneuver.notes}</p>` : ""
  ].filter((line) => line).join("");
}

export async function useSpecialManeuver(actor, maneuverOrId, options = {}) {
  const resolved = resolveManeuverFromInput(actor, maneuverOrId, options);
  if (!actor || !resolved?.maneuver) {
    return { status: "invalid-maneuver" };
  }

  const maneuver = normalizeSpecialManeuverEntry(resolved.maneuver);

  if (maneuver.requiresTarget === true && !hasTrackedTarget(actor)) {
    ui.notifications.warn(game.i18n.localize("RIFTS.Errors.TargetNotFound"));
    return { status: "target-required", maneuver };
  }

  if (maneuver.isReactive === true) {
    const content = buildManeuverChatContent(actor, maneuver, true);
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content
    });

    await actor.update({ "system.combat.lastAdvancedAction": maneuver.key });
    return { status: "reactive", maneuver, source: resolved.source };
  }

  const specialRules = [normalizeText(maneuver.specialRules), normalizeText(maneuver.notes)]
    .filter((entry) => entry.length > 0)
    .join(" | ");

  const attackMessage = await attackWithUnarmedManeuver({
    attacker: actor,
    tokenId: options.tokenId ?? "",
    maneuverKey: maneuver.key || "punch",
    maneuverData: {
      key: maneuver.key || normalizeSpecialManeuverKey(maneuver.name),
      label: maneuver.name,
      actionCost: Math.max(1, maneuver.actionCost),
      strikeModifier: maneuver.strikeModifier,
      damageFormula: maneuver.damageFormula,
      damageMultiplier: Math.max(1, Math.floor(num(maneuver.damageMultiplier, 1))),
      requiresHit: maneuver.requiresHit === true,
      canKnockdown: maneuver.canKnockdown === true,
      canKnockback: maneuver.canKnockback === true,
      knockbackValue: Math.max(0, Math.floor(num(maneuver.knockbackValue, 0))),
      impactType: normalizeText(maneuver.impactType).toLowerCase(),
      specialRules,
      sourceType: normalizeText(maneuver.sourceType),
      sourceId: normalizeText(maneuver.sourceId),
      sourceName: normalizeText(maneuver.sourceName),
      isReactive: false
    },
    advancedActionLabelOverride: game.i18n.localize("RIFTS.Maneuvers.UseManeuver")
  });

  const key = normalizeSpecialManeuverKey(maneuver.key || maneuver.name);
  let noteKey = "";
  if (key === "disarm") noteKey = "RIFTS.Maneuvers.DisarmNote";
  if (key === "entangle") noteKey = "RIFTS.Maneuvers.EntangleNote";
  if (key === "pullPunch") noteKey = "RIFTS.Maneuvers.PullPunchNote";

  if (noteKey) {
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<p>${game.i18n.localize(noteKey)}</p>`
    });
  }

  return { status: attackMessage ? "used" : "failed", maneuver, message: attackMessage, source: resolved.source };
}

export function actorHasSpecialManeuver(actor, key) {
  const normalized = normalizeSpecialManeuverKey(key);
  if (!actor || !normalized) return false;

  const context = getAvailableCombatManeuverContext(actor);
  return context.availableManeuverKeys.includes(normalized);
}

export function getSpecialManeuverDefinitions() {
  return SPECIAL_MANEUVER_DEFINITIONS;
}