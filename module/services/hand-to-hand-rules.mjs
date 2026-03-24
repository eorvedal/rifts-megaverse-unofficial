export const HTH_SPECIAL_RULE_IDS = Object.freeze([
  "kickAttack",
  "critRange19",
  "critRange18",
  "critRange17",
  "knockoutStun18",
  "knockoutStun17",
  "deathBlow20",
  "deathBlow19",
  "bodyThrow",
  "pullRollBonus"
]);

export const HTH_SPECIAL_RULE_ID_SET = new Set(HTH_SPECIAL_RULE_IDS);

export function normalizeHandToHandSpecialRuleId(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (HTH_SPECIAL_RULE_ID_SET.has(raw)) return raw;

  const compact = raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (["kickattack", "kick"].includes(compact)) return "kickAttack";
  if (["critrange19", "crit19", "critical19", "criticalstrike19"].includes(compact)) return "critRange19";
  if (["critrange18", "crit18", "critical18", "criticalstrike18"].includes(compact)) return "critRange18";
  if (["critrange17", "crit17", "critical17", "criticalstrike17"].includes(compact)) return "critRange17";
  if (["knockoutstun18", "kostun18", "stun18", "knockout18"].includes(compact)) return "knockoutStun18";
  if (["knockoutstun17", "kostun17", "stun17", "knockout17"].includes(compact)) return "knockoutStun17";
  if (["deathblow20", "death20", "deathblow"].includes(compact)) return "deathBlow20";
  if (["deathblow19", "death19"].includes(compact)) return "deathBlow19";
  if (["bodythrow", "bodyflip", "bodythrowflip", "judostylebodythrow", "judostylebodyflip"].includes(compact)) return "bodyThrow";
  if (["pullrollbonus", "pullroll", "pullpunchbonus", "rollwithpunchbonus"].includes(compact)) return "pullRollBonus";
  return "";
}
