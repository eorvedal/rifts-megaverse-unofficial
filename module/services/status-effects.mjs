function normalizeText(value) {
  return String(value ?? "").trim();
}

function getEffectStatuses(effect) {
  if (!effect) return [];
  if (effect.statuses instanceof Set) return Array.from(effect.statuses);
  if (Array.isArray(effect.statuses)) return effect.statuses;

  const sourceStatuses = foundry.utils.getProperty(effect, "_source.statuses");
  if (Array.isArray(sourceStatuses)) return sourceStatuses;

  const fallbackStatusId = foundry.utils.getProperty(effect, "flags.core.statusId");
  return fallbackStatusId ? [fallbackStatusId] : [];
}

export function effectHasStatus(effect, statusId) {
  if (!effect || !statusId) return false;
  return getEffectStatuses(effect).includes(statusId);
}

export function getConfiguredStatusDefinition(candidates = []) {
  const configured = Array.isArray(CONFIG.statusEffects) ? CONFIG.statusEffects : [];

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeText(candidate);
    if (!normalizedCandidate) continue;

    const match = configured.find((entry) => String(entry?.id ?? "") === normalizedCandidate);
    if (match) return match;
  }

  return null;
}

export function isRiftsGeneratedStatusEffect(effect) {
  const source = normalizeText(foundry.utils.getProperty(effect, "flags.rifts-megaverse.source"));
  const generatedStatus = normalizeText(foundry.utils.getProperty(effect, "flags.rifts-megaverse.generatedStatus"));
  return Boolean(source && generatedStatus);
}

export function findMatchingGeneratedStatusEffect(actor, statusId) {
  if (!actor || !statusId) return null;
  return actor.effects?.find?.((effect) =>
    isRiftsGeneratedStatusEffect(effect) && effectHasStatus(effect, statusId)
  ) ?? null;
}

export function registerStatusEffectHooks() {
  Hooks.on("preCreateActiveEffect", (effect, data) => {
    const actor = effect?.parent;
    if (!actor || actor.documentName !== "Actor") return;

    const incomingStatuses = Array.isArray(data?.statuses) ? data.statuses.filter(Boolean) : [];
    if (incomingStatuses.length !== 1) return;

    const incomingStatusId = normalizeText(incomingStatuses[0]);
    if (!incomingStatusId) return;

    const incomingSource = normalizeText(foundry.utils.getProperty(data, "flags.rifts-megaverse.source"));
    if (incomingSource) return;

    const matchingGenerated = findMatchingGeneratedStatusEffect(actor, incomingStatusId);
    if (!matchingGenerated) return;

    queueMicrotask(async () => {
      if (!matchingGenerated.parent) return;
      await matchingGenerated.delete();
    });

    return false;
  });
}
