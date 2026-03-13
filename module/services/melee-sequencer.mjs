const FLAG_SCOPE = "rifts-megaverse";
const FLAG_KEY = "meleeQueue";

let meleeHooksRegistered = false;
const holdActionLocks = new Set();

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getCombatantsInOrder(combat) {
  if (!combat) return [];

  const turns = Array.from(combat.turns ?? []);
  if (turns.length > 0) {
    return turns.filter((entry) => entry?.actor);
  }

  return Array.from(combat.combatants ?? [])
    .filter((entry) => entry?.actor)
    .sort((a, b) => {
      const initDelta = num(b.initiative, 0) - num(a.initiative, 0);
      if (initDelta !== 0) return initDelta;
      return String(a.name ?? "").localeCompare(String(b.name ?? ""));
    });
}

function readApmTotal(actor) {
  if (!actor) return 0;

  if (typeof actor.getApmTotal === "function") {
    return Math.max(0, Math.floor(num(actor.getApmTotal(), 0)));
  }

  return Math.max(0, Math.floor(num(
    actor.system?.combat?.apmTotal,
    num(actor.system?.progression?.attacksPerMelee, 0)
  )));
}

function normalizeState(state, round = 0) {
  const queue = Array.isArray(state?.queue)
    ? state.queue.map((entry) => ({
      actorId: String(entry?.actorId ?? ""),
      tokenId: String(entry?.tokenId ?? ""),
      combatantId: String(entry?.combatantId ?? ""),
      actionIndex: Math.max(1, Math.floor(num(entry?.actionIndex, 1))),
      meleePass: Math.max(1, Math.floor(num(entry?.meleePass, 1))),
      consumed: entry?.consumed === true
    }))
    : [];

  return {
    round: Math.max(0, Math.floor(num(state?.round, round))),
    pointer: Math.max(0, Math.floor(num(state?.pointer, 0))),
    queue
  };
}

function findNextUnconsumedIndex(queue, start = 0) {
  let index = Math.max(0, Math.floor(num(start, 0)));
  while (index < queue.length && queue[index]?.consumed === true) {
    index += 1;
  }

  return index;
}

function getQueueState(combat) {
  if (!combat) return normalizeState(null, 0);
  const raw = combat.getFlag(FLAG_SCOPE, FLAG_KEY);
  return normalizeState(raw, combat.round ?? 0);
}

function refreshCombatTracker() {
  if (typeof ui?.combat?.render !== "function") return;
  ui.combat.render();
}

async function setQueueState(combat, state) {
  if (!combat) return null;
  const normalized = normalizeState(state, combat.round ?? 0);
  await combat.setFlag(FLAG_SCOPE, FLAG_KEY, normalized);
  refreshCombatTracker();
  return normalized;
}

function resolveEntryName(combat, entry) {
  const combatant = combat?.combatants?.get?.(entry.combatantId) ?? null;
  if (combatant?.name) return combatant.name;

  const actor = entry.actorId ? game.actors.get(entry.actorId) : null;
  return actor?.name ?? game.i18n.localize("RIFTS.Combat.UnknownActor");
}

function matchesQueueEntry(current, { actorId = "", tokenId = "" } = {}) {
  if (!current) return false;

  const normalizedTokenId = String(tokenId ?? "");
  const normalizedActorId = String(actorId ?? "");
  const currentTokenId = String(current.tokenId ?? "");
  const currentActorId = String(current.actorId ?? "");

  if (normalizedTokenId) {
    if (currentTokenId) return currentTokenId === normalizedTokenId;
    return normalizedActorId ? currentActorId === normalizedActorId : false;
  }

  return normalizedActorId ? currentActorId === normalizedActorId : false;
}

function getActorHeldCount(actor) {
  return Math.max(0, Math.floor(num(actor?.system?.combat?.heldActionCount, 0)));
}

async function postQueueSummary(combat, state) {
  if (!combat || !state) return;

  const lines = state.queue.map((entry, index) => {
    const name = resolveEntryName(combat, entry);
    return `${index + 1}. ${name} (${game.i18n.localize("RIFTS.Melee.Pass")} ${entry.meleePass}, #${entry.actionIndex})`;
  });

  const content = `
    <div class="rifts-melee-queue-chat">
      <h3>${game.i18n.localize("RIFTS.Melee.Queue")}</h3>
      <p>${game.i18n.localize("RIFTS.Melee.QueuePosition")}: 1/${state.queue.length || 0}</p>
      <pre>${lines.join("\n")}</pre>
    </div>
  `;

  await ChatMessage.create({
    speaker: { alias: game.i18n.localize("RIFTS.Melee.Queue") },
    content
  });
}

async function postCurrentActionMessage(combat, state) {
  if (!combat || !state) return;

  const current = getCurrentMeleeAction(combat, state);
  if (!current) {
    await ChatMessage.create({
      speaker: { alias: game.i18n.localize("RIFTS.Melee.Queue") },
      content: `<p>${game.i18n.localize("RIFTS.Melee.QueueComplete")}</p>`
    });
    return;
  }

  const name = resolveEntryName(combat, current);
  const content = game.i18n.format("RIFTS.Melee.NextActionMessage", {
    actor: name,
    position: current.queuePosition,
    total: current.queueLength,
    pass: current.meleePass
  });

  await ChatMessage.create({
    speaker: { alias: game.i18n.localize("RIFTS.Melee.NextAction") },
    content: `<p>${content}</p>`
  });
}

async function postHeldActionMessage(actor, messageKey, data = {}) {
  if (!actor) return;

  const content = game.i18n.format(messageKey, {
    actor: actor.name,
    ...data
  });

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<p>${content}</p>`
  });
}

async function clearHeldActionsForCombat(combat) {
  if (!game.user?.isGM || !combat) return;

  for (const combatant of combat.combatants) {
    const actor = combatant?.actor;
    if (!actor) continue;

    const heldCount = getActorHeldCount(actor);
    const heldAction = actor.system?.combat?.heldAction === true;
    const heldReady = actor.system?.combat?.heldActionReady === true;

    if (!heldAction && !heldReady && heldCount <= 0) continue;

    await actor.update({
      "system.combat.heldAction": false,
      "system.combat.heldActionCount": 0,
      "system.combat.heldActionReady": false
    });
  }
}

export async function buildMeleeQueue(combat, { announce = false } = {}) {
  if (!combat) return null;

  const orderedCombatants = getCombatantsInOrder(combat)
    .filter((combatant) => combatant?.isDefeated !== true && combatant?.defeated !== true)
    .map((combatant) => {
      const actor = combatant.actor;
      return {
        combatant,
        actor,
        apmTotal: readApmTotal(actor),
        remaining: readApmTotal(actor)
      };
    })
    .filter((entry) => entry.apmTotal > 0);

  const queue = [];
  let meleePass = 1;

  while (true) {
    let addedThisPass = false;

    for (const entry of orderedCombatants) {
      if (entry.remaining <= 0) continue;

      entry.remaining -= 1;
      addedThisPass = true;

      queue.push({
        actorId: entry.actor.id,
        tokenId: entry.combatant.tokenId ?? entry.combatant.token?.id ?? "",
        combatantId: entry.combatant.id,
        actionIndex: entry.apmTotal - entry.remaining,
        meleePass,
        consumed: false
      });
    }

    if (!addedThisPass) break;
    meleePass += 1;
  }

  const state = {
    round: Math.max(0, Math.floor(num(combat.round, 0))),
    pointer: 0,
    queue
  };

  const saved = await setQueueState(combat, state);

  if (announce && game.user?.isGM) {
    await postQueueSummary(combat, saved);
    await postCurrentActionMessage(combat, saved);
  }

  return saved;
}

export async function resetMeleeQueue(combat, { announce = false } = {}) {
  if (!combat) return null;

  const state = getQueueState(combat);
  if (!state.queue.length) {
    return buildMeleeQueue(combat, { announce });
  }

  const reset = {
    round: Math.max(0, Math.floor(num(combat.round, state.round))),
    pointer: 0,
    queue: state.queue.map((entry) => ({ ...entry, consumed: false }))
  };

  const saved = await setQueueState(combat, reset);
  if (announce && game.user?.isGM) {
    await postCurrentActionMessage(combat, saved);
  }

  return saved;
}

export function getCurrentMeleeAction(combat, providedState = null) {
  const state = normalizeState(providedState ?? getQueueState(combat), combat?.round ?? 0);
  if (!state.queue.length) return null;

  const index = findNextUnconsumedIndex(state.queue, state.pointer);
  if (index >= state.queue.length) return null;

  const entry = state.queue[index];
  return {
    ...entry,
    queueIndex: index,
    queuePosition: index + 1,
    queueLength: state.queue.length
  };
}

export function getMeleeQueueState(combat) {
  return getQueueState(combat);
}

export async function holdCurrentMeleeAction({ combat = game.combat, actor = null, tokenId = "", announce = true, allowGMOverride = true } = {}) {
  if (!combat || !actor) return { ok: false, reason: "missing-combat-or-actor" };

  const lockKey = `${combat.id}:${actor.id}:${String(tokenId ?? "")}`;
  if (holdActionLocks.has(lockKey)) {
    return { ok: false, reason: "hold-pending" };
  }

  holdActionLocks.add(lockKey);

  try {
    let state = getQueueState(combat);
    if (!state.queue.length) {
      state = await buildMeleeQueue(combat, { announce: false });
    }

    const current = getCurrentMeleeAction(combat, state);
    if (!current) return { ok: false, reason: "queue-complete" };

    const isCurrentActor = matchesQueueEntry(current, { actorId: actor.id, tokenId });
    if (!isCurrentActor && !(allowGMOverride && game.user?.isGM)) {
      return { ok: false, reason: "not-current", current };
    }

    const existingHeldCount = getActorHeldCount(actor);
    if (existingHeldCount > 0) {
      return { ok: false, reason: "already-held", heldCount: existingHeldCount };
    }

    const spend = typeof actor.spendAttack === "function"
      ? await actor.spendAttack("hold-action")
      : { ok: false };

    if (!spend?.ok) {
      return { ok: false, reason: "no-attacks", spend };
    }

    const queue = [...state.queue];
    queue[current.queueIndex] = {
      ...queue[current.queueIndex],
      consumed: true
    };

    const updated = {
      round: state.round,
      pointer: current.queueIndex + 1,
      queue
    };

    const saved = await setQueueState(combat, updated);
    const heldCount = 1;

    await actor.update({
      "system.combat.heldAction": true,
      "system.combat.heldActionCount": heldCount,
      "system.combat.heldActionReady": false,
      "system.combat.lastAdvancedAction": "holdAction"
    });

    if (announce) {
      await postHeldActionMessage(actor, "RIFTS.Advanced.HoldActionLog", {
        count: heldCount
      });
    }

    if (announce && game.user?.isGM) {
      await postCurrentActionMessage(combat, saved);
    }

    return {
      ok: true,
      heldCount,
      current,
      next: getCurrentMeleeAction(combat, saved)
    };
  } finally {
    holdActionLocks.delete(lockKey);
  }
}
export async function releaseHeldAction(actor, { announce = true } = {}) {
  if (!actor) return { ok: false, reason: "missing-actor" };

  const heldCount = getActorHeldCount(actor);
  if (heldCount <= 0) return { ok: false, reason: "no-held-action" };

  await actor.update({
    "system.combat.heldAction": true,
    "system.combat.heldActionReady": true,
    "system.combat.lastAdvancedAction": "releaseHeldAction"
  });

  if (announce) {
    await postHeldActionMessage(actor, "RIFTS.Advanced.ReleaseHeldActionLog", {
      count: heldCount
    });
  }

  return {
    ok: true,
    heldCount
  };
}

export async function consumeHeldAction(actor, { announce = true, reasonKey = "RIFTS.Advanced.ReleaseHeldActionLog" } = {}) {
  if (!actor) return { ok: false, reason: "missing-actor" };

  const heldCount = getActorHeldCount(actor);
  if (heldCount <= 0) {
    return { ok: false, reason: "no-held-action" };
  }

  const remaining = Math.max(0, heldCount - 1);

  await actor.update({
    "system.combat.heldAction": remaining > 0,
    "system.combat.heldActionCount": remaining,
    "system.combat.heldActionReady": false,
    "system.combat.lastAdvancedAction": "releaseHeldAction"
  });

  if (announce) {
    await postHeldActionMessage(actor, reasonKey, {
      count: remaining
    });
  }

  return {
    ok: true,
    remaining
  };
}

export async function advanceMeleeAction(combat, { announce = true } = {}) {
  if (!combat) return null;

  let state = getQueueState(combat);
  if (!state.queue.length) {
    state = await buildMeleeQueue(combat, { announce: false });
  }

  if (!state || !state.queue.length) return null;

  const current = getCurrentMeleeAction(combat, state);
  if (!current) {
    if (announce && game.user?.isGM) {
      await postCurrentActionMessage(combat, state);
    }
    return { state, current: null, next: null };
  }

  const queue = [...state.queue];
  queue[current.queueIndex] = {
    ...queue[current.queueIndex],
    consumed: true
  };

  const updated = {
    round: state.round,
    pointer: current.queueIndex + 1,
    queue
  };

  const saved = await setQueueState(combat, updated);
  const next = getCurrentMeleeAction(combat, saved);

  if (announce && game.user?.isGM) {
    await postCurrentActionMessage(combat, saved);
  }

  return {
    state: saved,
    current,
    next
  };
}

export function getMeleeQueueStatus(combat, actorId = "", tokenId = "") {
  const state = getQueueState(combat);
  const current = getCurrentMeleeAction(combat, state);

  const hasQueue = state.queue.length > 0;
  const total = state.queue.length;
  const position = current?.queuePosition ?? total;
  const currentActorName = current ? resolveEntryName(combat, current) : game.i18n.localize("RIFTS.Melee.QueueComplete");

  return {
    hasQueue,
    total,
    position,
    currentPass: current?.meleePass ?? 0,
    currentActorId: current?.actorId ?? "",
    currentTokenId: current?.tokenId ?? "",
    currentActorName,
    isCurrentActor: matchesQueueEntry(current, { actorId, tokenId }),
    isComplete: hasQueue && !current
  };
}

export async function canActorTakeMeleeAction(combat, actor, { allowGMOverride = true, tokenId = "" } = {}) {
  if (!combat || !actor) {
    return {
      ok: true,
      isCurrent: true,
      gmOverride: false,
      current: null,
      currentActorName: "",
      reason: "no-combat"
    };
  }

  let state = getQueueState(combat);
  if (!state.queue.length) {
    state = await buildMeleeQueue(combat, { announce: false });
  }

  const current = getCurrentMeleeAction(combat, state);
  if (!current) {
    return {
      ok: true,
      isCurrent: true,
      gmOverride: false,
      current: null,
      currentActorName: "",
      reason: "queue-complete"
    };
  }

  const currentActorName = resolveEntryName(combat, current);

  if (matchesQueueEntry(current, { actorId: actor.id, tokenId })) {
    return {
      ok: true,
      isCurrent: true,
      gmOverride: false,
      current,
      currentActorName,
      reason: "current"
    };
  }

  if (allowGMOverride && game.user?.isGM) {
    return {
      ok: true,
      isCurrent: false,
      gmOverride: true,
      current,
      currentActorName,
      reason: "gm-override"
    };
  }

  return {
    ok: false,
    isCurrent: false,
    gmOverride: false,
    current,
    currentActorName,
    reason: "not-your-action"
  };
}

export async function printMeleeQueue(combat = game.combat) {
  if (!combat) return null;

  const state = getQueueState(combat);
  if (!state.queue.length) {
    const built = await buildMeleeQueue(combat, { announce: false });
    await postQueueSummary(combat, built);
    return built;
  }

  await postQueueSummary(combat, state);
  return state;
}

export function registerMeleeSequencerHooks() {
  if (meleeHooksRegistered) return;
  meleeHooksRegistered = true;

  Hooks.on("combatStart", async (combat) => {
    await clearHeldActionsForCombat(combat);
    await buildMeleeQueue(combat, { announce: true });
  });

  Hooks.on("combatRound", async (combat) => {
    await clearHeldActionsForCombat(combat);
    await buildMeleeQueue(combat, { announce: true });
  });

  Hooks.on("deleteCombat", async (combat) => {
    if (!combat) return;
    await clearHeldActionsForCombat(combat);
  });

  if (game.combat) {
    void buildMeleeQueue(game.combat, { announce: false });
  }
}


