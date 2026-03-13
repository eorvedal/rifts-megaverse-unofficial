import { RiftsActor } from "./documents/actor.mjs";
import * as RiftsRolls from "./services/rolls.mjs";
import * as RiftsCombat from "./services/combat.mjs";
import * as RiftsMeleeSequencer from "./services/melee-sequencer.mjs";
import * as RiftsCombatTracker from "./services/combat-tracker.mjs";
import * as RiftsAdvancedActions from "./services/advanced-actions.mjs";
import * as RiftsScale from "./services/scale.mjs";
import * as RiftsPowers from "./services/powers.mjs";
import * as RiftsProgression from "./services/progression.mjs";
import * as RiftsUnarmed from "./services/unarmed.mjs";
import * as RiftsManeuvers from "./services/maneuvers.mjs";
import * as RiftsImpact from "./services/impact.mjs";
import * as RiftsBulkImport from "./services/bulk-import.mjs";
import * as RiftsLevelUp from "./services/level-up.mjs";
import { openBulkImporter, RiftsBulkImporterMenu } from "./apps/bulk-importer.mjs";
import { openLevelUpDialog } from "./apps/level-up.mjs";
import { openCharacterCreationWizard } from "./apps/character-creation-wizard.mjs";
import { RiftsCharacterSheet } from "./sheets/character-sheet.mjs";
import { RiftsVehicleSheet } from "./sheets/vehicle-sheet.mjs";
import { RiftsItemSheet } from "./sheets/item-sheet.mjs";

export const RIFTS_SYSTEM_ID = "rifts-megaverse";
const TOKEN_VISUAL_FIX_SETTING = "tokenVisualRepairV1Complete";
let tokenSheetFallbackRegistered = false;

function normalizeSrc(value) {
  return String(value ?? "").trim();
}

function getDefaultTokenSrc() {
  return normalizeSrc(CONST?.DEFAULT_TOKEN ?? "icons/svg/mystery-man.svg");
}

function getActorTokenFallbackSrc(actor) {
  const actorImg = normalizeSrc(actor?.img);
  const protoSrc = normalizeSrc(foundry.utils.getProperty(actor, "prototypeToken.texture.src"));
  return actorImg || protoSrc || getDefaultTokenSrc();
}

function canOpenActorSheet(actor) {
  if (!actor || !game.user) return false;
  const observerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER ?? 2;
  return actor.testUserPermission(game.user, observerLevel);
}

function registerTokenSheetFallback() {
  if (tokenSheetFallbackRegistered) return;
  tokenSheetFallbackRegistered = true;

  Hooks.on("clickToken2", (token) => {
    const actor = token?.actor;
    if (!canOpenActorSheet(actor)) return;

    const tokenDocument = token?.document ?? token ?? null;
    const sheet = actor.sheet;
    if (!sheet) return;

    // Core should open on token double-click; this is a fallback only.
    // Always force token-context render so Configure Token can resolve a placed token.
    queueMicrotask(() => {
      const currentTokenId = String(
        sheet.token?.id
        ?? sheet.options?.token?.id
        ?? ""
      );
      const targetTokenId = String(tokenDocument?.id ?? "");

      if (sheet.rendered && currentTokenId === targetTokenId) {
        sheet.maximize?.();
        return;
      }

      sheet.render(true, { token: tokenDocument, focus: true });
    });
  });
}

function registerVehiclePrototypeTokenDefaults() {
  Hooks.on("preCreateActor", (actor) => {
    if (actor.type !== "vehicle") return;

    const currentBar1 = foundry.utils.getProperty(actor, "prototypeToken.bar1.attribute");
    const currentBar2 = foundry.utils.getProperty(actor, "prototypeToken.bar2.attribute");

    const updates = {};

    if (!currentBar1 || currentBar1 === "system.resources.hp") {
      updates["prototypeToken.bar1.attribute"] = "system.resources.mdc";
    }

    if (!currentBar2) {
      updates["prototypeToken.bar2.attribute"] = "system.resources.fuel";
    }

    if (Object.keys(updates).length) {
      actor.updateSource(updates);
    }
  });
}

function registerActorVisualDefaults() {
  Hooks.on("preCreateActor", (actor) => {
    const actorImg = normalizeSrc(actor?.img);
    const protoSrc = normalizeSrc(foundry.utils.getProperty(actor, "prototypeToken.texture.src"));
    const fallback = actorImg || protoSrc || getDefaultTokenSrc();
    if (!fallback) return;

    const updates = {};
    if (!actorImg) updates.img = fallback;
    if (!protoSrc) updates["prototypeToken.texture.src"] = fallback;

    if (Object.keys(updates).length) actor.updateSource(updates);
  });
}

function registerDataRepairSettings() {
  game.settings.register(RIFTS_SYSTEM_ID, TOKEN_VISUAL_FIX_SETTING, {
    name: "Token visual repair complete",
    hint: "Internal one-time repair flag for missing actor/token image fields.",
    scope: "world",
    config: false,
    type: Boolean,
    default: false
  });
}

async function runTokenVisualRepairPass({ force = false } = {}) {
  if (!game.user?.isGM) return;
  const alreadyCompleted = Boolean(game.settings.get(RIFTS_SYSTEM_ID, TOKEN_VISUAL_FIX_SETTING));
  if (alreadyCompleted && !force) return;

  let actorUpdates = 0;
  let tokenUpdates = 0;

  for (const actor of game.actors?.contents ?? []) {
    const actorImg = normalizeSrc(actor?.img);
    const protoSrc = normalizeSrc(foundry.utils.getProperty(actor, "prototypeToken.texture.src"));
    const fallback = actorImg || protoSrc || getDefaultTokenSrc();
    if (!fallback) continue;

    const updates = {};
    if (!actorImg) updates.img = fallback;
    if (!protoSrc) updates["prototypeToken.texture.src"] = fallback;
    if (!Object.keys(updates).length) continue;

    await actor.update(updates);
    actorUpdates += 1;
  }

  for (const scene of game.scenes?.contents ?? []) {
    const sceneTokenUpdates = [];

    for (const tokenDoc of scene.tokens ?? []) {
      const tokenSrc = normalizeSrc(foundry.utils.getProperty(tokenDoc, "texture.src"));
      if (tokenSrc) continue;

      const actor = tokenDoc.actor ?? game.actors?.get(tokenDoc.actorId) ?? null;
      const fallback = getActorTokenFallbackSrc(actor);
      if (!fallback) continue;

      sceneTokenUpdates.push({
        _id: tokenDoc.id,
        "texture.src": fallback
      });
    }

    if (!sceneTokenUpdates.length) continue;
    await scene.updateEmbeddedDocuments("Token", sceneTokenUpdates);
    tokenUpdates += sceneTokenUpdates.length;
  }

  await game.settings.set(RIFTS_SYSTEM_ID, TOKEN_VISUAL_FIX_SETTING, true);

  if (actorUpdates || tokenUpdates) {
    const message = `${RIFTS_SYSTEM_ID} | Token visual repair applied (actors: ${actorUpdates}, tokens: ${tokenUpdates})`;
    console.log(message);
    ui.notifications?.info?.(message);
  }
}
function registerBulkImporterMenu() {
  game.settings.registerMenu(RIFTS_SYSTEM_ID, "bulkImporter", {
    name: "RIFTS.Importer.BulkImporter",
    label: "RIFTS.Importer.Open",
    hint: "RIFTS.Importer.MenuHint",
    icon: "fa-solid fa-file-import",
    type: RiftsBulkImporterMenu,
    restricted: true
  });
}

Hooks.once("init", () => {
  console.log(`${RIFTS_SYSTEM_ID} | Initializing system`);

  CONFIG.Actor.documentClass = RiftsActor;

  CONFIG.RIFTS = {
    attributes: ["iq", "me", "ma", "ps", "pp", "pe", "pb", "spd"],
    resources: ["hp", "sdc", "mdc", "ppe", "isp", "fuel"],
    itemTypes: ["skill", "weapon", "armor", "occ", "rcc", "power", "gear", "feature", "cybernetic", "bionic", "handToHand", "specialManeuver"]
  };

  registerDataRepairSettings();
  registerActorVisualDefaults();
  registerVehiclePrototypeTokenDefaults();
  registerBulkImporterMenu();

  foundry.documents.collections.Actors.registerSheet(RIFTS_SYSTEM_ID, RiftsCharacterSheet, {
    types: ["character", "npc"],
    makeDefault: true,
    label: "RIFTS.Sheet.Character"
  });

  foundry.documents.collections.Actors.registerSheet(RIFTS_SYSTEM_ID, RiftsVehicleSheet, {
    types: ["vehicle"],
    makeDefault: true,
    label: "RIFTS.Sheet.Vehicle"
  });

  foundry.documents.collections.Items.registerSheet(RIFTS_SYSTEM_ID, RiftsItemSheet, {
    types: CONFIG.RIFTS.itemTypes,
    makeDefault: true,
    label: "RIFTS.Sheet.Item"
  });
});

Hooks.once("ready", async () => {
  // Disabled for now: fallback sheet opening can produce invalid token-context state
  // which breaks Foundry's built-in Configure Token action on some sheets.
  // Keep core Foundry token double-click behavior as the source of truth.
  try {
    await runTokenVisualRepairPass();
  } catch (error) {
    console.error(`${RIFTS_SYSTEM_ID} | Token visual repair failed`, error);
  }
  RiftsCombat.registerCombatChatListeners();
  RiftsCombat.registerCombatRoundHooks();
  RiftsMeleeSequencer.registerMeleeSequencerHooks();
  RiftsCombatTracker.registerCombatTrackerIntegration();

  game.rifts = {
    rolls: RiftsRolls,
    combat: RiftsCombat,
    melee: RiftsMeleeSequencer,
    combatTracker: RiftsCombatTracker,
    advancedActions: RiftsAdvancedActions,
    scale: RiftsScale,
    powers: RiftsPowers,
    progression: RiftsProgression,
    unarmed: RiftsUnarmed,
    maneuvers: RiftsManeuvers,
    impact: RiftsImpact,
    importer: {
      ...RiftsBulkImport,
      open: openBulkImporter
    },
    maintenance: {
      repairTokenVisuals: runTokenVisualRepairPass
    },
    levelUp: {
      ...RiftsLevelUp,
      open: openLevelUpDialog
    },
    creation: {
      open: openCharacterCreationWizard
    }
  };
});







