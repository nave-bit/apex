import React, { useState, useEffect, useMemo, useRef } from "react";

/* =========================================================================
   APEX v3 — Liftoff-like physique tracker
   Profil 1er lancement • Rangs recalibrés (plus durs) • XP/Level + décroissance
   Séances préconstruites • Liens YouTube • Cardio (MET, façon Strava)
   Mollets & exos corrigés • Courbes de progression
   ========================================================================= */

/* ----------------------------- TIERS ---------------------------------- */
/* Rangs plus durs : on ajoute Mythique au sommet et on étale les paliers.
   Chaque tier a 3 sous-niveaux -> 27 paliers au total. */
const TIERS = [
  { key: "fer",      label: "Fer",      color: "#7c7f86", glow: "#9aa0a8" },
  { key: "bronze",   label: "Bronze",   color: "#a9682f", glow: "#cd853f" },
  { key: "argent",   label: "Argent",   color: "#9ca3af", glow: "#d6dce4" },
  { key: "or",       label: "Or",       color: "#c9a227", glow: "#f4d03f" },
  { key: "platine",  label: "Platine",  color: "#27a3a3", glow: "#5ce0e0" },
  { key: "diamant",  label: "Diamant",  color: "#4f7bd6", glow: "#7ea8ff" },
  { key: "maitre",   label: "Maître",   color: "#8e44ec", glow: "#c08bff" },
  { key: "elite",    label: "Élite",    color: "#e0245e", glow: "#ff5c8a" },
  { key: "mythique", label: "Mythique", color: "#ff7a00", glow: "#ffb55c" },
];
function scoreToRank(score) {
  const s = Math.max(0, Math.min(0.9999, score));
  const perTier = 1 / TIERS.length;
  const tierIdx = Math.floor(s / perTier);
  const within = (s - tierIdx * perTier) / perTier;
  const sub = 3 - Math.floor(within * 3);
  return { tier: TIERS[tierIdx], sub: Math.max(1, Math.min(3, sub)), within, tierIdx };
}

/* --------------------------- MUSCLES ---------------------------------- */
const MUSCLES = [
  { key: "pecs", label: "Pectoraux" }, { key: "dos", label: "Dos" },
  { key: "epaules", label: "Épaules" }, { key: "biceps", label: "Biceps" },
  { key: "triceps", label: "Triceps" }, { key: "quads", label: "Quadriceps" },
  { key: "ischios", label: "Ischios" }, { key: "fessiers", label: "Fessiers" },
  { key: "abdos", label: "Abdominaux" }, { key: "mollets", label: "Mollets" },
];
const muscleLabel = (k) => MUSCLES.find((m) => m.key === k)?.label || k;

/* -------------------------- EXERCISES --------------------------------- */
/* eliteRatio RELEVÉ (rangs plus durs) : la barre du sommet (Mythique) est
   maintenant un niveau de compétiteur confirmé. yt = recherche YouTube. */
const yt = (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q + " technique musculation")}`;
const EXERCISES = [
  // ---- PECTORAUX ----
  { key: "bench", name: "Développé couché", icon: "▬", primary: "pecs", eliteRatio: 1.9, bw: false,
    muscles: { pecs: 0.6, triceps: 0.25, epaules: 0.15 }, yt: yt("développé couché"),
    aliases: ["bench press", "bench press (barbell)", "developpe couche", "barbell bench press"],
    tips: ["Omoplates serrées, pieds ancrés au sol.", "Barre au bas des pectoraux, coudes à ~45°.", "Descente contrôlée 2 s, pas de rebond."] },
  { key: "bench_db", name: "Développé couché haltères", icon: "▬", primary: "pecs", eliteRatio: 0.85, bw: false, perHand: true,
    muscles: { pecs: 0.6, triceps: 0.25, epaules: 0.15 }, yt: yt("développé couché haltères"),
    aliases: ["bench press (dumbbell)", "dumbbell bench press", "developpe haltere"],
    tips: ["Plus d'amplitude qu'à la barre.", "Contrôle la descente."] },
  { key: "incline", name: "Développé incliné", icon: "◤", primary: "pecs", eliteRatio: 1.6, bw: false,
    muscles: { pecs: 0.6, epaules: 0.25, triceps: 0.15 }, yt: yt("développé incliné barre"),
    aliases: ["incline bench press", "incline bench press (barbell)"],
    tips: ["Banc à 30-45° max.", "Descends vers le haut des pectoraux."] },
  { key: "incline_db", name: "Développé incliné haltères", icon: "◤", primary: "pecs", eliteRatio: 0.7, bw: false, perHand: true,
    muscles: { pecs: 0.6, epaules: 0.25, triceps: 0.15 }, yt: yt("développé incliné haltères"),
    aliases: ["incline bench press (dumbbell)", "incline dumbbell press"],
    tips: ["Congestion du haut des pecs.", "Poignets sous les coudes."] },
  { key: "fly", name: "Écarté", icon: "◇", primary: "pecs", eliteRatio: 0.55, bw: false, perHand: true,
    muscles: { pecs: 0.9, epaules: 0.1 }, yt: yt("écarté haltères pectoraux"),
    aliases: ["chest fly", "dumbbell fly", "cable fly", "pec deck", "écarté", "ecarte", "iso-lateral chest press"],
    tips: ["Léger fléchi du coude fixe.", "Sens l'étirement, contracte en fermant."] },
  { key: "pushup", name: "Pompes", icon: "⊟", primary: "pecs", eliteRatio: 1.25, bw: true,
    muscles: { pecs: 0.55, triceps: 0.3, epaules: 0.15 }, yt: yt("pompes"),
    aliases: ["push up", "push ups", "pompes"],
    tips: ["Corps gainé, ligne droite.", "Poitrine près du sol."] },

  // ---- DOS ----
  { key: "deadlift", name: "Soulevé de terre", icon: "⎯", primary: "dos", eliteRatio: 3.0, bw: false,
    muscles: { dos: 0.35, ischios: 0.3, fessiers: 0.25, quads: 0.1 }, yt: yt("soulevé de terre deadlift"),
    aliases: ["deadlift", "deadlift (barbell)", "conventional deadlift", "souleve de terre"],
    tips: ["Barre collée aux tibias, dos plat.", "Pousse le sol avec les jambes.", "Verrouille hanches et genoux ensemble."] },
  { key: "rdl", name: "Soulevé de terre roumain", icon: "⌐", primary: "ischios", eliteRatio: 2.4, bw: false,
    muscles: { ischios: 0.5, fessiers: 0.35, dos: 0.15 }, yt: yt("soulevé de terre roumain RDL"),
    aliases: ["romanian deadlift", "rdl", "romanian deadlift (barbell)"],
    tips: ["Jambes quasi tendues.", "Hanches vers l'arrière, dos plat."] },
  { key: "pullup", name: "Tractions", icon: "⊓", primary: "dos", eliteRatio: 1.0, bw: true,
    muscles: { dos: 0.6, biceps: 0.3, epaules: 0.1 }, yt: yt("tractions pull up"),
    aliases: ["pull up", "pull ups", "pull up (weighted)", "tractions"],
    tips: ["Bras tendus au départ, menton au-dessus.", "Coudes vers le bas, omoplates serrées."] },
  { key: "chinup", name: "Tractions supination", icon: "⊓", primary: "dos", eliteRatio: 1.05, bw: true,
    muscles: { dos: 0.5, biceps: 0.4, epaules: 0.1 }, yt: yt("tractions supination chin up"),
    aliases: ["chin up", "chin ups"],
    tips: ["Paumes vers toi.", "Plus de biceps."] },
  { key: "latpull", name: "Tirage vertical", icon: "⊤", primary: "dos", eliteRatio: 1.35, bw: false,
    muscles: { dos: 0.65, biceps: 0.25, epaules: 0.1 }, yt: yt("tirage vertical lat pulldown"),
    aliases: ["lat pulldown", "lat pulldown (cable)", "pulldown", "tirage vertical"],
    tips: ["Barre vers le haut de la poitrine.", "Bombe le torse."] },
  { key: "row", name: "Rowing barre", icon: "═", primary: "dos", eliteRatio: 1.6, bw: false,
    muscles: { dos: 0.6, biceps: 0.25, epaules: 0.15 }, yt: yt("rowing barre bent over row"),
    aliases: ["barbell row", "bent over row", "bent over row (barbell)", "rowing barre"],
    tips: ["Buste à ~45°, dos neutre.", "Tire vers le bas-ventre."] },
  { key: "row_db", name: "Rowing haltère", icon: "═", primary: "dos", eliteRatio: 0.8, bw: false, perHand: true,
    muscles: { dos: 0.6, biceps: 0.25, epaules: 0.15 }, yt: yt("rowing haltère un bras"),
    aliases: ["dumbbell row", "one arm row", "dumbbell row (single arm)"],
    tips: ["Un genou sur le banc, dos plat.", "Tire le coude haut et serré."] },
  { key: "row_cable", name: "Tirage horizontal", icon: "═", primary: "dos", eliteRatio: 1.45, bw: false,
    muscles: { dos: 0.6, biceps: 0.25, epaules: 0.15 }, yt: yt("tirage horizontal poulie seated row"),
    aliases: ["seated cable row", "cable row", "seated row"],
    tips: ["Dos droit, tire vers le nombril.", "Ne te penche pas en arrière."] },
  { key: "facepull", name: "Face pull", icon: "⊰", primary: "dos", eliteRatio: 0.55, bw: false,
    muscles: { dos: 0.4, epaules: 0.6 }, yt: yt("face pull"),
    aliases: ["face pull", "cable face pull"],
    tips: ["Tire vers le visage, coudes hauts.", "Bon pour la posture."] },

  // ---- ÉPAULES ----
  { key: "ohp", name: "Développé militaire", icon: "▲", primary: "epaules", eliteRatio: 1.3, bw: false,
    muscles: { epaules: 0.6, triceps: 0.3, pecs: 0.1 }, yt: yt("développé militaire overhead press"),
    aliases: ["overhead press", "ohp", "military press", "shoulder press (barbell)", "developpe militaire", "standing military press"],
    tips: ["Gaine abdos et fessiers.", "Passe la tête sous la barre en haut."] },
  { key: "ohp_db", name: "Développé épaules haltères", icon: "▲", primary: "epaules", eliteRatio: 0.62, bw: false, perHand: true,
    muscles: { epaules: 0.65, triceps: 0.25, pecs: 0.1 }, yt: yt("développé épaules haltères"),
    aliases: ["shoulder press (dumbbell)", "dumbbell shoulder press", "seated shoulder press", "arnold press"],
    tips: ["Plus stable, isole l'épaule.", "Ne verrouille pas brutalement."] },
  { key: "latraise", name: "Élévations latérales", icon: "⊥", primary: "epaules", eliteRatio: 0.32, bw: false, perHand: true,
    muscles: { epaules: 0.95, triceps: 0.05 }, yt: yt("élévations latérales lateral raise"),
    aliases: ["lateral raise", "lateral raise (dumbbell)", "side raise", "elevations laterales", "cable lateral raise"],
    tips: ["Léger fléchi du coude.", "Mène avec les coudes."] },
  { key: "reardelt", name: "Oiseau (arrière d'épaule)", icon: "⊻", primary: "epaules", eliteRatio: 0.28, bw: false, perHand: true,
    muscles: { epaules: 0.9, dos: 0.1 }, yt: yt("oiseau rear delt fly"),
    aliases: ["rear delt fly", "reverse fly", "oiseau", "rear delt reverse fly"],
    tips: ["Buste penché, écarte vers l'arrière."] },
  { key: "shrug", name: "Shrugs (trapèzes)", icon: "⊼", primary: "epaules", eliteRatio: 1.6, bw: false,
    muscles: { epaules: 0.7, dos: 0.3 }, yt: yt("shrugs trapèzes"),
    aliases: ["shrug", "shrugs", "barbell shrug", "dumbbell shrug"],
    tips: ["Monte les épaules vers les oreilles.", "Pause en haut, pas de rotation."] },

  // ---- BICEPS ----
  { key: "curl", name: "Curl biceps barre", icon: "↿", primary: "biceps", eliteRatio: 0.78, bw: false,
    muscles: { biceps: 0.9, epaules: 0.1 }, yt: yt("curl biceps barre"),
    aliases: ["bicep curl", "barbell curl", "bicep curl (barbell)", "curl", "ez bar curl"],
    tips: ["Coudes fixes le long du corps.", "Contracte en haut, descends lentement."] },
  { key: "curl_db", name: "Curl haltères", icon: "↿", primary: "biceps", eliteRatio: 0.42, bw: false, perHand: true,
    muscles: { biceps: 0.9, epaules: 0.1 }, yt: yt("curl biceps haltères"),
    aliases: ["dumbbell curl", "bicep curl (dumbbell)", "incline dumbbell curl"],
    tips: ["Supination en montant.", "Pas de balancier."] },
  { key: "hammer", name: "Curl marteau", icon: "↾", primary: "biceps", eliteRatio: 0.46, bw: false, perHand: true,
    muscles: { biceps: 0.8, epaules: 0.2 }, yt: yt("curl marteau hammer curl"),
    aliases: ["hammer curl", "hammer curl (dumbbell)"],
    tips: ["Prise neutre tout le long.", "Cible le brachial."] },
  { key: "preacher", name: "Curl pupitre", icon: "↿", primary: "biceps", eliteRatio: 0.62, bw: false,
    muscles: { biceps: 0.95, epaules: 0.05 }, yt: yt("curl pupitre preacher curl"),
    aliases: ["preacher curl", "preacher curl (barbell)", "preacher curl (machine)"],
    tips: ["Bras calés sur le pupitre.", "Isole le pic."] },

  // ---- TRICEPS ----
  { key: "dips", name: "Dips", icon: "⊔", primary: "triceps", eliteRatio: 0.85, bw: true,
    muscles: { triceps: 0.5, pecs: 0.35, epaules: 0.15 }, yt: yt("dips triceps"),
    aliases: ["dip", "dips", "triceps dip", "dips (weighted)", "chest dip"],
    tips: ["Buste droit = triceps.", "Descends à ~90° au coude."] },
  { key: "triext", name: "Extension triceps poulie", icon: "↧", primary: "triceps", eliteRatio: 0.7, bw: false,
    muscles: { triceps: 0.95, epaules: 0.05 }, yt: yt("extension triceps poulie pushdown"),
    aliases: ["triceps pushdown", "cable pushdown", "triceps extension", "rope pushdown", "tricep pushdown"],
    tips: ["Coudes collés au corps.", "Tends complètement en bas."] },
  { key: "skullcrusher", name: "Barre au front", icon: "↧", primary: "triceps", eliteRatio: 0.75, bw: false,
    muscles: { triceps: 0.95, epaules: 0.05 }, yt: yt("barre au front skullcrusher"),
    aliases: ["skullcrusher", "lying triceps extension", "ez bar skullcrusher", "triceps extension (barbell)"],
    tips: ["Coudes fixes, descends vers le front."] },
  { key: "overhead_tri", name: "Extension nuque", icon: "↥", primary: "triceps", eliteRatio: 0.5, bw: false,
    muscles: { triceps: 0.95, epaules: 0.05 }, yt: yt("extension triceps nuque overhead"),
    aliases: ["overhead triceps extension", "overhead tricep extension"],
    tips: ["Coudes hauts et serrés.", "Étire bien en bas."] },

  // ---- QUADRICEPS ----
  { key: "squat", name: "Squat", icon: "◢", primary: "quads", eliteRatio: 2.7, bw: false,
    muscles: { quads: 0.55, fessiers: 0.3, ischios: 0.15 }, yt: yt("squat barre technique"),
    aliases: ["squat", "back squat", "barbell squat", "squat (barbell)", "high bar squat"],
    tips: ["Cuisse parallèle au sol minimum.", "Dos neutre, genoux dans l'axe.", "Pousse dans le talon."] },
  { key: "frontsquat", name: "Squat avant", icon: "◢", primary: "quads", eliteRatio: 2.1, bw: false,
    muscles: { quads: 0.65, fessiers: 0.2, ischios: 0.15 }, yt: yt("front squat squat avant"),
    aliases: ["front squat", "front squat (barbell)"],
    tips: ["Barre sur les épaules, coudes hauts.", "Dos droit."] },
  { key: "legpress", name: "Presse à cuisses", icon: "▰", primary: "quads", eliteRatio: 3.8, bw: false,
    muscles: { quads: 0.6, fessiers: 0.25, ischios: 0.15 }, yt: yt("presse à cuisses leg press"),
    aliases: ["leg press", "leg press (machine)", "leg press horizontal"],
    tips: ["Pieds largeur d'épaules.", "Ne décolle pas les fessiers."] },
  { key: "lunge", name: "Fentes", icon: "◿", primary: "quads", eliteRatio: 1.0, bw: false, perHand: true,
    muscles: { quads: 0.45, fessiers: 0.4, ischios: 0.15 }, yt: yt("fentes lunges"),
    aliases: ["lunge", "lunges", "walking lunge", "dumbbell lunge", "bulgarian split squat"],
    tips: ["Grand pas, genou arrière vers le sol.", "Pousse dans le talon avant."] },
  { key: "legext", name: "Leg extension", icon: "◞", primary: "quads", eliteRatio: 0.9, bw: false,
    muscles: { quads: 1.0 }, yt: yt("leg extension"),
    aliases: ["leg extension", "leg extension (machine)"],
    tips: ["Contracte fort en haut.", "Descente contrôlée."] },
  { key: "hacksquat", name: "Hack squat", icon: "◢", primary: "quads", eliteRatio: 2.5, bw: false,
    muscles: { quads: 0.7, fessiers: 0.2, ischios: 0.1 }, yt: yt("hack squat"),
    aliases: ["hack squat", "hack squat (machine)"],
    tips: ["Dos plaqué, descends bas.", "Plus de quadriceps."] },

  // ---- ISCHIOS ----
  { key: "legcurl", name: "Leg curl allongé", icon: "◜", primary: "ischios", eliteRatio: 0.7, bw: false,
    muscles: { ischios: 0.9, mollets: 0.1 }, yt: yt("leg curl allongé"),
    aliases: ["leg curl", "lying leg curl", "hamstring curl", "lying leg curl (machine)"],
    tips: ["Mouvement lent et contrôlé.", "Contracte en fin de flexion."] },
  { key: "legcurl_seated", name: "Leg curl assis", icon: "◜", primary: "ischios", eliteRatio: 0.8, bw: false,
    muscles: { ischios: 0.9, mollets: 0.1 }, yt: yt("seated leg curl"),
    aliases: ["seated leg curl", "seated leg curl (machine)"],
    tips: ["Bassin calé.", "Amplitude complète."] },

  // ---- FESSIERS ----
  { key: "hipthrust", name: "Hip thrust", icon: "⊥", primary: "fessiers", eliteRatio: 2.5, bw: false,
    muscles: { fessiers: 0.7, ischios: 0.2, quads: 0.1 }, yt: yt("hip thrust fessiers"),
    aliases: ["hip thrust", "hip thrust (barbell)", "barbell hip thrust"],
    tips: ["Dos sur le banc aux omoplates.", "Serre les fessiers en haut."] },
  { key: "gluteridge", name: "Glute bridge", icon: "⌒", primary: "fessiers", eliteRatio: 2.0, bw: false,
    muscles: { fessiers: 0.75, ischios: 0.25 }, yt: yt("glute bridge"),
    aliases: ["glute bridge", "barbell glute bridge"],
    tips: ["Version au sol.", "Serre fort en haut."] },
  { key: "abduction", name: "Abduction (machine)", icon: "◹", primary: "fessiers", eliteRatio: 1.2, bw: false,
    muscles: { fessiers: 0.9, quads: 0.1 }, yt: yt("hip abduction machine fessiers"),
    aliases: ["hip abduction", "hip abduction (machine)", "abductor"],
    tips: ["Écarte lentement.", "Petite pause en fin de course."] },

  // ---- ABDOS ----
  { key: "plank", name: "Gainage", icon: "▭", primary: "abdos", isTime: true, eliteSeconds: 300, bw: true,
    muscles: { abdos: 0.9, epaules: 0.1 }, yt: yt("gainage planche plank"),
    aliases: ["plank", "planche", "gainage"],
    tips: ["Corps aligné, fessiers serrés.", "Rentre le nombril."] },
  { key: "legraise", name: "Relevés de jambes", icon: "◳", primary: "abdos", eliteRatio: 0.7, bw: true,
    muscles: { abdos: 0.95, quads: 0.05 }, yt: yt("relevés de jambes suspendu"),
    aliases: ["hanging leg raise", "leg raise", "captain's chair leg raise", "hanging knee raise"],
    tips: ["Suspendu, monte sans balancer.", "Enroule le bassin."] },
  { key: "crunch", name: "Crunch", icon: "◠", primary: "abdos", eliteRatio: 0.6, bw: false,
    muscles: { abdos: 1.0 }, yt: yt("crunch abdominaux"),
    aliases: ["crunch", "cable crunch", "sit up", "situp", "ab crunch"],
    tips: ["Enroule la colonne.", "Expire en montant."] },

  // ---- MOLLETS (corrigés + enrichis) ----
  { key: "calf", name: "Mollets debout", icon: "◣", primary: "mollets", eliteRatio: 2.2, bw: false,
    muscles: { mollets: 1.0 }, yt: yt("mollets debout standing calf raise"),
    aliases: ["standing calf raise", "calf raise", "calf raise (machine)", "calf raise (barbell)",
      "standing calf raise (machine)", "calf press", "calf press (machine)", "smith machine calf raise",
      "mollet", "mollets", "extension mollets", "calves"],
    tips: ["Amplitude max : talon bas, pointe haute.", "Pause 1 s en haut et en bas."] },
  { key: "calf_seated", name: "Mollets assis", icon: "◣", primary: "mollets", eliteRatio: 1.5, bw: false,
    muscles: { mollets: 1.0 }, yt: yt("mollets assis seated calf raise"),
    aliases: ["seated calf raise", "seated calf raise (machine)", "seated calf press"],
    tips: ["Cible le soléaire.", "Tempo lent, gros volume."] },
  { key: "calf_lecalfgpress", name: "Mollets à la presse", icon: "◣", primary: "mollets", eliteRatio: 3.2, bw: false,
    muscles: { mollets: 1.0 }, yt: yt("mollets à la presse leg press calf"),
    aliases: ["calf press on leg press", "leg press calf raise", "calf extension"],
    tips: ["Pointe des pieds en bas du plateau.", "Grande amplitude."] },
];
const EX_BY_KEY = Object.fromEntries(EXERCISES.map((e) => [e.key, e]));
const ALIAS_INDEX = {};
EXERCISES.forEach((e) => { ALIAS_INDEX[e.name.toLowerCase()] = e.key; (e.aliases || []).forEach((a) => (ALIAS_INDEX[a.toLowerCase()] = e.key)); });
function matchExercise(hevyName) {
  if (!hevyName) return null;
  const n = hevyName.toLowerCase().trim().replace(/\s+/g, " ");
  if (ALIAS_INDEX[n]) return ALIAS_INDEX[n];
  for (const [alias, key] of Object.entries(ALIAS_INDEX)) { if (n.includes(alias) || alias.includes(n)) return key; }
  return null;
}

/* ====================== XP / LEVEL SYSTEM ============================= */
/* Chaque série travaillée donne de l'XP au(x) muscle(s) ciblé(s).
   L'XP décroît avec le temps si le muscle n'est pas retravaillé (demi-vie). */
const XP_PER_SET = 10;          // XP de base par série complétée
const XP_HALFLIFE_DAYS = 10;    // l'XP d'un muscle perd la moitié en 10 j sans travail
const LEVEL_BASE = 100;         // XP pour passer level 1->2 (croît ensuite)

function xpForLevel(level) { return Math.round(LEVEL_BASE * Math.pow(level, 1.5)); }
function levelFromXP(totalXp) {
  let lvl = 1, need = xpForLevel(1), acc = 0;
  while (totalXp >= acc + need) { acc += need; lvl++; need = xpForLevel(lvl); }
  return { level: lvl, into: totalXp - acc, need, pct: (totalXp - acc) / need };
}
// applique la décroissance depuis la dernière mise à jour
function decayXp(xp, lastTs, now = Date.now()) {
  if (!xp || !lastTs) return xp || 0;
  const days = (now - lastTs) / 864e5;
  if (days <= 0) return xp;
  return xp * Math.pow(0.5, days / XP_HALFLIFE_DAYS);
}

/* ===================== SÉANCES PRÉCONSTRUITES ======================== */
const PRESET_ROUTINES = [
  { id: "preset_fullbody", name: "Full Body Débutant", preset: true,
    desc: "Tout le corps en une séance, 3×/semaine. Idéal pour démarrer.",
    exercises: [
      { key: "squat", sets: 3, targetReps: 8, rest: 120 },
      { key: "bench", sets: 3, targetReps: 8, rest: 120 },
      { key: "row", sets: 3, targetReps: 10, rest: 90 },
      { key: "ohp_db", sets: 3, targetReps: 10, rest: 90 },
      { key: "legcurl", sets: 3, targetReps: 12, rest: 60 },
      { key: "plank", sets: 3, targetReps: 0, rest: 60 },
    ] },
  { id: "preset_push", name: "Push (Pecs/Épaules/Triceps)", preset: true,
    desc: "Jour de poussée, pour un programme Push/Pull/Legs.",
    exercises: [
      { key: "bench", sets: 4, targetReps: 6, rest: 150 },
      { key: "incline_db", sets: 3, targetReps: 10, rest: 90 },
      { key: "ohp", sets: 3, targetReps: 8, rest: 120 },
      { key: "latraise", sets: 4, targetReps: 15, rest: 60 },
      { key: "triext", sets: 3, targetReps: 12, rest: 60 },
      { key: "dips", sets: 3, targetReps: 10, rest: 90 },
    ] },
  { id: "preset_pull", name: "Pull (Dos/Biceps)", preset: true,
    desc: "Jour de tirage, pour un programme Push/Pull/Legs.",
    exercises: [
      { key: "deadlift", sets: 3, targetReps: 5, rest: 180 },
      { key: "pullup", sets: 4, targetReps: 8, rest: 120 },
      { key: "row", sets: 3, targetReps: 10, rest: 90 },
      { key: "facepull", sets: 3, targetReps: 15, rest: 60 },
      { key: "curl", sets: 3, targetReps: 10, rest: 60 },
      { key: "hammer", sets: 3, targetReps: 12, rest: 60 },
    ] },
  { id: "preset_legs", name: "Legs (Jambes complètes)", preset: true,
    desc: "Jour de jambes, pour un programme Push/Pull/Legs.",
    exercises: [
      { key: "squat", sets: 4, targetReps: 6, rest: 180 },
      { key: "rdl", sets: 3, targetReps: 8, rest: 120 },
      { key: "legpress", sets: 3, targetReps: 12, rest: 90 },
      { key: "legcurl", sets: 3, targetReps: 12, rest: 60 },
      { key: "calf", sets: 4, targetReps: 15, rest: 45 },
    ] },
  { id: "preset_upper", name: "Upper (Haut du corps)", preset: true,
    desc: "Haut du corps complet, pour un programme Upper/Lower.",
    exercises: [
      { key: "bench", sets: 4, targetReps: 8, rest: 120 },
      { key: "row", sets: 4, targetReps: 8, rest: 120 },
      { key: "ohp_db", sets: 3, targetReps: 10, rest: 90 },
      { key: "latpull", sets: 3, targetReps: 10, rest: 90 },
      { key: "curl", sets: 3, targetReps: 12, rest: 60 },
      { key: "triext", sets: 3, targetReps: 12, rest: 60 },
    ] },
  { id: "preset_glutes", name: "Fessiers & Ischios", preset: true,
    desc: "Focus chaîne postérieure et fessiers.",
    exercises: [
      { key: "hipthrust", sets: 4, targetReps: 10, rest: 120 },
      { key: "rdl", sets: 3, targetReps: 10, rest: 90 },
      { key: "lunge", sets: 3, targetReps: 12, rest: 75 },
      { key: "abduction", sets: 3, targetReps: 15, rest: 45 },
      { key: "gluteridge", sets: 3, targetReps: 15, rest: 60 },
    ] },
];

/* ========================= CARDIO (MET) ============================== */
/* Calories = MET × poids(kg) × heures. MET varie selon l'allure. */
const CARDIO_TYPES = [
  { key: "marche", label: "Marche", icon: "🚶", baseMet: 3.5, paceMet: (kmh) => kmh < 4 ? 2.8 : kmh < 5.5 ? 3.5 : kmh < 6.5 ? 5.0 : 6.3, unit: "km" },
  { key: "course", label: "Course", icon: "🏃", baseMet: 9.8, paceMet: (kmh) => kmh < 8 ? 8.3 : kmh < 9.7 ? 9.8 : kmh < 11.3 ? 11.0 : kmh < 12.9 ? 11.8 : kmh < 14.5 ? 12.8 : 14.5, unit: "km" },
  { key: "velo", label: "Vélo", icon: "🚴", baseMet: 7.5, paceMet: (kmh) => kmh < 16 ? 4.0 : kmh < 19 ? 6.8 : kmh < 22.5 ? 8.0 : kmh < 26 ? 10.0 : 12.0, unit: "km" },
  { key: "natation", label: "Natation", icon: "🏊", baseMet: 7.0, paceMet: () => 7.0, unit: "m" },
];
const CARDIO_BY_KEY = Object.fromEntries(CARDIO_TYPES.map((c) => [c.key, c]));
function cardioStats(typeKey, distanceVal, minutes, bw) {
  const t = CARDIO_BY_KEY[typeKey]; if (!t || !minutes) return { kcal: 0, pace: "—", speed: 0 };
  const hours = minutes / 60;
  let distKm = typeKey === "natation" ? (Number(distanceVal) || 0) / 1000 : Number(distanceVal) || 0;
  const speed = distKm > 0 ? distKm / hours : 0;            // km/h
  const met = distKm > 0 ? t.paceMet(speed) : t.baseMet;
  const kcal = Math.round(met * (Number(bw) || 75) * hours);
  let pace = "—";
  if (distKm > 0 && typeKey !== "velo") {
    const minPerKm = minutes / distKm;
    pace = `${Math.floor(minPerKm)}:${String(Math.round((minPerKm % 1) * 60)).padStart(2, "0")} /km`;
  } else if (typeKey === "velo" && speed > 0) pace = `${speed.toFixed(1)} km/h`;
  return { kcal, pace, speed: Math.round(speed * 10) / 10, met };
}

/* -------------------------- NUTRITION --------------------------------- */
const GOALS = {
  seche: { label: "Sèche", kcalFactor: 28, protein: 2.2, fat: 0.8 },
  maintien: { label: "Maintien", kcalFactor: 33, protein: 1.8, fat: 1.0 },
  prise: { label: "Prise de masse", kcalFactor: 39, protein: 2.0, fat: 1.1 },
};
function computeMacros(bw, goalKey) {
  const g = GOALS[goalKey] || GOALS.maintien;
  const kcal = Math.round(bw * g.kcalFactor);
  const protein = Math.round(bw * g.protein), fat = Math.round(bw * g.fat);
  const carbs = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));
  return { kcal, protein, carbs, fat };
}
const MEAL_TIPS = {
  seche: ["Déficit modéré (~300-500 kcal).", "Protéines hautes pour garder le muscle.", "Aliments volumineux et rassasiants.", "Glucides autour de l'entraînement."],
  maintien: ["Mange à hauteur de ta dépense.", "Protéines réparties sur 3-4 repas.", "80 % brut, 20 % plaisir.", "35 ml d'eau/kg/jour."],
  prise: ["Léger surplus (~300-500 kcal).", "Glucides élevés pour le volume.", "Calories liquides si appétit faible.", "+0,25 à +0,5 %/semaine."],
};
function buildMeals(macros) {
  const split = [
    { t: "Petit-déjeuner", p: 0.25, c: 0.30, f: 0.25 }, { t: "Déjeuner", p: 0.30, c: 0.30, f: 0.30 },
    { t: "Collation", p: 0.20, c: 0.15, f: 0.20 }, { t: "Dîner", p: 0.25, c: 0.25, f: 0.25 },
  ];
  const ex = {
    "Petit-déjeuner": (p, c) => `${Math.round(p * 4)} g de skyr, ${Math.round(c / 0.6)} g de flocons d'avoine`,
    "Déjeuner": (p, c) => `${Math.round(p / 0.31)} g de poulet, ${Math.round(c / 0.28)} g de riz cuit, légumes`,
    "Collation": (p, c, f) => `${Math.round(p / 0.1)} g de fromage blanc, ${Math.round(f / 0.6)} g d'amandes`,
    "Dîner": (p, c) => `${Math.round(p / 0.2)} g de poisson, ${Math.round(c / 0.2)} g de patate douce, légumes`,
  };
  return split.map((s) => { const p = Math.round(macros.protein * s.p), c = Math.round(macros.carbs * s.c), f = Math.round(macros.fat * s.f);
    return { t: s.t, p, c, f, kcal: p * 4 + c * 4 + f * 9, ex: ex[s.t](p, c, f) }; });
}

/* --------------------------- HELPERS ---------------------------------- */
function perfToScore(ex, best1RM, bw) {
  if (!best1RM || !bw) return 0;
  if (ex.isTime) return Math.max(0, Math.min(1, best1RM / ex.eliteSeconds));
  let eff = ex.bw ? bw + best1RM : best1RM;
  const target = ex.eliteRatio * bw; if (target <= 0) return 0;
  return Math.max(0, Math.min(1, eff / target));
}
function estimate1RM(weight, reps) {
  const w = Number(weight), r = Number(reps); if (!w || !r) return 0;
  if (r === 1) return Math.round(w); return Math.round(w * (1 + r / 30));
}
function suggestNext(ex, lastSets) {
  if (!lastSets?.length) return null;
  const valid = lastSets.filter((s) => Number(s.weight) && Number(s.reps)); if (!valid.length) return null;
  const top = valid.reduce((a, b) => (Number(b.weight) > Number(a.weight) ? b : a));
  const w = Number(top.weight), r = Number(top.reps);
  if (r >= 8) return { weight: Math.round((w + (ex.perHand ? 2 : 2.5)) * 2) / 2, reps: 8, reason: `Tu avais ${w}kg × ${r}, tente plus lourd` };
  return { weight: w, reps: Math.min(r + 1, 8), reason: `Vise une rep de plus qu'à ${w}kg × ${r}` };
}
const uid = () => Math.random().toString(36).slice(2, 9);
function fmtTime(sec) { const m = Math.floor(sec / 60), s = Math.round(sec % 60); return `${m}:${String(s).padStart(2, "0")}`; }
/* --------------------- PERSISTENCE (localStorage) --------------------- */
const mem = {};
const store = {
  get(k, fb) { try { const v = window.localStorage.getItem(k); return v ? JSON.parse(v) : (mem[k] ?? fb); } catch { return mem[k] ?? fb; } },
  set(k, val) { mem[k] = val; try { window.localStorage.setItem(k, JSON.stringify(val)); } catch {} },
};
const K = { profile: "apex_profile", lifts: "apex_lifts", routines: "apex_routines", history: "apex_history", prs: "apex_prs", xp: "apex_xp", cardio: "apex_cardio", onboarded: "apex_onboarded" };

/* ----------------------------- UI BITS -------------------------------- */
function hexPoints(cx, cy, r) {
  let pts = [];
  for (let i = 0; i < 6; i++) { const a = (Math.PI / 180) * (60 * i - 90); pts.push(`${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`); }
  return pts.join(" ");
}
function RankBadge({ score, size = 64 }) {
  const { tier, sub } = scoreToRank(score); const r = size / 2; const gid = `g-${tier.key}-${size}`;
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <defs><radialGradient id={gid} cx="50%" cy="35%" r="70%"><stop offset="0%" stopColor={tier.glow} /><stop offset="100%" stopColor={tier.color} /></radialGradient></defs>
        <polygon points={hexPoints(r, r, r - 3)} fill={`url(#${gid})`} stroke="rgba(255,255,255,.25)" strokeWidth="1.5" />
        <polygon points={hexPoints(r, r, r - 9)} fill="none" stroke="rgba(0,0,0,.25)" strokeWidth="1" />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, textShadow: "0 1px 3px rgba(0,0,0,.5)", fontSize: size * 0.34, lineHeight: 1 }}>
        {tier.label[0]}<span style={{ fontSize: size * 0.18, fontWeight: 700, opacity: 0.95 }}>{sub}</span>
      </div>
    </div>
  );
}
function ProgressBar({ value, color }) {
  return <div style={{ height: 8, background: "#1b1f27", borderRadius: 99, overflow: "hidden" }}>
    <div style={{ width: `${Math.round(value * 100)}%`, height: "100%", background: `linear-gradient(90deg, ${color}aa, ${color})`, borderRadius: 99, transition: "width .5s cubic-bezier(.2,.8,.2,1)" }} /></div>;
}
/* Mini courbe de progression (1RM dans le temps) */
function ProgressChart({ points }) {
  if (!points || points.length < 2) return <div style={{ fontSize: 12.5, opacity: 0.45, padding: "12px 0" }}>Pas encore assez de données pour tracer une courbe (au moins 2 séances).</div>;
  const W = 300, H = 110, pad = 8;
  const xs = points.map((p) => +new Date(p.date));
  const ys = points.map((p) => p.value);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const sx = (x) => pad + ((x - minX) / (maxX - minX || 1)) * (W - 2 * pad);
  const sy = (y) => H - pad - ((y - minY) / (maxY - minY || 1)) * (H - 2 * pad);
  const d = points.map((p, i) => `${i ? "L" : "M"}${sx(+new Date(p.date)).toFixed(1)},${sy(p.value).toFixed(1)}`).join(" ");
  const area = `${d} L${sx(maxX).toFixed(1)},${H - pad} L${sx(minX).toFixed(1)},${H - pad} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }}>
      <defs><linearGradient id="pg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#e0245e" stopOpacity="0.3" /><stop offset="100%" stopColor="#e0245e" stopOpacity="0" /></linearGradient></defs>
      <path d={area} fill="url(#pg)" />
      <path d={d} fill="none" stroke="#e0245e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {points.map((p, i) => <circle key={i} cx={sx(+new Date(p.date))} cy={sy(p.value)} r="3" fill="#ff5c8a" />)}
      <text x={pad} y={12} fontSize="9" fill="#8a92a0">{maxY} kg</text>
      <text x={pad} y={H - 1} fontSize="9" fill="#8a92a0">{minY} kg</text>
    </svg>
  );
}
function Toast({ msg }) { return msg ? <div style={S.toast}>{msg}</div> : null; }

/* ============================== APP =================================== */

/* ============================== APP =================================== */
export default function App() {
  const [profile, setProfile] = useState(() => store.get(K.profile, null));
  const [onboarded, setOnboarded] = useState(() => store.get(K.onboarded, false));
  const [tab, setTab] = useState("apercu");
  const [lifts, setLifts] = useState(() => store.get(K.lifts, {}));
  const [prs, setPrs] = useState(() => store.get(K.prs, {}));
  const [routines, setRoutines] = useState(() => store.get(K.routines, []));
  const [history, setHistory] = useState(() => store.get(K.history, []));
  const [cardio, setCardio] = useState(() => store.get(K.cardio, []));
  // xp: { muscleKey: { xp, lastTs } }
  const [xpRaw, setXpRaw] = useState(() => store.get(K.xp, {}));
  const [editingRoutine, setEditingRoutine] = useState(null);
  const [liveSession, setLiveSession] = useState(null);
  const [toast, setToast] = useState("");

  useEffect(() => { if (profile) store.set(K.profile, profile); }, [profile]);
  useEffect(() => store.set(K.onboarded, onboarded), [onboarded]);
  useEffect(() => store.set(K.lifts, lifts), [lifts]);
  useEffect(() => store.set(K.prs, prs), [prs]);
  useEffect(() => store.set(K.routines, routines), [routines]);
  useEffect(() => store.set(K.history, history), [history]);
  useEffect(() => store.set(K.cardio, cardio), [cardio]);
  useEffect(() => store.set(K.xp, xpRaw), [xpRaw]);

  const flash = (m) => { setToast(m); setTimeout(() => setToast(""), 2400); };
  const bw = Number(profile?.bodyweight) || 0;

  // XP courant après décroissance
  const xpNow = useMemo(() => {
    const now = Date.now(); const out = {};
    MUSCLES.forEach((m) => { const r = xpRaw[m.key]; out[m.key] = r ? decayXp(r.xp, r.lastTs, now) : 0; });
    return out;
  }, [xpRaw]);
  const totalXp = useMemo(() => Object.values(xpNow).reduce((a, b) => a + b, 0), [xpNow]);
  const levelInfo = useMemo(() => levelFromXP(totalXp), [totalXp]);

  const muscleScores = useMemo(() => {
    const acc = {}; MUSCLES.forEach((m) => (acc[m.key] = { sum: 0, w: 0 }));
    EXERCISES.forEach((ex) => { const rec = lifts[ex.key]; if (!rec?.best1RM) return;
      const s = perfToScore(ex, rec.best1RM, bw);
      Object.entries(ex.muscles).forEach(([mk, w]) => { acc[mk].sum += s * w; acc[mk].w += w; }); });
    const out = {}; MUSCLES.forEach((m) => (out[m.key] = acc[m.key].w > 0 ? acc[m.key].sum / acc[m.key].w : 0));
    return out;
  }, [lifts, bw]);
  const overall = useMemo(() => { const v = Object.values(muscleScores).filter((x) => x > 0); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; }, [muscleScores]);
  const loggedCount = Object.values(lifts).filter((l) => l?.best1RM).length;

  const lastSessionSets = (exKey) => { for (const s of history) { const f = s.exercises?.find((e) => e.key === exKey); if (f) return f.sets; } return null; };
  const progressionFor = (exKey) => {
    const ex = EX_BY_KEY[exKey]; const pts = [];
    [...history].reverse().forEach((s) => { const f = s.exercises?.find((e) => e.key === exKey); if (!f) return;
      let best = 0; f.sets.forEach((st) => { const e = ex.isTime ? Number(st.secs) || 0 : estimate1RM(st.weight, st.reps); if (e > best) best = e; });
      if (best > 0) pts.push({ date: s.date, value: best }); });
    return pts;
  };

  const setBestLift = (exKey, e1rm, weight, reps) => setLifts((prev) => {
    const rec = prev[exKey] || { history: [] };
    const hist = [{ date: new Date().toISOString(), weight, reps, e1rm }, ...(rec.history || [])].slice(0, 50);
    return { ...prev, [exKey]: { best1RM: Math.max(e1rm, rec.best1RM || 0), history: hist } };
  });
  const setPR = (exKey, val) => setPrs((prev) => ({ ...prev, [exKey]: val }));

  // ajoute de l'XP aux muscles travaillés dans une séance
  const grantXp = (sessionExercises) => {
    const now = Date.now(); const gain = {};
    sessionExercises.forEach((se) => {
      const ex = EX_BY_KEY[se.key]; if (!ex) return;
      const doneSets = se.sets.filter((s) => (s.weight && s.reps) || s.secs).length || se.sets.length;
      Object.entries(ex.muscles).forEach(([mk, w]) => { gain[mk] = (gain[mk] || 0) + doneSets * XP_PER_SET * w; });
    });
    setXpRaw((prev) => { const next = { ...prev };
      Object.entries(gain).forEach(([mk, g]) => { const cur = next[mk] ? decayXp(next[mk].xp, next[mk].lastTs, now) : 0; next[mk] = { xp: cur + g, lastTs: now }; });
      return next; });
    return gain;
  };

  const saveRoutine = (r) => { setRoutines((prev) => prev.some((x) => x.id === r.id) ? prev.map((x) => x.id === r.id ? r : x) : [...prev, r]); setEditingRoutine(null); flash("Séance enregistrée ✓"); setTab("seances"); };
  const deleteRoutine = (id) => setRoutines((prev) => prev.filter((r) => r.id !== id));
  const addPreset = (preset) => { setRoutines((prev) => [...prev, { ...preset, id: uid(), preset: false, exercises: preset.exercises.map((e) => ({ ...e })) }]); flash("Séance ajoutée à tes séances ✓"); };

  const completeSession = (session) => {
    const gain = grantXp(session.exercises);
    setHistory((prev) => [{ ...session, id: uid(), date: new Date().toISOString() }, ...prev].slice(0, 300));
    setLifts((prev) => { const next = { ...prev };
      session.exercises.forEach((se) => { const ex = EX_BY_KEY[se.key]; if (!ex) return;
        let best = 0; se.sets.forEach((set) => { const e = ex.isTime ? Number(set.secs) || 0 : estimate1RM(set.weight, set.reps); if (e > best) best = e; });
        if (best > 0) { const rec = next[ex.key] || { history: [] }; next[ex.key] = { best1RM: Math.max(best, rec.best1RM || 0), history: rec.history || [] }; } });
      return next; });
    setLiveSession(null);
    const xpTotal = Math.round(Object.values(gain).reduce((a, b) => a + b, 0));
    flash(`Séance terminée · +${xpTotal} XP ✓`); setTab("historique");
  };

  const addCardio = (entry) => { setCardio((prev) => [{ ...entry, id: uid(), date: new Date().toISOString() }, ...prev].slice(0, 200)); flash(`Cardio enregistré · ${entry.kcal} kcal ✓`); };

  const importBackup = (data) => { if (data.profile) { setProfile(data.profile); setOnboarded(true); } if (data.best_lifts) setLifts(data.best_lifts); if (data.prs) setPrs(data.prs); if (data.routines) setRoutines(data.routines); if (data.sessions) setHistory(data.sessions); if (data.cardio) setCardio(data.cardio); if (data.xp) setXpRaw(data.xp); flash("Sauvegarde importée ✓"); };
  const importHevy = (sessions) => {
    sessions.forEach((s) => grantXp(s.exercises));
    setHistory((prev) => [...sessions, ...prev].slice(0, 300));
    setLifts((prev) => { const next = { ...prev };
      sessions.forEach((s) => s.exercises.forEach((se) => { const ex = EX_BY_KEY[se.key]; if (!ex) return;
        let best = 0; se.sets.forEach((set) => { const e = ex.isTime ? Number(set.secs) || 0 : estimate1RM(set.weight, set.reps); if (e > best) best = e; });
        if (best > 0) { const rec = next[ex.key] || { history: [] }; next[ex.key] = { best1RM: Math.max(best, rec.best1RM || 0), history: rec.history || [] }; } }));
      return next; });
    flash(`${sessions.length} séances importées depuis Hevy ✓`); setTab("historique");
  };
  const importRoutine = (r) => { setRoutines((prev) => [...prev, { ...r, id: uid() }]); flash("Séance importée ✓"); setTab("seances"); };

  // -------- onboarding (1er lancement) --------
  if (!onboarded || !profile) {
    return <Onboarding onDone={(p) => { setProfile(p); setOnboarded(true); }} />;
  }

  return (
    <div style={S.app}>
      <style>{KEYFRAMES}</style>
      <Toast msg={toast} />
      <header style={S.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={S.logo}><span style={{ color: "#e0245e" }}>A</span>PEX</div>
          <span style={S.tagline}>{profile.pseudo || "athlète"}</span>
        </div>
        <div style={S.levelPill}>
          <span style={{ fontSize: 11, opacity: 0.6 }}>Niv.</span>
          <span style={{ fontWeight: 800, fontSize: 16, color: "#ffb55c" }}>{levelInfo.level}</span>
        </div>
      </header>

      <nav style={S.tabs}>
        {[["apercu","Aperçu"],["muscles","Muscles"],["exos","Exercices"],["seances","Séances"],["cardio","Cardio"],["historique","Historique"],["nutrition","Nutrition"],["rangs","Rangs"],["donnees","Données"]].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={{ ...S.tab, ...(tab === k ? S.tabActive : {}) }}>{label}</button>
        ))}
      </nav>

      <main style={S.main}>
        {tab === "apercu" && <Overview overall={overall} muscleScores={muscleScores} loggedCount={loggedCount} setTab={setTab} history={history} levelInfo={levelInfo} totalXp={totalXp} xpNow={xpNow} />}
        {tab === "muscles" && <Muscles muscleScores={muscleScores} xpNow={xpNow} />}
        {tab === "exos" && <ExoByMuscle lifts={lifts} prs={prs} bw={bw} setBestLift={setBestLift} setPR={setPR} progressionFor={progressionFor} flash={flash} />}
        {tab === "seances" && (editingRoutine
          ? <RoutineEditor routine={editingRoutine} onSave={saveRoutine} onCancel={() => setEditingRoutine(null)} />
          : <Seances routines={routines} onNew={() => setEditingRoutine({ id: uid(), name: "", exercises: [] })} onEdit={setEditingRoutine} onDelete={deleteRoutine} onStart={(r) => setLiveSession(r)} onExport={(r) => exportRoutine(r, flash)} onAddPreset={addPreset} />)}
        {tab === "cardio" && <Cardio cardio={cardio} bw={bw} onAdd={addCardio} onClear={() => setCardio([])} />}
        {tab === "historique" && <History history={history} bw={bw} profile={profile} routines={routines} lifts={lifts} prs={prs} onClear={() => setHistory([])} flash={flash} />}
        {tab === "nutrition" && <Nutrition profile={profile} setProfile={setProfile} />}
        {tab === "rangs" && <RanksTab muscleScores={muscleScores} bw={bw} />}
        {tab === "donnees" && <DataTab profile={profile} routines={routines} lifts={lifts} prs={prs} history={history} cardio={cardio} xp={xpRaw} onImportBackup={importBackup} onImportHevy={importHevy} onImportRoutine={importRoutine} flash={flash} />}
      </main>

      {liveSession && <SessionLogger routine={liveSession} lastSessionSets={lastSessionSets} prs={prs} onFinish={completeSession} onCancel={() => setLiveSession(null)} />}
      <footer style={S.footer}>Données sur ton appareil. Pense à exporter une sauvegarde (onglet Données).</footer>
    </div>
  );
}

/* ----------------------- ONBOARDING (1er lancement) ------------------- */
function Onboarding({ onDone }) {
  const [step, setStep] = useState(0);
  const [pseudo, setPseudo] = useState("");
  const [sexe, setSexe] = useState("");
  const [age, setAge] = useState("");
  const [taille, setTaille] = useState("");
  const [poids, setPoids] = useState("");
  const [goal, setGoal] = useState("maintien");
  const num = (v, set) => (e) => { const x = e.target.value.replace(",", "."); if (x === "" || /^\d*\.?\d*$/.test(x)) set(x); };
  const canFinish = pseudo.trim() && taille && poids;

  return (
    <div style={{ ...S.app, justifyContent: "center", padding: "0 18px" }}>
      <style>{KEYFRAMES}</style>
      <div style={{ maxWidth: 420, margin: "0 auto", width: "100%", padding: "40px 0" }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ ...S.logo, fontSize: 38, marginBottom: 6 }}><span style={{ color: "#e0245e" }}>A</span>PEX</div>
          <div style={{ opacity: 0.55, fontSize: 14 }}>Mesure ton physique, monte en rang.</div>
        </div>

        {step === 0 && (
          <div style={{ ...S.card, display: "grid", gap: 14, animation: "fadeIn .3s" }}>
            <div style={{ fontWeight: 800, fontSize: 18 }}>Bienvenue 👋</div>
            <div style={{ opacity: 0.7, fontSize: 14, lineHeight: 1.5 }}>Quelques infos pour personnaliser tes rangs, tes calories et tes suggestions. Tout reste sur ton appareil.</div>
            <label><span style={S.obLabel}>Ton pseudo</span>
              <input value={pseudo} onChange={(e) => setPseudo(e.target.value)} placeholder="ex. Navè" style={S.input} /></label>
            <div><span style={S.obLabel}>Sexe (pour l'estimation des calories)</span>
              <div style={{ display: "flex", gap: 8 }}>
                {[["homme","Homme"],["femme","Femme"],["autre","Ne pas préciser"]].map(([k, l]) => (
                  <button key={k} onClick={() => setSexe(k)} style={{ ...S.goalBtn, ...(sexe === k ? S.goalBtnActive : {}) }}>{l}</button>
                ))}
              </div></div>
            <button style={{ ...S.btnPrimary, padding: 14, opacity: pseudo.trim() ? 1 : 0.4 }} disabled={!pseudo.trim()} onClick={() => setStep(1)}>Continuer →</button>
          </div>
        )}

        {step === 1 && (
          <div style={{ ...S.card, display: "grid", gap: 14, animation: "fadeIn .3s" }}>
            <div style={{ fontWeight: 800, fontSize: 18 }}>Tes mensurations</div>
            <div style={{ display: "flex", gap: 10 }}>
              <label style={{ flex: 1 }}><span style={S.obLabel}>Âge</span><input inputMode="numeric" value={age} onChange={num(age, setAge)} placeholder="25" style={S.input} /></label>
              <label style={{ flex: 1 }}><span style={S.obLabel}>Taille (cm)</span><input inputMode="numeric" value={taille} onChange={num(taille, setTaille)} placeholder="178" style={S.input} /></label>
            </div>
            <label><span style={S.obLabel}>Poids de corps (kg)</span><input inputMode="decimal" value={poids} onChange={num(poids, setPoids)} placeholder="75" style={S.input} /></label>
            <div><span style={S.obLabel}>Ton objectif</span>
              <div style={{ display: "flex", gap: 8 }}>
                {Object.entries(GOALS).map(([k, v]) => <button key={k} onClick={() => setGoal(k)} style={{ ...S.goalBtn, ...(goal === k ? S.goalBtnActive : {}) }}>{v.label}</button>)}
              </div></div>
            <div style={{ display: "flex", gap: 10 }}>
              <button style={S.btnGhost} onClick={() => setStep(0)}>← Retour</button>
              <button style={{ ...S.btnPrimary, flex: 1, padding: 14, opacity: canFinish ? 1 : 0.4 }} disabled={!canFinish}
                onClick={() => onDone({ pseudo: pseudo.trim(), sexe, age: Number(age) || null, height: Number(taille) || null, bodyweight: Number(poids) || 75, goal })}>
                C'est parti ! 💪
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------- OVERVIEW -------------------------------- */
function Overview({ overall, muscleScores, loggedCount, setTab, history, levelInfo, totalXp, xpNow }) {
  const { tier, sub, within } = scoreToRank(overall);
  const sorted = [...MUSCLES].sort((a, b) => muscleScores[b.key] - muscleScores[a.key]);
  const strongest = sorted[0];
  const weakest = [...sorted].reverse().find((m) => muscleScores[m.key] > 0) || sorted[sorted.length - 1];
  const thisWeek = history.filter((s) => (Date.now() - +new Date(s.date)) < 7 * 864e5).length;
  // muscle qui perd de l'XP (pas travaillé récemment)
  const fading = [...MUSCLES].filter((m) => xpNow[m.key] > 5).sort((a, b) => xpNow[a.key] - xpNow[b.key])[0];

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {/* niveau + XP */}
      <section style={{ ...S.card, ...S.heroCard }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={S.levelBadge}><div style={{ fontSize: 10, opacity: 0.7 }}>NIVEAU</div><div style={{ fontSize: 30, fontWeight: 900, color: "#ffb55c", lineHeight: 1 }}>{levelInfo.level}</div></div>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, opacity: 0.6, marginBottom: 4 }}>
              <span>XP total : {Math.round(totalXp)}</span><span>{Math.round(levelInfo.into)} / {levelInfo.need}</span>
            </div>
            <ProgressBar value={levelInfo.pct} color="#ffb55c" />
            <div style={{ fontSize: 11, opacity: 0.5, marginTop: 6 }}>{thisWeek} séance(s) cette semaine · gagne de l'XP en t'entraînant</div>
          </div>
        </div>
      </section>

      {/* rang global */}
      <section style={S.card}>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ animation: "float 4s ease-in-out infinite" }}><RankBadge score={overall} size={76} /></div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, letterSpacing: 2, opacity: 0.5, textTransform: "uppercase" }}>Rang global</div>
            <div style={{ fontSize: 26, fontWeight: 800, color: tier.glow, lineHeight: 1.1 }}>{tier.label} {sub}</div>
            <div style={{ marginTop: 8 }}><ProgressBar value={within} color={tier.glow} /></div>
          </div>
        </div>
      </section>

      {loggedCount === 0 ? (
        <section style={{ ...S.card, textAlign: "center", padding: 28 }}>
          <div style={{ fontSize: 36, marginBottom: 6 }}>◆</div>
          <div style={{ fontWeight: 700, fontSize: 17, marginBottom: 6 }}>Commence ton bilan</div>
          <div style={{ opacity: 0.6, fontSize: 13.5, marginBottom: 16 }}>Enregistre tes charges, importe Hevy, ou choisis une séance préconstruite.</div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
            <button style={S.btnPrimary} onClick={() => setTab("exos")}>Exercices →</button>
            <button style={S.btnGhost} onClick={() => setTab("seances")}>Séances toutes prêtes</button>
          </div>
        </section>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <section style={S.card}><div style={S.miniLabel}>💪 Point fort</div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}><RankBadge score={muscleScores[strongest.key]} size={40} />
                <div><div style={{ fontWeight: 700 }}>{strongest.label}</div><div style={{ fontSize: 12, opacity: 0.6 }}>{scoreToRank(muscleScores[strongest.key]).tier.label} {scoreToRank(muscleScores[strongest.key]).sub}</div></div></div></section>
            <section style={S.card}><div style={S.miniLabel}>🎯 À renforcer</div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}><RankBadge score={muscleScores[weakest.key]} size={40} />
                <div><div style={{ fontWeight: 700 }}>{weakest.label}</div><div style={{ fontSize: 12, opacity: 0.6 }}>{scoreToRank(muscleScores[weakest.key]).tier.label} {scoreToRank(muscleScores[weakest.key]).sub}</div></div></div></section>
          </div>
          {fading && <section style={{ ...S.card, borderColor: "#5a3a1a", background: "#1a140d" }}>
            <div style={{ fontSize: 13.5 }}>⏳ <b>{fading.label}</b> perd de l'XP — entraîne-le pour ne pas régresser.</div></section>}
          <section style={S.card}><div style={S.cardTitle}>Équilibre du physique</div><Radar scores={muscleScores} /></section>
        </>
      )}
    </div>
  );
}

/* ---------------------------- MUSCLES (avec XP) ----------------------- */
function Muscles({ muscleScores, xpNow }) {
  const sorted = [...MUSCLES].sort((a, b) => muscleScores[b.key] - muscleScores[a.key]);
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {sorted.map((m) => {
        const s = muscleScores[m.key]; const { tier, sub, within } = scoreToRank(s);
        const xp = Math.round(xpNow[m.key] || 0);
        return (
          <div key={m.key} style={{ ...S.card, display: "flex", alignItems: "center", gap: 14 }}>
            <RankBadge score={s} size={52} />
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontWeight: 700, fontSize: 15 }}>{m.label}</span>
                <span style={{ color: tier.glow, fontWeight: 700, fontSize: 13 }}>{s > 0 ? `${tier.label} ${sub}` : "Non évalué"}</span>
              </div>
              <div style={{ marginTop: 8 }}><ProgressBar value={s > 0 ? within : 0} color={s > 0 ? tier.glow : "#3a3f4a"} /></div>
              <div style={{ fontSize: 11, opacity: 0.5, marginTop: 5 }}>🔥 {xp} XP de fraîcheur{xp < 5 ? " · à réveiller !" : ""}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ----------------------------- CARDIO -------------------------------- */
function Cardio({ cardio, bw, onAdd, onClear }) {
  const [type, setType] = useState("course");
  const [dist, setDist] = useState("");
  const [mins, setMins] = useState("");
  const num = (set) => (e) => { const x = e.target.value.replace(",", "."); if (x === "" || /^\d*\.?\d*$/.test(x)) set(x); };
  const t = CARDIO_BY_KEY[type];
  const stats = cardioStats(type, dist, Number(mins), bw);
  const totalKcal = cardio.reduce((a, c) => a + (c.kcal || 0), 0);
  const weekCount = cardio.filter((c) => (Date.now() - +new Date(c.date)) < 7 * 864e5).length;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <section style={S.card}>
        <div style={S.cardTitle}>Nouvelle activité cardio</div>
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          {CARDIO_TYPES.map((c) => <button key={c.key} onClick={() => setType(c.key)} style={{ ...S.goalBtn, ...(type === c.key ? S.goalBtnActive : {}), fontSize: 13 }}>{c.icon} {c.label}</button>)}
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
          <label style={{ flex: 1 }}><span style={S.obLabel}>Distance ({t.unit})</span><input inputMode="decimal" value={dist} onChange={num(setDist)} placeholder={t.unit === "m" ? "1500" : "5"} style={S.input} /></label>
          <label style={{ flex: 1 }}><span style={S.obLabel}>Durée (min)</span><input inputMode="decimal" value={mins} onChange={num(setMins)} placeholder="30" style={S.input} /></label>
        </div>
        {Number(mins) > 0 && (
          <div style={{ ...S.previewBox, display: "flex", justifyContent: "space-around", textAlign: "center" }}>
            <div><div style={{ fontWeight: 800, fontSize: 18, color: "#ff5c8a" }}>{stats.kcal}</div><div style={{ fontSize: 11, opacity: 0.6 }}>kcal</div></div>
            <div><div style={{ fontWeight: 800, fontSize: 18 }}>{stats.pace}</div><div style={{ fontSize: 11, opacity: 0.6 }}>allure</div></div>
            {stats.speed > 0 && <div><div style={{ fontWeight: 800, fontSize: 18 }}>{stats.speed}</div><div style={{ fontSize: 11, opacity: 0.6 }}>km/h</div></div>}
          </div>
        )}
        <button style={{ ...S.btnPrimary, width: "100%", marginTop: 12, opacity: Number(mins) > 0 ? 1 : 0.4 }} disabled={!(Number(mins) > 0)}
          onClick={() => { onAdd({ type, distance: Number(dist) || 0, minutes: Number(mins), kcal: stats.kcal, pace: stats.pace, speed: stats.speed, unit: t.unit }); setDist(""); setMins(""); }}>
          Enregistrer
        </button>
      </section>

      {cardio.length > 0 && (
        <section style={S.card}>
          <div style={{ display: "flex", justifyContent: "space-around", textAlign: "center" }}>
            <div><div style={{ fontWeight: 800, fontSize: 20, color: "#ff5c8a" }}>{totalKcal}</div><div style={{ fontSize: 11, opacity: 0.6 }}>kcal cumulées</div></div>
            <div><div style={{ fontWeight: 800, fontSize: 20 }}>{cardio.length}</div><div style={{ fontSize: 11, opacity: 0.6 }}>sorties</div></div>
            <div><div style={{ fontWeight: 800, fontSize: 20 }}>{weekCount}</div><div style={{ fontSize: 11, opacity: 0.6 }}>cette semaine</div></div>
          </div>
        </section>
      )}

      {cardio.map((c) => {
        const ct = CARDIO_BY_KEY[c.type];
        return (
          <div key={c.id} style={{ ...S.card, display: "flex", alignItems: "center", gap: 12, padding: 14 }}>
            <div style={{ fontSize: 26 }}>{ct?.icon}</div>
            <div style={{ flex: 1 }}><div style={{ fontWeight: 700 }}>{ct?.label}</div>
              <div style={{ fontSize: 12, opacity: 0.55 }}>{c.distance}{c.unit} · {c.minutes} min · {c.pace}</div>
              <div style={{ fontSize: 11, opacity: 0.4 }}>{new Date(c.date).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}</div></div>
            <div style={{ textAlign: "right" }}><div style={{ fontWeight: 800, color: "#ff5c8a" }}>{c.kcal}</div><div style={{ fontSize: 11, opacity: 0.5 }}>kcal</div></div>
          </div>
        );
      })}
      {cardio.length > 0 && <button style={{ ...S.btnGhost, color: "#ff6b6b" }} onClick={onClear}>Effacer l'historique cardio</button>}
    </div>
  );
}

/* ----------------------------- RANGS --------------------------------- */
function RanksTab({ muscleScores, bw }) {
  const ordered = [...MUSCLES].sort((a, b) => muscleScores[b.key] - muscleScores[a.key]);
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <section style={S.card}>
        <div style={S.cardTitle}>Les 9 rangs à gravir</div>
        <div style={{ fontSize: 12.5, opacity: 0.6, marginTop: 4, lineHeight: 1.5 }}>Chaque rang a 3 paliers (3 → 1). Du plus accessible au sommet réservé aux athlètes confirmés.</div>
        <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
          {[...TIERS].reverse().map((tr, i) => {
            const idx = TIERS.length - 1 - i;
            const sampleScore = (idx + 0.5) / TIERS.length;
            return (
              <div key={tr.key} style={{ display: "flex", alignItems: "center", gap: 12, background: "#10151d", borderRadius: 10, padding: "8px 12px" }}>
                <RankBadge score={sampleScore} size={40} />
                <div style={{ flex: 1 }}><div style={{ fontWeight: 700, color: tr.glow }}>{tr.label}</div>
                  <div style={{ fontSize: 11, opacity: 0.5 }}>{idx === TIERS.length - 1 ? "Sommet — niveau compétiteur" : idx >= 6 ? "Très avancé" : idx >= 4 ? "Confirmé" : idx >= 2 ? "Intermédiaire" : "Débutant"}</div></div>
              </div>
            );
          })}
        </div>
      </section>
      <section style={S.card}>
        <div style={S.cardTitle}>Tes prochains objectifs</div>
        <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
          {ordered.map((m) => {
            const s = muscleScores[m.key]; const { tier, sub, tierIdx } = scoreToRank(s);
            const atTop = s >= (TIERS.length - 1) / TIERS.length;
            const nextLabel = atTop ? "Sommet atteint 🔥" : sub > 1 ? `${tier.label} ${sub - 1}` : (TIERS[tierIdx + 1] ? `${TIERS[tierIdx + 1].label} 3` : "—");
            return (
              <div key={m.key} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13.5 }}>
                <span style={{ width: 90, opacity: 0.8 }}>{m.label}</span>
                <span style={{ color: tier.glow, fontWeight: 700 }}>{s > 0 ? `${tier.label} ${sub}` : "—"}</span>
                <span style={{ opacity: 0.4 }}>→</span>
                <span style={{ opacity: 0.7 }}>{nextLabel}</span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
function Radar({ scores }) {
  const size = 260, cx = size / 2, cy = size / 2, R = size / 2 - 34, keys = MUSCLES, n = keys.length;
  const pt = (i, r) => { const a = (Math.PI * 2 * i) / n - Math.PI / 2; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
  const poly = keys.map((m, i) => pt(i, R * Math.max(0.04, scores[m.key])).join(",")).join(" ");
  return (
    <div style={{ display: "flex", justifyContent: "center", marginTop: 8 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {[0.25, 0.5, 0.75, 1].map((g) => <polygon key={g} points={keys.map((_, i) => pt(i, R * g).join(",")).join(" ")} fill="none" stroke="#262b35" strokeWidth="1" />)}
        {keys.map((_, i) => { const [x, y] = pt(i, R); return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="#262b35" strokeWidth="1" />; })}
        <polygon points={poly} fill="rgba(224,36,94,.22)" stroke="#e0245e" strokeWidth="2" style={{ animation: "fadeIn .6s ease" }} />
        {keys.map((m, i) => { const [x, y] = pt(i, R * Math.max(0.04, scores[m.key])); return <circle key={m.key} cx={x} cy={y} r="3" fill="#ff5c8a" />; })}
        {keys.map((m, i) => { const [x, y] = pt(i, R + 18); return <text key={m.key} x={x} y={y} fontSize="9.5" fill="#8a92a0" textAnchor="middle" dominantBaseline="middle">{m.label}</text>; })}
      </svg>
    </div>
  );
}

/* ---------------------------- MUSCLES --------------------------------- */
function ExoByMuscle({ lifts, prs, bw, setBestLift, setPR, progressionFor, flash }) {
  const [openMuscle, setOpenMuscle] = useState(MUSCLES[0].key);
  const [openExo, setOpenExo] = useState(null);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {MUSCLES.map((m) => {
        const list = EXERCISES.filter((e) => e.primary === m.key);
        if (!list.length) return null;
        const isMuscleOpen = openMuscle === m.key;
        const doneCount = list.filter((e) => lifts[e.key]?.best1RM).length;
        return (
          <div key={m.key} style={S.card}>
            <div onClick={() => setOpenMuscle(isMuscleOpen ? null : m.key)} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
              <div style={S.muscleDot} />
              <div style={{ flex: 1 }}><div style={{ fontWeight: 800, fontSize: 16 }}>{m.label}</div><div style={{ fontSize: 11.5, opacity: 0.5 }}>{list.length} exercices · {doneCount} renseignés</div></div>
              <span style={{ opacity: 0.4, fontSize: 20, transform: isMuscleOpen ? "rotate(90deg)" : "none", transition: ".2s" }}>›</span>
            </div>
            {isMuscleOpen && (
              <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
                {list.map((ex) => {
                  const rec = lifts[ex.key];
                  const score = rec?.best1RM ? perfToScore(ex, rec.best1RM, bw) : 0;
                  const isOpen = openExo === ex.key;
                  return (
                    <div key={ex.key} style={S.exoInner}>
                      <div onClick={() => setOpenExo(isOpen ? null : ex.key)} style={{ display: "flex", alignItems: "center", gap: 12, cursor: "pointer" }}>
                        <div style={S.exoIcon}>{ex.icon}</div>
                        <div style={{ flex: 1 }}><div style={{ fontWeight: 700, fontSize: 14 }}>{ex.name}{ex.perHand ? <span style={{ fontSize: 11, opacity: 0.5, fontWeight: 500 }}> /main</span> : null}</div>
                          <div style={{ fontSize: 12, opacity: 0.55 }}>{rec?.best1RM ? (ex.isTime ? `Record : ${rec.best1RM}s` : `1RM estimé : ${rec.best1RM} kg`) : "Aucune donnée"}{prs[ex.key] ? ` · PR ${prs[ex.key]}kg` : ""}</div></div>
                        {rec?.best1RM ? <RankBadge score={score} size={36} /> : <span style={{ fontSize: 12, color: "#e0245e", fontWeight: 600 }}>+ Ajouter</span>}
                      </div>
                      {isOpen && (
                        <div style={{ marginTop: 12, borderTop: "1px solid #232833", paddingTop: 12 }}>
                          <ExoForm ex={ex} bw={bw} onSave={(e, w, r) => { setBestLift(ex.key, e, w, r); flash("Performance enregistrée ✓"); }} />
                          <PRInput ex={ex} value={prs[ex.key]} onSave={(v) => { setPR(ex.key, v); flash("PR enregistré ✓"); }} />
                          <div style={{ marginTop: 14 }}><div style={S.miniLabel}>Progression (1RM estimé)</div><div style={{ marginTop: 6 }}><ProgressChart points={progressionFor(ex.key)} /></div></div>
                          <div style={{ marginTop: 14 }}><div style={S.miniLabel}>Muscles ciblés</div>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                              {Object.entries(ex.muscles).sort((a, b) => b[1] - a[1]).map(([mk, w]) => <span key={mk} style={{ ...S.chip, opacity: 0.4 + w * 0.6 }}>{muscleLabel(mk)} {Math.round(w * 100)}%</span>)}
                            </div></div>
                          <div style={{ marginTop: 14 }}><div style={S.miniLabel}>Conseils de forme</div><ul style={S.tipList}>{ex.tips.map((t, i) => <li key={i} style={S.tipItem}>{t}</li>)}</ul></div>
                          {ex.yt && <a href={ex.yt} target="_blank" rel="noopener noreferrer" style={{ ...S.btnGhost, display: "block", textAlign: "center", textDecoration: "none", marginTop: 12, color: "#ff5c8a" }}>▶ Voir la technique sur YouTube</a>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
function ExoForm({ ex, bw, onSave }) {
  const [weight, setWeight] = useState(""); const [reps, setReps] = useState(""); const [secs, setSecs] = useState("");
  if (ex.isTime) {
    const preview = Number(secs) || 0; const score = preview ? perfToScore(ex, preview, bw) : 0;
    return (
      <div>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
          <Field label="Temps tenu (s)" value={secs} onChange={setSecs} placeholder="ex. 90" />
          <button style={{ ...S.btnPrimary, opacity: preview ? 1 : 0.4 }} disabled={!preview} onClick={() => { onSave(preview, 0, 0); setSecs(""); }}>Valider</button>
        </div>
        {preview > 0 && <div style={S.previewBox}>Rang estimé : <b style={{ color: scoreToRank(score).tier.glow }}>{scoreToRank(score).tier.label} {scoreToRank(score).sub}</b></div>}
      </div>
    );
  }
  const e1rm = estimate1RM(weight, reps); const score = e1rm ? perfToScore(ex, e1rm, bw) : 0;
  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
        <Field label={ex.bw ? "Charge ajoutée (kg)" : ex.perHand ? "Charge / main (kg)" : "Charge (kg)"} value={weight} onChange={setWeight} placeholder={ex.bw ? "0 = poids du corps" : "ex. 80"} />
        <Field label="Répétitions" value={reps} onChange={setReps} placeholder="ex. 5" />
        <button style={{ ...S.btnPrimary, opacity: e1rm ? 1 : 0.4 }} disabled={!e1rm} onClick={() => { onSave(e1rm, Number(weight), Number(reps)); setWeight(""); setReps(""); }}>Valider</button>
      </div>
      {e1rm > 0 && <div style={S.previewBox}>1RM estimé : <b>{e1rm} kg</b> · Rang : <b style={{ color: scoreToRank(score).tier.glow }}>{scoreToRank(score).tier.label} {scoreToRank(score).sub}</b>{ex.bw && <span style={{ opacity: 0.5 }}> (corps {bw} + {weight || 0})</span>}</div>}
    </div>
  );
}

/* PR optionnel */
function PRInput({ ex, value, onSave }) {
  const [open, setOpen] = useState(false); const [v, setV] = useState(value ? String(value) : "");
  if (ex.isTime) return null;
  return (
    <div style={{ marginTop: 12, background: "#0e1218", borderRadius: 10, padding: "10px 12px" }}>
      <div onClick={() => setOpen(!open)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, opacity: 0.8 }}>🏆 Record personnel (PR) {value ? `: ${value} kg` : "(optionnel)"}</span>
        <span style={{ fontSize: 12, color: "#e0245e" }}>{open ? "Fermer" : value ? "Modifier" : "Ajouter"}</span>
      </div>
      {open && (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 8 }}>
          <Field label="Charge max (kg)" value={v} onChange={setV} placeholder="ex. 120" />
          <button style={S.btnPrimary} onClick={() => { onSave(Number(v) || 0); setOpen(false); }}>OK</button>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, onChange, placeholder }) {
  return (
    <label style={{ display: "block", flex: "1 1 110px" }}>
      <span style={{ fontSize: 11, opacity: 0.55, display: "block", marginBottom: 4 }}>{label}</span>
      <input type="text" inputMode="decimal" value={value} placeholder={placeholder}
        onChange={(e) => { const v = e.target.value.replace(",", "."); if (v === "" || /^\d*\.?\d*$/.test(v)) onChange(v); }} style={S.input} />
    </label>
  );
}

/* ---------------------------- SÉANCES --------------------------------- */

/* ---------------------------- SÉANCES --------------------------------- */
function Seances({ routines, onNew, onEdit, onDelete, onStart, onExport, onAddPreset }) {
  const [showPresets, setShowPresets] = useState(routines.length === 0);
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <button style={{ ...S.btnPrimary, width: "100%", padding: 14, fontSize: 15 }} onClick={onNew}>+ Créer ma séance</button>

      <section style={S.card}>
        <div onClick={() => setShowPresets(!showPresets)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}>
          <div><div style={{ fontWeight: 800, fontSize: 16 }}>📋 Séances préconstruites</div><div style={{ fontSize: 11.5, opacity: 0.5 }}>{PRESET_ROUTINES.length} programmes prêts à l'emploi</div></div>
          <span style={{ opacity: 0.4, fontSize: 20, transform: showPresets ? "rotate(90deg)" : "none", transition: ".2s" }}>›</span>
        </div>
        {showPresets && (
          <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
            {PRESET_ROUTINES.map((p) => (
              <div key={p.id} style={S.exoInner}>
                <div style={{ fontWeight: 700, fontSize: 14.5 }}>{p.name}</div>
                <div style={{ fontSize: 12, opacity: 0.55, marginTop: 2 }}>{p.desc}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 8 }}>{p.exercises.map((e) => <span key={e.key} style={{ ...S.chip, fontSize: 11 }}>{EX_BY_KEY[e.key]?.name || e.key}</span>)}</div>
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button style={{ ...S.btnPrimary, flex: 1, fontSize: 13 }} onClick={() => onStart({ ...p, id: uid() })}>▶ Démarrer</button>
                  <button style={{ ...S.btnGhost, fontSize: 13 }} onClick={() => onAddPreset(p)}>+ Mes séances</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {routines.length > 0 && <div style={{ ...S.miniLabel, marginTop: 4 }}>Mes séances</div>}
      {routines.map((r) => (
        <div key={r.id} style={S.card}>
          <div style={{ fontWeight: 800, fontSize: 17 }}>{r.name || "Séance sans nom"}</div>
          <div style={{ fontSize: 12.5, opacity: 0.55, marginTop: 2 }}>{r.exercises.length} exercices</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>{r.exercises.map((e) => <span key={e.key} style={S.chip}>{EX_BY_KEY[e.key]?.name || e.key}</span>)}</div>
          <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
            <button style={{ ...S.btnPrimary, flex: 1 }} onClick={() => onStart(r)}>▶ Démarrer</button>
            <button style={S.btnGhost} onClick={() => onEdit(r)}>Modifier</button>
            <button style={S.btnGhost} onClick={() => onExport(r)}>Partager</button>
            <button style={{ ...S.btnGhost, color: "#ff6b6b" }} onClick={() => onDelete(r.id)}>Suppr.</button>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------- ROUTINE EDITOR ----------------------------- */
function RoutineEditor({ routine, onSave, onCancel }) {
  const [name, setName] = useState(routine.name || "");
  const [exercises, setExercises] = useState(routine.exercises || []);
  const [picker, setPicker] = useState(false);
  const toggle = (key) => setExercises((prev) => prev.some((e) => e.key === key) ? prev.filter((e) => e.key !== key) : [...prev, { key, sets: 3, targetReps: 8, rest: 90 }]);
  const isSel = (key) => exercises.some((e) => e.key === key);
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <section style={S.card}><div style={S.miniLabel}>Nom de la séance</div>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="ex. Push lundi…" style={{ ...S.input, marginTop: 8 }} /></section>
      <section style={S.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={S.cardTitle}>Exercices ({exercises.length})</div>
          <button style={S.btnGhost} onClick={() => setPicker(!picker)}>{picker ? "Fermer" : "+ Ajouter"}</button>
        </div>
        {exercises.length === 0 && !picker && <div style={{ opacity: 0.5, fontSize: 13.5, marginTop: 8 }}>Touche « + Ajouter ».</div>}
        {!picker && exercises.map((e) => { const ex = EX_BY_KEY[e.key];
          return (
            <div key={e.key} style={{ ...S.exoInner, marginTop: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}><div style={S.exoIcon}>{ex.icon}</div>
                <div style={{ flex: 1, fontWeight: 700, fontSize: 14 }}>{ex.name}</div>
                <button style={{ ...S.btnGhost, color: "#ff6b6b", padding: "4px 10px" }} onClick={() => toggle(e.key)}>×</button></div>
              <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                <MiniNum label="Séries" value={e.sets} onChange={(v) => setExercises((p) => p.map((x) => x.key === e.key ? { ...x, sets: v } : x))} />
                {!ex.isTime && <MiniNum label="Reps" value={e.targetReps} onChange={(v) => setExercises((p) => p.map((x) => x.key === e.key ? { ...x, targetReps: v } : x))} />}
                <MiniNum label="Repos (s)" value={e.rest || 90} step={15} onChange={(v) => setExercises((p) => p.map((x) => x.key === e.key ? { ...x, rest: v } : x))} />
              </div>
            </div>
          ); })}
        {picker && (
          <div style={{ marginTop: 10, display: "grid", gap: 12 }}>
            {MUSCLES.map((m) => { const list = EXERCISES.filter((e) => e.primary === m.key); if (!list.length) return null;
              return (
                <div key={m.key}><div style={{ ...S.miniLabel, marginBottom: 6 }}>{m.label}</div>
                  <div style={{ display: "grid", gap: 6 }}>
                    {list.map((ex) => (
                      <div key={ex.key} onClick={() => toggle(ex.key)} style={{ ...S.pickRow, ...(isSel(ex.key) ? S.pickRowOn : {}) }}>
                        <div style={{ ...S.exoIcon, width: 32, height: 32, fontSize: 16 }}>{ex.icon}</div>
                        <span style={{ flex: 1, fontWeight: 600, fontSize: 13.5 }}>{ex.name}</span>
                        <span style={{ fontSize: 18, color: isSel(ex.key) ? "#e0245e" : "#3a3f4a", fontWeight: 800 }}>{isSel(ex.key) ? "✓" : "+"}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ); })}
          </div>
        )}
      </section>
      <div style={{ display: "flex", gap: 10 }}>
        <button style={{ ...S.btnPrimary, flex: 1, padding: 14, opacity: exercises.length ? 1 : 0.4 }} disabled={!exercises.length} onClick={() => onSave({ id: routine.id, name, exercises })}>Enregistrer</button>
        <button style={S.btnGhost} onClick={onCancel}>Annuler</button>
      </div>
    </div>
  );
}
function MiniNum({ label, value, onChange, step = 1 }) {
  return (
    <div style={{ flex: 1 }}><div style={{ fontSize: 10.5, opacity: 0.5, marginBottom: 3 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button style={S.stepBtn} onClick={() => onChange(Math.max(step, value - step))}>−</button>
        <span style={{ minWidth: 28, textAlign: "center", fontWeight: 700 }}>{value}</span>
        <button style={S.stepBtn} onClick={() => onChange(value + step)}>+</button>
      </div>
    </div>
  );
}

function SessionLogger({ routine, lastSessionSets, prs, onFinish, onCancel }) {
  const [elapsed, setElapsed] = useState(0);            // chrono séance
  const [rest, setRest] = useState(0);                  // chrono repos restant
  const [restTotal, setRestTotal] = useState(0);
  const startRef = useRef(Date.now());
  const [data, setData] = useState(() =>
    routine.exercises.map((e) => {
      const ex = EX_BY_KEY[e.key];
      return { key: e.key, rest: e.rest || 90, sets: Array.from({ length: e.sets || 3 }, () => (ex.isTime ? { secs: "", done: false } : { weight: "", reps: String(e.targetReps || ""), done: false })) };
    })
  );

  // chrono séance
  useEffect(() => {
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  // chrono repos
  useEffect(() => {
    if (rest <= 0) return;
    const id = setInterval(() => setRest((r) => Math.max(0, r - 1)), 1000);
    return () => clearInterval(id);
  }, [rest]);

  const update = (ei, si, field, val) => {
    const v = val.replace(",", ".");
    if (v !== "" && !/^\d*\.?\d*$/.test(v)) return;
    setData((prev) => prev.map((ex, i) => i !== ei ? ex : { ...ex, sets: ex.sets.map((s, j) => j !== si ? s : { ...s, [field]: v }) }));
  };
  const validateSet = (ei, si) => {
    setData((prev) => prev.map((ex, i) => i !== ei ? ex : { ...ex, sets: ex.sets.map((s, j) => j !== si ? s : { ...s, done: !s.done }) }));
    const r = data[ei].rest || 90; setRest(r); setRestTotal(r);
  };
  const addSet = (ei) => setData((prev) => prev.map((ex, i) => i !== ei ? ex : { ...ex, sets: [...ex.sets, EX_BY_KEY[ex.key].isTime ? { secs: "", done: false } : { weight: "", reps: "", done: false }] }));

  return (
    <div style={S.overlay}>
      <div style={S.sheet}>
        {/* barre chrono fixe */}
        <div style={S.chronoBar}>
          <div><div style={{ fontSize: 10, opacity: 0.5, textTransform: "uppercase", letterSpacing: 1 }}>Durée séance</div>
            <div style={{ fontSize: 24, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{fmtTime(elapsed)}</div></div>
          {rest > 0 ? (
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 10, opacity: 0.5, textTransform: "uppercase", letterSpacing: 1 }}>Repos</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: "#5ce0e0", fontVariantNumeric: "tabular-nums" }}>{fmtTime(rest)}</div>
              <div style={{ display: "flex", gap: 4, marginTop: 2, justifyContent: "flex-end" }}>
                <button style={S.restMini} onClick={() => setRest((r) => r + 15)}>+15</button>
                <button style={S.restMini} onClick={() => setRest(0)}>skip</button>
              </div>
            </div>
          ) : <button style={S.btnGhost} onClick={onCancel}>Quitter</button>}
        </div>

        {/* barre de progression du repos */}
        {rest > 0 && <div style={{ height: 4, background: "#1b1f27", borderRadius: 99, overflow: "hidden", marginBottom: 12 }}>
          <div style={{ height: "100%", width: `${(rest / (restTotal || 1)) * 100}%`, background: "#5ce0e0", transition: "width 1s linear" }} /></div>}

        <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 10 }}>{routine.name || "Séance"}</div>

        <div style={{ display: "grid", gap: 12 }}>
          {data.map((ex, ei) => {
            const meta = EX_BY_KEY[ex.key];
            const last = lastSessionSets(ex.key);
            const sugg = !meta.isTime ? suggestNext(meta, last) : null;
            const pr = prs[ex.key];
            return (
              <div key={ex.key} style={S.card}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <div style={S.exoIcon}>{meta.icon}</div>
                  <div style={{ flex: 1 }}><div style={{ fontWeight: 700 }}>{meta.name}</div>
                    {last && <div style={{ fontSize: 11.5, opacity: 0.5 }}>Dernière fois : {last.filter(s=>s.weight&&s.reps).map((s) => `${s.weight}×${s.reps}`).join(", ") || "—"}</div>}</div>
                </div>
                {sugg && <div style={S.suggBox}>💡 {sugg.reason} (suggéré : {sugg.weight}kg × {sugg.reps})</div>}
                <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
                  {ex.sets.map((set, si) => {
                    const isPR = !meta.isTime && pr && Number(set.weight) > Number(pr) && Number(set.reps) >= 1;
                    return (
                      <div key={si} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ width: 22, fontSize: 12, opacity: 0.5, fontWeight: 700 }}>{si + 1}</span>
                        {meta.isTime ? (
                          <input type="text" inputMode="decimal" placeholder="secondes" value={set.secs} onChange={(e) => update(ei, si, "secs", e.target.value)} style={{ ...S.logInput, ...(set.done ? S.logDone : {}) }} />
                        ) : (
                          <>
                            <input type="text" inputMode="decimal" placeholder="kg" value={set.weight} onChange={(e) => update(ei, si, "weight", e.target.value)} style={{ ...S.logInput, ...(set.done ? S.logDone : {}), ...(isPR ? S.logPR : {}) }} />
                            <span style={{ opacity: 0.4 }}>×</span>
                            <input type="text" inputMode="numeric" placeholder="reps" value={set.reps} onChange={(e) => update(ei, si, "reps", e.target.value)} style={{ ...S.logInput, ...(set.done ? S.logDone : {}) }} />
                          </>
                        )}
                        {isPR && <span title="Nouveau record !" style={{ fontSize: 16 }}>🏆</span>}
                        <button style={{ ...S.checkBtn, ...(set.done ? S.checkOn : {}) }} onClick={() => validateSet(ei, si)}>✓</button>
                      </div>
                    );
                  })}
                </div>
                <button style={{ ...S.btnGhost, marginTop: 8, fontSize: 12 }} onClick={() => addSet(ei)}>+ série</button>
              </div>
            );
          })}
        </div>

        <button style={{ ...S.btnPrimary, width: "100%", padding: 15, marginTop: 16, fontSize: 15 }}
          onClick={() => onFinish({ routineId: routine.id, name: routine.name, durationSec: elapsed, exercises: data.map((ex) => ({ key: ex.key, sets: ex.sets.map(({ done, ...rest }) => rest) })) })}>
          ✓ Terminer la séance ({fmtTime(elapsed)})
        </button>
      </div>
    </div>
  );
}

/* --------------------------- HISTORIQUE ------------------------------- */
function History({ history, bw, profile, routines, lifts, prs, onClear, flash }) {
  const volumeOf = (s) => { let v = 0; s.exercises.forEach((ex) => ex.sets.forEach((st) => { v += (Number(st.weight) || 0) * (Number(st.reps) || 0); })); return Math.round(v); };
  // comparaison avec la séance précédente du même nom
  const prevSameName = (s, idx) => history.slice(idx + 1).find((h) => h.name === s.name && h.routineId === s.routineId);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {history.length === 0 ? (
        <div style={{ ...S.card, textAlign: "center", padding: 28, opacity: 0.6 }}>Aucune séance terminée. Démarre une séance depuis l'onglet « Séances », ou importe ton historique Hevy depuis « Données ».</div>
      ) : (
        <>
          {history.map((s, idx) => {
            const vol = volumeOf(s); const prev = prevSameName(s, idx); const prevVol = prev ? volumeOf(prev) : null;
            const diff = prevVol != null ? vol - prevVol : null;
            return (
              <div key={s.id} style={S.card}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div><div style={{ fontWeight: 800, fontSize: 16 }}>{s.name || "Séance"}</div>
                    <div style={{ fontSize: 12, opacity: 0.55 }}>{new Date(s.date).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" })}{s.durationSec ? ` · ${fmtTime(s.durationSec)}` : ""}{s.source === "hevy" ? " · Hevy" : ""}</div></div>
                  <div style={{ textAlign: "right" }}><div style={{ fontSize: 11, opacity: 0.4 }}>Volume</div>
                    <div style={{ fontWeight: 800, color: "#ff5c8a" }}>{vol} kg</div>
                    {diff != null && <div style={{ fontSize: 11, fontWeight: 700, color: diff >= 0 ? "#4ade80" : "#ff6b6b" }}>{diff >= 0 ? "▲" : "▼"} {Math.abs(diff)} kg vs préc.</div>}</div>
                </div>
                <div style={{ display: "grid", gap: 4, marginTop: 10 }}>
                  {s.exercises.map((ex) => {
                    const meta = EX_BY_KEY[ex.key]; const done = ex.sets.filter((st) => (st.weight && st.reps) || st.secs).length;
                    return <div key={ex.key} style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                      <span style={{ opacity: 0.85 }}>{meta?.name || ex.key}</span><span style={{ opacity: 0.5 }}>{done} séries</span></div>;
                  })}
                </div>
              </div>
            );
          })}
          <button style={{ ...S.btnGhost, color: "#ff6b6b" }} onClick={onClear}>Effacer tout l'historique</button>
        </>
      )}
    </div>
  );
}

/* --------------------------- NUTRITION -------------------------------- */
function Nutrition({ profile, setProfile }) {
  const bw = Number(profile.bodyweight) || 75;
  const macros = computeMacros(bw, profile.goal);
  const meals = buildMeals(macros);
  const goalLabel = (GOALS[profile.goal] || GOALS.maintien).label;
  const bars = [
    { label: "Protéines", g: macros.protein, kcal: macros.protein * 4, color: "#e0245e" },
    { label: "Glucides", g: macros.carbs, kcal: macros.carbs * 4, color: "#27a3a3" },
    { label: "Lipides", g: macros.fat, kcal: macros.fat * 9, color: "#c9a227" },
  ];
  const totalK = bars.reduce((a, m) => a + m.kcal, 0) || 1;
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <section style={S.card}><div style={S.miniLabel}>Mon objectif</div>
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          {Object.entries(GOALS).map(([k, v]) => <button key={k} onClick={() => setProfile({ ...profile, goal: k })} style={{ ...S.goalBtn, ...(profile.goal === k ? S.goalBtnActive : {}) }}>{v.label}</button>)}
        </div></section>
      <section style={S.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={S.cardTitle}>Cibles journalières</div>
          <div style={{ fontSize: 26, fontWeight: 800, color: "#ff5c8a" }}>{macros.kcal} <span style={{ fontSize: 14, opacity: 0.6, fontWeight: 600 }}>kcal</span></div>
        </div>
        <div style={{ display: "flex", height: 12, borderRadius: 99, overflow: "hidden", marginTop: 14 }}>{bars.map((m) => <div key={m.label} style={{ width: `${(m.kcal / totalK) * 100}%`, background: m.color }} />)}</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginTop: 14 }}>
          {bars.map((m) => <div key={m.label} style={{ textAlign: "center" }}><div style={{ width: 10, height: 10, borderRadius: 3, background: m.color, margin: "0 auto 4px" }} /><div style={{ fontWeight: 800, fontSize: 18 }}>{m.g}g</div><div style={{ fontSize: 11, opacity: 0.55 }}>{m.label}</div></div>)}
        </div>
      </section>
      <section style={S.card}><div style={S.cardTitle}>Conseils {goalLabel.toLowerCase()}</div><ul style={S.tipList}>{MEAL_TIPS[profile.goal].map((t, i) => <li key={i} style={S.tipItem}>{t}</li>)}</ul></section>
      <section style={S.card}><div style={S.cardTitle}>Répartition sur la journée (quantités)</div>
        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
          {meals.map((meal, i) => (
            <div key={i} style={{ background: "#0e1218", borderRadius: 10, padding: "11px 13px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontWeight: 700, color: "#ff8fb0", fontSize: 13.5 }}>{meal.t}</span>
                <span style={{ fontSize: 12, opacity: 0.6 }}>{meal.kcal} kcal · P{meal.p} G{meal.c} L{meal.f}</span>
              </div>
              <div style={{ fontSize: 13, opacity: 0.8, marginTop: 4 }}>{meal.ex}</div>
            </div>
          ))}
        </div>
      </section>
      <div style={{ fontSize: 11, opacity: 0.4, textAlign: "center", lineHeight: 1.5 }}>Estimations selon ton poids de corps ({bw} kg). Adapte selon ton activité et consulte un professionnel pour un suivi personnalisé.</div>
    </div>
  );
}

function DataTab({ profile, routines, lifts, prs, history, cardio, xp, onImportBackup, onImportHevy, onImportRoutine, flash }) {
  const fileBackup = useRef(); const fileHevy = useRef(); const fileRoutine = useRef();
  const [hevyReport, setHevyReport] = useState(null);

  const exportBackup = () => download("apex-sauvegarde.json", JSON.stringify({ schema: "apex.v3", exported_at: new Date().toISOString(), profile, routines, best_lifts: lifts, prs, sessions: history, cardio, xp }, null, 2), "application/json");
  const exportCSV = () => {
    const rows = [["session_id", "date", "seance", "exercice", "muscle", "serie", "poids_kg", "reps", "secondes", "e1rm_kg"]];
    history.forEach((s) => s.exercises.forEach((ex) => { const meta = EX_BY_KEY[ex.key];
      ex.sets.forEach((set, i) => rows.push([s.id, s.date, s.name || "", meta?.name || ex.key, meta?.primary || "", i + 1, set.weight || "", set.reps || "", set.secs || "", meta?.isTime ? "" : estimate1RM(set.weight, set.reps) || ""])); }));
    download("apex-sessions.csv", rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n"), "text/csv");
  };
  const readFile = (input, cb) => { const f = input.current?.files?.[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => cb(rd.result); rd.readAsText(f); };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <section style={S.card}>
        <div style={S.cardTitle}>📥 Importer depuis Hevy</div>
        <div style={{ fontSize: 12.5, opacity: 0.6, marginTop: 4, lineHeight: 1.5 }}>Dans Hevy : Profil → Réglages → Exporter les données → Exporter les entraînements. Récupère le fichier CSV et charge-le ici.</div>
        <input ref={fileHevy} type="file" accept=".csv" style={{ display: "none" }} onChange={() => readFile(fileHevy, (txt) => { const { sessions, unmatched } = parseHevy(txt); if (!sessions.length) { flash("Aucune séance reconnue dans ce fichier"); return; } setHevyReport({ count: sessions.length, unmatched }); onImportHevy(sessions); })} />
        <button style={{ ...S.btnPrimary, width: "100%", marginTop: 12 }} onClick={() => fileHevy.current?.click()}>Choisir le fichier Hevy (.csv)</button>
        {hevyReport && (
          <div style={{ ...S.previewBox, marginTop: 10 }}>
            ✓ {hevyReport.count} séances importées.
            {hevyReport.unmatched.length > 0 && <div style={{ marginTop: 6, fontSize: 12, opacity: 0.6 }}>Non reconnus (ignorés) : {hevyReport.unmatched.slice(0, 8).join(", ")}{hevyReport.unmatched.length > 8 ? "…" : ""}</div>}
          </div>
        )}
      </section>

      <section style={S.card}>
        <div style={S.cardTitle}>💾 Sauvegarde complète</div>
        <div style={{ fontSize: 12.5, opacity: 0.6, marginTop: 4, lineHeight: 1.5 }}>Exporte toutes tes données (profil, records, séances, historique) pour les sauvegarder ou les transférer sur un autre appareil.</div>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button style={{ ...S.btnPrimary, flex: 1 }} onClick={exportBackup}>⬇ Exporter</button>
          <input ref={fileBackup} type="file" accept=".json" style={{ display: "none" }} onChange={() => readFile(fileBackup, (txt) => { try { onImportBackup(JSON.parse(txt)); } catch { flash("Fichier invalide"); } })} />
          <button style={{ ...S.btnGhost, flex: 1 }} onClick={() => fileBackup.current?.click()}>⬆ Importer</button>
        </div>
      </section>

      <section style={S.card}>
        <div style={S.cardTitle}>📊 Export pour base de données</div>
        <div style={{ fontSize: 12.5, opacity: 0.6, marginTop: 4, lineHeight: 1.5 }}>Exporte tes séries en CSV/JSON pour les analyser dans un tableur ou une BDD (Supabase, Sheets…).</div>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button style={{ ...S.btnPrimary, flex: 1 }} onClick={exportCSV} disabled={!history.length}>⬇ CSV</button>
          <button style={{ ...S.btnPrimary, flex: 1 }} onClick={exportBackup} disabled={!history.length}>⬇ JSON</button>
        </div>
      </section>

      <section style={S.card}>
        <div style={S.cardTitle}>🔗 Importer une séance partagée</div>
        <div style={{ fontSize: 12.5, opacity: 0.6, marginTop: 4, lineHeight: 1.5 }}>Reçu un fichier de séance d'un ami ? Charge-le pour l'ajouter à tes séances.</div>
        <input ref={fileRoutine} type="file" accept=".json" style={{ display: "none" }} onChange={() => readFile(fileRoutine, (txt) => { try { const d = JSON.parse(txt); if (d.routine) onImportRoutine(d.routine); else flash("Fichier de séance invalide"); } catch { flash("Fichier invalide"); } })} />
        <button style={{ ...S.btnGhost, width: "100%", marginTop: 12 }} onClick={() => fileRoutine.current?.click()}>Charger une séance (.json)</button>
      </section>
    </div>
  );
}

function download(filename, content, mime) {
  try { const blob = new Blob([content], { type: mime }); const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {}
}
function exportRoutine(r, flash) {
  download(`apex-seance-${(r.name || "sans-nom").replace(/\s+/g, "-")}.json`, JSON.stringify({ schema: "apex.routine.v1", routine: { name: r.name, exercises: r.exercises } }, null, 2), "application/json");
  flash && flash("Séance exportée ✓");
}

/* Parseur CSV simple (gère les guillemets) */
function parseCSV(text) {
  const rows = []; let row = [], cur = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c; }
    else { if (c === '"') inQ = true; else if (c === ",") { row.push(cur); cur = ""; } else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; } else cur += c; }
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.length > 1);
}
/* Convertit l'export Hevy en séances APEX */
function parseHevy(text) {
  const rows = parseCSV(text); if (!rows.length) return { sessions: [], unmatched: [] };
  const header = rows[0].map((h) => h.toLowerCase().trim());
  const col = (name) => header.indexOf(name);
  const ci = { title: col("title"), start: col("start_time"), ex: col("exercise_title"), setIdx: col("set_index"), wlbs: col("weight_lbs"), wkg: col("weight_kg"), reps: col("reps"), dur: col("duration_seconds") };
  const byWorkout = {}; const unmatched = new Set();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; if (!r[ci.ex]) continue;
    const wkKey = `${r[ci.title]}__${r[ci.start]}`;
    const exKey = matchExercise(r[ci.ex]);
    if (!exKey) { unmatched.add(r[ci.ex]); continue; }
    let weight = 0;
    if (ci.wkg >= 0 && r[ci.wkg]) weight = Number(r[ci.wkg]);
    else if (ci.wlbs >= 0 && r[ci.wlbs]) weight = Math.round(Number(r[ci.wlbs]) * 0.4536 * 2) / 2; // lbs->kg
    const reps = Number(r[ci.reps]) || 0;
    const secs = Number(r[ci.dur]) || 0;
    if (!byWorkout[wkKey]) byWorkout[wkKey] = { name: r[ci.title] || "Séance Hevy", date: r[ci.start], exercises: {} };
    if (!byWorkout[wkKey].exercises[exKey]) byWorkout[wkKey].exercises[exKey] = [];
    const ex = EX_BY_KEY[exKey];
    byWorkout[wkKey].exercises[exKey].push(ex.isTime ? { secs: String(secs) } : { weight: String(weight), reps: String(reps) });
  }
  const sessions = Object.values(byWorkout).map((w) => ({
    id: uid(), source: "hevy", name: w.name,
    date: parseHevyDate(w.date),
    exercises: Object.entries(w.exercises).map(([key, sets]) => ({ key, sets })),
  })).filter((s) => s.exercises.length);
  return { sessions, unmatched: [...unmatched] };
}
function parseHevyDate(str) {
  if (!str) return new Date().toISOString();
  const d = new Date(str); if (!isNaN(d)) return d.toISOString();
  // format "28 Mar 2025, 17:29"
  const d2 = new Date(str.replace(",", "")); return isNaN(d2) ? new Date().toISOString() : d2.toISOString();
}
/* ----------------------------- STYLES --------------------------------- */
const S = {
  levelPill: { display: "flex", alignItems: "center", gap: 6, background: "#161b22", padding: "6px 14px", borderRadius: 99, border: "1px solid #2a3140" },
  levelBadge: { width: 70, height: 70, borderRadius: 16, background: "#0e1218", border: "1px solid #2a3140", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  obLabel: { fontSize: 11, opacity: 0.55, display: "block", marginBottom: 5, marginTop: 2 },
  app: { maxWidth: 560, margin: "0 auto", minHeight: "100vh", background: "#0d1015", color: "#e8ecf2", fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", display: "flex", flexDirection: "column" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 18px 14px", position: "sticky", top: 0, zIndex: 10, background: "linear-gradient(180deg, #0d1015 70%, rgba(13,16,21,0))" },
  logo: { fontSize: 24, fontWeight: 900, letterSpacing: 1 },
  tagline: { fontSize: 11, opacity: 0.4, letterSpacing: 1, textTransform: "uppercase" },
  bwPill: { display: "flex", alignItems: "center", gap: 6, background: "#161b22", padding: "6px 12px", borderRadius: 99, border: "1px solid #232833" },
  bwInput: { width: 48, background: "transparent", border: "none", color: "#fff", fontWeight: 700, fontSize: 15, textAlign: "right", outline: "none" },
  tabs: { display: "flex", gap: 4, padding: "0 12px 8px", overflowX: "auto" },
  tab: { flexShrink: 0, padding: "8px 14px", borderRadius: 99, border: "none", background: "transparent", color: "#8a92a0", fontSize: 13.5, fontWeight: 600, cursor: "pointer", transition: ".2s", whiteSpace: "nowrap" },
  tabActive: { background: "#e0245e", color: "#fff" },
  main: { flex: 1, padding: "8px 14px 24px" },
  footer: { padding: "16px 18px 28px", fontSize: 11, opacity: 0.35, lineHeight: 1.5, textAlign: "center" },
  card: { background: "#141921", border: "1px solid #1f2530", borderRadius: 16, padding: 18 },
  heroCard: { background: "linear-gradient(135deg, #1a1f2b 0%, #141921 60%)", border: "1px solid #2a3140" },
  cardTitle: { fontWeight: 700, fontSize: 15, marginBottom: 4 },
  miniLabel: { fontSize: 11, letterSpacing: 1, opacity: 0.5, textTransform: "uppercase", fontWeight: 600 },
  muscleDot: { width: 10, height: 10, borderRadius: 99, background: "#e0245e", boxShadow: "0 0 8px #e0245e" },
  exoInner: { background: "#10151d", border: "1px solid #1c222d", borderRadius: 12, padding: 12 },
  exoIcon: { width: 44, height: 44, borderRadius: 12, background: "#1c2230", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, color: "#ff5c8a", flexShrink: 0 },
  chip: { background: "#1c2230", padding: "4px 10px", borderRadius: 99, fontSize: 12, color: "#cdd4de" },
  tipList: { margin: "8px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 7 },
  tipItem: { fontSize: 13.5, lineHeight: 1.45, paddingLeft: 18, position: "relative", opacity: 0.85 },
  input: { width: "100%", boxSizing: "border-box", background: "#0e1218", border: "1px solid #2a313d", borderRadius: 10, padding: "10px 12px", color: "#fff", fontSize: 15, outline: "none" },
  logInput: { flex: 1, minWidth: 0, width: "100%", boxSizing: "border-box", background: "#0e1218", border: "1px solid #2a313d", borderRadius: 8, padding: "9px 10px", color: "#fff", fontSize: 15, outline: "none", textAlign: "center" },
  logDone: { borderColor: "#2e7d4f", background: "#10201a" },
  logPR: { borderColor: "#c9a227", background: "#1f1c10" },
  previewBox: { marginTop: 12, background: "#0e1218", borderRadius: 10, padding: "10px 12px", fontSize: 13.5 },
  suggBox: { background: "#10201a", border: "1px solid #1d3b2c", borderRadius: 8, padding: "8px 10px", fontSize: 12.5, color: "#8fe0b0" },
  btnPrimary: { background: "#e0245e", color: "#fff", border: "none", borderRadius: 10, padding: "10px 18px", fontWeight: 700, fontSize: 14, cursor: "pointer", whiteSpace: "nowrap" },
  btnGhost: { background: "#1c2230", color: "#cdd4de", border: "1px solid #2a313d", borderRadius: 10, padding: "10px 14px", fontWeight: 600, fontSize: 13.5, cursor: "pointer", whiteSpace: "nowrap" },
  stepBtn: { width: 30, height: 30, borderRadius: 8, border: "1px solid #2a313d", background: "#1c2230", color: "#fff", fontSize: 18, fontWeight: 700, cursor: "pointer", lineHeight: 1 },
  checkBtn: { width: 34, height: 34, borderRadius: 8, border: "1px solid #2a313d", background: "#1c2230", color: "#4a5160", fontSize: 16, fontWeight: 800, cursor: "pointer", flexShrink: 0 },
  checkOn: { background: "#2e7d4f", color: "#fff", borderColor: "#2e7d4f" },
  pickRow: { display: "flex", alignItems: "center", gap: 10, background: "#10151d", border: "1px solid #1c222d", borderRadius: 10, padding: "8px 12px", cursor: "pointer", transition: ".15s" },
  pickRowOn: { borderColor: "#e0245e", background: "#1a1016" },
  goalBtn: { flex: 1, padding: "10px 8px", borderRadius: 10, border: "1px solid #2a313d", background: "#0e1218", color: "#8a92a0", fontWeight: 600, fontSize: 13.5, cursor: "pointer" },
  goalBtnActive: { background: "#e0245e", color: "#fff", borderColor: "#e0245e" },
  overlay: { position: "fixed", inset: 0, background: "rgba(6,8,12,.82)", backdropFilter: "blur(4px)", zIndex: 100, display: "flex", justifyContent: "center", alignItems: "flex-end" },
  sheet: { width: "100%", maxWidth: 560, maxHeight: "94vh", overflowY: "auto", background: "#0d1015", borderTopLeftRadius: 22, borderTopRightRadius: 22, border: "1px solid #232833", padding: "16px 16px 28px", animation: "slideUp .28s cubic-bezier(.2,.8,.2,1)" },
  chronoBar: { display: "flex", justifyContent: "space-between", alignItems: "center", background: "#141921", border: "1px solid #232833", borderRadius: 14, padding: "12px 16px", marginBottom: 12, position: "sticky", top: 0, zIndex: 5 },
  restMini: { background: "#1c2230", border: "1px solid #2a313d", color: "#cdd4de", borderRadius: 6, padding: "2px 8px", fontSize: 11, fontWeight: 600, cursor: "pointer" },
  toast: { position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", background: "#1a1f2b", border: "1px solid #2a3140", color: "#fff", padding: "10px 18px", borderRadius: 99, fontSize: 13.5, fontWeight: 600, zIndex: 200, boxShadow: "0 8px 24px rgba(0,0,0,.4)", animation: "slideDown .25s ease" },
};
const KEYFRAMES = `
  @keyframes float { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-6px)} }
  @keyframes fadeIn { from{opacity:0} to{opacity:1} }
  @keyframes slideUp { from{transform:translateY(40px);opacity:0} to{transform:translateY(0);opacity:1} }
  @keyframes slideDown { from{transform:translate(-50%,-16px);opacity:0} to{transform:translate(-50%,0);opacity:1} }
  ::-webkit-scrollbar { height:0; width:0; }
  input::-webkit-outer-spin-button, input::-webkit-inner-spin-button { -webkit-appearance:none; margin:0; }
  ul li::before { content:"›"; position:absolute; left:4px; color:#e0245e; font-weight:700; }
`;
