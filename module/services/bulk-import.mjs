import { isXPTableAscending, normalizeXPThresholdTable } from "./progression.mjs";
import { normalizeManeuverPackageEntries, normalizeSpecialManeuverEntry } from "./maneuvers.mjs";
const BOOLEAN_TRUE = new Set(["true", "t", "yes", "y", "1", "on"]);
const BOOLEAN_FALSE = new Set(["false", "f", "no", "n", "0", "off"]);

const IMPORT_FORMATS = [
  { id: "csv", labelKey: "RIFTS.Importer.CSV" },
  { id: "json", labelKey: "RIFTS.Importer.JSON" }
];

const DUPLICATE_MODES = [
  { id: "create", labelKey: "RIFTS.Importer.CreateAlways" },
  { id: "skip", labelKey: "RIFTS.Importer.SkipDuplicates" },
  { id: "update", labelKey: "RIFTS.Importer.UpdateExisting" }
];

const IMPORT_DESTINATIONS = [
  { id: "world", labelKey: "RIFTS.Importer.WorldImport" },
  { id: "compendium", labelKey: "RIFTS.Importer.CompendiumImport" }
];

function text(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}
function normalizeRollableImportValue(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }

  const normalizedText = text(value);
  if (!normalizedText) return Math.max(0, Math.floor(Number(fallback) || 0));

  const numeric = Number(normalizedText);
  if (Number.isFinite(numeric)) return Math.max(0, Math.floor(numeric));

  return normalizedText;
}

function normalizeForLookup(value) {
  return text(value).toLowerCase();
}

function normalizeForCompare(value) {
  return text(value).toLowerCase();
}

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = normalizeForLookup(value);
  if (!normalized) return fallback;
  if (BOOLEAN_TRUE.has(normalized)) return true;
  if (BOOLEAN_FALSE.has(normalized)) return false;
  return fallback;
}

function normalizeEnum(value, allowed, fallback, issues = null, label = "value") {
  const key = normalizeForLookup(value);
  if (!key) return fallback;
  if (allowed.has(key)) return key;
  if (issues?.warnings) {
    issues.warnings.push(`Unrecognized ${label}: "${text(value)}"; using ${fallback}.`);
  }
  return fallback;
}

function parseJSON(raw) {
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, error };
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepClone(value) {
  return foundry.utils.deepClone(value);
}

function parseNumericArray(value, fallback = []) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => Number(entry))
      .filter((entry) => Number.isFinite(entry));
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [...fallback];

    const parsed = parseJSON(trimmed);
    if (parsed.ok && Array.isArray(parsed.data)) {
      return parseNumericArray(parsed.data, fallback);
    }

    return trimmed
      .split(/[\n,;]/)
      .map((entry) => Number(entry.trim()))
      .filter((entry) => Number.isFinite(entry));
  }

  if (isPlainObject(value)) {
    const out = [];
    for (const [key, rawEntry] of Object.entries(value)) {
      const level = Math.max(1, Math.floor(Number(key)));
      const numeric = Number(rawEntry);
      if (!Number.isFinite(level) || !Number.isFinite(numeric)) continue;
      out[level - 1] = numeric;
    }

    return out
      .map((entry) => Number(entry))
      .filter((entry) => Number.isFinite(entry));
  }

  return [...fallback];
}

function normalizeSkillPackageEntry(entry) {
  if (typeof entry === "string") {
    const name = text(entry);
    return {
      name,
      category: "",
      base: 0,
      perLevel: 0,
      modifier: 0,
      notes: ""
    };
  }

  if (!isPlainObject(entry)) {
    return null;
  }

  const name = text(entry.name);
  if (!name) return null;

  return {
    name,
    category: text(entry.category),
    base: Number.isFinite(Number(entry.base)) ? Number(entry.base) : 0,
    perLevel: Number.isFinite(Number(entry.perLevel)) ? Number(entry.perLevel) : 0,
    modifier: Number.isFinite(Number(entry.modifier)) ? Number(entry.modifier) : 0,
    notes: text(entry.notes)
  };
}

function normalizeSkillPackageArray(rawValue, issues, fieldName) {
  const source = Array.isArray(rawValue) ? rawValue : [];
  if (rawValue !== undefined && !Array.isArray(rawValue)) {
    issues.errors.push(`${fieldName} must be an array.`);
  }

  const out = [];
  for (const entry of source) {
    const normalized = normalizeSkillPackageEntry(entry);
    if (!normalized) {
      issues.warnings.push(`Ignored invalid ${fieldName} entry.`);
      continue;
    }
    out.push(normalized);
  }

  return out;
}

function toProfileResult(documentData, summary = "") {
  return {
    documentData,
    summary: text(summary)
  };
}
function applyImportKey(documentData, rawRow) {
  const importKey = text(rawRow?.systemKey ?? rawRow?.system?.key ?? rawRow?.importKey);
  if (!importKey) return documentData;
  if (!documentData || typeof documentData !== "object") return documentData;

  const cloned = deepClone(documentData);
  cloned.system ??= {};
  cloned.system.key = importKey;
  return cloned;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRowAccessor(rawRow) {
  const lookup = {};
  for (const [key, value] of Object.entries(rawRow ?? {})) {
    lookup[normalizeForLookup(key)] = value;
  }

  const get = (...keys) => {
    for (const key of keys) {
      const normalized = normalizeForLookup(key);
      if (!normalized) continue;
      if (Object.prototype.hasOwnProperty.call(lookup, normalized)) {
        return lookup[normalized];
      }
    }
    return undefined;
  };

  return {
    text(keys, fallback = "") {
      const keyList = Array.isArray(keys) ? keys : [keys];
      const value = get(...keyList);
      return text(value, fallback);
    },
    number(keys, fallback = 0, issues = null, label = "") {
      const keyList = Array.isArray(keys) ? keys : [keys];
      const value = get(...keyList);
      const raw = text(value);
      if (!raw) return fallback;
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return parsed;
      if (issues?.warnings) {
        issues.warnings.push(`Invalid number for ${label || keyList[0]}: "${raw}"`);
      }
      return fallback;
    },
    integer(keys, fallback = 0, issues = null, label = "") {
      return Math.floor(this.number(keys, fallback, issues, label));
    },
    boolean(keys, fallback = false) {
      const keyList = Array.isArray(keys) ? keys : [keys];
      const value = get(...keyList);
      return parseBoolean(value, fallback);
    }
  };
}

function parseCsv(textContent) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  const pushCell = () => {
    row.push(cell);
    cell = "";
  };

  const pushRow = () => {
    pushCell();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < textContent.length; i += 1) {
    const ch = textContent[i];
    const next = textContent[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && ch === ",") {
      pushCell();
      continue;
    }

    if (!inQuotes && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && next === "\n") i += 1;
      pushRow();
      continue;
    }

    cell += ch;
  }

  if (cell.length > 0 || row.length > 0) {
    pushRow();
  }

  if (rows.length <= 0) {
    return {
      ok: false,
      errors: ["CSV input is empty."]
    };
  }

  const header = rows[0].map((entry) => text(entry));
  if (header.length <= 0 || header.every((entry) => !entry)) {
    return {
      ok: false,
      errors: ["CSV header row is missing."]
    };
  }

  const dataRows = [];
  for (let i = 1; i < rows.length; i += 1) {
    const csvRow = rows[i] ?? [];
    const mapped = {};
    let hasValue = false;

    for (let col = 0; col < header.length; col += 1) {
      const headerKey = header[col];
      if (!headerKey) continue;
      const value = text(csvRow[col] ?? "");
      mapped[headerKey] = value;
      if (value.length > 0) hasValue = true;
    }

    if (!hasValue) continue;
    dataRows.push({
      rowNumber: i + 1,
      data: mapped
    });
  }

  return {
    ok: true,
    rows: dataRows,
    header
  };
}

function parseInput({ inputFormat, raw }) {
  const cleanRaw = String(raw ?? "").trim();
  if (!cleanRaw) {
    return {
      ok: false,
      errors: ["Input is empty."]
    };
  }

  if (inputFormat === "csv") {
    return parseCsv(cleanRaw);
  }

  if (inputFormat === "json") {
    const parsed = parseJSON(cleanRaw);
    if (!parsed.ok) {
      return {
        ok: false,
        errors: [parsed.error?.message ?? "Invalid JSON."]
      };
    }

    if (!Array.isArray(parsed.data)) {
      return {
        ok: false,
        errors: ["JSON input must be an array of objects."]
      };
    }

    const rows = parsed.data.map((entry, index) => ({
      rowNumber: index + 1,
      data: entry
    }));

    return {
      ok: true,
      rows
    };
  }

  return {
    ok: false,
    errors: [`Unsupported format: ${inputFormat}`]
  };
}

function mapSkillProfile(rawRow, issues) {
  const read = buildRowAccessor(rawRow);
  return {
    name: read.text(["name"]),
    type: "skill",
    system: {
      description: read.text(["description"]),
      category: read.text(["category"]),
      base: read.number(["base"], 30, issues, "base"),
      perLevel: read.number(["perLevel", "per_level"], 0, issues, "perLevel"),
      modifier: read.number(["modifier", "mod"], 0, issues, "modifier"),
      isOCCSkill: read.boolean(["isOCCSkill", "is_occ_skill"], false),
      isRelatedSkill: read.boolean(["isRelatedSkill", "is_related_skill"], false),
      isSecondarySkill: read.boolean(["isSecondarySkill", "is_secondary_skill"], false),
      sourceType: read.text(["sourceType", "source_type"]),
      sourceId: read.text(["sourceId", "source_id"]),
      notes: read.text(["notes"])
    }
  };
}

function mapPowerProfile(rawRow, issues) {
  const read = buildRowAccessor(rawRow);
  const powerType = normalizeEnum(
    read.text(["powerType", "power_type"], "ability"),
    new Set(["psionic", "spell", "ability", "techno-wizard", "supernatural"]),
    "ability",
    issues,
    "powerType"
  );
  const costType = normalizeEnum(
    read.text(["costType", "cost_type"], "none"),
    new Set(["none", "isp", "ppe", "hp", "sdc"]),
    "none",
    issues,
    "costType"
  );

  return {
    name: read.text(["name"]),
    type: "power",
    system: {
      powerType,
      subType: read.text(["subType", "sub_type"]),
      costType,
      cost: Math.max(0, read.number(["cost"], 0, issues, "cost")),
      range: read.text(["range"]),
      duration: read.text(["duration"]),
      activationTime: read.text(["activationTime", "activation_time"]),
      saveType: read.text(["saveType", "save_type"]),
      damage: read.text(["damage"]),
      description: read.text(["description"]),
      notes: read.text(["notes"]),
      requiresTarget: read.boolean(["requiresTarget", "requires_target"], false),
      requiresAttackRoll: read.boolean(["requiresAttackRoll", "requires_attack_roll"], false),
      requiresSave: read.boolean(["requiresSave", "requires_save"], false),
      scale: normalizeForLookup(read.text(["scale"])),
      active: read.boolean(["active"], false)
    }
  };
}

function mapWeaponProfile(rawRow, issues) {
  const read = buildRowAccessor(rawRow);
  const ammoMax = Math.max(0, read.integer(["ammoMax", "ammo_max"], 0, issues, "ammoMax"));
  const ammoValue = Math.max(0, read.integer(["ammo", "ammoValue", "ammo_value"], ammoMax, issues, "ammo"));
  const isMdc = read.boolean(["isMdc", "isMegaDamage", "is_mega_damage"], false);

  return {
    name: read.text(["name"]),
    type: "weapon",
    system: {
      equipped: read.boolean(["equipped"], false),
      active: read.boolean(["active"], false),
      weapon: {
        isMegaDamage: isMdc,
        attackType: read.text(["attackType", "attack_type"], "strike") || "strike",
        damage: read.text(["damage"], "1d6") || "1d6",
        bonusStrike: read.number(["bonusStrike", "bonus_strike"], 0, issues, "bonusStrike"),
        range: read.text(["range"]),
        ammo: {
          value: ammoValue,
          max: ammoMax
        },
        isMounted: read.boolean(["isMounted", "is_mounted"], false),
        mountName: read.text(["mountName", "mount_name"]),
        linkedToVehicle: read.boolean(["linkedToVehicle", "linked_to_vehicle"], false),
        requiresCrew: Math.max(1, read.integer(["requiresCrew", "requires_crew"], 1, issues, "requiresCrew")),
        linkedArmorId: read.text(["linkedArmorId", "linked_armor_id"]),
        requiresPowerArmor: read.boolean(["requiresPowerArmor", "requires_power_armor"], false),
        notes: read.text(["notes"])
      }
    }
  };
}

function mapArmorProfile(rawRow, issues) {
  const read = buildRowAccessor(rawRow);
  const sdcMax = Math.max(0, read.integer(["sdcMax", "sdc_max"], 0, issues, "sdcMax"));
  const mdcMax = Math.max(0, read.integer(["mdcMax", "mdc_max"], 0, issues, "mdcMax"));
  const sdcValue = Math.max(0, read.integer(["sdc", "sdcValue", "sdc_value"], sdcMax, issues, "sdc"));
  const mdcValue = Math.max(0, read.integer(["mdc", "mdcValue", "mdc_value"], mdcMax, issues, "mdc"));
  const isMdc = read.boolean(["isMdc", "isMegaDamageArmor", "is_mega_damage_armor"], mdcMax > 0);

  return {
    name: read.text(["name"]),
    type: "armor",
    system: {
      equipped: read.boolean(["equipped"], false),
      active: read.boolean(["active"], false),
      armor: {
        ar: Math.max(0, read.integer(["ar"], 0, issues, "ar")),
        isMegaDamageArmor: isMdc,
        sdc: {
          value: sdcValue,
          max: sdcMax
        },
        mdc: {
          value: mdcValue,
          max: mdcMax
        },
        isPowerArmor: read.boolean(["isPowerArmor", "is_power_armor"], false),
        mountCapacity: Math.max(0, read.integer(["mountCapacity", "mount_capacity"], 0, issues, "mountCapacity")),
        powerArmorClass: read.text(["powerArmorClass", "power_armor_class"]),
        handlingMod: read.number(["handlingMod", "handling_mod"], 0, issues, "handlingMod"),
        speedMod: read.number(["speedMod", "speed_mod"], 0, issues, "speedMod"),
        notes: read.text(["notes"])
      }
    }
  };
}

function mapGearProfile(rawRow, issues) {
  const read = buildRowAccessor(rawRow);
  return {
    name: read.text(["name"]),
    type: "gear",
    system: {
      quantity: Math.max(0, read.number(["quantity"], 1, issues, "quantity")),
      weight: Math.max(0, read.number(["weight"], 0, issues, "weight")),
      description: read.text(["description"]),
      notes: read.text(["notes"])
    }
  };
}

function mapVehicleProfile(rawRow, issues) {
  const read = buildRowAccessor(rawRow);
  const mdcMax = Math.max(0, read.integer(["mdcMax", "mdc_max"], 0, issues, "mdcMax"));
  const sdcMax = Math.max(0, read.integer(["sdcMax", "sdc_max"], 0, issues, "sdcMax"));
  const fuelMax = Math.max(0, read.integer(["fuelMax", "fuel_max"], 0, issues, "fuelMax"));
  const mdcValue = Math.max(0, read.integer(["mdc", "mdcValue", "mdc_value"], mdcMax, issues, "mdc"));
  const sdcValue = Math.max(0, read.integer(["sdc", "sdcValue", "sdc_value"], sdcMax, issues, "sdc"));
  const fuelValue = Math.max(0, read.integer(["fuel", "fuelValue", "fuel_value"], fuelMax, issues, "fuel"));

  return {
    name: read.text(["name"]),
    type: "vehicle",
    img: read.text(["img"], "icons/svg/mystery-man.svg") || "icons/svg/mystery-man.svg",
    system: {
      details: {
        level: Math.max(1, read.integer(["level"], 1, issues, "level")),
        sizeCategory: read.text(["sizeCategory", "size_category"], "large") || "large"
      },
      vehicle: {
        classification: read.text(["classification"]),
        crewRequired: Math.max(1, read.integer(["crewRequired", "crew_required"], 1, issues, "crewRequired")),
        passengerCapacity: Math.max(0, read.integer(["passengerCapacity", "passenger_capacity"], 0, issues, "passengerCapacity")),
        speedGround: Math.max(0, read.number(["speedGround", "speed_ground"], 0, issues, "speedGround")),
        speedAir: Math.max(0, read.number(["speedAir", "speed_air"], 0, issues, "speedAir")),
        speedWater: Math.max(0, read.number(["speedWater", "speed_water"], 0, issues, "speedWater")),
        handling: read.number(["handling"], 0, issues, "handling"),
        notes: read.text(["notes"])
      },
      resources: {
        mdc: { value: mdcValue, max: mdcMax },
        sdc: { value: sdcValue, max: sdcMax },
        fuel: { value: fuelValue, max: fuelMax }
      },
      combat: {
        initiativeMod: read.number(["initiativeMod", "initiative_mod"], 0, issues, "initiativeMod"),
        pilotBonus: read.number(["pilotBonus", "pilot_bonus"], 0, issues, "pilotBonus")
      }
    }
  };
}

function mapOccRccProfile(rawRow, issues, itemType = "occ") {
  if (!isPlainObject(rawRow)) {
    issues.errors.push("Invalid nested data for class import.");
    return toProfileResult({ name: "", type: itemType, system: {} }, "");
  }

  const source = isPlainObject(rawRow.system) ? rawRow.system : rawRow;
  const ATTRIBUTE_KEYS = ["iq", "me", "ma", "ps", "pp", "pe", "pb", "spd"];
  const CHOICE_KEYS = ["spells", "psionics", "maneuvers", "weaponProficiencies", "packageChoices", "optionalChoices"];

  const parseMaybeJson = (value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (!trimmed) return value;
    const parsed = parseJSON(trimmed);
    return parsed.ok ? parsed.data : value;
  };

  const toIntegerMap = (value, fieldName) => {
    const source = parseMaybeJson(value);
    const out = {};

    if (Array.isArray(source)) {
      for (let i = 0; i < source.length; i += 1) {
        const numeric = Math.floor(Number(source[i]));
        if (!Number.isFinite(numeric) || numeric === 0) continue;
        out[String(i + 1)] = numeric;
      }
      return out;
    }

    if (isPlainObject(source)) {
      for (const [rawLevel, rawValue] of Object.entries(source)) {
        const level = Math.floor(Number(rawLevel));
        const numeric = Math.floor(Number(rawValue));
        if (!Number.isFinite(level) || level <= 0) continue;
        if (!Number.isFinite(numeric) || numeric === 0) continue;
        out[String(level)] = numeric;
      }
      return out;
    }

    if (source === undefined || source === null || text(source).length <= 0) {
      return {};
    }

    issues.warnings.push(`${fieldName} should be a map/array. Using empty map.`);
    return {};
  };

  const toLooseArray = (value, fieldName) => {
    const source = parseMaybeJson(value);

    if (Array.isArray(source)) return deepClone(source);
    if (source === undefined || source === null || text(source).length <= 0) return [];

    if (typeof source === "string") {
      return source
        .split(/[\r\n,;]+/)
        .map((entry) => text(entry))
        .filter((entry) => entry.length > 0)
        .map((entry) => ({ name: entry }));
    }

    if (isPlainObject(source)) return [deepClone(source)];

    issues.warnings.push(`${fieldName} should be an array. Using empty array.`);
    return [];
  };

  const normalizeChoicePool = (value, fieldName) => {
    const source = toLooseArray(value, fieldName);
    return source
      .map((entry) => {
        if (typeof entry === "string" || typeof entry === "number") {
          const name = text(entry);
          return name ? { name } : null;
        }
        if (isPlainObject(entry)) return deepClone(entry);
        return null;
      })
      .filter((entry) => entry && Object.keys(entry).length > 0);
  };

  const normalizeRequirements = (value) => {
    const parsed = parseMaybeJson(value);
    const source = isPlainObject(parsed) ? parsed : {};
    const out = {};

    for (const key of ATTRIBUTE_KEYS) {
      const raw = source[key];
      if (raw === null || raw === undefined || text(raw).length <= 0) {
        out[key] = null;
        continue;
      }
      const numeric = Math.floor(Number(raw));
      out[key] = Number.isFinite(numeric) && numeric > 0 ? numeric : null;
    }

    return out;
  };

  const normalizeEffects = (value) => {
    const parsed = parseMaybeJson(value);
    const source = isPlainObject(parsed) ? parsed : {};
    const out = {
      attributes: { iq: 0, me: 0, ma: 0, ps: 0, pp: 0, pe: 0, pb: 0, spd: 0 },
      combat: { strike: 0, parry: 0, dodge: 0, initiative: 0, apm: 0 },
      resources: { hp: 0, sdc: 0, mdc: 0, ppe: 0, isp: 0 },
      flags: {}
    };

    for (const key of ATTRIBUTE_KEYS) {
      const numeric = Number(source?.attributes?.[key] ?? 0);
      out.attributes[key] = Number.isFinite(numeric) ? numeric : 0;
    }

    for (const key of ["strike", "parry", "dodge", "initiative", "apm"]) {
      const numeric = Number(source?.combat?.[key] ?? 0);
      out.combat[key] = Number.isFinite(numeric) ? numeric : 0;
    }

    for (const key of ["hp", "sdc", "mdc", "ppe", "isp"]) {
      const numeric = Number(source?.resources?.[key] ?? 0);
      out.resources[key] = Number.isFinite(numeric) ? numeric : 0;
    }

    if (isPlainObject(source?.flags)) {
      for (const [key, valueRaw] of Object.entries(source.flags)) {
        const normalizedKey = text(key);
        if (!normalizedKey) continue;
        out.flags[normalizedKey] = parseBoolean(valueRaw, false);
      }
    }

    return out;
  };

  const classBonus = isPlainObject(source.bonuses?.combat) ? source.bonuses.combat : {};
  const classSkillBonuses = isPlainObject(source.bonuses?.skills) ? source.bonuses.skills : {};

  const xpRaw = source.xp?.value ?? source.xpValue ?? source.experience ?? 0;
  const xpValue = Math.max(0, Math.floor(Number(xpRaw) || 0));

  const xpTableRaw = source.progression?.xpTable ?? source.xpTable ?? [0];
  const normalizedXpTableResult = normalizeXPThresholdTable(xpTableRaw);
  const xpTable = normalizedXpTableResult.xpTable;
  if ((normalizedXpTableResult.ignoredNonNumericCount ?? 0) > 0) {
    issues.warnings.push("XP table contained non-numeric values that were ignored.");
  }
  if (!isXPTableAscending(xpTable)) {
    issues.warnings.push("XP table is not ascending.");
  }

  const maxLevelRaw = source.progression?.maxLevel ?? source.maxLevel ?? 15;
  const maxLevel = Math.max(1, Math.floor(Number(maxLevelRaw) || 15));

  const skillPackage = isPlainObject(source.skillPackage) ? source.skillPackage : {};
  const occSkills = normalizeSkillPackageArray(skillPackage.occSkills, issues, "skillPackage.occSkills");
  const relatedSkills = normalizeSkillPackageArray(skillPackage.relatedSkills, issues, "skillPackage.relatedSkills");
  const secondarySkills = normalizeSkillPackageArray(skillPackage.secondarySkills, issues, "skillPackage.secondarySkills");

  const attacksPerMeleePerLevel = toIntegerMap(source.attacksPerMeleePerLevel, "attacksPerMeleePerLevel");

  const skillSelectionSource = isPlainObject(source.skillSelection) ? source.skillSelection : {};
  const skillSelection = {
    occ: Math.max(0, Math.floor(Number(skillSelectionSource.occ ?? source.occSkillSelection ?? 0) || 0)),
    related: Math.max(0, Math.floor(Number(skillSelectionSource.related ?? source.relatedSkillSelection ?? 0) || 0)),
    secondary: Math.max(0, Math.floor(Number(skillSelectionSource.secondary ?? source.secondarySkillSelection ?? 0) || 0)),
    occProgression: toIntegerMap(skillSelectionSource.occProgression, "skillSelection.occProgression"),
    relatedProgression: toIntegerMap(skillSelectionSource.relatedProgression, "skillSelection.relatedProgression"),
    secondaryProgression: toIntegerMap(skillSelectionSource.secondaryProgression, "skillSelection.secondaryProgression")
  };

    const startingResourcesSource = isPlainObject(source.startingResources) ? source.startingResources : {};
  const startingResources = {
    hp: normalizeRollableImportValue(startingResourcesSource.hp ?? source.startingHp ?? 0, 0),
    sdc: normalizeRollableImportValue(startingResourcesSource.sdc ?? source.startingSdc ?? 0, 0),
    isp: normalizeRollableImportValue(startingResourcesSource.isp ?? source.startingIsp ?? 0, 0),
    ppe: normalizeRollableImportValue(startingResourcesSource.ppe ?? source.startingPpe ?? 0, 0)
  };

  const resourceProgressionSource = isPlainObject(source.resourceProgression) ? source.resourceProgression : {};
  const resourceProgression = {
    hpPerLevel: text(resourceProgressionSource.hpPerLevel ?? source.hpPerLevel ?? "1d6", "1d6"),
    sdcPerLevel: text(resourceProgressionSource.sdcPerLevel ?? source.sdcPerLevel ?? "1d6", "1d6"),
    ispPerLevel: text(resourceProgressionSource.ispPerLevel ?? source.ispPerLevel),
    ppePerLevel: text(resourceProgressionSource.ppePerLevel ?? source.ppePerLevel)
  };

  const startingPowersSource = isPlainObject(source.startingPowers) ? source.startingPowers : {};
  const startingPowers = {
    spells: toLooseArray(startingPowersSource.spells, "startingPowers.spells"),
    psionics: toLooseArray(startingPowersSource.psionics, "startingPowers.psionics")
  };

  const powerProgressionSource = isPlainObject(source.powerProgression) ? source.powerProgression : {};
  const legacySpellsPerLevel = Math.max(0, Math.floor(Number(powerProgressionSource.spellsPerLevel ?? source.spellsPerLevel ?? 0) || 0));
  const legacyPsionicsPerLevel = Math.max(0, Math.floor(Number(powerProgressionSource.psionicsPerLevel ?? source.psionicsPerLevel ?? 0) || 0));
  const powerProgression = {
    spellProgression: toIntegerMap(
      powerProgressionSource.spellProgression ?? (legacySpellsPerLevel > 0 ? { "1": legacySpellsPerLevel } : {}),
      "powerProgression.spellProgression"
    ),
    psionicProgression: toIntegerMap(
      powerProgressionSource.psionicProgression ?? (legacyPsionicsPerLevel > 0 ? { "1": legacyPsionicsPerLevel } : {}),
      "powerProgression.psionicProgression"
    )
  };

  const choiceProgressionSource = isPlainObject(source.choiceProgression) ? source.choiceProgression : {};
  const choiceProgression = {};
  for (const key of CHOICE_KEYS) {
    const progressionRaw = choiceProgressionSource[key] ?? source[`${key}Progression`] ?? {};
    choiceProgression[key] = toIntegerMap(progressionRaw, `choiceProgression.${key}`);
  }

  const choicePoolsSource = isPlainObject(source.choicePools) ? source.choicePools : {};
  const choicePools = {};
  for (const key of CHOICE_KEYS) {
    const topLevelPool = Array.isArray(source[key]) ? source[key] : undefined;
    const poolRaw = choicePoolsSource[key] ?? source[`${key}Pool`] ?? topLevelPool ?? [];
    choicePools[key] = normalizeChoicePool(poolRaw, `choicePools.${key}`);
  }

    const startingCreditsSource = isPlainObject(source.startingCredits) ? source.startingCredits : {};
  const startingCredits = {
    credits: normalizeRollableImportValue(startingCreditsSource.credits ?? source.credits ?? 0, 0)
  };

  const startingPackagesSource = isPlainObject(source.startingPackages) ? source.startingPackages : {};
  const startingPackages = {
    bionics: toLooseArray(startingPackagesSource.bionics, "startingPackages.bionics"),
    cybernetics: toLooseArray(startingPackagesSource.cybernetics, "startingPackages.cybernetics"),
    abilities: toLooseArray(startingPackagesSource.abilities, "startingPackages.abilities"),
    gear: toLooseArray(startingPackagesSource.gear, "startingPackages.gear")
  };

  const documentData = {
    name: text(rawRow.name ?? source.name),
    type: itemType,
    system: {
      description: text(source.description),
      category: text(source.category),
      isPrimaryClass: parseBoolean(source.isPrimaryClass, false),
      active: parseBoolean(source.active, false),
      notes: text(source.notes),
      experience: xpValue,
      xp: { value: xpValue },
      baseAttacksPerMelee: Math.max(0, Math.floor(Number(source.baseAttacksPerMelee ?? 2) || 2)),
      attacksPerMeleePerLevel,
      progression: {
        xpTable,
        maxLevel
      },
      bonuses: {
        combat: {
          strike: Number(classBonus.strike) || 0,
          parry: Number(classBonus.parry) || 0,
          dodge: Number(classBonus.dodge) || 0,
          initiative: Number(classBonus.initiative) || 0
        },
        skills: deepClone(classSkillBonuses)
      },
      effects: normalizeEffects(source.effects),
      grantedAbilities: toLooseArray(source.grantedAbilities, "grantedAbilities"),
      grantedSkills: toLooseArray(source.grantedSkills, "grantedSkills"),
      skillPackage: {
        occSkills,
        relatedSkills,
        secondarySkills
      },
      attributeRequirements: normalizeRequirements(source.attributeRequirements),
      skillSelection,
      startingResources,
      resourceProgression,
      startingPowers,
      powerProgression,
      choiceProgression,
      choicePools,
      startingCredits,
      startingPackages
    }
  };

  const summary = [
    `xpTable:${xpTable.length}`,
    `occ:${occSkills.length}`,
    `related:${relatedSkills.length}`,
    `secondary:${secondarySkills.length}`,
    `choices:${Object.values(choiceProgression).reduce((sum, map) => sum + Object.keys(map).length, 0)}`
  ].join(" ");

  return toProfileResult(documentData, summary);
}
function mapOccProfile(rawRow, issues) {
  return mapOccRccProfile(rawRow, issues, "occ");
}

function mapRccProfile(rawRow, issues) {
  return mapOccRccProfile(rawRow, issues, "rcc");
}

function mapHandToHandProfile(rawRow, issues) {
  if (!isPlainObject(rawRow)) {
    issues.errors.push("Invalid nested data for Hand-to-Hand import.");
    return toProfileResult({ name: "", type: "handToHand", system: {} }, "");
  }

  const progression = isPlainObject(rawRow.progression) ? rawRow.progression : {};

  const parseProgressionField = (value, fieldName) => {
    const numeric = parseNumericArray(value, []);
    if (value !== undefined && numeric.length <= 0) {
      const hasRawContent = Array.isArray(value)
        ? value.length > 0
        : isPlainObject(value)
          ? Object.keys(value).length > 0
          : text(value).length > 0;
      if (hasRawContent) {
        issues.errors.push(`${fieldName} must contain numeric values.`);
      }
    }
    return numeric;
  };

  const apmBonus = parseProgressionField(progression.apmBonus ?? rawRow.apmBonus, "progression.apmBonus");
  const strikeBonus = parseProgressionField(progression.strikeBonus ?? rawRow.strikeBonus, "progression.strikeBonus");
  const parryBonus = parseProgressionField(progression.parryBonus ?? rawRow.parryBonus, "progression.parryBonus");
  const dodgeBonus = parseProgressionField(progression.dodgeBonus ?? rawRow.dodgeBonus, "progression.dodgeBonus");
  const autoDodgeLevel = parseProgressionField(progression.autoDodgeLevel ?? rawRow.autoDodgeLevel, "progression.autoDodgeLevel");
  const damageBonus = parseProgressionField(progression.damageBonus ?? rawRow.damageBonus, "progression.damageBonus");

  const rawPackage = rawRow.maneuverPackage?.grantedManeuvers ?? rawRow.grantedManeuvers ?? [];
  if (!Array.isArray(rawPackage)) {
    issues.errors.push("maneuverPackage.grantedManeuvers must be an array.");
  }

  const maneuverArray = Array.isArray(rawPackage) ? rawPackage : [];
  if (maneuverArray.some((entry) => !isPlainObject(entry))) {
    issues.warnings.push("Ignored non-object entries in maneuverPackage.grantedManeuvers.");
  }

  const grantedManeuvers = normalizeManeuverPackageEntries(
    maneuverArray.filter((entry) => isPlainObject(entry))
  );

  const documentData = {
    name: text(rawRow.name),
    type: "handToHand",
    system: {
      active: parseBoolean(rawRow.active, false),
      style: text(rawRow.style, "basic") || "basic",
      notes: text(rawRow.notes),
      progression: {
        apmBonus,
        strikeBonus,
        parryBonus,
        dodgeBonus,
        autoDodgeLevel,
        damageBonus
      },
      maneuverPackage: {
        grantedManeuvers
      }
    }
  };

  const summary = `apm:${apmBonus.length} strike:${strikeBonus.length} maneuvers:${grantedManeuvers.length}`;
  return toProfileResult(documentData, summary);
}

function mapSpecialManeuverProfile(rawRow, issues) {
  if (!isPlainObject(rawRow)) {
    issues.errors.push("Invalid nested data for special maneuver import.");
    return toProfileResult({ name: "", type: "specialManeuver", system: {} }, "");
  }

  const normalized = normalizeSpecialManeuverEntry(rawRow);
  if (!normalized.key && !text(rawRow.name)) {
    issues.errors.push("Special maneuver requires a name or key.");
  }

  const documentData = {
    name: text(rawRow.name || normalized.name),
    type: "specialManeuver",
    system: {
      key: text(rawRow.key || normalized.key),
      category: text(rawRow.category || normalized.category),
      description: text(rawRow.description || normalized.description),
      actionCost: Math.max(0, Math.floor(Number(rawRow.actionCost ?? normalized.actionCost ?? 1) || 1)),
      strikeModifier: Number(rawRow.strikeModifier ?? normalized.strikeModifier ?? 0) || 0,
      damageFormula: text(rawRow.damageFormula || normalized.damageFormula, "0") || "0",
      isReactive: parseBoolean(rawRow.isReactive ?? normalized.isReactive, false),
      requiresTarget: parseBoolean(rawRow.requiresTarget ?? normalized.requiresTarget, true),
      minLevel: Math.max(1, Math.floor(Number(rawRow.minLevel ?? normalized.minLevel ?? 1) || 1)),
      sourceType: text(rawRow.sourceType || normalized.sourceType),
      sourceId: text(rawRow.sourceId || normalized.sourceId),
      notes: text(rawRow.notes || normalized.notes),
      canKnockdown: parseBoolean(rawRow.canKnockdown ?? normalized.canKnockdown, false),
      canKnockback: parseBoolean(rawRow.canKnockback ?? normalized.canKnockback, false),
      impactType: text(rawRow.impactType || normalized.impactType),
      knockbackValue: Math.max(0, Number(rawRow.knockbackValue ?? normalized.knockbackValue ?? 0) || 0)
    }
  };

  const summary = `category:${documentData.system.category || "-"} cost:${documentData.system.actionCost} reactive:${documentData.system.isReactive ? "yes" : "no"}`;
  return toProfileResult(documentData, summary);
}
const IMPORT_PROFILES = {
  skill: {
    id: "skill",
    labelKey: "RIFTS.Importer.Profile.Skill",
    documentName: "Item",
    documentType: "skill",
    required: ["name"],
    map: mapSkillProfile,
    exampleCsv: [
      "name,category,base,perLevel,modifier,isOCCSkill,isRelatedSkill,isSecondarySkill,description,notes",
      "Pilot: Automobile,Pilot,60,4,0,true,false,false,Operate common ground vehicles,Basic framework example",
      "Computer Operation,Technical,50,5,0,false,true,false,Use and troubleshoot computers,"
    ].join("\n"),
    exampleJson: JSON.stringify([
      {
        name: "Pilot: Automobile",
        category: "Pilot",
        base: 60,
        perLevel: 4,
        modifier: 0,
        isOCCSkill: true
      }
    ], null, 2)
  },
  power: {
    id: "power",
    labelKey: "RIFTS.Importer.Profile.Power",
    documentName: "Item",
    documentType: "power",
    required: ["name"],
    map: mapPowerProfile,
    exampleCsv: [
      "name,powerType,subType,costType,cost,range,duration,activationTime,saveType,damage,requiresTarget,requiresAttackRoll,requiresSave,description,notes",
      "Mind Bolt,psionic,sensitive,isp,4,60 ft,instant,1 action,,2d6,true,true,false,Framework example power,"
    ].join("\n"),
    exampleJson: JSON.stringify([
      {
        name: "Mind Bolt",
        powerType: "psionic",
        costType: "isp",
        cost: 4,
        damage: "2d6",
        requiresTarget: true,
        requiresAttackRoll: true
      }
    ], null, 2)
  },
  weapon: {
    id: "weapon",
    labelKey: "RIFTS.Importer.Profile.Weapon",
    documentName: "Item",
    documentType: "weapon",
    required: ["name"],
    map: mapWeaponProfile,
    exampleCsv: [
      "name,damage,isMdc,range,ammoMax,isMounted,mountName,requiresPowerArmor,bonusStrike,notes",
      "Laser Rifle,2d6,false,400 ft,20,false,,false,1,Framework example weapon",
      "Mini-Missile Pod,1d4x10,true,1 mile,12,true,Shoulder Hardpoint,true,0,"
    ].join("\n"),
    exampleJson: JSON.stringify([
      {
        name: "Laser Rifle",
        damage: "2d6",
        isMdc: false,
        range: "400 ft",
        ammoMax: 20,
        bonusStrike: 1
      }
    ], null, 2)
  },
  armor: {
    id: "armor",
    labelKey: "RIFTS.Importer.Profile.Armor",
    documentName: "Item",
    documentType: "armor",
    required: ["name"],
    map: mapArmorProfile,
    exampleCsv: [
      "name,isMdc,isPowerArmor,ar,sdcMax,mdcMax,mountCapacity,notes",
      "Concealed Vest,false,false,12,80,0,0,Framework example armor",
      "SAMAS Frame,true,true,0,0,420,4,Framework example power armor"
    ].join("\n"),
    exampleJson: JSON.stringify([
      {
        name: "Concealed Vest",
        isMdc: false,
        ar: 12,
        sdcMax: 80
      }
    ], null, 2)
  },
  gear: {
    id: "gear",
    labelKey: "RIFTS.Importer.Profile.Gear",
    documentName: "Item",
    documentType: "gear",
    required: ["name"],
    map: mapGearProfile,
    exampleCsv: [
      "name,quantity,weight,description,notes",
      "Rope,1,5,50 ft nylon rope,Framework example gear",
      "Field Rations,6,0.2,,"
    ].join("\n"),
    exampleJson: JSON.stringify([
      {
        name: "Rope",
        quantity: 1,
        weight: 5,
        description: "50 ft nylon rope"
      }
    ], null, 2)
  },
  vehicle: {
    id: "vehicle",
    labelKey: "RIFTS.Importer.Profile.Vehicle",
    documentName: "Actor",
    documentType: "vehicle",
    required: ["name"],
    map: mapVehicleProfile,
    exampleCsv: [
      "name,classification,crewRequired,passengerCapacity,speedGround,speedAir,speedWater,handling,mdcMax,sdcMax,fuelMax,notes",
      "Hover APC,Ground Vehicle,2,8,120,0,0,2,450,0,100,Framework example vehicle"
    ].join("\n"),
    exampleJson: JSON.stringify([
      {
        name: "Hover APC",
        classification: "Ground Vehicle",
        crewRequired: 2,
        passengerCapacity: 8,
        speedGround: 120,
        handling: 2,
        mdcMax: 450,
        fuelMax: 100
      }
    ], null, 2)
  },
  occ: {
    id: "occ",
    labelKey: "RIFTS.Importer.Profile.OCC",
    documentName: "Item",
    documentType: "occ",
    required: ["name"],
    supportsFormats: ["json"],
    updateStrategy: "replace-system",
    map: mapOccProfile,
    exampleCsv: "",
    exampleJson: JSON.stringify([
      {
        name: "City Rat",
        category: "Men of Arms",
        description: "Framework OCC example",
        isPrimaryClass: true,
        active: false,
        xp: { value: 0 },
        progression: { xpTable: [0, 2200, 4400, 8800, 17600], maxLevel: 15 },
        baseAttacksPerMelee: 2,
        attacksPerMeleePerLevel: { "3": 1, "7": 1 },
        bonuses: { combat: { strike: 0, parry: 0, dodge: 0, initiative: 0 }, skills: {} },
        effects: {
          attributes: { iq: 0, me: 0, ma: 0, ps: 0, pp: 0, pe: 0, pb: 0, spd: 0 },
          combat: { strike: 0, parry: 0, dodge: 0, initiative: 0, apm: 0 },
          resources: { hp: 0, sdc: 0, mdc: 0, ppe: 0, isp: 0 },
          flags: {}
        },
        attributeRequirements: { iq: 9, me: 9, ma: null, ps: null, pp: null, pe: null, pb: null, spd: null },
        skillSelection: {
          occ: 8,
          related: 4,
          secondary: 4,
          occProgression: { "3": 1 },
          relatedProgression: { "3": 1, "6": 1 },
          secondaryProgression: { "3": 1, "6": 1 }
        },
        skillPackage: {
          occSkills: [{ name: "Pilot: Automobile", category: "Pilot", base: 60, perLevel: 4, modifier: 0 }],
          relatedSkills: [{ name: "Streetwise", category: "Rogue", base: 32, perLevel: 4, modifier: 0 }],
          secondarySkills: []
        },
        startingResources: { hp: 0, sdc: 0, isp: 0, ppe: 0 },
        resourceProgression: { hpPerLevel: "1d6", sdcPerLevel: "1d6", ispPerLevel: "", ppePerLevel: "" },
        startingPowers: { spells: [], psionics: [] },
        powerProgression: { spellProgression: {}, psionicProgression: {} },
        choiceProgression: { spells: {}, psionics: {}, maneuvers: {}, weaponProficiencies: { "2": 1 }, packageChoices: {}, optionalChoices: {} },
        choicePools: { spells: [], psionics: [], maneuvers: [], weaponProficiencies: [{ name: "WP Sword", category: "Melee" }], packageChoices: [], optionalChoices: [] },
        startingCredits: { credits: 5000 },
        startingPackages: { bionics: [], cybernetics: [], abilities: [], gear: [] },
        grantedAbilities: [],
        notes: "Framework OCC example"
      }
    ], null, 2)
  },
  rcc: {
    id: "rcc",
    labelKey: "RIFTS.Importer.Profile.RCC",
    documentName: "Item",
    documentType: "rcc",
    required: ["name"],
    supportsFormats: ["json"],
    updateStrategy: "replace-system",
    map: mapRccProfile,
    exampleCsv: "",
    exampleJson: JSON.stringify([
      {
        name: "Wolfen",
        category: "RCC",
        description: "Framework RCC example",
        isPrimaryClass: true,
        active: false,
        xp: { value: 0 },
        progression: { xpTable: [0, 2150, 4300, 8600, 17200], maxLevel: 15 },
        baseAttacksPerMelee: 2,
        attacksPerMeleePerLevel: { "4": 1, "8": 1 },
        bonuses: { combat: { strike: 1, parry: 1, dodge: 0, initiative: 0 }, skills: {} },
        attributeRequirements: { iq: null, me: null, ma: null, ps: 10, pp: null, pe: 10, pb: null, spd: null },
        skillSelection: {
          occ: 6,
          related: 3,
          secondary: 2,
          occProgression: { "3": 1 },
          relatedProgression: { "6": 1 },
          secondaryProgression: { "6": 1 }
        },
        skillPackage: {
          occSkills: [{ name: "Wilderness Survival", category: "Wilderness", base: 40, perLevel: 5, modifier: 0 }],
          relatedSkills: [],
          secondarySkills: [{ name: "Land Navigation", category: "Wilderness", base: 36, perLevel: 4, modifier: 0 }]
        },
        startingResources: { hp: 0, sdc: 0, isp: 0, ppe: 0 },
        resourceProgression: { hpPerLevel: "1d6", sdcPerLevel: "1d6", ispPerLevel: "", ppePerLevel: "" },
        startingPowers: { spells: [], psionics: [] },
        powerProgression: { spellProgression: {}, psionicProgression: {} },
        choiceProgression: { spells: {}, psionics: {}, maneuvers: {}, weaponProficiencies: {}, packageChoices: {}, optionalChoices: {} },
        choicePools: { spells: [], psionics: [], maneuvers: [], weaponProficiencies: [], packageChoices: [], optionalChoices: [] },
        startingCredits: { credits: 0 },
        startingPackages: { bionics: [], cybernetics: [], abilities: [], gear: [] },
        grantedAbilities: [],
        notes: "Framework RCC example"
      }
    ], null, 2)
  },
  handToHand: {
    id: "handToHand",
    labelKey: "RIFTS.Importer.Profile.HandToHand",
    documentName: "Item",
    documentType: "handToHand",
    required: ["name"],
    supportsFormats: ["json"],
    updateStrategy: "replace-system",
    map: mapHandToHandProfile,
    exampleCsv: "",
    exampleJson: JSON.stringify([
      {
        name: "Hand to Hand: Expert",
        style: "expert",
        progression: {
          apmBonus: [0, 0, 1, 1],
          strikeBonus: [0, 1, 1, 2],
          parryBonus: [0, 1, 1, 2],
          dodgeBonus: [0, 0, 1, 1],
          autoDodgeLevel: [0, 0, 9],
          damageBonus: [0, 0, 1, 2]
        },
        maneuverPackage: {
          grantedManeuvers: [
            { name: "Disarm", key: "disarm", minLevel: 3, category: "offensive", actionCost: 1 },
            { name: "Roll With Punch", key: "roll-with-punch", minLevel: 2, category: "reactive", isReactive: true }
          ]
        },
        notes: "Framework HtH example"
      }
    ], null, 2)
  },
  specialManeuver: {
    id: "specialManeuver",
    labelKey: "RIFTS.Importer.Profile.SpecialManeuver",
    documentName: "Item",
    documentType: "specialManeuver",
    required: ["name"],
    supportsFormats: ["json"],
    updateStrategy: "replace-system",
    map: mapSpecialManeuverProfile,
    exampleCsv: "",
    exampleJson: JSON.stringify([
      {
        name: "Disarm",
        key: "disarm",
        category: "offensive",
        description: "Attempt to disarm an opponent.",
        actionCost: 1,
        strikeModifier: 0,
        damageFormula: "0",
        isReactive: false,
        requiresTarget: true,
        minLevel: 1,
        sourceType: "handToHand",
        sourceId: "",
        notes: "Framework special maneuver example"
      }
    ], null, 2)
  }
};

export function getBulkImportProfiles() {
  return Object.values(IMPORT_PROFILES).map((profile) => ({
    id: profile.id,
    labelKey: profile.labelKey,
    documentName: profile.documentName,
    documentType: profile.documentType,
    supportsFormats: Array.isArray(profile.supportsFormats) && profile.supportsFormats.length > 0
      ? [...profile.supportsFormats]
      : ["csv", "json"]
  }));
}

export function getSupportedFormatsForProfile(profileId) {
  const profile = getProfile(profileId);
  if (!profile) return ["csv", "json"];
  if (Array.isArray(profile.supportsFormats) && profile.supportsFormats.length > 0) {
    return [...profile.supportsFormats];
  }
  return ["csv", "json"];
}

export function getImporterInputFormats() {
  return IMPORT_FORMATS.map((entry) => ({ ...entry }));
}

export function getImporterDuplicateModes() {
  return DUPLICATE_MODES.map((entry) => ({ ...entry }));
}

export function getImporterDestinations() {
  return IMPORT_DESTINATIONS.map((entry) => ({ ...entry }));
}

export function getImporterWorldFolders(profileId) {
  const profile = getProfile(profileId);
  if (!profile) return [];

  const folders = Array.from(game.folders ?? [])
    .filter((folder) => text(folder?.type) === profile.documentName && !text(folder?.pack))
    .map((folder) => ({
      id: folder.id,
      name: text(folder.name)
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return folders;
}

export function getImporterTemplate(profileId, inputFormat) {
  const profile = IMPORT_PROFILES[profileId];
  if (!profile) return "";

  const supportedFormats = Array.isArray(profile.supportsFormats) && profile.supportsFormats.length > 0
    ? profile.supportsFormats
    : ["csv", "json"];
  const effectiveFormat = supportedFormats.includes(inputFormat)
    ? inputFormat
    : supportedFormats[0];

  return effectiveFormat === "json"
    ? (profile.exampleJson ?? "")
    : (profile.exampleCsv ?? profile.exampleJson ?? "");
}

function getProfile(profileId) {
  return IMPORT_PROFILES[profileId] ?? null;
}

function getDestinationCollection(profile) {
  if (!profile) return null;
  if (profile.documentName === "Item") return game.items;
  if (profile.documentName === "Actor") return game.actors;
  return null;
}

async function getCompendiumContext(profile, packId) {
  const errors = [];
  if (!packId) {
    errors.push("Compendium pack is required.");
    return { ok: false, errors };
  }

  const pack = game.packs.get(packId);
  if (!pack) {
    errors.push(`Compendium pack not found: ${packId}`);
    return { ok: false, errors };
  }

  if (pack.documentName !== profile.documentName) {
    errors.push(`Compendium pack ${packId} stores ${pack.documentName}, expected ${profile.documentName}.`);
    return { ok: false, errors };
  }

  if (pack.locked) {
    errors.push(`Compendium pack ${packId} is locked.`);
    return { ok: false, errors };
  }

  const existingDocs = await pack.getDocuments();
  return {
    ok: true,
    errors,
    existingDocs,
    createOptions: { pack: pack.collection },
    pack
  };
}

async function getImportContext({ profile, destination, packId, folderId }) {
  const errors = [];
  if (!profile) {
    errors.push("Unsupported content type profile.");
    return { ok: false, errors, existingDocs: [], createOptions: {} };
  }

  if (destination === "world") {
    const collection = getDestinationCollection(profile);
    if (!collection) {
      errors.push(`Unsupported world destination for ${profile.documentName}.`);
      return { ok: false, errors, existingDocs: [], createOptions: {} };
    }

    const createOptions = {};
    const normalizedFolderId = text(folderId);
    if (normalizedFolderId) {
      const folder = game.folders?.get(normalizedFolderId) ?? null;
      if (!folder) {
        errors.push(`Folder not found: ${normalizedFolderId}`);
      } else if (text(folder.type) !== profile.documentName) {
        errors.push(`Folder ${folder.name} is type ${folder.type}, expected ${profile.documentName}.`);
      } else if (text(folder.pack)) {
        errors.push(`Folder ${folder.name} belongs to a compendium and cannot be used for world import.`);
      } else {
        createOptions.folder = folder.id;
      }
    }

    if (errors.length > 0) {
      return { ok: false, errors, existingDocs: [], createOptions: {} };
    }

    return {
      ok: true,
      errors,
      existingDocs: Array.from(collection),
      createOptions
    };
  }

  if (destination === "compendium") {
    return getCompendiumContext(profile, packId);
  }

  errors.push(`Unsupported import destination: ${destination}`);
  return { ok: false, errors, existingDocs: [], createOptions: {} };
}

function mapRowToDocument(profile, rawRow, rowNumber) {
  const issues = { errors: [], warnings: [] };

  if (!rawRow || typeof rawRow !== "object" || Array.isArray(rawRow)) {
    issues.errors.push("Row must be an object.");
    return {
      ok: false,
      rowNumber,
      issues,
      documentData: null,
      summary: ""
    };
  }

  const mapped = profile.map(rawRow, issues);
  const hasWrappedResult = isPlainObject(mapped) && isPlainObject(mapped.documentData);
  const documentData = hasWrappedResult ? mapped.documentData : mapped;
  const summary = hasWrappedResult ? text(mapped.summary) : "";
  const keyedDocumentData = applyImportKey(documentData, rawRow);

  for (const field of profile.required) {
    const requiredValue = text(keyedDocumentData?.[field]);
    if (!requiredValue) {
      issues.errors.push(`Missing required field: ${field}`);
    }
  }

  if (text(keyedDocumentData?.name).length <= 0) {
    issues.errors.push("Name is required.");
  }

  return {
    ok: issues.errors.length <= 0,
    rowNumber,
    issues,
    documentData: keyedDocumentData,
    summary
  };
}

function getDocType(doc) {
  return text(doc?.type);
}

function getDocName(doc) {
  return text(doc?.name);
}

function getDocSystemKey(doc) {
  return text(foundry.utils.getProperty(doc, "system.key"));
}

function findExistingDuplicate(documentData, existingDocs) {
  const docType = text(documentData?.type);
  const docName = normalizeForCompare(documentData?.name);
  const docKey = normalizeForCompare(foundry.utils.getProperty(documentData, "system.key"));

  if (docKey) {
    const keyed = existingDocs.find((doc) => {
      if (normalizeForCompare(getDocType(doc)) !== normalizeForCompare(docType)) return false;
      return normalizeForCompare(getDocSystemKey(doc)) === docKey;
    });

    if (keyed) {
      return {
        duplicate: keyed,
        strategy: "system.key"
      };
    }
  }

  const byName = existingDocs.find((doc) => {
    if (normalizeForCompare(getDocType(doc)) !== normalizeForCompare(docType)) return false;
    return normalizeForCompare(getDocName(doc)) === docName;
  });

  if (byName) {
    return {
      duplicate: byName,
      strategy: "name+type"
    };
  }

  return {
    duplicate: null,
    strategy: docKey ? "system.key" : "name+type"
  };
}

function decideRowAction(duplicateMode, duplicateFound) {
  if (!duplicateFound) return "create";
  if (duplicateMode === "create") return "create";
  if (duplicateMode === "update") return "update";
  return "skip";
}

function buildCounts(rowResults, contextErrors) {
  const counts = {
    parsed: rowResults.length,
    valid: 0,
    invalid: 0,
    duplicates: 0,
    create: 0,
    update: 0,
    skip: 0,
    errors: contextErrors.length
  };

  for (const row of rowResults) {
    if (row.status === "invalid") {
      counts.invalid += 1;
      continue;
    }

    counts.valid += 1;
    if (row.duplicateId) counts.duplicates += 1;
    if (row.action === "create") counts.create += 1;
    else if (row.action === "update") counts.update += 1;
    else if (row.action === "skip") counts.skip += 1;
  }

  return counts;
}

function cloneForUpdate(documentData) {
  const updateData = foundry.utils.deepClone(documentData);
  delete updateData.type;
  return updateData;
}

export async function previewBulkImport(options) {
  const profile = getProfile(options.profileId);
  const duplicateMode = ["create", "skip", "update"].includes(options.duplicateMode)
    ? options.duplicateMode
    : "skip";
  const destination = ["world", "compendium"].includes(options.destination)
    ? options.destination
    : "world";
  const folderId = destination === "world" ? text(options.folderId) : "";

  const profileFormats = profile
    ? getSupportedFormatsForProfile(profile.id)
    : ["csv", "json"];
  const inputFormat = profileFormats.includes(options.inputFormat)
    ? options.inputFormat
    : profileFormats[0] ?? "json";

  const parsed = parseInput({
    inputFormat,
    raw: options.raw
  });

  const context = await getImportContext({
    profile,
    destination,
    packId: options.packId,
    folderId
  });

  const rowResults = [];
  const contextErrors = [];

  if (!profile) {
    contextErrors.push("Unsupported content type profile.");
  }

  if (profile && options.inputFormat && !profileFormats.includes(options.inputFormat)) {
    contextErrors.push(game.i18n.localize("RIFTS.Importer.InvalidNestedData") + ` (${profile.id} supports: ${profileFormats.join(", ")}).`);
  }

  if (!parsed.ok) {
    contextErrors.push(...parsed.errors);
  }

  if (!context.ok) {
    contextErrors.push(...context.errors);
  }

  if (profile && parsed.ok && context.ok) {
    for (const row of parsed.rows) {
      const mapped = mapRowToDocument(profile, row.data, row.rowNumber);
      if (!mapped.ok) {
        rowResults.push({
          rowNumber: row.rowNumber,
          status: "invalid",
          action: "skip",
          duplicateStrategy: "",
          duplicateId: "",
          name: text(mapped.documentData?.name),
          type: text(mapped.documentData?.type),
          errors: mapped.issues.errors,
          warnings: mapped.issues.warnings,
          summary: mapped.summary ?? "",
          documentData: mapped.documentData
        });
        continue;
      }

      const duplicateMatch = findExistingDuplicate(mapped.documentData, context.existingDocs);
      const action = decideRowAction(duplicateMode, Boolean(duplicateMatch.duplicate));
      rowResults.push({
        rowNumber: row.rowNumber,
        status: "valid",
        action,
        duplicateStrategy: duplicateMatch.strategy,
        duplicateId: duplicateMatch.duplicate?.id ?? "",
        duplicateName: duplicateMatch.duplicate?.name ?? "",
        name: text(mapped.documentData?.name),
        type: text(mapped.documentData?.type),
        errors: mapped.issues.errors,
        warnings: mapped.issues.warnings,
          summary: mapped.summary ?? "",
        documentData: mapped.documentData
      });
    }
  }

  return {
    ok: contextErrors.length <= 0,
    profileId: options.profileId,
    inputFormat,
    destination,
    duplicateMode,
    packId: options.packId ?? "",
    folderId,
    counts: buildCounts(rowResults, contextErrors),
    errors: contextErrors,
    rows: rowResults
  };
}

async function createDocument(profile, data, options) {
  const createData = deepClone(data);
  const createOptions = { ...(options ?? {}) };

  // For world docs, folder is a document field. For compendium create, keep pack in options.
  if (!createOptions.pack && text(createOptions.folder)) {
    createData.folder = createOptions.folder;
    delete createOptions.folder;
  }

  if (profile.documentName === "Item") {
    return Item.create(createData, createOptions);
  }
  if (profile.documentName === "Actor") {
    return Actor.create(createData, createOptions);
  }
  throw new Error(`Unsupported document class ${profile.documentName}`);
}

export async function executeBulkImport(options) {
  const preview = await previewBulkImport(options);
  if (!preview.ok) {
    return {
      ok: false,
      preview,
      counts: {
        created: 0,
        updated: 0,
        skipped: 0,
        errors: preview.errors.length + preview.counts.invalid
      },
      rows: preview.rows.map((row) => ({
        rowNumber: row.rowNumber,
        action: row.action,
        status: row.status,
        name: row.name,
        message: row.errors.join("; ")
      })),
      errors: [...preview.errors]
    };
  }

  const profile = getProfile(preview.profileId);
  const context = await getImportContext({
    profile,
    destination: preview.destination,
    packId: preview.packId,
    folderId: preview.folderId
  });

  if (!context.ok) {
    return {
      ok: false,
      preview,
      counts: { created: 0, updated: 0, skipped: 0, errors: context.errors.length },
      rows: [],
      errors: [...context.errors]
    };
  }

  const results = [];
  const errors = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of preview.rows) {
    if (row.status === "invalid") {
      skipped += 1;
      results.push({
        rowNumber: row.rowNumber,
        name: row.name,
        action: "invalid",
        status: "error",
        message: row.errors.join("; ")
      });
      continue;
    }

    try {
      const duplicateMatch = findExistingDuplicate(row.documentData, context.existingDocs);
      const action = decideRowAction(preview.duplicateMode, Boolean(duplicateMatch.duplicate));
      if (action === "skip") {
        skipped += 1;
        results.push({
          rowNumber: row.rowNumber,
          name: row.name,
          action: "skip",
          status: "skipped",
          message: "Duplicate skipped."
        });
        continue;
      }

      if (action === "update" && duplicateMatch.duplicate) {
        const updateData = cloneForUpdate(row.documentData);
        const targetFolderId = text(context.createOptions?.folder);

        if (profile?.updateStrategy === "replace-system" && updateData.system) {
          const replacementUpdate = {
            name: row.documentData?.name ?? duplicateMatch.duplicate.name,
            system: updateData.system
          };

          if (Object.prototype.hasOwnProperty.call(updateData, "img")) {
            replacementUpdate.img = updateData.img;
          }

          if (targetFolderId) {
            replacementUpdate.folder = targetFolderId;
          }

          await duplicateMatch.duplicate.update(replacementUpdate);
        } else {
          if (targetFolderId) {
            updateData.folder = targetFolderId;
          }
          await duplicateMatch.duplicate.update(updateData);
        }

        updated += 1;
        results.push({
          rowNumber: row.rowNumber,
          name: row.name,
          action: "update",
          status: "updated",
          message: row.summary
            ? `Updated existing ${duplicateMatch.duplicate.name}. ${row.summary}`
            : `Updated existing ${duplicateMatch.duplicate.name}.`
        });
        continue;
      }

      const createdDoc = await createDocument(profile, row.documentData, context.createOptions);
      context.existingDocs.push(createdDoc);
      created += 1;
      results.push({
        rowNumber: row.rowNumber,
        name: row.name,
        action: "create",
        status: "created",
        message: row.summary ? `Created. ${row.summary}` : "Created."
      });
    } catch (error) {
      const message = error?.message ?? String(error);
      errors.push(`Row ${row.rowNumber}: ${message}`);
      results.push({
        rowNumber: row.rowNumber,
        name: row.name,
        action: row.action,
        status: "error",
        message
      });
    }
  }

  return {
    ok: errors.length <= 0,
    preview,
    counts: {
      created,
      updated,
      skipped,
      errors: errors.length
    },
    rows: results,
    errors
  };
}

export function getCompendiumChoicesForProfile(profileId) {
  const profile = getProfile(profileId);
  if (!profile) return [];

  return Array.from(game.packs.values())
    .filter((pack) => pack.documentName === profile.documentName)
    .map((pack) => ({
      id: pack.collection,
      label: `${pack.metadata?.label ?? pack.collection} (${pack.collection})`,
      locked: pack.locked === true
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function getImportSummaryRows(previewOrReport, maxRows = 20) {
  const rows = Array.isArray(previewOrReport?.rows) ? previewOrReport.rows : [];
  return rows.slice(0, Math.max(1, maxRows));
}

export function getProfileById(profileId) {
  return getProfile(profileId);
}

export function parseCommaListToNumbers(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry));
}

export function csvHeaderIncludes(header, key) {
  if (!Array.isArray(header)) return false;
  const rx = new RegExp(`^${escapeRegExp(key)}$`, "i");
  return header.some((entry) => rx.test(text(entry)));
}





































