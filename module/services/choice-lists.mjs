const SYSTEM_ID = "rifts-megaverse";

function text(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return text(value).toLowerCase();
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

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = lower(value);
  if (["true", "yes", "y", "1", "on"].includes(normalized)) return true;
  if (["false", "no", "n", "0", "off"].includes(normalized)) return false;
  return fallback;
}

function parseJsonMaybe(value) {
  const raw = text(value);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

function normalizeInlineEntry(entry) {
  if (typeof entry === "string" || typeof entry === "number") {
    const name = text(entry);
    return name ? { name } : null;
  }

  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    return clone(entry);
  }

  return null;
}

function normalizeInlineItems(value) {
  const source = asArray(value);
  return source
    .map((entry) => normalizeInlineEntry(entry))
    .filter((entry) => entry && Object.keys(entry).length > 0);
}

function parseLooseInlineItems(rawText) {
  const raw = text(rawText);
  if (!raw) return [];

  return raw
    .split(/[\r\n,;]+/)
    .map((entry) => text(entry).replace(/^['\"]+|['\"]+$/g, ""))
    .filter((entry) => entry.length > 0)
    .map((entry) => ({ name: entry }));
}

function normalizeMode(value) {
  const mode = lower(value);
  return mode === "list" ? "list" : "inline";
}

export function normalizeChoicePoolSource(value) {
  if (Array.isArray(value)) {
    return {
      mode: "inline",
      items: normalizeInlineItems(value)
    };
  }

  if (typeof value === "string") {
    const parsed = parseJsonMaybe(value);
    if (parsed !== null) return normalizeChoicePoolSource(parsed);

    return {
      mode: "inline",
      items: parseLooseInlineItems(value)
    };
  }

  if (!value || typeof value !== "object") {
    return {
      mode: "inline",
      items: []
    };
  }

  const source = asObject(value);
  const mode = normalizeMode(source.mode);

  if (mode === "list" || (text(source.listId) && !Array.isArray(source.items) && !Array.isArray(source.entries))) {
    return {
      mode: "list",
      listId: text(source.listId)
    };
  }

  if (mode === "inline") {
    const items = Array.isArray(source.items)
      ? source.items
      : (Array.isArray(source.entries) ? source.entries : []);

    if (items.length > 0) {
      return {
        mode: "inline",
        items: normalizeInlineItems(items)
      };
    }
  }

  if (text(source.listId)) {
    return {
      mode: "list",
      listId: text(source.listId)
    };
  }

  return {
    mode: "inline",
    items: normalizeInlineItems([source])
  };
}

export function poolSourceHasEntries(value) {
  const normalized = normalizeChoicePoolSource(value);
  if (normalized.mode === "list") return text(normalized.listId).length > 0;
  return asArray(normalized.items).length > 0;
}

export function poolSourceToDisplayValue(value) {
  const normalized = normalizeChoicePoolSource(value);
  if (normalized.mode === "list") return { mode: "list", listId: normalized.listId };
  return normalized.items;
}

export function parsePoolSourceInput(raw, { poolKey = "" } = {}) {
  const trimmed = text(raw);
  if (!trimmed) return { mode: "inline", items: [] };

  const parsed = parseJsonMaybe(trimmed);
  if (parsed !== null) {
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && poolKey && Object.prototype.hasOwnProperty.call(parsed, poolKey)) {
      return normalizeChoicePoolSource(parsed[poolKey]);
    }

    return normalizeChoicePoolSource(parsed);
  }

  return {
    mode: "inline",
    items: parseLooseInlineItems(trimmed)
  };
}

function getCandidateValue(document, key) {
  const normalizedKey = text(key);
  if (!normalizedKey) return undefined;

  if (normalizedKey === "entryType") return document?.type;
  if (normalizedKey.includes(".")) {
    const direct = foundry.utils.getProperty(document, normalizedKey);
    if (direct !== undefined) return direct;
    return foundry.utils.getProperty(document?.system, normalizedKey);
  }

  if (document && Object.prototype.hasOwnProperty.call(document, normalizedKey)) {
    return document[normalizedKey];
  }

  const fromSystem = foundry.utils.getProperty(document?.system, normalizedKey);
  if (fromSystem !== undefined) return fromSystem;

  return undefined;
}

function toComparable(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  const raw = text(value);
  if (!raw) return "";

  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric;

  if (["true", "false"].includes(lower(raw))) return parseBoolean(raw, false);
  return lower(raw);
}

function valuesEqual(left, right) {
  return toComparable(left) === toComparable(right);
}

function matchesFilterCriterion(candidate, expected) {
  if (Array.isArray(expected)) {
    if (Array.isArray(candidate)) {
      return candidate.some((entry) => expected.some((allowed) => valuesEqual(entry, allowed)));
    }
    return expected.some((allowed) => valuesEqual(candidate, allowed));
  }

  if (Array.isArray(candidate)) {
    return candidate.some((entry) => valuesEqual(entry, expected));
  }

  return valuesEqual(candidate, expected);
}

function matchesFilters(document, filters) {
  const source = asObject(filters);

  for (const [key, expected] of Object.entries(source)) {
    const candidate = getCandidateValue(document, key);
    if (candidate === undefined || candidate === null) return false;
    if (!matchesFilterCriterion(candidate, expected)) return false;
  }

  return true;
}

function normalizeResolvedEntry(entry, index, { sourceLabel = "", entryType = "", prefix = "pool" } = {}) {
  const item = normalizeInlineEntry(entry);
  if (!item) return null;

  const payload = asObject(item.payload);
  const name = text(item.name || payload.name);
  if (!name) return null;

  return {
    entryId: `${prefix}:${index}`,
    name,
    category: text(item.category || payload.category || item.entryType || entryType),
    detail: text(item.detail || item.description || item.notes || payload.detail || payload.description),
    source: text(item.source || sourceLabel),
    payload: {
      ...clone(item),
      ...clone(payload),
      entryType: text(item.entryType || payload.entryType || entryType)
    }
  };
}

function createEntryFromDocument(item, index, sourceLabel = "") {
  const payload = {
    itemId: item.id,
    itemType: item.type
  };

  if (item.type === "power") {
    payload.powerType = text(item.system?.powerType);
    payload.subType = text(item.system?.subType);
    payload.costType = text(item.system?.costType);
    payload.cost = Number(item.system?.cost ?? 0) || 0;
    payload.range = text(item.system?.range);
    payload.duration = text(item.system?.duration);
    payload.activationTime = text(item.system?.activationTime);
    payload.saveType = text(item.system?.saveType);
    payload.damage = text(item.system?.damage);
    payload.description = text(item.system?.description);
    payload.notes = text(item.system?.notes);
  }

  if (item.type === "skill") {
    payload.base = Number(item.system?.base ?? 0) || 0;
    payload.perLevel = Number(item.system?.perLevel ?? 0) || 0;
    payload.modifier = Number(item.system?.modifier ?? 0) || 0;
    payload.category = text(item.system?.category);
    payload.notes = text(item.system?.notes);
  }

  if (item.type === "specialManeuver") {
    payload.maneuver = {
      ...clone(item.system ?? {}),
      name: item.name
    };
  }

  return {
    entryId: `filter:${index}`,
    name: text(item.name),
    category: text(item.system?.category || item.system?.subType || item.type),
    detail: text(item.system?.description || item.system?.notes),
    source: sourceLabel,
    payload
  };
}

function normalizeChoiceListEntries(value) {
  return asArray(value)
    .map((entry) => {
      if (typeof entry === "string") {
        const uuid = text(entry);
        return uuid ? { uuid } : null;
      }

      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const uuid = text(entry.uuid || entry.itemUuid || entry.id);
        if (!uuid) return null;
        return {
          uuid,
          name: text(entry.name),
          itemType: text(entry.itemType || entry.type)
        };
      }

      return null;
    })
    .filter((entry) => Boolean(entry));
}

function resolveItemFromUuidSync(uuid) {
  const normalizedUuid = text(uuid);
  if (!normalizedUuid) return null;

  if (normalizedUuid.startsWith("Item.")) {
    const itemId = normalizedUuid.split(".")[1];
    const worldItem = itemId ? game?.items?.get?.(itemId) : null;
    if (worldItem) return worldItem;
  }

  if (typeof fromUuidSync === "function") {
    try {
      const doc = fromUuidSync(normalizedUuid);
      if (doc?.documentName === "Item") return doc;
    } catch (_error) {
      // Fall through to unresolved state.
    }
  }

  return null;
}

function createEntryFromReference(reference, index, { sourceLabel = "", entryType = "", prefix = "entry" } = {}) {
  const uuid = text(reference?.uuid);
  if (!uuid) return null;

  const expectedEntryType = lower(entryType);
  const resolvedItem = resolveItemFromUuidSync(uuid);

  if (resolvedItem) {
    if (expectedEntryType && lower(resolvedItem.type) !== expectedEntryType) return null;

    const resolved = createEntryFromDocument(resolvedItem, index, sourceLabel);
    resolved.entryId = `${prefix}:${index}`;
    resolved.payload = {
      ...asObject(resolved.payload),
      itemUuid: uuid,
      itemType: resolvedItem.type
    };
    return resolved;
  }

  const fallbackType = text(reference?.itemType);
  if (expectedEntryType && fallbackType && lower(fallbackType) !== expectedEntryType) return null;

  const fallbackName = text(reference?.name);
  if (!fallbackName) return null;

  return {
    entryId: `${prefix}:${index}`,
    name: fallbackName,
    category: text(fallbackType || entryType),
    detail: "",
    source: sourceLabel,
    payload: {
      itemUuid: uuid,
      itemType: text(fallbackType || entryType),
      name: fallbackName
    }
  };
}

function dedupeResolvedEntries(entries) {
  const seen = new Set();
  const out = [];

  for (const entry of asArray(entries)) {
    const key = lower(
      entry?.payload?.itemUuid
      || entry?.payload?.itemId
      || `${text(entry?.name)}|${text(entry?.category)}`
    );

    if (!key) {
      out.push(entry);
      continue;
    }

    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }

  return out;
}

function normalizeChoiceListDocument(choiceListItem) {
  const system = asObject(choiceListItem?.system);
  return {
    id: choiceListItem?.id || "",
    name: text(choiceListItem?.name),
    listId: text(system.listId),
    label: text(system.label || choiceListItem?.name),
    entryType: text(system.entryType),
    sourceMode: lower(system.sourceMode) === "filter" ? "filter" : "static",
    entries: normalizeChoiceListEntries(system.entries),
    staticEntries: normalizeInlineItems(system.staticEntries),
    filters: asObject(system.filters),
    notes: text(system.notes)
  };
}
function getChoiceListById(listId) {
  const target = lower(listId);
  if (!target) return null;

  const world = game?.items?.contents ?? [];
  const match = world.find((item) => {
    if (item.type !== "choiceList") return false;
    const systemListId = lower(item.system?.listId);
    if (systemListId && systemListId === target) return true;
    return lower(item.name) === target;
  });

  return match ?? null;
}

export function resolveChoicePool(poolSource, options = {}) {
  const normalized = normalizeChoicePoolSource(poolSource);
  const sourceLabel = text(options.sourceLabel || options.sourceName);
  const fallbackEntryType = text(options.entryType || options.fallbackEntryType);

  if (normalized.mode === "inline") {
    const entries = asArray(normalized.items)
      .map((entry, index) => normalizeResolvedEntry(entry, index, {
        sourceLabel,
        entryType: fallbackEntryType,
        prefix: "inline"
      }))
      .filter((entry) => Boolean(entry));

    return {
      ok: true,
      mode: "inline",
      listId: "",
      sourceLabel,
      entries,
      error: ""
    };
  }

  const listId = text(normalized.listId);
  if (!listId) {
    return {
      ok: false,
      mode: "list",
      listId: "",
      sourceLabel,
      entries: [],
      error: game?.i18n?.localize?.("RIFTS.ChoiceList.MissingChoiceList") || "Missing choice list"
    };
  }

  const listItem = getChoiceListById(listId);
  if (!listItem) {
    const message = `${SYSTEM_ID} | Missing choiceList '${listId}'.`;
    console.warn(message);
    return {
      ok: false,
      mode: "list",
      listId,
      sourceLabel,
      entries: [],
      error: game?.i18n?.localize?.("RIFTS.ChoiceList.MissingChoiceList") || "Missing choice list"
    };
  }

  const choiceList = normalizeChoiceListDocument(listItem);
  const listSourceLabel = choiceList.label || listItem.name || sourceLabel;

  if (choiceList.sourceMode === "static") {
    const referenceEntries = asArray(choiceList.entries)
      .map((entry, index) => createEntryFromReference(entry, index, {
        sourceLabel: listSourceLabel,
        entryType: choiceList.entryType || fallbackEntryType,
        prefix: `listref:${choiceList.listId || listItem.id}`
      }))
      .filter((entry) => Boolean(entry));

    const legacyStaticEntries = asArray(choiceList.staticEntries)
      .map((entry, index) => normalizeResolvedEntry(entry, index, {
        sourceLabel: listSourceLabel,
        entryType: choiceList.entryType || fallbackEntryType,
        prefix: `list:${choiceList.listId || listItem.id}`
      }))
      .filter((entry) => Boolean(entry));

    const entries = dedupeResolvedEntries([...referenceEntries, ...legacyStaticEntries]);

    return {
      ok: true,
      mode: "list",
      listId: choiceList.listId || listItem.id,
      sourceLabel: listSourceLabel,
      entries,
      error: ""
    };
  }

  const candidateItems = (game?.items?.contents ?? []).filter((item) => {
    const expectedEntryType = lower(choiceList.entryType || fallbackEntryType);
    if (!expectedEntryType) return true;
    return lower(item.type) === expectedEntryType;
  });

  const filteredItems = candidateItems.filter((item) => matchesFilters(item, choiceList.filters));
  const entries = filteredItems.map((item, index) => createEntryFromDocument(item, index, listSourceLabel));

  return {
    ok: true,
    mode: "list",
    listId: choiceList.listId || listItem.id,
    sourceLabel: listSourceLabel,
    entries,
    error: ""
  };
}




