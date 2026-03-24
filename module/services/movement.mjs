import { getCurrentMeleeAction } from "./melee-sequencer.mjs";

const MOVEMENT_NOTIFY_THROTTLE_MS = 750;
let movementHooksRegistered = false;
const lastMovementWarnings = new Map();

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function getActorFromTokenDocument(tokenDocument) {
  return tokenDocument?.actor ?? (tokenDocument?.actorId ? game.actors.get(tokenDocument.actorId) : null);
}

function getGridSize() {
  return Math.max(1, num(canvas?.scene?.grid?.size, num(canvas?.grid?.size, 100)));
}

function getGridDistance() {
  return Math.max(0, num(canvas?.scene?.grid?.distance, 5));
}

function getTokenCenter(tokenDocument, x, y) {
  const gridSize = getGridSize();
  const width = Math.max(1, num(tokenDocument?.width, 1)) * gridSize;
  const height = Math.max(1, num(tokenDocument?.height, 1)) * gridSize;
  return {
    x: num(x, 0) + (width / 2),
    y: num(y, 0) + (height / 2)
  };
}

function measureMoveDistance(tokenDocument, changes) {
  if (!canvas?.grid || (!Object.prototype.hasOwnProperty.call(changes, "x") && !Object.prototype.hasOwnProperty.call(changes, "y"))) {
    return 0;
  }

  const startX = num(tokenDocument?.x, 0);
  const startY = num(tokenDocument?.y, 0);
  const endX = Object.prototype.hasOwnProperty.call(changes, "x") ? num(changes.x, startX) : startX;
  const endY = Object.prototype.hasOwnProperty.call(changes, "y") ? num(changes.y, startY) : startY;

  if (startX === endX && startY === endY) return 0;

  const start = getTokenCenter(tokenDocument, startX, startY);
  const end = getTokenCenter(tokenDocument, endX, endY);

  try {
    if (typeof canvas.grid.measurePath === "function") {
      const measured = canvas.grid.measurePath([start, end]);
      const directDistance = num(measured?.distance, NaN);
      if (Number.isFinite(directDistance)) return directDistance;

      const segmentDistance = Array.isArray(measured?.segments)
        ? measured.segments.reduce((sum, segment) => sum + num(segment?.distance, 0), 0)
        : NaN;
      if (Number.isFinite(segmentDistance)) return segmentDistance;
    }
  } catch (_error) {
    // Fall through to older grid helpers.
  }

  try {
    if (typeof canvas.grid.measureDistances === "function") {
      const ray = new Ray(start, end);
      const measured = canvas.grid.measureDistances([{ ray }], { gridSpaces: true });
      const fallbackDistance = Array.isArray(measured) ? num(measured[0], NaN) : NaN;
      if (Number.isFinite(fallbackDistance)) return fallbackDistance;
    }
  } catch (_error) {
    // Fall through to pixel conversion.
  }

  const pixels = Math.hypot(end.x - start.x, end.y - start.y);
  return (pixels / getGridSize()) * getGridDistance();
}

function getActorSpeed(actor) {
  return Math.max(0, num(actor?.system?.attributes?.spd?.value, 0));
}

function getActorApm(actor) {
  return Math.max(
    1,
    num(
      actor?.system?.combat?.apmTotal,
      num(
        actor?.system?.combat?.derived?.apmTotal,
        num(
          actor?.system?.combat?.derived?.attacksPerMelee,
          num(actor?.system?.progression?.attacksPerMelee, 1)
        )
      )
    )
  );
}

function getOutOfCombatMovementLimit(actor) {
  return Math.max(0, getActorSpeed(actor) * 5);
}

function getInCombatMovementPerAction(actor) {
  return getOutOfCombatMovementLimit(actor) / Math.max(1, getActorApm(actor));
}

function getCurrentActionState(combat, actor, tokenDocument) {
  if (!combat || !actor) {
    return {
      hasCurrent: false,
      isCurrent: true,
      currentActorName: "",
      actionKey: ""
    };
  }

  const current = getCurrentMeleeAction(combat);
  if (!current) {
    return {
      hasCurrent: false,
      isCurrent: true,
      currentActorName: "",
      actionKey: ""
    };
  }

  const actorId = String(actor.id ?? "");
  const tokenId = String(tokenDocument?.id ?? "");
  const currentActorId = String(current.actorId ?? "");
  const currentTokenId = String(current.tokenId ?? "");
  const currentActorName = current.actorId
    ? (game.actors.get(current.actorId)?.name ?? "")
    : "";

  const matchesActor = currentActorId === actorId;
  const matchesToken = currentTokenId ? currentTokenId === tokenId : matchesActor;
  const actionKey = matchesActor && matchesToken
    ? `${combat.id}:${Math.max(0, Math.floor(num(combat.round, 0)))}:${current.queueIndex}:${currentActorId}:${currentTokenId}`
    : "";

  return {
    hasCurrent: true,
    isCurrent: matchesActor && matchesToken,
    currentActorName,
    actionKey
  };
}

function getMovementStateForAction(actor, actionKey) {
  const storedKey = normalizeText(actor?.system?.combat?.movementActionKey);
  if (!actionKey || storedKey !== actionKey) {
    return {
      used: 0,
      actionKey
    };
  }

  return {
    used: Math.max(0, num(actor?.system?.combat?.movementUsedThisAction, 0)),
    actionKey
  };
}

function shouldBypassMovementEnforcement(options = {}) {
  return options?.teleport === true || options?.forced === true || options?.riftsBypassMovement === true;
}

function shouldNotify(userId) {
  return String(userId ?? "") === String(game.user?.id ?? "");
}

function throttledWarn(key, message, userId) {
  if (!shouldNotify(userId)) return;

  const now = Date.now();
  const last = num(lastMovementWarnings.get(key), 0);
  if (now - last < MOVEMENT_NOTIFY_THROTTLE_MS) return;
  lastMovementWarnings.set(key, now);
  ui.notifications?.warn?.(message);
}

function formatDistance(value) {
  const rounded = Math.round((num(value, 0) + Number.EPSILON) * 100) / 100;
  return String(rounded);
}

function buildMovementExceededMessage({ inCombat = false, remaining = 0, max = 0 }) {
  return inCombat
    ? game.i18n.format("RIFTS.Movement.MovementExceededCombat", {
      remaining: formatDistance(remaining),
      max: formatDistance(max)
    })
    : game.i18n.format("RIFTS.Movement.MovementExceededOutOfCombat", {
      max: formatDistance(max)
    });
}

function buildNotYourActionMessage(currentActorName = "") {
  return currentActorName
    ? game.i18n.format("RIFTS.Movement.NotYourActionDetailed", { actor: currentActorName })
    : game.i18n.localize("RIFTS.Movement.NotYourAction");
}

function buildPreparedMovementContext(tokenDocument, changes) {
  const actor = getActorFromTokenDocument(tokenDocument);
  if (!actor) return { actor: null, distance: 0, skip: true };

  const distance = measureMoveDistance(tokenDocument, changes);
  if (distance <= 0) return { actor, distance: 0, skip: true };

  return { actor, distance, skip: false };
}

function isMovementBlockedByStatus(actor) {
  return actor?.system?.combat?.derived?.control?.movementBlocked === true;
}

export function clearActorMovementTracking(actor) {
  if (!actor) return null;

  return actor.update({
    "system.combat.movementUsedThisAction": 0,
    "system.combat.movementActionKey": ""
  });
}

async function clearMovementTrackingForCombat(combat) {
  if (!combat || !game.user?.isGM) return;

  for (const combatant of combat.combatants ?? []) {
    const actor = combatant?.actor;
    if (!actor) continue;
    await clearActorMovementTracking(actor);
  }
}

function prepareCombatMovement(tokenDocument, actor, distance, userId) {
  if (!game.combat) return { allow: true };

  const actionState = getCurrentActionState(game.combat, actor, tokenDocument);

  if (!actionState.isCurrent) {
    if (game.user?.isGM) {
      return {
        allow: true,
        inCombat: true,
        trackMovement: false,
        gmOverride: true
      };
    }

    throttledWarn(
      `movement-action:${tokenDocument?.id ?? actor.id}`,
      buildNotYourActionMessage(actionState.currentActorName),
      userId
    );
    return { allow: false };
  }

  const max = getInCombatMovementPerAction(actor);
  const movementState = getMovementStateForAction(actor, actionState.actionKey);
  const remaining = Math.max(0, max - movementState.used);

  if (distance > remaining + 1e-6) {
    throttledWarn(
      `movement-budget:${tokenDocument?.id ?? actor.id}`,
      buildMovementExceededMessage({
        inCombat: true,
        remaining,
        max
      }),
      userId
    );
    return { allow: false };
  }

  return {
    allow: true,
    inCombat: true,
    trackMovement: true,
    actionKey: actionState.actionKey,
    usedBefore: movementState.used
  };
}

function prepareOutOfCombatMovement(actor, distance, tokenDocument, userId) {
  const max = getOutOfCombatMovementLimit(actor);
  if (distance > max + 1e-6) {
    throttledWarn(
      `movement-out-of-combat:${tokenDocument?.id ?? actor.id}`,
      buildMovementExceededMessage({
        inCombat: false,
        max
      }),
      userId
    );
    return { allow: false };
  }

  return { allow: true, inCombat: false, trackMovement: false };
}

export function registerMovementHooks() {
  if (movementHooksRegistered) return;
  movementHooksRegistered = true;

  Hooks.on("preUpdateToken", (tokenDocument, changes, options, userId) => {
    if (shouldBypassMovementEnforcement(options)) return true;

    const prepared = buildPreparedMovementContext(tokenDocument, changes);
    if (prepared.skip || !prepared.actor) return true;

  const { actor, distance } = prepared;
    if (isMovementBlockedByStatus(actor)) {
      throttledWarn(
        `movement-blocked:${tokenDocument?.id ?? actor.id}`,
        game.i18n.localize("RIFTS.Movement.BlockedByControlEffect"),
        userId
      );
      return false;
    }

    const result = game.combat
      ? prepareCombatMovement(tokenDocument, actor, distance, userId)
      : prepareOutOfCombatMovement(actor, distance, tokenDocument, userId);

    if (!result.allow) return false;

    options.riftsMovement = {
      distance,
      actorId: actor.id,
      tokenId: tokenDocument?.id ?? "",
      inCombat: result.inCombat === true,
      trackMovement: result.trackMovement === true,
      actionKey: normalizeText(result.actionKey),
      usedBefore: Math.max(0, num(result.usedBefore, 0))
    };

    return true;
  });

  Hooks.on("updateToken", async (tokenDocument, _changes, options, userId) => {
    if (String(userId ?? "") !== String(game.user?.id ?? "")) return;

    const movement = options?.riftsMovement;
    if (!movement?.trackMovement) return;

    const actor = getActorFromTokenDocument(tokenDocument);
    if (!actor) return;

    const actionKey = normalizeText(movement.actionKey);
    if (!actionKey) return;

    const usedBefore = Math.max(0, num(movement.usedBefore, 0));
    const distance = Math.max(0, num(movement.distance, 0));

    await actor.update({
      "system.combat.movementActionKey": actionKey,
      "system.combat.movementUsedThisAction": usedBefore + distance
    });
  });

  Hooks.on("combatStart", async (combat) => {
    await clearMovementTrackingForCombat(combat);
  });

  Hooks.on("combatRound", async (combat) => {
    await clearMovementTrackingForCombat(combat);
  });

  Hooks.on("deleteCombat", async (combat) => {
    await clearMovementTrackingForCombat(combat);
  });
}
