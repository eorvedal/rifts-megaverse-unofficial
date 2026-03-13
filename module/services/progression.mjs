function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parsePositiveInteger(value, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i > 0 ? i : fallback;
}

function getClassItems(actor) {
  if (!actor?.items) return [];
  return actor.items.filter((item) => item.type === "occ" || item.type === "rcc");
}

export function getActiveClass(actor) {
  const classItems = getClassItems(actor);
  if (classItems.length === 0) return null;

  const active = classItems.find((item) => item.system?.active === true);
  if (active) return active;

  const primaryOcc = classItems.find((item) => item.type === "occ" && item.system?.isPrimaryClass === true);
  if (primaryOcc) return primaryOcc;

  const primaryAny = classItems.find((item) => item.system?.isPrimaryClass === true);
  if (primaryAny) return primaryAny;

  const firstOcc = classItems.find((item) => item.type === "occ");
  if (firstOcc) return firstOcc;

  return classItems[0] ?? null;
}

function parseXPTableInput(rawValue) {
  let parsed = rawValue;

  if (typeof parsed === "string") {
    const trimmed = parsed.trim();
    if (!trimmed) return [];

    try {
      parsed = JSON.parse(trimmed);
    } catch (_error) {
      // Allow compact manual entry: "0, 2200, 4400"
      return trimmed
        .split(/[,\n;]/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    }
  }

  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") return parsed;
  return [];
}

function parseThresholdValue(rawValue) {
  if (rawValue === undefined || rawValue === null) return null;
  if (typeof rawValue === "string" && rawValue.trim() === "") return null;

  const n = Number(rawValue);
  if (!Number.isFinite(n)) return null;

  return Math.max(0, Math.floor(n));
}

function buildThresholdsFromLegacyArray(entries) {
  const thresholds = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;

    const level = parsePositiveInteger(entry.level, index + 1);
    const xp = parseThresholdValue(entry.xp);
    if (xp === null) continue;

    thresholds[level - 1] = xp;
  }

  return thresholds;
}

function buildThresholdsFromLegacyObject(obj) {
  const thresholds = [];

  for (const [levelKey, xpValue] of Object.entries(obj)) {
    const level = parsePositiveInteger(levelKey, null);
    if (!level) continue;

    const xp = parseThresholdValue(xpValue);
    if (xp === null) continue;

    thresholds[level - 1] = xp;
  }

  return thresholds;
}

function compactInputThresholds(rawThresholds) {
  const compact = [];
  let ignoredNonNumericCount = 0;
  let ignoredEmptyCount = 0;

  for (const raw of rawThresholds) {
    if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
      ignoredEmptyCount += 1;
      continue;
    }

    const value = parseThresholdValue(raw);
    if (value === null) {
      ignoredNonNumericCount += 1;
      continue;
    }

    compact.push(value);
  }

  if (compact.length === 0) compact.push(0);
  compact[0] = 0;

  return {
    xpTable: compact,
    validEntryCount: compact.length,
    ignoredNonNumericCount,
    ignoredEmptyCount
  };
}

function compactLegacyThresholds(rawThresholds) {
  const compact = [];
  const maxIndex = Math.max(0, rawThresholds.length - 1);

  for (let index = 0; index <= maxIndex; index += 1) {
    const raw = rawThresholds[index];
    const previous = index > 0 ? compact[index - 1] : 0;
    const parsed = parseThresholdValue(raw);
    const value = parsed === null ? previous : parsed;
    compact.push(value);
  }

  if (compact.length === 0) compact.push(0);
  compact[0] = 0;

  return {
    xpTable: compact,
    validEntryCount: compact.length,
    ignoredNonNumericCount: 0,
    ignoredEmptyCount: 0
  };
}

export function isXPTableAscending(xpTable) {
  if (!Array.isArray(xpTable)) return false;
  for (let index = 1; index < xpTable.length; index += 1) {
    if (num(xpTable[index], 0) < num(xpTable[index - 1], 0)) return false;
  }
  return true;
}

export function normalizeXPThresholdTable(table) {
  const parsed = parseXPTableInput(table);
  let usedLegacyFormat = false;
  let normalized;

  if (Array.isArray(parsed)) {
    const hasLegacyObjects = parsed.some((entry) => entry && typeof entry === "object" && !Array.isArray(entry));

    if (hasLegacyObjects) {
      usedLegacyFormat = true;
      normalized = compactLegacyThresholds(buildThresholdsFromLegacyArray(parsed));
    } else {
      normalized = compactInputThresholds(parsed);
    }
  } else if (parsed && typeof parsed === "object") {
    usedLegacyFormat = true;
    normalized = compactLegacyThresholds(buildThresholdsFromLegacyObject(parsed));
  } else {
    normalized = compactInputThresholds([]);
  }

  return {
    xpTable: normalized.xpTable,
    validEntryCount: normalized.validEntryCount,
    ignoredNonNumericCount: normalized.ignoredNonNumericCount,
    ignoredEmptyCount: normalized.ignoredEmptyCount,
    usedLegacyFormat,
    isAscending: isXPTableAscending(normalized.xpTable)
  };
}

function getMaxLevel(classItem, xpTable) {
  const configured = Math.floor(num(classItem?.system?.progression?.maxLevel, 0));
  if (configured > 0) return configured;
  return Math.max(1, xpTable.length);
}

function getClassXPFromItem(classItem) {
  return Math.max(0, Math.floor(num(classItem?.system?.xp?.value, num(classItem?.system?.experience, 0))));
}

function deriveFromClass(classItem, actor = null) {
  const useOverride = actor?.system?.debug?.useLevelOverride === true;
  const overrideLevel = Math.max(1, Math.floor(num(actor?.system?.debug?.overrideLevel, 1)));

  if (!classItem) {
    return {
      activeClass: null,
      level: useOverride ? overrideLevel : 1,
      baseLevel: 1,
      overrideLevel,
      currentXP: 0,
      nextLevelXP: null,
      progressPercent: 0,
      maxLevel: 1,
      xpTable: [0],
      currentLevelXP: 0,
      useOverride,
      usedLegacyFormat: false,
      isAscending: true
    };
  }

  const normalized = normalizeXPThresholdTable(classItem.system?.progression?.xpTable ?? []);
  const xpTable = normalized.xpTable;
  const currentXP = getClassXPFromItem(classItem);
  const maxLevel = Math.max(1, getMaxLevel(classItem, xpTable));
  const maxDerivedLevel = Math.max(1, Math.min(maxLevel, xpTable.length));

  let level = 1;
  let currentLevelXP = xpTable[0] ?? 0;
  for (let index = 0; index < maxDerivedLevel; index += 1) {
    const threshold = Math.max(0, Math.floor(num(xpTable[index], 0)));
    if (currentXP >= threshold) {
      level = index + 1;
      currentLevelXP = threshold;
    }
  }

  let nextLevelXP = null;
  if (level < maxDerivedLevel) {
    nextLevelXP = Math.max(0, Math.floor(num(xpTable[level], currentLevelXP)));
  }

  let progressPercent = 100;
  if (nextLevelXP !== null) {
    const span = Math.max(1, nextLevelXP - currentLevelXP);
    const currentProgress = Math.max(0, currentXP - currentLevelXP);
    progressPercent = Math.min(100, Math.max(0, Math.floor((currentProgress / span) * 100)));
  }

  const overrideLevelAtLevel = Math.max(1, Math.floor(num(actor?.system?.debug?.overrideLevel, level)));

  return {
    activeClass: classItem,
    level: useOverride ? overrideLevelAtLevel : level,
    baseLevel: level,
    overrideLevel: overrideLevelAtLevel,
    currentXP,
    nextLevelXP,
    progressPercent,
    maxLevel,
    xpTable,
    currentLevelXP,
    useOverride,
    usedLegacyFormat: normalized.usedLegacyFormat,
    isAscending: normalized.isAscending
  };
}

export function getClassXP(actor) {
  const classItem = getActiveClass(actor);
  return getClassXPFromItem(classItem);
}

export function getXPTable(actor) {
  const classItem = getActiveClass(actor);
  if (!classItem) return [0];
  return normalizeXPThresholdTable(classItem.system?.progression?.xpTable ?? []).xpTable;
}

export function getProgressionData(actor) {
  const classItem = getActiveClass(actor);
  return deriveFromClass(classItem, actor);
}

export function getDerivedLevel(actor) {
  return getProgressionData(actor).level;
}

export function getXPForNextLevel(actor) {
  return getProgressionData(actor).nextLevelXP;
}

export function getProgressPercent(actor) {
  return getProgressionData(actor).progressPercent;
}
