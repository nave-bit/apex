import React, { useState, useEffect, useMemo, useRef } from "react";

/* ----------------------------- SUPABASE -------------------------------- */
// supabase est initialisé de façon lazy au 1er montage du composant AccountBox.
// Si les variables VITE_ ne sont pas définies, toute la section "Compte" est
// désactivée — l'app fonctionne normalement en mode local uniquement.
let _supabaseClient = null;
async function getSupabase() {
  if (_supabaseClient) return _supabaseClient;
  const url = import.meta?.env?.VITE_SUPABASE_URL;
  const key = import.meta?.env?.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  try {
    const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
    _supabaseClient = createClient(url, key);
    return _supabaseClient;
  } catch { return null; }
}

/* ----------------------- SYNCHRO CLOUD (apex_data) -------------------- */
// Clés localStorage synchronisées (doit rester aligné avec K + apex_measures).
const SYNC_KEYS = ["apex_profile","apex_lifts","apex_routines","apex_history","apex_prs","apex_xp","apex_cardio","apex_onboarded","apex_measures"];

function readLocalBundle() {
  const out = {};
  for (const k of SYNC_KEYS) {
    try { const v = window.localStorage.getItem(k); if (v != null) out[k] = JSON.parse(v); } catch {}
  }
  return out;
}
function writeLocalBundle(bundle) {
  if (!bundle || typeof bundle !== "object") return false;
  let changed = false;
  for (const k of SYNC_KEYS) {
    if (!(k in bundle)) continue;
    const next = JSON.stringify(bundle[k]);
    if (window.localStorage.getItem(k) !== next) { window.localStorage.setItem(k, next); changed = true; }
  }
  return changed;
}

const cloudSync = {
  async pull(client, userId) {
    const { data, error } = await client.from("apex_data").select("data").eq("user_id", userId).maybeSingle();
    if (error) return { ok: false, error };
    return { ok: true, data: data?.data ?? null };
  },
  async push(client, userId) {
    const bundle = readLocalBundle();
    const { error } = await client.from("apex_data").upsert({ user_id: userId, data: bundle, updated_at: new Date().toISOString() });
    return { ok: !error, error };
  },
};

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
  { key: "bench", name: "Développé couché", icon: "▬", primary: "pecs", eliteRatio: 2.18, bw: false,
    muscles: { pecs: 0.6, triceps: 0.25, epaules: 0.15 }, yt: yt("développé couché"),
    aliases: ["bench press", "bench press (barbell)", "developpe couche", "barbell bench press", "développé couché (barre)"],
    tips: ["Omoplates serrées, pieds ancrés au sol.", "Barre au bas des pectoraux, coudes à ~45°.", "Descente contrôlée 2 s, pas de rebond."] },
  { key: "bench_db", name: "Développé couché haltères", icon: "▬", primary: "pecs", eliteRatio: 0.98, bw: false, perHand: true,
    muscles: { pecs: 0.6, triceps: 0.25, epaules: 0.15 }, yt: yt("développé couché haltères"),
    aliases: ["bench press (dumbbell)", "dumbbell bench press", "developpe haltere", "développé couché (haltère)"],
    tips: ["Plus d'amplitude qu'à la barre.", "Contrôle la descente."] },
  { key: "incline", name: "Développé incliné", icon: "◤", primary: "pecs", eliteRatio: 1.84, bw: false,
    muscles: { pecs: 0.6, epaules: 0.25, triceps: 0.15 }, yt: yt("développé incliné barre"),
    aliases: ["incline bench press", "incline bench press (barbell)", "développé couché incliné (barre)"],
    tips: ["Banc à 30-45° max.", "Descends vers le haut des pectoraux."] },
  { key: "incline_db", name: "Développé incliné haltères", icon: "◤", primary: "pecs", eliteRatio: 0.8, bw: false, perHand: true,
    muscles: { pecs: 0.6, epaules: 0.25, triceps: 0.15 }, yt: yt("développé incliné haltères"),
    aliases: ["incline bench press (dumbbell)", "incline dumbbell press", "développé couché incliné (haltère)"],
    tips: ["Congestion du haut des pecs.", "Poignets sous les coudes."] },
  { key: "fly", name: "Écarté", icon: "◇", primary: "pecs", eliteRatio: 0.63, bw: false, perHand: true,
    muscles: { pecs: 0.9, epaules: 0.1 }, yt: yt("écarté haltères pectoraux"),
    aliases: ["chest fly", "dumbbell fly", "cable fly", "pec deck", "écarté", "ecarte", "iso-lateral chest press", "butterfly (pec deck)", "écarté poulie un bras", "écartés poulie", "écartés poulie basse"],
    tips: ["Léger fléchi du coude fixe.", "Sens l'étirement, contracte en fermant."] },
  { key: "pushup", name: "Pompes", icon: "⊟", primary: "pecs", eliteRatio: 1.44, bw: true,
    muscles: { pecs: 0.55, triceps: 0.3, epaules: 0.15 }, yt: yt("pompes"),
    aliases: ["push up", "push ups", "pompes"],
    tips: ["Corps gainé, ligne droite.", "Poitrine près du sol."] },

  // ---- DOS ----
  { key: "deadlift", name: "Soulevé de terre", icon: "⎯", primary: "dos", eliteRatio: 3.45, bw: false,
    muscles: { dos: 0.35, ischios: 0.3, fessiers: 0.25, quads: 0.1 }, yt: yt("soulevé de terre deadlift"),
    aliases: ["deadlift", "deadlift (barbell)", "conventional deadlift", "souleve de terre", "soulevé de terre (barre)"],
    tips: ["Barre collée aux tibias, dos plat.", "Pousse le sol avec les jambes.", "Verrouille hanches et genoux ensemble."] },
  { key: "rdl", name: "Soulevé de terre roumain", icon: "⌐", primary: "ischios", eliteRatio: 2.76, bw: false,
    muscles: { ischios: 0.5, fessiers: 0.35, dos: 0.15 }, yt: yt("soulevé de terre roumain RDL"),
    aliases: ["romanian deadlift", "rdl", "romanian deadlift (barbell)", "soulevé de terre jambes tendues", "soulevé de terre roumain (barre)"],
    tips: ["Jambes quasi tendues.", "Hanches vers l'arrière, dos plat."] },
  { key: "pullup", name: "Tractions", icon: "⊓", primary: "dos", eliteRatio: 1.15, bw: true,
    muscles: { dos: 0.6, biceps: 0.3, epaules: 0.1 }, yt: yt("tractions pull up"),
    aliases: ["pull up", "pull ups", "pull up (weighted)", "tractions", "tractions"],
    tips: ["Bras tendus au départ, menton au-dessus.", "Coudes vers le bas, omoplates serrées."] },
  { key: "chinup", name: "Tractions supination", icon: "⊓", primary: "dos", eliteRatio: 1.21, bw: true,
    muscles: { dos: 0.5, biceps: 0.4, epaules: 0.1 }, yt: yt("tractions supination chin up"),
    aliases: ["chin up", "chin ups"],
    tips: ["Paumes vers toi.", "Plus de biceps."] },
  { key: "latpull", name: "Tirage vertical", icon: "⊤", primary: "dos", eliteRatio: 1.55, bw: false,
    muscles: { dos: 0.65, biceps: 0.25, epaules: 0.1 }, yt: yt("tirage vertical lat pulldown"),
    aliases: ["lat pulldown", "lat pulldown (cable)", "pulldown", "tirage vertical", "tirage poitrine (poulie)"],
    tips: ["Barre vers le haut de la poitrine.", "Bombe le torse."] },
  { key: "row", name: "Rowing barre", icon: "═", primary: "dos", eliteRatio: 1.84, bw: false,
    muscles: { dos: 0.6, biceps: 0.25, epaules: 0.15 }, yt: yt("rowing barre bent over row"),
    aliases: ["barbell row", "bent over row", "bent over row (barbell)", "rowing barre", "rowing pendlay (barre)"],
    tips: ["Buste à ~45°, dos neutre.", "Tire vers le bas-ventre."] },
  { key: "row_db", name: "Rowing haltère", icon: "═", primary: "dos", eliteRatio: 0.92, bw: false, perHand: true,
    muscles: { dos: 0.6, biceps: 0.25, epaules: 0.15 }, yt: yt("rowing haltère un bras"),
    aliases: ["dumbbell row", "one arm row", "dumbbell row (single arm)", "rowing un bras poulie"],
    tips: ["Un genou sur le banc, dos plat.", "Tire le coude haut et serré."] },
  { key: "row_cable", name: "Tirage horizontal", icon: "═", primary: "dos", eliteRatio: 1.67, bw: false,
    muscles: { dos: 0.6, biceps: 0.25, epaules: 0.15 }, yt: yt("tirage horizontal poulie seated row"),
    aliases: ["seated cable row", "cable row", "seated row", "rowing assis (machine)", "rowing poulie assis"],
    tips: ["Dos droit, tire vers le nombril.", "Ne te penche pas en arrière."] },
  { key: "facepull", name: "Face pull", icon: "⊰", primary: "dos", eliteRatio: 0.63, bw: false,
    muscles: { dos: 0.4, epaules: 0.6 }, yt: yt("face pull"),
    aliases: ["face pull", "cable face pull", "tirage vers visage"],
    tips: ["Tire vers le visage, coudes hauts.", "Bon pour la posture."] },

  // ---- ÉPAULES ----
  { key: "ohp", name: "Développé militaire", icon: "▲", primary: "epaules", eliteRatio: 1.49, bw: false,
    muscles: { epaules: 0.6, triceps: 0.3, pecs: 0.1 }, yt: yt("développé militaire overhead press"),
    aliases: ["overhead press", "ohp", "military press", "shoulder press (barbell)", "developpe militaire", "standing military press"],
    tips: ["Gaine abdos et fessiers.", "Passe la tête sous la barre en haut."] },
  { key: "ohp_db", name: "Développé épaules haltères", icon: "▲", primary: "epaules", eliteRatio: 0.71, bw: false, perHand: true,
    muscles: { epaules: 0.65, triceps: 0.25, pecs: 0.1 }, yt: yt("développé épaules haltères"),
    aliases: ["shoulder press (dumbbell)", "dumbbell shoulder press", "seated shoulder press", "arnold press", "développé militaire (haltère)", "presse épaules (haltère)", "shoulder press (machine plates)"],
    tips: ["Plus stable, isole l'épaule.", "Ne verrouille pas brutalement."] },
  { key: "latraise", name: "Élévations latérales", icon: "⊥", primary: "epaules", eliteRatio: 0.37, bw: false, perHand: true,
    muscles: { epaules: 0.95, triceps: 0.05 }, yt: yt("élévations latérales lateral raise"),
    aliases: ["lateral raise", "lateral raise (dumbbell)", "side raise", "elevations laterales", "cable lateral raise", "élévation latérale (haltère)", "élévation latérale (poulie)"],
    tips: ["Léger fléchi du coude.", "Mène avec les coudes."] },
  { key: "reardelt", name: "Oiseau (arrière d'épaule)", icon: "⊻", primary: "epaules", eliteRatio: 0.32, bw: false, perHand: true,
    muscles: { epaules: 0.9, dos: 0.1 }, yt: yt("oiseau rear delt fly"),
    aliases: ["rear delt fly", "reverse fly", "oiseau", "rear delt reverse fly", "oiseau (haltère)", "oiseau (machine)"],
    tips: ["Buste penché, écarte vers l'arrière."] },
  { key: "shrug", name: "Shrugs (trapèzes)", icon: "⊼", primary: "epaules", eliteRatio: 1.84, bw: false,
    muscles: { epaules: 0.7, dos: 0.3 }, yt: yt("shrugs trapèzes"),
    aliases: ["shrug", "shrugs", "barbell shrug", "dumbbell shrug", "shrug (haltère)", "shrug (poulie)"],
    tips: ["Monte les épaules vers les oreilles.", "Pause en haut, pas de rotation."] },

  // ---- BICEPS ----
  { key: "curl", name: "Curl biceps barre", icon: "↿", primary: "biceps", eliteRatio: 0.9, bw: false,
    muscles: { biceps: 0.9, epaules: 0.1 }, yt: yt("curl biceps barre"),
    aliases: ["bicep curl", "barbell curl", "bicep curl (barbell)", "curl", "ez bar curl", "curl biceps (barre)"],
    tips: ["Coudes fixes le long du corps.", "Contracte en haut, descends lentement."] },
  { key: "curl_db", name: "Curl haltères", icon: "↿", primary: "biceps", eliteRatio: 0.48, bw: false, perHand: true,
    muscles: { biceps: 0.9, epaules: 0.1 }, yt: yt("curl biceps haltères"),
    aliases: ["dumbbell curl", "bicep curl (dumbbell)", "incline dumbbell curl", "curl incliné assis (haltère)"],
    tips: ["Supination en montant.", "Pas de balancier."] },
  { key: "hammer", name: "Curl marteau", icon: "↾", primary: "biceps", eliteRatio: 0.53, bw: false, perHand: true,
    muscles: { biceps: 0.8, epaules: 0.2 }, yt: yt("curl marteau hammer curl"),
    aliases: ["hammer curl", "hammer curl (dumbbell)", "curl marteau (haltère)"],
    tips: ["Prise neutre tout le long.", "Cible le brachial."] },
  { key: "preacher", name: "Curl pupitre", icon: "↿", primary: "biceps", eliteRatio: 0.71, bw: false,
    muscles: { biceps: 0.95, epaules: 0.05 }, yt: yt("curl pupitre preacher curl"),
    aliases: ["preacher curl", "preacher curl (barbell)", "preacher curl (machine)", "curl pupitre (barre)"],
    tips: ["Bras calés sur le pupitre.", "Isole le pic."] },

  // ---- TRICEPS ----
  { key: "dips", name: "Dips", icon: "⊔", primary: "triceps", eliteRatio: 0.98, bw: true,
    muscles: { triceps: 0.5, pecs: 0.35, epaules: 0.15 }, yt: yt("dips triceps"),
    aliases: ["dip", "dips", "triceps dip", "dips (weighted)", "chest dip", "dips triceps"],
    tips: ["Buste droit = triceps.", "Descends à ~90° au coude."] },
  { key: "triext", name: "Extension triceps poulie", icon: "↧", primary: "triceps", eliteRatio: 0.8, bw: false,
    muscles: { triceps: 0.95, epaules: 0.05 }, yt: yt("extension triceps poulie pushdown"),
    aliases: ["triceps pushdown", "cable pushdown", "triceps extension", "rope pushdown", "tricep pushdown", "extension triceps poulie haute"],
    tips: ["Coudes collés au corps.", "Tends complètement en bas."] },
  { key: "skullcrusher", name: "Barre au front", icon: "↧", primary: "triceps", eliteRatio: 0.86, bw: false,
    muscles: { triceps: 0.95, epaules: 0.05 }, yt: yt("barre au front skullcrusher"),
    aliases: ["skullcrusher", "lying triceps extension", "ez bar skullcrusher", "triceps extension (barbell)", "extension triceps (barre)", "skullcrusher (barre)"],
    tips: ["Coudes fixes, descends vers le front."] },
  { key: "overhead_tri", name: "Extension nuque", icon: "↥", primary: "triceps", eliteRatio: 0.57, bw: false,
    muscles: { triceps: 0.95, epaules: 0.05 }, yt: yt("extension triceps nuque overhead"),
    aliases: ["overhead triceps extension", "overhead tricep extension", "extension des triceps au-dessus de la tête (câble)", "overhead triceps extension (cable)"],
    tips: ["Coudes hauts et serrés.", "Étire bien en bas."] },

  // ---- QUADRICEPS ----
  { key: "squat", name: "Squat", icon: "◢", primary: "quads", eliteRatio: 3.1, bw: false,
    muscles: { quads: 0.55, fessiers: 0.3, ischios: 0.15 }, yt: yt("squat barre technique"),
    aliases: ["squat", "back squat", "barbell squat", "squat (barbell)", "high bar squat", "squat (barre)", "squat (haltère)"],
    tips: ["Cuisse parallèle au sol minimum.", "Dos neutre, genoux dans l'axe.", "Pousse dans le talon."] },
  { key: "frontsquat", name: "Squat avant", icon: "◢", primary: "quads", eliteRatio: 2.42, bw: false,
    muscles: { quads: 0.65, fessiers: 0.2, ischios: 0.15 }, yt: yt("front squat squat avant"),
    aliases: ["front squat", "front squat (barbell)"],
    tips: ["Barre sur les épaules, coudes hauts.", "Dos droit."] },
  { key: "legpress", name: "Presse à cuisses", icon: "▰", primary: "quads", eliteRatio: 4.37, bw: false,
    muscles: { quads: 0.6, fessiers: 0.25, ischios: 0.15 }, yt: yt("presse à cuisses leg press"),
    aliases: ["leg press", "leg press (machine)", "leg press horizontal", "presse à cuisses", "presse à cuisses horizontal"],
    tips: ["Pieds largeur d'épaules.", "Ne décolle pas les fessiers."] },
  { key: "lunge", name: "Fentes", icon: "◿", primary: "quads", eliteRatio: 1.15, bw: false, perHand: true,
    muscles: { quads: 0.45, fessiers: 0.4, ischios: 0.15 }, yt: yt("fentes lunges"),
    aliases: ["lunge", "lunges", "walking lunge", "dumbbell lunge", "bulgarian split squat"],
    tips: ["Grand pas, genou arrière vers le sol.", "Pousse dans le talon avant."] },
  { key: "legext", name: "Leg extension", icon: "◞", primary: "quads", eliteRatio: 1.03, bw: false,
    muscles: { quads: 1.0 }, yt: yt("leg extension"),
    aliases: ["leg extension", "leg extension (machine)", "extension jambes"],
    tips: ["Contracte fort en haut.", "Descente contrôlée."] },
  { key: "hacksquat", name: "Hack squat", icon: "◢", primary: "quads", eliteRatio: 2.88, bw: false,
    muscles: { quads: 0.7, fessiers: 0.2, ischios: 0.1 }, yt: yt("hack squat"),
    aliases: ["hack squat", "hack squat (machine)", "hack squat (machine)"],
    tips: ["Dos plaqué, descends bas.", "Plus de quadriceps."] },

  // ---- ISCHIOS ----
  { key: "legcurl", name: "Leg curl allongé", icon: "◜", primary: "ischios", eliteRatio: 0.8, bw: false,
    muscles: { ischios: 0.9, mollets: 0.1 }, yt: yt("leg curl allongé"),
    aliases: ["leg curl", "lying leg curl", "hamstring curl", "lying leg curl (machine)"],
    tips: ["Mouvement lent et contrôlé.", "Contracte en fin de flexion."] },
  { key: "legcurl_seated", name: "Leg curl assis", icon: "◜", primary: "ischios", eliteRatio: 0.92, bw: false,
    muscles: { ischios: 0.9, mollets: 0.1 }, yt: yt("seated leg curl"),
    aliases: ["seated leg curl", "seated leg curl (machine)", "leg curl assis"],
    tips: ["Bassin calé.", "Amplitude complète."] },

  // ---- FESSIERS ----
  { key: "hipthrust", name: "Hip thrust", icon: "⊥", primary: "fessiers", eliteRatio: 2.88, bw: false,
    muscles: { fessiers: 0.7, ischios: 0.2, quads: 0.1 }, yt: yt("hip thrust fessiers"),
    aliases: ["hip thrust", "hip thrust (barbell)", "barbell hip thrust"],
    tips: ["Dos sur le banc aux omoplates.", "Serre les fessiers en haut."] },
  { key: "gluteridge", name: "Glute bridge", icon: "⌒", primary: "fessiers", eliteRatio: 2.3, bw: false,
    muscles: { fessiers: 0.75, ischios: 0.25 }, yt: yt("glute bridge"),
    aliases: ["glute bridge", "barbell glute bridge"],
    tips: ["Version au sol.", "Serre fort en haut."] },
  { key: "abduction", name: "Abduction (machine)", icon: "◹", primary: "fessiers", eliteRatio: 1.38, bw: false,
    muscles: { fessiers: 0.9, quads: 0.1 }, yt: yt("hip abduction machine fessiers"),
    aliases: ["hip abduction", "hip abduction (machine)", "abductor", "abduction hanche"],
    tips: ["Écarte lentement.", "Petite pause en fin de course."] },

  // ---- ABDOS ----
  { key: "plank", name: "Gainage", icon: "▭", primary: "abdos", isTime: true, eliteSeconds: 345, bw: true,
    muscles: { abdos: 0.9, epaules: 0.1 }, yt: yt("gainage planche plank"),
    aliases: ["plank", "planche", "gainage"],
    tips: ["Corps aligné, fessiers serrés.", "Rentre le nombril."] },
  { key: "legraise", name: "Relevés de jambes", icon: "◳", primary: "abdos", eliteRatio: 0.8, bw: true,
    muscles: { abdos: 0.95, quads: 0.05 }, yt: yt("relevés de jambes suspendu"),
    aliases: ["hanging leg raise", "leg raise", "captain's chair leg raise", "hanging knee raise"],
    tips: ["Suspendu, monte sans balancer.", "Enroule le bassin."] },
  { key: "crunch", name: "Crunch", icon: "◠", primary: "abdos", eliteRatio: 0.69, bw: false,
    muscles: { abdos: 1.0 }, yt: yt("crunch abdominaux"),
    aliases: ["crunch", "cable crunch", "sit up", "situp", "ab crunch", "crunch décliné (lesté)"],
    tips: ["Enroule la colonne.", "Expire en montant."] },

  // ---- MOLLETS (corrigés + enrichis) ----
  { key: "calf", name: "Mollets debout", icon: "◣", primary: "mollets", eliteRatio: 2.53, bw: false,
    muscles: { mollets: 1.0 }, yt: yt("mollets debout standing calf raise"),
    aliases: ["standing calf raise", "calf raise", "calf raise (machine)", "calf raise (barbell)",
      "standing calf raise (machine)", "calf press", "calf press (machine)", "smith machine calf raise",
      "mollet", "mollets", "extension mollets", "calves", "extension mollet debout une jambe (barre)", "extension mollets (machine)"],
    tips: ["Amplitude max : talon bas, pointe haute.", "Pause 1 s en haut et en bas."] },
  { key: "calf_seated", name: "Mollets assis", icon: "◣", primary: "mollets", eliteRatio: 1.72, bw: false,
    muscles: { mollets: 1.0 }, yt: yt("mollets assis seated calf raise"),
    aliases: ["seated calf raise", "seated calf raise (machine)", "seated calf press"],
    tips: ["Cible le soléaire.", "Tempo lent, gros volume."] },
  { key: "calf_lecalfgpress", name: "Mollets à la presse", icon: "◣", primary: "mollets", eliteRatio: 3.68, bw: false,
    muscles: { mollets: 1.0 }, yt: yt("mollets à la presse leg press calf"),
    aliases: ["calf press on leg press", "leg press calf raise", "calf extension"],
    tips: ["Pointe des pieds en bas du plateau.", "Grande amplitude."] },
  // ---- Exos importés (FR) ----
  { key: "fr_adduction_hanche", name: "Adduction Hanche", icon: "⊥", primary: "fessiers", eliteRatio: 1.15, bw: false, perHand: false,
    muscles: { fessiers: 1.0 }, yt: yt("Adduction Hanche"), aliases: ["adduction hanche"],
    tips: ["Exercice importé — ajuste la charge et progresse régulièrement."] },
  { key: "fr_braquial_de_t_mort", name: "Braquial De T Mort", icon: "↿", primary: "biceps", eliteRatio: 0.57, bw: false, perHand: false,
    muscles: { biceps: 1.0 }, yt: yt("Braquial De T Mort"), aliases: ["braquial de t mort"],
    tips: ["Exercice importé — ajuste la charge et progresse régulièrement."] },
  { key: "fr_curl_biceps_poulie", name: "Curl Biceps (Poulie)", icon: "↿", primary: "biceps", eliteRatio: 0.57, bw: false, perHand: false,
    muscles: { biceps: 1.0 }, yt: yt("Curl Biceps (Poulie)"), aliases: ["curl biceps (poulie)"],
    tips: ["Exercice importé — ajuste la charge et progresse régulièrement."] },
  { key: "fr_curl_incline_vis_a_vis", name: "Curl Incliné Vis A Vis", icon: "↿", primary: "biceps", eliteRatio: 0.57, bw: false, perHand: false,
    muscles: { biceps: 1.0 }, yt: yt("Curl Incliné Vis A Vis"), aliases: ["curl incliné vis a vis"],
    tips: ["Exercice importé — ajuste la charge et progresse régulièrement."] },
  { key: "fr_curl_marteau_poulie", name: "Curl Marteau (Poulie)", icon: "↿", primary: "biceps", eliteRatio: 0.57, bw: false, perHand: false,
    muscles: { biceps: 1.0 }, yt: yt("Curl Marteau (Poulie)"), aliases: ["curl marteau (poulie)"],
    tips: ["Exercice importé — ajuste la charge et progresse régulièrement."] },
  { key: "fr_curl_poignet", name: "Curl Poignet", icon: "↿", primary: "biceps", eliteRatio: 0.57, bw: false, perHand: false,
    muscles: { biceps: 1.0 }, yt: yt("Curl Poignet"), aliases: ["curl poignet"],
    tips: ["Exercice importé — ajuste la charge et progresse régulièrement."] },
  { key: "fr_curl_poignet_haut", name: "Curl Poignet (Haut)", icon: "↿", primary: "biceps", eliteRatio: 0.57, bw: false, perHand: false,
    muscles: { biceps: 1.0 }, yt: yt("Curl Poignet (Haut)"), aliases: ["curl poignet (haut)"],
    tips: ["Exercice importé — ajuste la charge et progresse régulièrement."] },
  { key: "fr_curl_poignet_arriere_deb", name: "Curl Poignet Arrière Debout (Barre)", icon: "↿", primary: "biceps", eliteRatio: 0.57, bw: false, perHand: false,
    muscles: { biceps: 1.0 }, yt: yt("Curl Poignet Arrière Debout (Barre)"), aliases: ["curl poignet arrière debout (barre)"],
    tips: ["Exercice importé — ajuste la charge et progresse régulièrement."] },
  { key: "fr_curl_poignets_paumes_ver", name: "Curl Poignets Paumes vers le Haut Assis", icon: "↿", primary: "biceps", eliteRatio: 0.57, bw: false, perHand: false,
    muscles: { biceps: 1.0 }, yt: yt("Curl Poignets Paumes vers le Haut Assis"), aliases: ["curl poignets paumes vers le haut assis"],
    tips: ["Exercice importé — ajuste la charge et progresse régulièrement."] },
  { key: "fr_developper_couche_inclin", name: "Développer Couché Incliné Vis A Vis", icon: "◇", primary: "pecs", eliteRatio: 0.8, bw: false, perHand: false,
    muscles: { pecs: 1.0 }, yt: yt("Développer Couché Incliné Vis A Vis"), aliases: ["développer couché incliné vis a vis"],
    tips: ["Exercice importé — ajuste la charge et progresse régulièrement."] },
  { key: "fr_developper_vis_a_vis_che", name: "Développer Vis A Vis Chess Press", icon: "◇", primary: "pecs", eliteRatio: 0.8, bw: false, perHand: false,
    muscles: { pecs: 1.0 }, yt: yt("Développer Vis A Vis Chess Press"), aliases: ["développer vis a vis chess press"],
    tips: ["Exercice importé — ajuste la charge et progresse régulièrement."] },
  { key: "fr_exo_chelou_de_lo\u00efc", name: "Exo Chelou De Loïc", icon: "◳", primary: "abdos", eliteRatio: 0.57, bw: false, perHand: false,
    muscles: { abdos: 1.0 }, yt: yt("Exo Chelou De Loïc"), aliases: ["exo chelou de loïc"],
    tips: ["Exercice importé — ajuste la charge et progresse régulièrement."] },
  { key: "fr_exo_miaou", name: "Exo Miaou", icon: "◳", primary: "abdos", eliteRatio: 0.57, bw: false, perHand: false,
    muscles: { abdos: 1.0 }, yt: yt("Exo Miaou"), aliases: ["exo miaou"],
    tips: ["Exercice importé — ajuste la charge et progresse régulièrement."] },
  { key: "fr_exo_triceps_yoga", name: "Exo Triceps Yoga", icon: "↧", primary: "triceps", eliteRatio: 0.57, bw: false, perHand: false,
    muscles: { triceps: 1.0 }, yt: yt("Exo Triceps Yoga"), aliases: ["exo triceps yoga"],
    tips: ["Exercice importé — ajuste la charge et progresse régulièrement."] },
  { key: "fr_extension_poignets_assis", name: "Extension Poignets Assis (Barre)", icon: "↿", primary: "biceps", eliteRatio: 0.57, bw: false, perHand: false,
    muscles: { biceps: 1.0 }, yt: yt("Extension Poignets Assis (Barre)"), aliases: ["extension poignets assis (barre)"],
    tips: ["Exercice importé — ajuste la charge et progresse régulièrement."] },
  { key: "fr_tirage_corde_bras_tendus", name: "Tirage Corde Bras Tendus", icon: "═", primary: "dos", eliteRatio: 1.15, bw: false, perHand: false,
    muscles: { dos: 1.0 }, yt: yt("Tirage Corde Bras Tendus"), aliases: ["tirage corde bras tendus"],
    tips: ["Exercice importé — ajuste la charge et progresse régulièrement."] },
  { key: "fr_tirage_poulie_a_genoux", name: "Tirage Poulie A Genoux", icon: "═", primary: "dos", eliteRatio: 1.15, bw: false, perHand: false,
    muscles: { dos: 1.0 }, yt: yt("Tirage Poulie A Genoux"), aliases: ["tirage poulie a genoux"],
    tips: ["Exercice importé — ajuste la charge et progresse régulièrement."] },
  { key: "fr_tirage_poulie_a_genoux_e", name: "Tirage Poulie à Genoux (Élastique)", icon: "═", primary: "dos", eliteRatio: 1.15, bw: false, perHand: false,
    muscles: { dos: 1.0 }, yt: yt("Tirage Poulie à Genoux (Élastique)"), aliases: ["tirage poulie à genoux (élastique)"],
    tips: ["Exercice importé — ajuste la charge et progresse régulièrement."] },
  { key: "fr_elevation_frontale_halte", name: "Élévation Frontale (Haltère)", icon: "⊥", primary: "epaules", eliteRatio: 0.34, bw: false, perHand: true,
    muscles: { epaules: 1.0 }, yt: yt("Élévation Frontale (Haltère)"), aliases: ["élévation frontale (haltère)"],
    tips: ["Exercice importé — ajuste la charge et progresse régulièrement."] },
  { key: "fr_elevation_frontale_pouli", name: "Élévation Frontale (Poulie)", icon: "⊥", primary: "epaules", eliteRatio: 0.34, bw: false, perHand: false,
    muscles: { epaules: 1.0 }, yt: yt("Élévation Frontale (Poulie)"), aliases: ["élévation frontale (poulie)"],
    tips: ["Exercice importé — ajuste la charge et progresse régulièrement."] },
];
/* Base étendue d'exercices (domaine public, free-exercise-db, 873 exos). */
const EXTRA_DB = [
["db_3_4_sit_up","3/4 Sit-Up","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_90_90_hamstring","90/90 Hamstring","ischios",1.72,0,1,{ischios:0.7,mollets:0.3},"body only"],
["db_ab_crunch_machine","Ab Crunch Machine","abdos",0.69,0,0,{abdos:1.0},"machine"],
["db_ab_roller","Ab Roller","abdos",0.69,0,0,{abdos:0.7,epaules:0.3},"other"],
["db_adductor","Adductor","fessiers",1.72,0,0,{fessiers:1.0},"foam roll"],
["db_adductor_groin","Adductor/Groin","fessiers",1.72,0,0,{fessiers:1.0},"autre"],
["db_advanced_kettlebell_windmill","Advanced Kettlebell Windmill","abdos",0.69,0,0,{abdos:0.7,fessiers:0.1,ischios:0.1,epaules:0.1},"kettlebells"],
["db_air_bike","Air Bike","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_all_fours_quad_stretch","All Fours Quad Stretch","quads",2.3,0,1,{quads:1.0},"body only"],
["db_alternate_hammer_curl","Alternate Hammer Curl","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
["db_alternate_heel_touchers","Alternate Heel Touchers","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_alternate_incline_dumbbell_curl","Alternate Incline Dumbbell Curl","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
["db_alternate_leg_diagonal_bound","Alternate Leg Diagonal Bound","quads",2.3,0,0,{quads:0.7,fessiers:0.18,mollets:0.06,ischios:0.06},"autre"],
["db_alternating_cable_shoulder_press","Alternating Cable Shoulder Press","epaules",1.03,0,0,{epaules:0.7,triceps:0.3},"cable"],
["db_alternating_deltoid_raise","Alternating Deltoid Raise","epaules",1.03,1,0,{epaules:1.0},"dumbbell"],
["db_alternating_floor_press","Alternating Floor Press","pecs",1.49,0,0,{pecs:0.7,abdos:0.1,epaules:0.1,triceps:0.1},"kettlebells"],
["db_alternating_hang_clean","Alternating Hang Clean","ischios",1.72,0,0,{ischios:0.7,biceps:0.1,mollets:0.05,fessiers:0.05,dos:0.05,epaules:0.05},"kettlebells"],
["db_alternating_kettlebell_press","Alternating Kettlebell Press","epaules",1.03,0,0,{epaules:0.7,triceps:0.3},"kettlebells"],
["db_alternating_kettlebell_row","Alternating Kettlebell Row","dos",1.49,0,0,{dos:0.7,biceps:0.3},"kettlebells"],
["db_alternating_renegade_row","Alternating Renegade Row","dos",1.49,0,0,{dos:0.7,abdos:0.07,biceps:0.07,pecs:0.07,triceps:0.07},"kettlebells"],
["db_ankle_circles","Ankle Circles","mollets",2.07,0,0,{mollets:1.0},"autre"],
["db_ankle_on_the_knee","Ankle On The Knee","fessiers",1.72,0,0,{fessiers:1.0},"autre"],
["db_anterior_tibialis_smr","Anterior Tibialis-SMR","mollets",2.07,0,0,{mollets:1.0},"other"],
["db_anti_gravity_press","Anti-Gravity Press","epaules",1.03,0,0,{epaules:0.7,dos:0.15,triceps:0.15},"barbell"],
["db_arm_circles","Arm Circles","epaules",1.03,0,0,{epaules:1.0},"autre"],
["db_arnold_dumbbell_press","Arnold Dumbbell Press","epaules",1.03,1,0,{epaules:0.7,triceps:0.3},"dumbbell"],
["db_around_the_worlds","Around The Worlds","pecs",1.49,1,0,{pecs:0.7,epaules:0.3},"dumbbell"],
["db_atlas_stone_trainer","Atlas Stone Trainer","dos",1.49,0,0,{dos:0.7,biceps:0.12,fessiers:0.06,ischios:0.06,quads:0.06},"other"],
["db_atlas_stones","Atlas Stones","dos",1.49,0,0,{dos:0.7,abdos:0.03,fessiers:0.06,biceps:0.06,mollets:0.03,ischios:0.03,quads:0.03,epaules:0.03},"other"],
["db_axle_deadlift","Axle Deadlift","dos",1.49,0,0,{dos:0.7,biceps:0.06,fessiers:0.06,ischios:0.06,quads:0.06,epaules:0.06},"other"],
["db_back_flyes_with_bands","Back Flyes - With Bands","epaules",1.03,0,0,{epaules:0.7,dos:0.15,triceps:0.15},"bands"],
["db_backward_drag","Backward Drag","quads",2.3,0,0,{quads:0.7,mollets:0.06,biceps:0.06,fessiers:0.06,ischios:0.06,dos:0.06},"other"],
["db_backward_medicine_ball_throw","Backward Medicine Ball Throw","epaules",1.03,0,0,{epaules:1.0},"medicine ball"],
["db_balance_board","Balance Board","mollets",2.07,0,0,{mollets:0.7,ischios:0.15,quads:0.15},"other"],
["db_ball_leg_curl","Ball Leg Curl","ischios",1.72,0,0,{ischios:0.7,mollets:0.15,fessiers:0.15},"exercise ball"],
["db_band_assisted_pull_up","Band Assisted Pull-Up","dos",1.49,0,0,{dos:0.7,abdos:0.15,biceps:0.15},"other"],
["db_band_good_morning","Band Good Morning","ischios",1.72,0,0,{ischios:0.7,fessiers:0.15,dos:0.15},"bands"],
["db_band_good_morning_pull_through","Band Good Morning (Pull Through)","ischios",1.72,0,0,{ischios:0.7,fessiers:0.15,dos:0.15},"bands"],
["db_band_hip_adductions","Band Hip Adductions","fessiers",1.72,0,0,{fessiers:1.0},"bands"],
["db_band_pull_apart","Band Pull Apart","epaules",1.03,0,0,{epaules:0.7,dos:0.3},"bands"],
["db_band_skull_crusher","Band Skull Crusher","triceps",0.69,0,0,{triceps:1.0},"bands"],
["db_barbell_ab_rollout","Barbell Ab Rollout","abdos",0.69,0,0,{abdos:0.7,dos:0.15,epaules:0.15},"barbell"],
["db_barbell_ab_rollout_on_knees","Barbell Ab Rollout - On Knees","abdos",0.69,0,0,{abdos:0.7,dos:0.15,epaules:0.15},"barbell"],
["db_barbell_bench_press_medium_grip","Barbell Bench Press - Medium Grip","pecs",1.49,0,0,{pecs:0.7,epaules:0.15,triceps:0.15},"barbell"],
["db_barbell_curl","Barbell Curl","biceps",0.69,0,0,{biceps:1.0},"barbell"],
["db_barbell_curls_lying_against_an_inc","Barbell Curls Lying Against An Incline","biceps",0.69,0,0,{biceps:1.0},"barbell"],
["db_barbell_deadlift","Barbell Deadlift","dos",1.49,0,0,{dos:0.7,mollets:0.05,biceps:0.05,fessiers:0.05,ischios:0.05,quads:0.05,epaules:0.05},"barbell"],
["db_barbell_full_squat","Barbell Full Squat","quads",2.3,0,0,{quads:0.7,mollets:0.07,fessiers:0.07,ischios:0.07,dos:0.07},"barbell"],
["db_barbell_glute_bridge","Barbell Glute Bridge","fessiers",1.72,0,0,{fessiers:0.7,mollets:0.15,ischios:0.15},"barbell"],
["db_barbell_guillotine_bench_press","Barbell Guillotine Bench Press","pecs",1.49,0,0,{pecs:0.7,epaules:0.15,triceps:0.15},"barbell"],
["db_barbell_hack_squat","Barbell Hack Squat","quads",2.3,0,0,{quads:0.7,mollets:0.1,biceps:0.1,ischios:0.1},"barbell"],
["db_barbell_hip_thrust","Barbell Hip Thrust","fessiers",1.72,0,0,{fessiers:0.7,mollets:0.15,ischios:0.15},"barbell"],
["db_barbell_incline_bench_press_medium","Barbell Incline Bench Press - Medium Grip","pecs",1.49,0,0,{pecs:0.7,epaules:0.15,triceps:0.15},"barbell"],
["db_barbell_incline_shoulder_raise","Barbell Incline Shoulder Raise","epaules",1.03,0,0,{epaules:0.7,pecs:0.3},"barbell"],
["db_barbell_lunge","Barbell Lunge","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"barbell"],
["db_barbell_rear_delt_row","Barbell Rear Delt Row","epaules",1.03,0,0,{epaules:0.7,biceps:0.1,dos:0.2},"barbell"],
["db_barbell_rollout_from_bench","Barbell Rollout from Bench","abdos",0.69,0,0,{abdos:0.7,fessiers:0.07,ischios:0.07,dos:0.07,epaules:0.07},"barbell"],
["db_barbell_seated_calf_raise","Barbell Seated Calf Raise","mollets",2.07,0,0,{mollets:1.0},"barbell"],
["db_barbell_shoulder_press","Barbell Shoulder Press","epaules",1.03,0,0,{epaules:0.7,pecs:0.15,triceps:0.15},"barbell"],
["db_barbell_shrug","Barbell Shrug","epaules",1.03,0,0,{epaules:1.0},"barbell"],
["db_barbell_shrug_behind_the_back","Barbell Shrug Behind The Back","epaules",1.03,0,0,{epaules:0.7,biceps:0.15,dos:0.15},"barbell"],
["db_barbell_side_bend","Barbell Side Bend","abdos",0.69,0,0,{abdos:0.7,dos:0.3},"barbell"],
["db_barbell_side_split_squat","Barbell Side Split Squat","quads",2.3,0,0,{quads:0.7,mollets:0.1,ischios:0.1,dos:0.1},"barbell"],
["db_barbell_squat","Barbell Squat","quads",2.3,0,0,{quads:0.7,mollets:0.07,fessiers:0.07,ischios:0.07,dos:0.07},"barbell"],
["db_barbell_squat_to_a_bench","Barbell Squat To A Bench","quads",2.3,0,0,{quads:0.7,mollets:0.07,fessiers:0.07,ischios:0.07,dos:0.07},"barbell"],
["db_barbell_step_ups","Barbell Step Ups","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"barbell"],
["db_barbell_walking_lunge","Barbell Walking Lunge","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"barbell"],
["db_battling_ropes","Battling Ropes","epaules",1.03,0,0,{epaules:0.7,pecs:0.15,biceps:0.15},"other"],
["db_bear_crawl_sled_drags","Bear Crawl Sled Drags","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"other"],
["db_behind_head_chest_stretch","Behind Head Chest Stretch","pecs",1.49,0,0,{pecs:0.7,epaules:0.3},"other"],
["db_bench_dips","Bench Dips","triceps",0.69,0,1,{triceps:0.7,pecs:0.15,epaules:0.15},"body only"],
["db_bench_jump","Bench Jump","quads",2.3,0,1,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"body only"],
["db_bench_press_powerlifting","Bench Press - Powerlifting","triceps",0.69,0,0,{triceps:0.7,pecs:0.07,biceps:0.07,dos:0.07,epaules:0.07},"barbell"],
["db_bench_press_with_bands","Bench Press - With Bands","pecs",1.49,0,0,{pecs:0.7,epaules:0.15,triceps:0.15},"bands"],
["db_bench_press_with_chains","Bench Press with Chains","triceps",0.69,0,0,{triceps:0.7,pecs:0.1,dos:0.1,epaules:0.1},"barbell"],
["db_bench_sprint","Bench Sprint","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"other"],
["db_bent_arm_barbell_pullover","Bent-Arm Barbell Pullover","dos",1.49,0,0,{dos:0.7,pecs:0.1,epaules:0.1,triceps:0.1},"barbell"],
["db_bent_arm_dumbbell_pullover","Bent-Arm Dumbbell Pullover","pecs",1.49,1,0,{pecs:0.7,dos:0.1,epaules:0.1,triceps:0.1},"dumbbell"],
["db_bent_knee_hip_raise","Bent-Knee Hip Raise","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_bent_over_barbell_row","Bent Over Barbell Row","dos",1.49,0,0,{dos:0.7,biceps:0.15,epaules:0.15},"barbell"],
["db_bent_over_dumbbell_rear_delt_raise","Bent Over Dumbbell Rear Delt Raise With Head On Bench","epaules",1.03,1,0,{epaules:1.0},"dumbbell"],
["db_bent_over_low_pulley_side_lateral","Bent Over Low-Pulley Side Lateral","epaules",1.03,0,0,{epaules:0.7,dos:0.3},"cable"],
["db_bent_over_one_arm_long_bar_row","Bent Over One-Arm Long Bar Row","dos",1.49,0,0,{dos:0.7,biceps:0.15,epaules:0.15},"barbell"],
["db_bent_over_two_arm_long_bar_row","Bent Over Two-Arm Long Bar Row","dos",1.49,0,0,{dos:0.7,biceps:0.3},"barbell"],
["db_bent_over_two_dumbbell_row","Bent Over Two-Dumbbell Row","dos",1.49,1,0,{dos:0.7,biceps:0.15,epaules:0.15},"dumbbell"],
["db_bent_over_two_dumbbell_row_with_pa","Bent Over Two-Dumbbell Row With Palms In","dos",1.49,1,0,{dos:0.7,biceps:0.3},"dumbbell"],
["db_bent_press","Bent Press","abdos",0.69,0,0,{abdos:0.7,fessiers:0.05,ischios:0.05,dos:0.05,quads:0.05,epaules:0.05,triceps:0.05},"kettlebells"],
["db_bicycling","Bicycling","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"other"],
["db_bicycling_stationary","Bicycling, Stationary","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"machine"],
["db_board_press","Board Press","triceps",0.69,0,0,{triceps:0.7,pecs:0.07,biceps:0.07,dos:0.07,epaules:0.07},"barbell"],
["db_body_up","Body-Up","triceps",0.69,0,1,{triceps:0.7,abdos:0.15,biceps:0.15},"body only"],
["db_body_tricep_press","Body Tricep Press","triceps",0.69,0,1,{triceps:1.0},"body only"],
["db_bodyweight_flyes","Bodyweight Flyes","pecs",1.49,0,0,{pecs:0.7,abdos:0.1,epaules:0.1,triceps:0.1},"e-z curl bar"],
["db_bodyweight_mid_row","Bodyweight Mid Row","dos",1.49,0,0,{dos:0.7,biceps:0.3},"other"],
["db_bodyweight_squat","Bodyweight Squat","quads",2.3,0,1,{quads:0.7,fessiers:0.15,ischios:0.15},"body only"],
["db_bodyweight_walking_lunge","Bodyweight Walking Lunge","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"autre"],
["db_bosu_ball_cable_crunch_with_side_b","Bosu Ball Cable Crunch With Side Bends","abdos",0.69,0,0,{abdos:1.0},"cable"],
["db_bottoms_up_clean_from_the_hang_pos","Bottoms-Up Clean From The Hang Position","biceps",0.69,0,0,{biceps:0.7,epaules:0.3},"kettlebells"],
["db_bottoms_up","Bottoms Up","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_box_jump_multiple_response","Box Jump (Multiple Response)","ischios",1.72,0,0,{ischios:0.7,fessiers:0.18,mollets:0.06,quads:0.06},"other"],
["db_box_skip","Box Skip","ischios",1.72,0,0,{ischios:0.7,fessiers:0.18,mollets:0.06,quads:0.06},"other"],
["db_box_squat","Box Squat","quads",2.3,0,0,{quads:0.7,fessiers:0.12,mollets:0.06,ischios:0.06,dos:0.06},"barbell"],
["db_box_squat_with_bands","Box Squat with Bands","quads",2.3,0,0,{quads:0.7,fessiers:0.15000000000000002,mollets:0.05,ischios:0.05,dos:0.05},"barbell"],
["db_box_squat_with_chains","Box Squat with Chains","quads",2.3,0,0,{quads:0.7,fessiers:0.15000000000000002,mollets:0.05,ischios:0.05,dos:0.05},"barbell"],
["db_brachialis_smr","Brachialis-SMR","biceps",0.69,0,0,{biceps:1.0},"foam roll"],
["db_bradford_rocky_presses","Bradford/Rocky Presses","epaules",1.03,0,0,{epaules:0.7,triceps:0.3},"barbell"],
["db_butt_ups","Butt-Ups","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_butt_lift_bridge","Butt Lift (Bridge)","fessiers",1.72,0,1,{fessiers:0.7,ischios:0.3},"body only"],
["db_butterfly","Butterfly","pecs",1.49,0,0,{pecs:1.0},"machine"],
["db_cable_chest_press","Cable Chest Press","pecs",1.49,0,0,{pecs:0.7,epaules:0.15,triceps:0.15},"cable"],
["db_cable_crossover","Cable Crossover","pecs",1.49,0,0,{pecs:0.7,epaules:0.3},"cable"],
["db_cable_crunch","Cable Crunch","abdos",0.69,0,0,{abdos:1.0},"cable"],
["db_cable_deadlifts","Cable Deadlifts","quads",2.3,0,0,{quads:0.7,biceps:0.07,fessiers:0.07,ischios:0.07,dos:0.07},"cable"],
["db_cable_hammer_curls_rope_attachment","Cable Hammer Curls - Rope Attachment","biceps",0.69,0,0,{biceps:1.0},"cable"],
["db_cable_hip_adduction","Cable Hip Adduction","quads",2.3,0,0,{quads:1.0},"cable"],
["db_cable_incline_pushdown","Cable Incline Pushdown","dos",1.49,0,0,{dos:1.0},"cable"],
["db_cable_incline_triceps_extension","Cable Incline Triceps Extension","triceps",0.69,0,0,{triceps:1.0},"cable"],
["db_cable_internal_rotation","Cable Internal Rotation","epaules",1.03,0,0,{epaules:1.0},"cable"],
["db_cable_iron_cross","Cable Iron Cross","pecs",1.49,0,0,{pecs:1.0},"cable"],
["db_cable_judo_flip","Cable Judo Flip","abdos",0.69,0,0,{abdos:1.0},"cable"],
["db_cable_lying_triceps_extension","Cable Lying Triceps Extension","triceps",0.69,0,0,{triceps:1.0},"cable"],
["db_cable_one_arm_tricep_extension","Cable One Arm Tricep Extension","triceps",0.69,0,0,{triceps:1.0},"cable"],
["db_cable_preacher_curl","Cable Preacher Curl","biceps",0.69,0,0,{biceps:1.0},"cable"],
["db_cable_rear_delt_fly","Cable Rear Delt Fly","epaules",1.03,0,0,{epaules:1.0},"cable"],
["db_cable_reverse_crunch","Cable Reverse Crunch","abdos",0.69,0,0,{abdos:1.0},"cable"],
["db_cable_rope_overhead_triceps_extens","Cable Rope Overhead Triceps Extension","triceps",0.69,0,0,{triceps:1.0},"cable"],
["db_cable_rope_rear_delt_rows","Cable Rope Rear-Delt Rows","epaules",1.03,0,0,{epaules:0.7,biceps:0.15,dos:0.15},"cable"],
["db_cable_russian_twists","Cable Russian Twists","abdos",0.69,0,0,{abdos:1.0},"cable"],
["db_cable_seated_crunch","Cable Seated Crunch","abdos",0.69,0,0,{abdos:1.0},"cable"],
["db_cable_seated_lateral_raise","Cable Seated Lateral Raise","epaules",1.03,0,0,{epaules:0.7,dos:0.3},"cable"],
["db_cable_shoulder_press","Cable Shoulder Press","epaules",1.03,0,0,{epaules:0.7,triceps:0.3},"cable"],
["db_cable_shrugs","Cable Shrugs","epaules",1.03,0,0,{epaules:1.0},"cable"],
["db_cable_wrist_curl","Cable Wrist Curl","biceps",0.69,0,0,{biceps:1.0},"cable"],
["db_calf_machine_shoulder_shrug","Calf-Machine Shoulder Shrug","epaules",1.03,0,0,{epaules:1.0},"machine"],
["db_calf_press","Calf Press","mollets",2.07,0,0,{mollets:1.0},"machine"],
["db_calf_press_on_the_leg_press_machin","Calf Press On The Leg Press Machine","mollets",2.07,0,0,{mollets:1.0},"machine"],
["db_calf_raise_on_a_dumbbell","Calf Raise On A Dumbbell","mollets",2.07,1,0,{mollets:1.0},"dumbbell"],
["db_calf_raises_with_bands","Calf Raises - With Bands","mollets",2.07,0,0,{mollets:1.0},"bands"],
["db_calf_stretch_elbows_against_wall","Calf Stretch Elbows Against Wall","mollets",2.07,0,0,{mollets:1.0},"autre"],
["db_calf_stretch_hands_against_wall","Calf Stretch Hands Against Wall","mollets",2.07,0,0,{mollets:1.0},"autre"],
["db_calves_smr","Calves-SMR","mollets",2.07,0,0,{mollets:1.0},"foam roll"],
["db_car_deadlift","Car Deadlift","quads",2.3,0,0,{quads:0.7,biceps:0.06,fessiers:0.06,ischios:0.06,dos:0.06,epaules:0.06},"other"],
["db_car_drivers","Car Drivers","epaules",1.03,0,0,{epaules:0.7,biceps:0.3},"barbell"],
["db_carioca_quick_step","Carioca Quick Step","fessiers",1.72,0,0,{fessiers:0.7,abdos:0.07,mollets:0.07,ischios:0.07,quads:0.07},"autre"],
["db_cat_stretch","Cat Stretch","dos",1.49,0,0,{dos:0.7,epaules:0.3},"autre"],
["db_catch_and_overhead_throw","Catch and Overhead Throw","dos",1.49,0,0,{dos:0.7,abdos:0.1,pecs:0.1,epaules:0.1},"medicine ball"],
["db_chain_handle_extension","Chain Handle Extension","triceps",0.69,0,0,{triceps:1.0},"other"],
["db_chain_press","Chain Press","pecs",1.49,0,0,{pecs:0.7,epaules:0.15,triceps:0.15},"other"],
["db_chair_leg_extended_stretch","Chair Leg Extended Stretch","ischios",1.72,0,0,{ischios:0.7,fessiers:0.3},"other"],
["db_chair_lower_back_stretch","Chair Lower Back Stretch","dos",1.49,0,0,{dos:1.0},"autre"],
["db_chair_squat","Chair Squat","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"machine"],
["db_chair_upper_body_stretch","Chair Upper Body Stretch","epaules",1.03,0,0,{epaules:0.7,biceps:0.15,pecs:0.15},"other"],
["db_chest_and_front_of_shoulder_stretc","Chest And Front Of Shoulder Stretch","pecs",1.49,0,0,{pecs:0.7,epaules:0.3},"other"],
["db_chest_push_from_3_point_stance","Chest Push from 3 point stance","pecs",1.49,0,0,{pecs:0.7,abdos:0.1,epaules:0.1,triceps:0.1},"medicine ball"],
["db_chest_push_multiple_response","Chest Push (multiple response)","pecs",1.49,0,0,{pecs:0.7,abdos:0.1,epaules:0.1,triceps:0.1},"medicine ball"],
["db_chest_push_single_response","Chest Push (single response)","pecs",1.49,0,0,{pecs:0.7,abdos:0.1,epaules:0.1,triceps:0.1},"medicine ball"],
["db_chest_push_with_run_release","Chest Push with Run Release","pecs",1.49,0,0,{pecs:0.7,abdos:0.1,epaules:0.1,triceps:0.1},"medicine ball"],
["db_chest_stretch_on_stability_ball","Chest Stretch on Stability Ball","pecs",1.49,0,0,{pecs:1.0},"exercise ball"],
["db_child_s_pose","Child's Pose","dos",1.49,0,0,{dos:0.7,fessiers:0.3},"autre"],
["db_chin_up","Chin-Up","dos",1.49,0,1,{dos:0.7,biceps:0.3},"body only"],
["db_chin_to_chest_stretch","Chin To Chest Stretch","epaules",1.03,0,0,{epaules:1.0},"autre"],
["db_circus_bell","Circus Bell","epaules",1.03,0,0,{epaules:0.7,biceps:0.06,fessiers:0.06,ischios:0.06,dos:0.06,triceps:0.06},"other"],
["db_clean","Clean","ischios",1.72,0,0,{ischios:0.7,mollets:0.04,biceps:0.04,fessiers:0.04,dos:0.04,quads:0.04,epaules:0.08},"barbell"],
["db_clean_deadlift","Clean Deadlift","ischios",1.72,0,0,{ischios:0.7,biceps:0.05,fessiers:0.05,dos:0.1,quads:0.05,epaules:0.05},"barbell"],
["db_clean_pull","Clean Pull","quads",2.3,0,0,{quads:0.7,biceps:0.06,fessiers:0.06,ischios:0.06,dos:0.06,epaules:0.06},"barbell"],
["db_clean_shrug","Clean Shrug","epaules",1.03,0,0,{epaules:0.7,biceps:0.3},"barbell"],
["db_clean_and_jerk","Clean and Jerk","epaules",1.03,0,0,{epaules:0.7,abdos:0.05,fessiers:0.05,ischios:0.05,dos:0.05,quads:0.05,triceps:0.05},"barbell"],
["db_clean_and_press","Clean and Press","epaules",1.03,0,0,{epaules:0.7,abdos:0.04,mollets:0.04,fessiers:0.04,ischios:0.04,dos:0.08,quads:0.04,triceps:0.04},"barbell"],
["db_clean_from_blocks","Clean from Blocks","quads",2.3,0,0,{quads:0.7,mollets:0.06,fessiers:0.06,ischios:0.06,epaules:0.12},"barbell"],
["db_clock_push_up","Clock Push-Up","pecs",1.49,0,1,{pecs:0.7,epaules:0.15,triceps:0.15},"body only"],
["db_close_grip_barbell_bench_press","Close-Grip Barbell Bench Press","triceps",0.69,0,0,{triceps:0.7,pecs:0.15,epaules:0.15},"barbell"],
["db_close_grip_dumbbell_press","Close-Grip Dumbbell Press","triceps",0.69,1,0,{triceps:0.7,pecs:0.15,epaules:0.15},"dumbbell"],
["db_close_grip_ez_bar_curl_with_band","Close-Grip EZ-Bar Curl with Band","biceps",0.69,0,0,{biceps:1.0},"e-z curl bar"],
["db_close_grip_ez_bar_press","Close-Grip EZ-Bar Press","triceps",0.69,0,0,{triceps:0.7,pecs:0.15,epaules:0.15},"e-z curl bar"],
["db_close_grip_ez_bar_curl","Close-Grip EZ Bar Curl","biceps",0.69,0,0,{biceps:1.0},"barbell"],
["db_close_grip_front_lat_pulldown","Close-Grip Front Lat Pulldown","dos",1.49,0,0,{dos:0.7,biceps:0.15,epaules:0.15},"cable"],
["db_close_grip_push_up_off_of_a_dumbbe","Close-Grip Push-Up off of a Dumbbell","triceps",0.69,0,1,{triceps:0.7,abdos:0.1,pecs:0.1,epaules:0.1},"body only"],
["db_close_grip_standing_barbell_curl","Close-Grip Standing Barbell Curl","biceps",0.69,0,0,{biceps:1.0},"barbell"],
["db_cocoons","Cocoons","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_conan_s_wheel","Conan's Wheel","quads",2.3,0,0,{quads:0.7,abdos:0.04,biceps:0.08,mollets:0.04,dos:0.04,epaules:0.08},"other"],
["db_concentration_curls","Concentration Curls","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
["db_cross_body_crunch","Cross-Body Crunch","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_cross_body_hammer_curl","Cross Body Hammer Curl","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
["db_cross_over_with_bands","Cross Over - With Bands","pecs",1.49,0,0,{pecs:0.7,biceps:0.15,epaules:0.15},"bands"],
["db_crossover_reverse_lunge","Crossover Reverse Lunge","dos",1.49,0,0,{dos:0.7,abdos:0.06,fessiers:0.12,ischios:0.06,quads:0.06},"autre"],
["db_crucifix","Crucifix","epaules",1.03,0,0,{epaules:0.7,biceps:0.3},"other"],
["db_crunch_hands_overhead","Crunch - Hands Overhead","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_crunch_legs_on_exercise_ball","Crunch - Legs On Exercise Ball","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_crunches","Crunches","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_cuban_press","Cuban Press","epaules",1.03,1,0,{epaules:1.0},"dumbbell"],
["db_dancer_s_stretch","Dancer's Stretch","dos",1.49,0,0,{dos:0.7,fessiers:0.3},"autre"],
["db_dead_bug","Dead Bug","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_deadlift_with_bands","Deadlift with Bands","dos",1.49,0,0,{dos:0.7,biceps:0.06,fessiers:0.06,ischios:0.06,quads:0.06,epaules:0.06},"barbell"],
["db_deadlift_with_chains","Deadlift with Chains","dos",1.49,0,0,{dos:0.7,biceps:0.06,fessiers:0.06,ischios:0.06,quads:0.06,epaules:0.06},"barbell"],
["db_decline_barbell_bench_press","Decline Barbell Bench Press","pecs",1.49,0,0,{pecs:0.7,epaules:0.15,triceps:0.15},"barbell"],
["db_decline_close_grip_bench_to_skull_","Decline Close-Grip Bench To Skull Crusher","triceps",0.69,0,0,{triceps:0.7,pecs:0.15,epaules:0.15},"barbell"],
["db_decline_crunch","Decline Crunch","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_decline_dumbbell_bench_press","Decline Dumbbell Bench Press","pecs",1.49,1,0,{pecs:0.7,epaules:0.15,triceps:0.15},"dumbbell"],
["db_decline_dumbbell_flyes","Decline Dumbbell Flyes","pecs",1.49,1,0,{pecs:1.0},"dumbbell"],
["db_decline_dumbbell_triceps_extension","Decline Dumbbell Triceps Extension","triceps",0.69,1,0,{triceps:1.0},"dumbbell"],
["db_decline_ez_bar_triceps_extension","Decline EZ Bar Triceps Extension","triceps",0.69,0,0,{triceps:1.0},"barbell"],
["db_decline_oblique_crunch","Decline Oblique Crunch","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_decline_push_up","Decline Push-Up","pecs",1.49,0,0,{pecs:0.7,epaules:0.15,triceps:0.15},"autre"],
["db_decline_reverse_crunch","Decline Reverse Crunch","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_decline_smith_press","Decline Smith Press","pecs",1.49,0,0,{pecs:0.7,epaules:0.15,triceps:0.15},"machine"],
["db_deficit_deadlift","Deficit Deadlift","dos",1.49,0,0,{dos:0.7,biceps:0.06,fessiers:0.06,ischios:0.06,quads:0.06,epaules:0.06},"barbell"],
["db_depth_jump_leap","Depth Jump Leap","quads",2.3,0,0,{quads:0.7,fessiers:0.18,mollets:0.06,ischios:0.06},"other"],
["db_dip_machine","Dip Machine","triceps",0.69,0,0,{triceps:0.7,pecs:0.15,epaules:0.15},"machine"],
["db_dips_chest_version","Dips - Chest Version","pecs",1.49,0,0,{pecs:0.7,epaules:0.15,triceps:0.15},"other"],
["db_dips_triceps_version","Dips - Triceps Version","triceps",0.69,0,1,{triceps:0.7,pecs:0.15,epaules:0.15},"body only"],
["db_donkey_calf_raises","Donkey Calf Raises","mollets",2.07,0,0,{mollets:1.0},"other"],
["db_double_kettlebell_alternating_hang","Double Kettlebell Alternating Hang Clean","ischios",1.72,0,0,{ischios:0.7,biceps:0.08,mollets:0.04,fessiers:0.04,dos:0.04,quads:0.04,epaules:0.04},"kettlebells"],
["db_double_kettlebell_jerk","Double Kettlebell Jerk","epaules",1.03,0,0,{epaules:0.7,mollets:0.1,quads:0.1,triceps:0.1},"kettlebells"],
["db_double_kettlebell_push_press","Double Kettlebell Push Press","epaules",1.03,0,0,{epaules:0.7,mollets:0.1,quads:0.1,triceps:0.1},"kettlebells"],
["db_double_kettlebell_snatch","Double Kettlebell Snatch","epaules",1.03,0,0,{epaules:0.7,fessiers:0.1,ischios:0.1,quads:0.1},"kettlebells"],
["db_double_kettlebell_windmill","Double Kettlebell Windmill","abdos",0.69,0,0,{abdos:0.7,fessiers:0.07,ischios:0.07,epaules:0.07,triceps:0.07},"kettlebells"],
["db_double_leg_butt_kick","Double Leg Butt Kick","quads",2.3,0,1,{quads:0.7,fessiers:0.18,mollets:0.06,ischios:0.06},"body only"],
["db_downward_facing_balance","Downward Facing Balance","fessiers",1.72,0,0,{fessiers:0.7,abdos:0.15,ischios:0.15},"exercise ball"],
["db_drag_curl","Drag Curl","biceps",0.69,0,0,{biceps:1.0},"barbell"],
["db_drop_push","Drop Push","pecs",1.49,0,0,{pecs:0.7,epaules:0.15,triceps:0.15},"other"],
["db_dumbbell_alternate_bicep_curl","Dumbbell Alternate Bicep Curl","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
["db_dumbbell_bench_press","Dumbbell Bench Press","pecs",1.49,1,0,{pecs:0.7,epaules:0.15,triceps:0.15},"dumbbell"],
["db_dumbbell_bench_press_with_neutral_","Dumbbell Bench Press with Neutral Grip","pecs",1.49,1,0,{pecs:0.7,epaules:0.15,triceps:0.15},"dumbbell"],
["db_dumbbell_bicep_curl","Dumbbell Bicep Curl","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
["db_dumbbell_clean","Dumbbell Clean","ischios",1.72,1,0,{ischios:0.7,mollets:0.04,biceps:0.04,fessiers:0.04,dos:0.04,quads:0.04,epaules:0.08},"dumbbell"],
["db_dumbbell_floor_press","Dumbbell Floor Press","triceps",0.69,1,0,{triceps:0.7,pecs:0.15,epaules:0.15},"dumbbell"],
["db_dumbbell_flyes","Dumbbell Flyes","pecs",1.49,1,0,{pecs:1.0},"dumbbell"],
["db_dumbbell_incline_row","Dumbbell Incline Row","dos",1.49,1,0,{dos:0.7,biceps:0.2,epaules:0.1},"dumbbell"],
["db_dumbbell_incline_shoulder_raise","Dumbbell Incline Shoulder Raise","epaules",1.03,1,0,{epaules:0.7,triceps:0.3},"dumbbell"],
["db_dumbbell_lunges","Dumbbell Lunges","quads",2.3,1,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"dumbbell"],
["db_dumbbell_lying_one_arm_rear_latera","Dumbbell Lying One-Arm Rear Lateral Raise","epaules",1.03,1,0,{epaules:0.7,dos:0.3},"dumbbell"],
["db_dumbbell_lying_pronation","Dumbbell Lying Pronation","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
["db_dumbbell_lying_rear_lateral_raise","Dumbbell Lying Rear Lateral Raise","epaules",1.03,1,0,{epaules:1.0},"dumbbell"],
["db_dumbbell_lying_supination","Dumbbell Lying Supination","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
["db_dumbbell_one_arm_shoulder_press","Dumbbell One-Arm Shoulder Press","epaules",1.03,1,0,{epaules:0.7,triceps:0.3},"dumbbell"],
["db_dumbbell_one_arm_triceps_extension","Dumbbell One-Arm Triceps Extension","triceps",0.69,1,0,{triceps:1.0},"dumbbell"],
["db_dumbbell_one_arm_upright_row","Dumbbell One-Arm Upright Row","epaules",1.03,1,0,{epaules:0.7,biceps:0.3},"dumbbell"],
["db_dumbbell_prone_incline_curl","Dumbbell Prone Incline Curl","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
["db_dumbbell_raise","Dumbbell Raise","epaules",1.03,1,0,{epaules:0.7,biceps:0.3},"dumbbell"],
["db_dumbbell_rear_lunge","Dumbbell Rear Lunge","quads",2.3,1,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"dumbbell"],
["db_dumbbell_scaption","Dumbbell Scaption","epaules",1.03,1,0,{epaules:1.0},"dumbbell"],
["db_dumbbell_seated_box_jump","Dumbbell Seated Box Jump","quads",2.3,1,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"dumbbell"],
["db_dumbbell_seated_one_leg_calf_raise","Dumbbell Seated One-Leg Calf Raise","mollets",2.07,1,0,{mollets:1.0},"dumbbell"],
["db_dumbbell_shoulder_press","Dumbbell Shoulder Press","epaules",1.03,1,0,{epaules:0.7,triceps:0.3},"dumbbell"],
["db_dumbbell_shrug","Dumbbell Shrug","epaules",1.03,1,0,{epaules:1.0},"dumbbell"],
["db_dumbbell_side_bend","Dumbbell Side Bend","abdos",0.69,1,0,{abdos:1.0},"dumbbell"],
["db_dumbbell_squat","Dumbbell Squat","quads",2.3,1,0,{quads:0.7,mollets:0.07,fessiers:0.07,ischios:0.07,dos:0.07},"dumbbell"],
["db_dumbbell_squat_to_a_bench","Dumbbell Squat To A Bench","quads",2.3,1,0,{quads:0.7,mollets:0.07,fessiers:0.07,ischios:0.07,dos:0.07},"dumbbell"],
["db_dumbbell_step_ups","Dumbbell Step Ups","quads",2.3,1,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"dumbbell"],
["db_dumbbell_tricep_extension_pronated","Dumbbell Tricep Extension -Pronated Grip","triceps",0.69,1,0,{triceps:1.0},"dumbbell"],
["db_dynamic_back_stretch","Dynamic Back Stretch","dos",1.49,0,0,{dos:1.0},"autre"],
["db_dynamic_chest_stretch","Dynamic Chest Stretch","pecs",1.49,0,0,{pecs:0.7,dos:0.3},"autre"],
["db_ez_bar_curl","EZ-Bar Curl","biceps",0.69,0,0,{biceps:1.0},"e-z curl bar"],
["db_ez_bar_skullcrusher","EZ-Bar Skullcrusher","triceps",0.69,0,0,{triceps:0.7,biceps:0.3},"e-z curl bar"],
["db_elbow_circles","Elbow Circles","epaules",1.03,0,0,{epaules:1.0},"autre"],
["db_elbow_to_knee","Elbow to Knee","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_elbows_back","Elbows Back","pecs",1.49,0,0,{pecs:0.7,epaules:0.3},"autre"],
["db_elevated_back_lunge","Elevated Back Lunge","quads",2.3,0,0,{quads:0.7,fessiers:0.15,ischios:0.15},"barbell"],
["db_elevated_cable_rows","Elevated Cable Rows","dos",1.49,0,0,{dos:0.7,epaules:0.3},"cable"],
["db_elliptical_trainer","Elliptical Trainer","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"machine"],
["db_exercise_ball_crunch","Exercise Ball Crunch","abdos",0.69,0,0,{abdos:1.0},"exercise ball"],
["db_exercise_ball_pull_in","Exercise Ball Pull-In","abdos",0.69,0,0,{abdos:1.0},"exercise ball"],
["db_extended_range_one_arm_kettlebell_","Extended Range One-Arm Kettlebell Floor Press","pecs",1.49,0,0,{pecs:0.7,epaules:0.15,triceps:0.15},"kettlebells"],
["db_external_rotation","External Rotation","epaules",1.03,1,0,{epaules:1.0},"dumbbell"],
["db_external_rotation_with_band","External Rotation with Band","epaules",1.03,0,0,{epaules:1.0},"bands"],
["db_external_rotation_with_cable","External Rotation with Cable","epaules",1.03,0,0,{epaules:1.0},"cable"],
["db_face_pull","Face Pull","epaules",1.03,0,0,{epaules:0.7,dos:0.3},"cable"],
["db_farmer_s_walk","Farmer's Walk","biceps",0.69,0,0,{biceps:0.7,abdos:0.05,fessiers:0.05,ischios:0.05,dos:0.05,quads:0.05,epaules:0.05},"other"],
["db_fast_skipping","Fast Skipping","quads",2.3,0,1,{quads:0.7,fessiers:0.18,mollets:0.06,ischios:0.06},"body only"],
["db_finger_curls","Finger Curls","biceps",0.69,0,0,{biceps:1.0},"barbell"],
["db_flat_bench_cable_flyes","Flat Bench Cable Flyes","pecs",1.49,0,0,{pecs:1.0},"cable"],
["db_flat_bench_leg_pull_in","Flat Bench Leg Pull-In","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_flat_bench_lying_leg_raise","Flat Bench Lying Leg Raise","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_flexor_incline_dumbbell_curls","Flexor Incline Dumbbell Curls","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
["db_floor_glute_ham_raise","Floor Glute-Ham Raise","ischios",1.72,0,0,{ischios:0.7,mollets:0.15,fessiers:0.15},"autre"],
["db_floor_press","Floor Press","triceps",0.69,0,0,{triceps:0.7,pecs:0.15,epaules:0.15},"barbell"],
["db_floor_press_with_chains","Floor Press with Chains","triceps",0.69,0,0,{triceps:0.7,pecs:0.15,epaules:0.15},"barbell"],
["db_flutter_kicks","Flutter Kicks","fessiers",1.72,0,1,{fessiers:0.7,ischios:0.3},"body only"],
["db_foot_smr","Foot-SMR","mollets",2.07,0,0,{mollets:1.0},"other"],
["db_forward_drag_with_press","Forward Drag with Press","pecs",1.49,0,0,{pecs:0.7,mollets:0.05,fessiers:0.05,ischios:0.05,quads:0.05,epaules:0.05,triceps:0.05},"other"],
["db_frankenstein_squat","Frankenstein Squat","quads",2.3,0,0,{quads:0.7,abdos:0.07,mollets:0.07,fessiers:0.07,ischios:0.07},"barbell"],
["db_freehand_jump_squat","Freehand Jump Squat","quads",2.3,0,1,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"body only"],
["db_frog_hops","Frog Hops","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"autre"],
["db_frog_sit_ups","Frog Sit-Ups","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_front_barbell_squat","Front Barbell Squat","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"barbell"],
["db_front_barbell_squat_to_a_bench","Front Barbell Squat To A Bench","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"barbell"],
["db_front_box_jump","Front Box Jump","ischios",1.72,0,0,{ischios:0.7,fessiers:0.18,mollets:0.06,quads:0.06},"other"],
["db_front_cable_raise","Front Cable Raise","epaules",1.03,0,0,{epaules:1.0},"cable"],
["db_front_cone_hops_or_hurdle_hops","Front Cone Hops (or hurdle hops)","quads",2.3,0,0,{quads:0.7,fessiers:0.18,mollets:0.06,ischios:0.06},"other"],
["db_front_dumbbell_raise","Front Dumbbell Raise","epaules",1.03,1,0,{epaules:1.0},"dumbbell"],
["db_front_incline_dumbbell_raise","Front Incline Dumbbell Raise","epaules",1.03,1,0,{epaules:1.0},"dumbbell"],
["db_front_leg_raises","Front Leg Raises","ischios",1.72,0,1,{ischios:1.0},"body only"],
["db_front_plate_raise","Front Plate Raise","epaules",1.03,0,0,{epaules:1.0},"other"],
["db_front_raise_and_pullover","Front Raise And Pullover","pecs",1.49,0,0,{pecs:0.7,dos:0.1,epaules:0.1,triceps:0.1},"barbell"],
["db_front_squat_clean_grip","Front Squat (Clean Grip)","quads",2.3,0,0,{quads:0.7,abdos:0.1,fessiers:0.1,ischios:0.1},"barbell"],
["db_front_squats_with_two_kettlebells","Front Squats With Two Kettlebells","quads",2.3,0,0,{quads:0.7,mollets:0.15,fessiers:0.15},"kettlebells"],
["db_front_two_dumbbell_raise","Front Two-Dumbbell Raise","epaules",1.03,1,0,{epaules:1.0},"dumbbell"],
["db_full_range_of_motion_lat_pulldown","Full Range-Of-Motion Lat Pulldown","dos",1.49,0,0,{dos:0.7,biceps:0.15,epaules:0.15},"cable"],
["db_gironda_sternum_chins","Gironda Sternum Chins","dos",1.49,0,0,{dos:0.7,biceps:0.3},"other"],
["db_glute_ham_raise","Glute Ham Raise","ischios",1.72,0,0,{ischios:0.7,mollets:0.15,fessiers:0.15},"machine"],
["db_glute_kickback","Glute Kickback","fessiers",1.72,0,1,{fessiers:0.7,ischios:0.3},"body only"],
["db_goblet_squat","Goblet Squat","quads",2.3,0,0,{quads:0.7,mollets:0.07,fessiers:0.07,ischios:0.07,epaules:0.07},"kettlebells"],
["db_good_morning","Good Morning","ischios",1.72,0,0,{ischios:0.7,abdos:0.1,fessiers:0.1,dos:0.1},"barbell"],
["db_good_morning_off_pins","Good Morning off Pins","ischios",1.72,0,0,{ischios:0.7,abdos:0.1,fessiers:0.1,dos:0.1},"barbell"],
["db_gorilla_chin_crunch","Gorilla Chin/Crunch","abdos",0.69,0,1,{abdos:0.7,biceps:0.15,dos:0.15},"body only"],
["db_groin_and_back_stretch","Groin and Back Stretch","fessiers",1.72,0,0,{fessiers:1.0},"autre"],
["db_groiners","Groiners","fessiers",1.72,0,1,{fessiers:1.0},"body only"],
["db_hack_squat","Hack Squat","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"machine"],
["db_hammer_curls","Hammer Curls","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
["db_hammer_grip_incline_db_bench_press","Hammer Grip Incline DB Bench Press","pecs",1.49,1,0,{pecs:0.7,epaules:0.15,triceps:0.15},"dumbbell"],
["db_hamstring_smr","Hamstring-SMR","ischios",1.72,0,0,{ischios:1.0},"foam roll"],
["db_hamstring_stretch","Hamstring Stretch","ischios",1.72,0,0,{ischios:1.0},"autre"],
["db_handstand_push_ups","Handstand Push-Ups","epaules",1.03,0,1,{epaules:0.7,triceps:0.3},"body only"],
["db_hang_clean","Hang Clean","quads",2.3,0,0,{quads:0.7,mollets:0.04,biceps:0.04,fessiers:0.04,ischios:0.04,dos:0.04,epaules:0.08},"barbell"],
["db_hang_clean_below_the_knees","Hang Clean - Below the Knees","quads",2.3,0,0,{quads:0.7,mollets:0.04,biceps:0.04,fessiers:0.04,ischios:0.04,dos:0.04,epaules:0.08},"barbell"],
["db_hang_snatch","Hang Snatch","ischios",1.72,0,0,{ischios:0.7,abdos:0.04,mollets:0.04,biceps:0.04,fessiers:0.04,dos:0.04,quads:0.04,epaules:0.08},"barbell"],
["db_hang_snatch_below_knees","Hang Snatch - Below Knees","ischios",1.72,0,0,{ischios:0.7,abdos:0.04,mollets:0.04,biceps:0.04,fessiers:0.04,dos:0.04,quads:0.04,epaules:0.08},"barbell"],
["db_hanging_bar_good_morning","Hanging Bar Good Morning","ischios",1.72,0,0,{ischios:0.7,abdos:0.1,fessiers:0.1,dos:0.1},"barbell"],
["db_hanging_leg_raise","Hanging Leg Raise","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_hanging_pike","Hanging Pike","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_heaving_snatch_balance","Heaving Snatch Balance","quads",2.3,0,0,{quads:0.7,abdos:0.05,biceps:0.05,fessiers:0.05,ischios:0.05,epaules:0.05,triceps:0.05},"barbell"],
["db_heavy_bag_thrust","Heavy Bag Thrust","pecs",1.49,0,0,{pecs:0.7,abdos:0.1,epaules:0.1,triceps:0.1},"other"],
["db_high_cable_curls","High Cable Curls","biceps",0.69,0,0,{biceps:1.0},"cable"],
["db_hip_circles_prone","Hip Circles (prone)","fessiers",1.72,0,1,{fessiers:1.0},"body only"],
["db_hip_extension_with_bands","Hip Extension with Bands","fessiers",1.72,0,0,{fessiers:0.7,ischios:0.3},"bands"],
["db_hip_flexion_with_band","Hip Flexion with Band","quads",2.3,0,0,{quads:1.0},"bands"],
["db_hip_lift_with_band","Hip Lift with Band","fessiers",1.72,0,0,{fessiers:0.7,mollets:0.15,ischios:0.15},"bands"],
["db_hug_a_ball","Hug A Ball","dos",1.49,0,0,{dos:0.7,mollets:0.15,fessiers:0.15},"exercise ball"],
["db_hug_knees_to_chest","Hug Knees To Chest","dos",1.49,0,0,{dos:0.7,fessiers:0.3},"autre"],
["db_hurdle_hops","Hurdle Hops","ischios",1.72,0,0,{ischios:0.7,fessiers:0.21000000000000002,mollets:0.07},"other"],
["db_hyperextensions_back_extensions","Hyperextensions (Back Extensions)","dos",1.49,0,0,{dos:0.7,fessiers:0.15,ischios:0.15},"other"],
["db_hyperextensions_with_no_hyperexten","Hyperextensions With No Hyperextension Bench","dos",1.49,0,1,{dos:0.7,fessiers:0.15,ischios:0.15},"body only"],
["db_it_band_and_glute_stretch","IT Band and Glute Stretch","fessiers",1.72,0,0,{fessiers:1.0},"other"],
["db_iliotibial_tract_smr","Iliotibial Tract-SMR","fessiers",1.72,0,0,{fessiers:1.0},"foam roll"],
["db_inchworm","Inchworm","ischios",1.72,0,1,{ischios:1.0},"body only"],
["db_incline_barbell_triceps_extension","Incline Barbell Triceps Extension","triceps",0.69,0,0,{triceps:0.7,biceps:0.3},"barbell"],
["db_incline_bench_pull","Incline Bench Pull","dos",1.49,0,0,{dos:0.7,epaules:0.3},"barbell"],
["db_incline_cable_chest_press","Incline Cable Chest Press","pecs",1.49,0,0,{pecs:0.7,epaules:0.15,triceps:0.15},"cable"],
["db_incline_cable_flye","Incline Cable Flye","pecs",1.49,0,0,{pecs:0.7,epaules:0.3},"cable"],
["db_incline_dumbbell_bench_with_palms_","Incline Dumbbell Bench With Palms Facing In","pecs",1.49,1,0,{pecs:0.7,epaules:0.15,triceps:0.15},"dumbbell"],
["db_incline_dumbbell_curl","Incline Dumbbell Curl","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
["db_incline_dumbbell_flyes","Incline Dumbbell Flyes","pecs",1.49,1,0,{pecs:0.7,epaules:0.3},"dumbbell"],
["db_incline_dumbbell_flyes_with_a_twis","Incline Dumbbell Flyes - With A Twist","pecs",1.49,1,0,{pecs:0.7,epaules:0.3},"dumbbell"],
["db_incline_dumbbell_press","Incline Dumbbell Press","pecs",1.49,1,0,{pecs:0.7,epaules:0.15,triceps:0.15},"dumbbell"],
["db_incline_hammer_curls","Incline Hammer Curls","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
["db_incline_inner_biceps_curl","Incline Inner Biceps Curl","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
["db_incline_push_up","Incline Push-Up","pecs",1.49,0,1,{pecs:0.7,epaules:0.15,triceps:0.15},"body only"],
["db_incline_push_up_close_grip","Incline Push-Up Close-Grip","triceps",0.69,0,1,{triceps:0.7,pecs:0.15,epaules:0.15},"body only"],
["db_incline_push_up_depth_jump","Incline Push-Up Depth Jump","pecs",1.49,0,0,{pecs:0.7,epaules:0.15,triceps:0.15},"other"],
["db_incline_push_up_medium","Incline Push-Up Medium","pecs",1.49,0,1,{pecs:0.7,abdos:0.1,epaules:0.1,triceps:0.1},"body only"],
["db_incline_push_up_reverse_grip","Incline Push-Up Reverse Grip","pecs",1.49,0,1,{pecs:0.7,abdos:0.1,epaules:0.1,triceps:0.1},"body only"],
["db_incline_push_up_wide","Incline Push-Up Wide","pecs",1.49,0,1,{pecs:0.7,abdos:0.1,epaules:0.1,triceps:0.1},"body only"],
["db_intermediate_groin_stretch","Intermediate Groin Stretch","ischios",1.72,0,0,{ischios:1.0},"other"],
["db_intermediate_hip_flexor_and_quad_s","Intermediate Hip Flexor and Quad Stretch","quads",2.3,0,0,{quads:1.0},"other"],
["db_internal_rotation_with_band","Internal Rotation with Band","epaules",1.03,0,0,{epaules:1.0},"bands"],
["db_inverted_row","Inverted Row","dos",1.49,0,0,{dos:1.0},"autre"],
["db_inverted_row_with_straps","Inverted Row with Straps","dos",1.49,0,0,{dos:0.7,biceps:0.3},"other"],
["db_iron_cross","Iron Cross","epaules",1.03,1,0,{epaules:0.7,pecs:0.06,fessiers:0.06,ischios:0.06,dos:0.06,quads:0.06},"dumbbell"],
["db_iron_crosses_stretch","Iron Crosses (stretch)","quads",2.3,0,0,{quads:1.0},"autre"],
["db_isometric_chest_squeezes","Isometric Chest Squeezes","pecs",1.49,0,1,{pecs:0.7,epaules:0.15,triceps:0.15},"body only"],
["db_isometric_neck_exercise_front_and_","Isometric Neck Exercise - Front And Back","epaules",1.03,0,1,{epaules:1.0},"body only"],
["db_isometric_neck_exercise_sides","Isometric Neck Exercise - Sides","epaules",1.03,0,1,{epaules:1.0},"body only"],
["db_isometric_wipers","Isometric Wipers","pecs",1.49,0,1,{pecs:0.7,abdos:0.1,epaules:0.1,triceps:0.1},"body only"],
["db_jm_press","JM Press","triceps",0.69,0,0,{triceps:0.7,pecs:0.15,epaules:0.15},"barbell"],
["db_jackknife_sit_up","Jackknife Sit-Up","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_janda_sit_up","Janda Sit-Up","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_jefferson_squats","Jefferson Squats","quads",2.3,0,0,{quads:0.7,mollets:0.06,fessiers:0.06,ischios:0.06,dos:0.06,epaules:0.06},"barbell"],
["db_jerk_balance","Jerk Balance","epaules",1.03,0,0,{epaules:0.7,fessiers:0.07,ischios:0.07,quads:0.07,triceps:0.07},"barbell"],
["db_jerk_dip_squat","Jerk Dip Squat","quads",2.3,0,0,{quads:0.7,abdos:0.15,mollets:0.15},"barbell"],
["db_jogging_treadmill","Jogging, Treadmill","quads",2.3,0,0,{quads:0.7,fessiers:0.15,ischios:0.15},"machine"],
["db_keg_load","Keg Load","dos",1.49,0,0,{dos:0.7,abdos:0.03,biceps:0.06,mollets:0.03,fessiers:0.03,ischios:0.03,quads:0.03,epaules:0.06},"other"],
["db_kettlebell_arnold_press","Kettlebell Arnold Press","epaules",1.03,0,0,{epaules:0.7,triceps:0.3},"kettlebells"],
["db_kettlebell_dead_clean","Kettlebell Dead Clean","ischios",1.72,0,0,{ischios:0.7,mollets:0.06,fessiers:0.06,dos:0.06,quads:0.06,epaules:0.06},"kettlebells"],
["db_kettlebell_figure_8","Kettlebell Figure 8","abdos",0.69,0,0,{abdos:0.7,ischios:0.15,epaules:0.15},"kettlebells"],
["db_kettlebell_hang_clean","Kettlebell Hang Clean","ischios",1.72,0,0,{ischios:0.7,mollets:0.06,fessiers:0.06,dos:0.06,epaules:0.12},"kettlebells"],
["db_kettlebell_one_legged_deadlift","Kettlebell One-Legged Deadlift","ischios",1.72,0,0,{ischios:0.7,fessiers:0.15,dos:0.15},"kettlebells"],
["db_kettlebell_pass_between_the_legs","Kettlebell Pass Between The Legs","abdos",0.69,0,0,{abdos:0.7,fessiers:0.1,ischios:0.1,epaules:0.1},"kettlebells"],
["db_kettlebell_pirate_ships","Kettlebell Pirate Ships","epaules",1.03,0,0,{epaules:0.7,abdos:0.3},"kettlebells"],
["db_kettlebell_pistol_squat","Kettlebell Pistol Squat","quads",2.3,0,0,{quads:0.7,mollets:0.07,fessiers:0.07,ischios:0.07,epaules:0.07},"kettlebells"],
["db_kettlebell_seated_press","Kettlebell Seated Press","epaules",1.03,0,0,{epaules:0.7,triceps:0.3},"kettlebells"],
["db_kettlebell_seesaw_press","Kettlebell Seesaw Press","epaules",1.03,0,0,{epaules:0.7,triceps:0.3},"kettlebells"],
["db_kettlebell_sumo_high_pull","Kettlebell Sumo High Pull","epaules",1.03,0,0,{epaules:0.7,fessiers:0.14,ischios:0.07,quads:0.07},"kettlebells"],
["db_kettlebell_thruster","Kettlebell Thruster","epaules",1.03,0,0,{epaules:0.7,quads:0.15,triceps:0.15},"kettlebells"],
["db_kettlebell_turkish_get_up_lunge_st","Kettlebell Turkish Get-Up (Lunge style)","epaules",1.03,0,0,{epaules:0.7,abdos:0.07,ischios:0.07,quads:0.07,triceps:0.07},"kettlebells"],
["db_kettlebell_turkish_get_up_squat_st","Kettlebell Turkish Get-Up (Squat style)","epaules",1.03,0,0,{epaules:0.7,abdos:0.06,mollets:0.06,ischios:0.06,quads:0.06,triceps:0.06},"kettlebells"],
["db_kettlebell_windmill","Kettlebell Windmill","abdos",0.69,0,0,{abdos:0.7,fessiers:0.07,ischios:0.07,epaules:0.07,triceps:0.07},"kettlebells"],
["db_kipping_muscle_up","Kipping Muscle Up","dos",1.49,0,0,{dos:0.7,abdos:0.05,biceps:0.1,epaules:0.1,triceps:0.05},"other"],
["db_knee_across_the_body","Knee Across The Body","fessiers",1.72,0,0,{fessiers:0.7,dos:0.3},"autre"],
["db_knee_circles","Knee Circles","mollets",2.07,0,1,{mollets:0.7,ischios:0.15,quads:0.15},"body only"],
["db_knee_hip_raise_on_parallel_bars","Knee/Hip Raise On Parallel Bars","abdos",0.69,0,0,{abdos:1.0},"other"],
["db_knee_tuck_jump","Knee Tuck Jump","ischios",1.72,0,1,{ischios:0.7,fessiers:0.18,mollets:0.06,quads:0.06},"body only"],
["db_kneeling_arm_drill","Kneeling Arm Drill","epaules",1.03,0,0,{epaules:0.7,abdos:0.3},"autre"],
["db_kneeling_cable_crunch_with_alterna","Kneeling Cable Crunch With Alternating Oblique Twists","abdos",0.69,0,0,{abdos:1.0},"cable"],
["db_kneeling_cable_triceps_extension","Kneeling Cable Triceps Extension","triceps",0.69,0,0,{triceps:1.0},"cable"],
["db_kneeling_forearm_stretch","Kneeling Forearm Stretch","biceps",0.69,0,0,{biceps:1.0},"autre"],
["db_kneeling_high_pulley_row","Kneeling High Pulley Row","dos",1.49,0,0,{dos:0.7,biceps:0.3},"cable"],
["db_kneeling_hip_flexor","Kneeling Hip Flexor","quads",2.3,0,0,{quads:1.0},"autre"],
["db_kneeling_jump_squat","Kneeling Jump Squat","fessiers",1.72,0,0,{fessiers:0.7,mollets:0.1,ischios:0.1,quads:0.1},"barbell"],
["db_kneeling_single_arm_high_pulley_ro","Kneeling Single-Arm High Pulley Row","dos",1.49,0,0,{dos:0.7,biceps:0.3},"cable"],
["db_kneeling_squat","Kneeling Squat","fessiers",1.72,0,0,{fessiers:0.7,abdos:0.1,ischios:0.1,dos:0.1},"barbell"],
["db_landmine_180_s","Landmine 180's","abdos",0.69,0,0,{abdos:0.7,fessiers:0.1,dos:0.1,epaules:0.1},"barbell"],
["db_landmine_linear_jammer","Landmine Linear Jammer","epaules",1.03,0,0,{epaules:0.7,abdos:0.05,mollets:0.05,pecs:0.05,ischios:0.05,quads:0.05,triceps:0.05},"barbell"],
["db_lateral_bound","Lateral Bound","fessiers",1.72,0,1,{fessiers:0.7,mollets:0.1,ischios:0.1,quads:0.1},"body only"],
["db_lateral_box_jump","Lateral Box Jump","fessiers",1.72,0,0,{fessiers:0.7,mollets:0.1,ischios:0.1,quads:0.1},"other"],
["db_lateral_cone_hops","Lateral Cone Hops","fessiers",1.72,0,0,{fessiers:0.7,mollets:0.1,ischios:0.1,quads:0.1},"other"],
["db_lateral_raise_with_bands","Lateral Raise - With Bands","epaules",1.03,0,0,{epaules:1.0},"bands"],
["db_latissimus_dorsi_smr","Latissimus Dorsi-SMR","dos",1.49,0,0,{dos:1.0},"foam roll"],
["db_leg_over_floor_press","Leg-Over Floor Press","pecs",1.49,0,0,{pecs:0.7,epaules:0.15,triceps:0.15},"kettlebells"],
["db_leg_up_hamstring_stretch","Leg-Up Hamstring Stretch","ischios",1.72,0,0,{ischios:1.0},"autre"],
["db_leg_extensions","Leg Extensions","quads",2.3,0,0,{quads:1.0},"machine"],
["db_leg_lift","Leg Lift","fessiers",1.72,0,1,{fessiers:0.7,ischios:0.3},"body only"],
["db_leg_press","Leg Press","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"machine"],
["db_leg_pull_in","Leg Pull-In","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_leverage_chest_press","Leverage Chest Press","pecs",1.49,0,0,{pecs:0.7,epaules:0.15,triceps:0.15},"machine"],
["db_leverage_deadlift","Leverage Deadlift","quads",2.3,0,0,{quads:0.7,fessiers:0.15,ischios:0.15},"machine"],
["db_leverage_decline_chest_press","Leverage Decline Chest Press","pecs",1.49,0,0,{pecs:0.7,epaules:0.15,triceps:0.15},"machine"],
["db_leverage_high_row","Leverage High Row","dos",1.49,0,0,{dos:1.0},"machine"],
["db_leverage_incline_chest_press","Leverage Incline Chest Press","pecs",1.49,0,0,{pecs:0.7,epaules:0.15,triceps:0.15},"machine"],
["db_leverage_iso_row","Leverage Iso Row","dos",1.49,0,0,{dos:0.7,biceps:0.3},"machine"],
["db_leverage_shoulder_press","Leverage Shoulder Press","epaules",1.03,0,0,{epaules:0.7,triceps:0.3},"machine"],
["db_leverage_shrug","Leverage Shrug","epaules",1.03,0,0,{epaules:0.7,biceps:0.3},"machine"],
["db_linear_3_part_start_technique","Linear 3-Part Start Technique","ischios",1.72,0,0,{ischios:0.7,mollets:0.15,quads:0.15},"autre"],
["db_linear_acceleration_wall_drill","Linear Acceleration Wall Drill","ischios",1.72,0,0,{ischios:0.7,mollets:0.1,fessiers:0.1,quads:0.1},"autre"],
["db_linear_depth_jump","Linear Depth Jump","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"other"],
["db_log_lift","Log Lift","epaules",1.03,0,0,{epaules:0.7,abdos:0.04,pecs:0.04,fessiers:0.04,ischios:0.04,dos:0.08,quads:0.04,triceps:0.04},"other"],
["db_london_bridges","London Bridges","dos",1.49,0,0,{dos:0.7,biceps:0.3},"other"],
["db_looking_at_ceiling","Looking At Ceiling","quads",2.3,0,0,{quads:1.0},"autre"],
["db_low_cable_crossover","Low Cable Crossover","pecs",1.49,0,0,{pecs:0.7,epaules:0.3},"cable"],
["db_low_cable_triceps_extension","Low Cable Triceps Extension","triceps",0.69,0,0,{triceps:1.0},"cable"],
["db_low_pulley_row_to_neck","Low Pulley Row To Neck","epaules",1.03,0,0,{epaules:0.7,biceps:0.15,dos:0.15},"cable"],
["db_lower_back_smr","Lower Back-SMR","dos",1.49,0,0,{dos:1.0},"foam roll"],
["db_lower_back_curl","Lower Back Curl","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_lunge_pass_through","Lunge Pass Through","ischios",1.72,0,0,{ischios:0.7,mollets:0.1,fessiers:0.1,quads:0.1},"kettlebells"],
["db_lunge_sprint","Lunge Sprint","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"machine"],
["db_lying_bent_leg_groin","Lying Bent Leg Groin","fessiers",1.72,0,0,{fessiers:1.0},"other"],
["db_lying_cable_curl","Lying Cable Curl","biceps",0.69,0,0,{biceps:1.0},"cable"],
["db_lying_cambered_barbell_row","Lying Cambered Barbell Row","dos",1.49,0,0,{dos:0.7,biceps:0.15,epaules:0.15},"barbell"],
["db_lying_close_grip_bar_curl_on_high_","Lying Close-Grip Bar Curl On High Pulley","biceps",0.69,0,0,{biceps:1.0},"cable"],
["db_lying_close_grip_barbell_triceps_e","Lying Close-Grip Barbell Triceps Extension Behind The Head","triceps",0.69,0,0,{triceps:1.0},"barbell"],
["db_lying_close_grip_barbell_triceps_p","Lying Close-Grip Barbell Triceps Press To Chin","triceps",0.69,0,0,{triceps:1.0},"e-z curl bar"],
["db_lying_crossover","Lying Crossover","fessiers",1.72,0,1,{fessiers:1.0},"body only"],
["db_lying_dumbbell_tricep_extension","Lying Dumbbell Tricep Extension","triceps",0.69,1,0,{triceps:0.7,pecs:0.15,epaules:0.15},"dumbbell"],
["db_lying_face_down_plate_neck_resista","Lying Face Down Plate Neck Resistance","epaules",1.03,0,0,{epaules:1.0},"other"],
["db_lying_face_up_plate_neck_resistanc","Lying Face Up Plate Neck Resistance","epaules",1.03,0,0,{epaules:1.0},"other"],
["db_lying_glute","Lying Glute","fessiers",1.72,0,1,{fessiers:1.0},"body only"],
["db_lying_hamstring","Lying Hamstring","ischios",1.72,0,0,{ischios:0.7,mollets:0.3},"other"],
["db_lying_high_bench_barbell_curl","Lying High Bench Barbell Curl","biceps",0.69,0,0,{biceps:1.0},"barbell"],
["db_lying_leg_curls","Lying Leg Curls","ischios",1.72,0,0,{ischios:1.0},"machine"],
["db_lying_machine_squat","Lying Machine Squat","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"machine"],
["db_lying_one_arm_lateral_raise","Lying One-Arm Lateral Raise","epaules",1.03,1,0,{epaules:1.0},"dumbbell"],
["db_lying_prone_quadriceps","Lying Prone Quadriceps","quads",2.3,0,1,{quads:1.0},"body only"],
["db_lying_rear_delt_raise","Lying Rear Delt Raise","epaules",1.03,1,0,{epaules:1.0},"dumbbell"],
["db_lying_supine_dumbbell_curl","Lying Supine Dumbbell Curl","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
["db_lying_t_bar_row","Lying T-Bar Row","dos",1.49,0,0,{dos:0.7,biceps:0.3},"machine"],
["db_lying_triceps_press","Lying Triceps Press","triceps",0.69,0,0,{triceps:1.0},"e-z curl bar"],
["db_machine_bench_press","Machine Bench Press","pecs",1.49,0,0,{pecs:0.7,epaules:0.15,triceps:0.15},"machine"],
["db_machine_bicep_curl","Machine Bicep Curl","biceps",0.69,0,0,{biceps:1.0},"machine"],
["db_machine_preacher_curls","Machine Preacher Curls","biceps",0.69,0,0,{biceps:1.0},"machine"],
["db_machine_shoulder_military_press","Machine Shoulder (Military) Press","epaules",1.03,0,0,{epaules:0.7,triceps:0.3},"machine"],
["db_machine_triceps_extension","Machine Triceps Extension","triceps",0.69,0,0,{triceps:1.0},"machine"],
["db_medicine_ball_chest_pass","Medicine Ball Chest Pass","pecs",1.49,0,0,{pecs:0.7,epaules:0.15,triceps:0.15},"medicine ball"],
["db_medicine_ball_full_twist","Medicine Ball Full Twist","abdos",0.69,0,0,{abdos:0.7,epaules:0.3},"medicine ball"],
["db_medicine_ball_scoop_throw","Medicine Ball Scoop Throw","epaules",1.03,0,0,{epaules:0.7,abdos:0.1,ischios:0.1,quads:0.1},"medicine ball"],
["db_middle_back_shrug","Middle Back Shrug","dos",1.49,1,0,{dos:1.0},"dumbbell"],
["db_middle_back_stretch","Middle Back Stretch","dos",1.49,0,0,{dos:0.7,abdos:0.3},"autre"],
["db_mixed_grip_chin","Mixed Grip Chin","dos",1.49,0,0,{dos:0.7,biceps:0.3},"other"],
["db_monster_walk","Monster Walk","fessiers",1.72,0,0,{fessiers:1.0},"bands"],
["db_mountain_climbers","Mountain Climbers","quads",2.3,0,0,{quads:0.7,pecs:0.1,ischios:0.1,epaules:0.1},"autre"],
["db_moving_claw_series","Moving Claw Series","ischios",1.72,0,0,{ischios:0.7,mollets:0.15,quads:0.15},"autre"],
["db_muscle_snatch","Muscle Snatch","ischios",1.72,0,0,{ischios:0.7,fessiers:0.06,dos:0.06,quads:0.06,epaules:0.06,triceps:0.06},"barbell"],
["db_muscle_up","Muscle Up","dos",1.49,0,0,{dos:0.7,abdos:0.05,biceps:0.1,epaules:0.1,triceps:0.05},"other"],
["db_narrow_stance_hack_squats","Narrow Stance Hack Squats","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"machine"],
["db_narrow_stance_leg_press","Narrow Stance Leg Press","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"machine"],
["db_narrow_stance_squats","Narrow Stance Squats","quads",2.3,0,0,{quads:0.7,mollets:0.07,fessiers:0.07,ischios:0.07,dos:0.07},"barbell"],
["db_natural_glute_ham_raise","Natural Glute Ham Raise","ischios",1.72,0,1,{ischios:0.7,mollets:0.1,fessiers:0.1,dos:0.1},"body only"],
["db_neck_smr","Neck-SMR","epaules",1.03,0,0,{epaules:1.0},"other"],
["db_neck_press","Neck Press","pecs",1.49,0,0,{pecs:0.7,epaules:0.15,triceps:0.15},"barbell"],
["db_oblique_crunches","Oblique Crunches","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_oblique_crunches_on_the_floor","Oblique Crunches - On The Floor","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_olympic_squat","Olympic Squat","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"barbell"],
["db_on_your_back_quad_stretch","On-Your-Back Quad Stretch","quads",2.3,0,0,{quads:1.0},"other"],
["db_on_your_side_quad_stretch","On Your Side Quad Stretch","quads",2.3,0,0,{quads:1.0},"autre"],
["db_one_arm_dumbbell_row","One-Arm Dumbbell Row","dos",1.49,1,0,{dos:0.7,biceps:0.15,epaules:0.15},"dumbbell"],
["db_one_arm_flat_bench_dumbbell_flye","One-Arm Flat Bench Dumbbell Flye","pecs",1.49,1,0,{pecs:1.0},"dumbbell"],
["db_one_arm_high_pulley_cable_side_ben","One-Arm High-Pulley Cable Side Bends","abdos",0.69,0,0,{abdos:1.0},"cable"],
["db_one_arm_incline_lateral_raise","One-Arm Incline Lateral Raise","epaules",1.03,1,0,{epaules:1.0},"dumbbell"],
["db_one_arm_kettlebell_clean","One-Arm Kettlebell Clean","ischios",1.72,0,0,{ischios:0.7,fessiers:0.07,dos:0.07,epaules:0.14},"kettlebells"],
["db_one_arm_kettlebell_clean_and_jerk","One-Arm Kettlebell Clean and Jerk","epaules",1.03,0,0,{epaules:1.0},"kettlebells"],
["db_one_arm_kettlebell_floor_press","One-Arm Kettlebell Floor Press","pecs",1.49,0,0,{pecs:0.7,triceps:0.3},"kettlebells"],
["db_one_arm_kettlebell_jerk","One-Arm Kettlebell Jerk","epaules",1.03,0,0,{epaules:0.7,mollets:0.1,quads:0.1,triceps:0.1},"kettlebells"],
["db_one_arm_kettlebell_military_press_","One-Arm Kettlebell Military Press To The Side","epaules",1.03,0,0,{epaules:0.7,triceps:0.3},"kettlebells"],
["db_one_arm_kettlebell_para_press","One-Arm Kettlebell Para Press","epaules",1.03,0,0,{epaules:0.7,triceps:0.3},"kettlebells"],
["db_one_arm_kettlebell_push_press","One-Arm Kettlebell Push Press","epaules",1.03,0,0,{epaules:0.7,mollets:0.1,quads:0.1,triceps:0.1},"kettlebells"],
["db_one_arm_kettlebell_row","One-Arm Kettlebell Row","dos",1.49,0,0,{dos:0.7,biceps:0.3},"kettlebells"],
["db_one_arm_kettlebell_snatch","One-Arm Kettlebell Snatch","epaules",1.03,0,0,{epaules:0.7,mollets:0.06,fessiers:0.06,ischios:0.06,dos:0.06,triceps:0.06},"kettlebells"],
["db_one_arm_kettlebell_split_jerk","One-Arm Kettlebell Split Jerk","epaules",1.03,0,0,{epaules:0.7,fessiers:0.07,ischios:0.07,quads:0.07,triceps:0.07},"kettlebells"],
["db_one_arm_kettlebell_split_snatch","One-Arm Kettlebell Split Snatch","epaules",1.03,0,0,{epaules:0.7,ischios:0.15,quads:0.15},"kettlebells"],
["db_one_arm_kettlebell_swings","One-Arm Kettlebell Swings","ischios",1.72,0,0,{ischios:0.7,mollets:0.07,fessiers:0.07,dos:0.07,epaules:0.07},"kettlebells"],
["db_one_arm_long_bar_row","One-Arm Long Bar Row","dos",1.49,0,0,{dos:0.7,biceps:0.3},"barbell"],
["db_one_arm_medicine_ball_slam","One-Arm Medicine Ball Slam","abdos",0.69,0,0,{abdos:0.7,dos:0.15,epaules:0.15},"medicine ball"],
["db_one_arm_open_palm_kettlebell_clean","One-Arm Open Palm Kettlebell Clean","ischios",1.72,0,0,{ischios:0.7,biceps:0.06,fessiers:0.06,dos:0.06,quads:0.06,epaules:0.06},"kettlebells"],
["db_one_arm_overhead_kettlebell_squats","One-Arm Overhead Kettlebell Squats","quads",2.3,0,0,{quads:0.7,mollets:0.07,fessiers:0.07,ischios:0.07,epaules:0.07},"kettlebells"],
["db_one_arm_side_deadlift","One-Arm Side Deadlift","quads",2.3,0,0,{quads:0.7,abdos:0.05,mollets:0.05,fessiers:0.05,ischios:0.05,dos:0.05,epaules:0.05},"barbell"],
["db_one_arm_side_laterals","One-Arm Side Laterals","epaules",1.03,1,0,{epaules:1.0},"dumbbell"],
["db_one_legged_cable_kickback","One-Legged Cable Kickback","fessiers",1.72,0,0,{fessiers:0.7,ischios:0.3},"cable"],
["db_one_arm_against_wall","One Arm Against Wall","dos",1.49,0,0,{dos:1.0},"autre"],
["db_one_arm_chin_up","One Arm Chin-Up","dos",1.49,0,0,{dos:0.7,biceps:0.3},"other"],
["db_one_arm_dumbbell_bench_press","One Arm Dumbbell Bench Press","pecs",1.49,1,0,{pecs:0.7,epaules:0.15,triceps:0.15},"dumbbell"],
["db_one_arm_dumbbell_preacher_curl","One Arm Dumbbell Preacher Curl","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
["db_one_arm_floor_press","One Arm Floor Press","triceps",0.69,0,0,{triceps:0.7,pecs:0.15,epaules:0.15},"barbell"],
["db_one_arm_lat_pulldown","One Arm Lat Pulldown","dos",1.49,0,0,{dos:0.7,biceps:0.3},"cable"],
["db_one_arm_pronated_dumbbell_triceps_","One Arm Pronated Dumbbell Triceps Extension","triceps",0.69,1,0,{triceps:1.0},"dumbbell"],
["db_one_arm_supinated_dumbbell_triceps","One Arm Supinated Dumbbell Triceps Extension","triceps",0.69,1,0,{triceps:1.0},"dumbbell"],
["db_one_half_locust","One Half Locust","quads",2.3,0,0,{quads:0.7,abdos:0.1,biceps:0.1,pecs:0.1},"autre"],
["db_one_handed_hang","One Handed Hang","dos",1.49,0,0,{dos:0.7,biceps:0.3},"other"],
["db_one_knee_to_chest","One Knee To Chest","fessiers",1.72,0,0,{fessiers:0.7,ischios:0.15,dos:0.15},"autre"],
["db_one_leg_barbell_squat","One Leg Barbell Squat","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"barbell"],
["db_open_palm_kettlebell_clean","Open Palm Kettlebell Clean","ischios",1.72,0,0,{ischios:0.7,fessiers:0.07,dos:0.07,quads:0.07,epaules:0.07},"kettlebells"],
["db_otis_up","Otis-Up","abdos",0.69,0,0,{abdos:0.7,pecs:0.1,epaules:0.1,triceps:0.1},"other"],
["db_overhead_cable_curl","Overhead Cable Curl","biceps",0.69,0,0,{biceps:1.0},"cable"],
["db_overhead_lat","Overhead Lat","dos",1.49,0,0,{dos:0.7,triceps:0.3},"other"],
["db_overhead_slam","Overhead Slam","dos",1.49,0,0,{dos:1.0},"medicine ball"],
["db_overhead_squat","Overhead Squat","quads",2.3,0,0,{quads:0.7,abdos:0.04,mollets:0.04,fessiers:0.04,ischios:0.04,dos:0.04,epaules:0.04,triceps:0.04},"barbell"],
["db_overhead_stretch","Overhead Stretch","abdos",0.69,0,0,{abdos:0.7,pecs:0.07,biceps:0.07,dos:0.07,triceps:0.07},"autre"],
["db_overhead_triceps","Overhead Triceps","triceps",0.69,0,1,{triceps:0.7,dos:0.3},"body only"],
["db_pallof_press","Pallof Press","abdos",0.69,0,0,{abdos:0.7,pecs:0.1,epaules:0.1,triceps:0.1},"cable"],
["db_pallof_press_with_rotation","Pallof Press With Rotation","abdos",0.69,0,0,{abdos:0.7,pecs:0.1,epaules:0.1,triceps:0.1},"cable"],
["db_palms_down_dumbbell_wrist_curl_ove","Palms-Down Dumbbell Wrist Curl Over A Bench","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
["db_palms_down_wrist_curl_over_a_bench","Palms-Down Wrist Curl Over A Bench","biceps",0.69,0,0,{biceps:1.0},"barbell"],
["db_palms_up_barbell_wrist_curl_over_a","Palms-Up Barbell Wrist Curl Over A Bench","biceps",0.69,0,0,{biceps:1.0},"barbell"],
["db_palms_up_dumbbell_wrist_curl_over_","Palms-Up Dumbbell Wrist Curl Over A Bench","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
["db_parallel_bar_dip","Parallel Bar Dip","triceps",0.69,0,0,{triceps:0.7,pecs:0.15,epaules:0.15},"other"],
["db_pelvic_tilt_into_bridge","Pelvic Tilt Into Bridge","dos",1.49,0,0,{dos:1.0},"autre"],
["db_peroneals_smr","Peroneals-SMR","mollets",2.07,0,0,{mollets:1.0},"foam roll"],
["db_peroneals_stretch","Peroneals Stretch","mollets",2.07,0,0,{mollets:1.0},"other"],
["db_physioball_hip_bridge","Physioball Hip Bridge","fessiers",1.72,0,0,{fessiers:0.7,ischios:0.3},"exercise ball"],
["db_pin_presses","Pin Presses","triceps",0.69,0,0,{triceps:0.7,pecs:0.06,biceps:0.06,dos:0.12,epaules:0.06},"barbell"],
["db_piriformis_smr","Piriformis-SMR","fessiers",1.72,0,0,{fessiers:1.0},"foam roll"],
["db_plank","Plank","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_plate_pinch","Plate Pinch","biceps",0.69,0,0,{biceps:1.0},"other"],
["db_plate_twist","Plate Twist","abdos",0.69,0,0,{abdos:1.0},"other"],
["db_platform_hamstring_slides","Platform Hamstring Slides","ischios",1.72,0,0,{ischios:0.7,fessiers:0.3},"other"],
["db_plie_dumbbell_squat","Plie Dumbbell Squat","quads",2.3,1,0,{quads:0.7,abdos:0.07,mollets:0.07,fessiers:0.07,ischios:0.07},"dumbbell"],
["db_plyo_kettlebell_pushups","Plyo Kettlebell Pushups","pecs",1.49,0,0,{pecs:0.7,epaules:0.15,triceps:0.15},"kettlebells"],
["db_plyo_push_up","Plyo Push-up","pecs",1.49,0,1,{pecs:0.7,epaules:0.15,triceps:0.15},"body only"],
["db_posterior_tibialis_stretch","Posterior Tibialis Stretch","mollets",2.07,0,0,{mollets:1.0},"other"],
["db_power_clean","Power Clean","ischios",1.72,0,0,{ischios:0.7,mollets:0.03,biceps:0.03,fessiers:0.03,dos:0.06,quads:0.03,epaules:0.06,triceps:0.03},"barbell"],
["db_power_clean_from_blocks","Power Clean from Blocks","ischios",1.72,0,0,{ischios:0.7,quads:0.3},"barbell"],
["db_power_jerk","Power Jerk","quads",2.3,0,0,{quads:0.7,abdos:0.05,mollets:0.05,fessiers:0.05,ischios:0.05,epaules:0.05,triceps:0.05},"barbell"],
["db_power_partials","Power Partials","epaules",1.03,1,0,{epaules:1.0},"dumbbell"],
["db_power_snatch","Power Snatch","ischios",1.72,0,0,{ischios:0.7,mollets:0.04,fessiers:0.04,dos:0.04,quads:0.04,epaules:0.08,triceps:0.04},"barbell"],
["db_power_snatch_from_blocks","Power Snatch from Blocks","quads",2.3,0,0,{quads:0.7,mollets:0.04,biceps:0.04,fessiers:0.04,ischios:0.04,dos:0.04,epaules:0.08,triceps:0.04},"barbell"],
["db_power_stairs","Power Stairs","ischios",1.72,0,0,{ischios:0.7,fessiers:0.08,mollets:0.04,dos:0.04,quads:0.04,epaules:0.08},"other"],
["db_preacher_curl","Preacher Curl","biceps",0.69,0,0,{biceps:1.0},"barbell"],
["db_preacher_hammer_dumbbell_curl","Preacher Hammer Dumbbell Curl","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
["db_press_sit_up","Press Sit-Up","abdos",0.69,0,0,{abdos:0.7,pecs:0.1,epaules:0.1,triceps:0.1},"barbell"],
["db_prone_manual_hamstring","Prone Manual Hamstring","ischios",1.72,0,0,{ischios:1.0},"autre"],
["db_prowler_sprint","Prowler Sprint","ischios",1.72,0,0,{ischios:0.7,mollets:0.06,pecs:0.06,fessiers:0.06,quads:0.06,epaules:0.06},"other"],
["db_pull_through","Pull Through","fessiers",1.72,0,0,{fessiers:0.7,ischios:0.15,dos:0.15},"cable"],
["db_pullups","Pullups","dos",1.49,0,1,{dos:0.7,biceps:0.3},"body only"],
["db_push_up_wide","Push-Up Wide","pecs",1.49,0,1,{pecs:0.7,abdos:0.1,epaules:0.1,triceps:0.1},"body only"],
["db_push_ups_close_triceps_position","Push-Ups - Close Triceps Position","triceps",0.69,0,1,{triceps:0.7,pecs:0.15,epaules:0.15},"body only"],
["db_push_ups_with_feet_elevated","Push-Ups With Feet Elevated","pecs",1.49,0,1,{pecs:0.7,epaules:0.15,triceps:0.15},"body only"],
["db_push_ups_with_feet_on_an_exercise_","Push-Ups With Feet On An Exercise Ball","pecs",1.49,0,0,{pecs:0.7,epaules:0.15,triceps:0.15},"exercise ball"],
["db_push_press","Push Press","epaules",1.03,0,0,{epaules:0.7,quads:0.15,triceps:0.15},"barbell"],
["db_push_press_behind_the_neck","Push Press - Behind the Neck","epaules",1.03,0,0,{epaules:0.7,mollets:0.1,quads:0.1,triceps:0.1},"barbell"],
["db_push_up_to_side_plank","Push Up to Side Plank","pecs",1.49,0,1,{pecs:0.7,abdos:0.1,epaules:0.1,triceps:0.1},"body only"],
["db_pushups","Pushups","pecs",1.49,0,1,{pecs:0.7,epaules:0.15,triceps:0.15},"body only"],
["db_pushups_close_and_wide_hand_positi","Pushups (Close and Wide Hand Positions)","pecs",1.49,0,1,{pecs:0.7,epaules:0.15,triceps:0.15},"body only"],
["db_pyramid","Pyramid","dos",1.49,0,0,{dos:0.7,epaules:0.3},"exercise ball"],
["db_quad_stretch","Quad Stretch","quads",2.3,0,0,{quads:1.0},"other"],
["db_quadriceps_smr","Quadriceps-SMR","quads",2.3,0,0,{quads:1.0},"foam roll"],
["db_quick_leap","Quick Leap","quads",2.3,0,0,{quads:0.7,mollets:0.15,ischios:0.15},"other"],
["db_rack_delivery","Rack Delivery","epaules",1.03,0,0,{epaules:0.7,biceps:0.3},"barbell"],
["db_rack_pull_with_bands","Rack Pull with Bands","dos",1.49,0,0,{dos:0.7,biceps:0.06,fessiers:0.06,ischios:0.06,quads:0.06,epaules:0.06},"barbell"],
["db_rack_pulls","Rack Pulls","dos",1.49,0,0,{dos:0.7,biceps:0.07,fessiers:0.07,ischios:0.07,epaules:0.07},"barbell"],
["db_rear_leg_raises","Rear Leg Raises","quads",2.3,0,1,{quads:1.0},"body only"],
["db_recumbent_bike","Recumbent Bike","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"machine"],
["db_return_push_from_stance","Return Push from Stance","epaules",1.03,0,0,{epaules:0.7,pecs:0.15,triceps:0.15},"medicine ball"],
["db_reverse_band_bench_press","Reverse Band Bench Press","triceps",0.69,0,0,{triceps:0.7,pecs:0.06,biceps:0.06,dos:0.12,epaules:0.06},"barbell"],
["db_reverse_band_box_squat","Reverse Band Box Squat","quads",2.3,0,0,{quads:0.7,fessiers:0.12,mollets:0.04,biceps:0.04,ischios:0.04,dos:0.04},"barbell"],
["db_reverse_band_deadlift","Reverse Band Deadlift","dos",1.49,0,0,{dos:0.7,fessiers:0.15000000000000002,mollets:0.05,ischios:0.05,quads:0.05},"barbell"],
["db_reverse_band_power_squat","Reverse Band Power Squat","quads",2.3,0,0,{quads:0.7,fessiers:0.12,mollets:0.06,ischios:0.06,dos:0.06},"barbell"],
["db_reverse_band_sumo_deadlift","Reverse Band Sumo Deadlift","ischios",1.72,0,0,{ischios:0.7,fessiers:0.12,mollets:0.04,biceps:0.04,dos:0.04,quads:0.04,epaules:0.04},"barbell"],
["db_reverse_barbell_curl","Reverse Barbell Curl","biceps",0.69,0,0,{biceps:1.0},"barbell"],
["db_reverse_barbell_preacher_curls","Reverse Barbell Preacher Curls","biceps",0.69,0,0,{biceps:1.0},"e-z curl bar"],
["db_reverse_cable_curl","Reverse Cable Curl","biceps",0.69,0,0,{biceps:1.0},"cable"],
["db_reverse_crunch","Reverse Crunch","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_reverse_flyes","Reverse Flyes","epaules",1.03,1,0,{epaules:1.0},"dumbbell"],
["db_reverse_flyes_with_external_rotati","Reverse Flyes With External Rotation","epaules",1.03,1,0,{epaules:1.0},"dumbbell"],
["db_reverse_grip_bent_over_rows","Reverse Grip Bent-Over Rows","dos",1.49,0,0,{dos:0.7,biceps:0.15,epaules:0.15},"barbell"],
["db_reverse_grip_triceps_pushdown","Reverse Grip Triceps Pushdown","triceps",0.69,0,0,{triceps:1.0},"cable"],
["db_reverse_hyperextension","Reverse Hyperextension","ischios",1.72,0,0,{ischios:0.7,mollets:0.15,fessiers:0.15},"machine"],
["db_reverse_machine_flyes","Reverse Machine Flyes","epaules",1.03,0,0,{epaules:1.0},"machine"],
["db_reverse_plate_curls","Reverse Plate Curls","biceps",0.69,0,0,{biceps:1.0},"other"],
["db_reverse_triceps_bench_press","Reverse Triceps Bench Press","triceps",0.69,0,0,{triceps:0.7,pecs:0.15,epaules:0.15},"barbell"],
["db_rhomboids_smr","Rhomboids-SMR","dos",1.49,0,0,{dos:0.7,epaules:0.3},"foam roll"],
["db_rickshaw_carry","Rickshaw Carry","biceps",0.69,0,0,{biceps:0.7,abdos:0.04,mollets:0.04,fessiers:0.04,ischios:0.04,dos:0.04,quads:0.04,epaules:0.04},"other"],
["db_rickshaw_deadlift","Rickshaw Deadlift","quads",2.3,0,0,{quads:0.7,biceps:0.06,fessiers:0.06,ischios:0.06,dos:0.06,epaules:0.06},"other"],
["db_ring_dips","Ring Dips","triceps",0.69,0,0,{triceps:0.7,pecs:0.15,epaules:0.15},"other"],
["db_rocket_jump","Rocket Jump","quads",2.3,0,1,{quads:0.7,mollets:0.15,ischios:0.15},"body only"],
["db_rocking_standing_calf_raise","Rocking Standing Calf Raise","mollets",2.07,0,0,{mollets:1.0},"barbell"],
["db_rocky_pull_ups_pulldowns","Rocky Pull-Ups/Pulldowns","dos",1.49,0,0,{dos:0.7,biceps:0.15,epaules:0.15},"other"],
["db_romanian_deadlift","Romanian Deadlift","ischios",1.72,0,0,{ischios:0.7,mollets:0.1,fessiers:0.1,dos:0.1},"barbell"],
["db_romanian_deadlift_from_deficit","Romanian Deadlift from Deficit","ischios",1.72,0,0,{ischios:0.7,biceps:0.07,fessiers:0.07,dos:0.07,epaules:0.07},"barbell"],
["db_rope_climb","Rope Climb","dos",1.49,0,0,{dos:0.7,biceps:0.2,epaules:0.1},"other"],
["db_rope_crunch","Rope Crunch","abdos",0.69,0,0,{abdos:1.0},"cable"],
["db_rope_jumping","Rope Jumping","quads",2.3,0,0,{quads:0.7,mollets:0.15,ischios:0.15},"other"],
["db_rope_straight_arm_pulldown","Rope Straight-Arm Pulldown","dos",1.49,0,0,{dos:1.0},"cable"],
["db_round_the_world_shoulder_stretch","Round The World Shoulder Stretch","epaules",1.03,0,0,{epaules:0.7,biceps:0.15,pecs:0.15},"other"],
["db_rowing_stationary","Rowing, Stationary","quads",2.3,0,0,{quads:0.7,biceps:0.05,mollets:0.05,fessiers:0.05,ischios:0.05,dos:0.1},"machine"],
["db_runner_s_stretch","Runner's Stretch","ischios",1.72,0,0,{ischios:0.7,mollets:0.3},"autre"],
["db_running_treadmill","Running, Treadmill","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"machine"],
["db_russian_twist","Russian Twist","abdos",0.69,0,1,{abdos:0.7,dos:0.3},"body only"],
["db_sandbag_load","Sandbag Load","quads",2.3,0,0,{quads:0.7,abdos:0.03,biceps:0.06,mollets:0.03,fessiers:0.03,ischios:0.03,dos:0.06,epaules:0.06},"other"],
["db_scapular_pull_up","Scapular Pull-Up","epaules",1.03,0,0,{epaules:0.7,dos:0.3},"autre"],
["db_scissor_kick","Scissor Kick","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_scissors_jump","Scissors Jump","quads",2.3,0,1,{quads:0.7,fessiers:0.15,ischios:0.15},"body only"],
["db_seated_band_hamstring_curl","Seated Band Hamstring Curl","ischios",1.72,0,0,{ischios:1.0},"other"],
["db_seated_barbell_military_press","Seated Barbell Military Press","epaules",1.03,0,0,{epaules:0.7,triceps:0.3},"barbell"],
["db_seated_barbell_twist","Seated Barbell Twist","abdos",0.69,0,0,{abdos:1.0},"barbell"],
["db_seated_bent_over_one_arm_dumbbell_","Seated Bent-Over One-Arm Dumbbell Triceps Extension","triceps",0.69,1,0,{triceps:1.0},"dumbbell"],
["db_seated_bent_over_rear_delt_raise","Seated Bent-Over Rear Delt Raise","epaules",1.03,1,0,{epaules:1.0},"dumbbell"],
["db_seated_bent_over_two_arm_dumbbell_","Seated Bent-Over Two-Arm Dumbbell Triceps Extension","triceps",0.69,1,0,{triceps:1.0},"dumbbell"],
["db_seated_biceps","Seated Biceps","biceps",0.69,0,1,{biceps:0.7,pecs:0.15,epaules:0.15},"body only"],
["db_seated_cable_rows","Seated Cable Rows","dos",1.49,0,0,{dos:0.7,biceps:0.15,epaules:0.15},"cable"],
["db_seated_cable_shoulder_press","Seated Cable Shoulder Press","epaules",1.03,0,0,{epaules:0.7,triceps:0.3},"cable"],
["db_seated_calf_raise","Seated Calf Raise","mollets",2.07,0,0,{mollets:1.0},"machine"],
["db_seated_calf_stretch","Seated Calf Stretch","mollets",2.07,0,0,{mollets:0.7,ischios:0.15,dos:0.15},"autre"],
["db_seated_close_grip_concentration_ba","Seated Close-Grip Concentration Barbell Curl","biceps",0.69,0,0,{biceps:1.0},"barbell"],
["db_seated_dumbbell_curl","Seated Dumbbell Curl","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
["db_seated_dumbbell_inner_biceps_curl","Seated Dumbbell Inner Biceps Curl","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
["db_seated_dumbbell_palms_down_wrist_c","Seated Dumbbell Palms-Down Wrist Curl","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
["db_seated_dumbbell_palms_up_wrist_cur","Seated Dumbbell Palms-Up Wrist Curl","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
["db_seated_dumbbell_press","Seated Dumbbell Press","epaules",1.03,1,0,{epaules:0.7,triceps:0.3},"dumbbell"],
["db_seated_flat_bench_leg_pull_in","Seated Flat Bench Leg Pull-In","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_seated_floor_hamstring_stretch","Seated Floor Hamstring Stretch","ischios",1.72,0,0,{ischios:0.7,mollets:0.3},"autre"],
["db_seated_front_deltoid","Seated Front Deltoid","epaules",1.03,0,1,{epaules:0.7,pecs:0.3},"body only"],
["db_seated_glute","Seated Glute","fessiers",1.72,0,1,{fessiers:1.0},"body only"],
["db_seated_good_mornings","Seated Good Mornings","dos",1.49,0,0,{dos:0.7,fessiers:0.3},"barbell"],
["db_seated_hamstring","Seated Hamstring","ischios",1.72,0,0,{ischios:0.7,mollets:0.3},"autre"],
["db_seated_hamstring_and_calf_stretch","Seated Hamstring and Calf Stretch","ischios",1.72,0,0,{ischios:0.7,mollets:0.3},"other"],
["db_seated_head_harness_neck_resistanc","Seated Head Harness Neck Resistance","epaules",1.03,0,0,{epaules:1.0},"other"],
["db_seated_leg_curl","Seated Leg Curl","ischios",1.72,0,0,{ischios:1.0},"machine"],
["db_seated_leg_tucks","Seated Leg Tucks","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_seated_one_arm_dumbbell_palms_down","Seated One-Arm Dumbbell Palms-Down Wrist Curl","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
["db_seated_one_arm_dumbbell_palms_up_w","Seated One-Arm Dumbbell Palms-Up Wrist Curl","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
["db_seated_one_arm_cable_pulley_rows","Seated One-arm Cable Pulley Rows","dos",1.49,0,0,{dos:0.7,biceps:0.15,epaules:0.15},"cable"],
["db_seated_overhead_stretch","Seated Overhead Stretch","abdos",0.69,0,0,{abdos:1.0},"autre"],
["db_seated_palm_up_barbell_wrist_curl","Seated Palm-Up Barbell Wrist Curl","biceps",0.69,0,0,{biceps:1.0},"barbell"],
["db_seated_palms_down_barbell_wrist_cu","Seated Palms-Down Barbell Wrist Curl","biceps",0.69,0,0,{biceps:1.0},"barbell"],
["db_seated_side_lateral_raise","Seated Side Lateral Raise","epaules",1.03,1,0,{epaules:1.0},"dumbbell"],
["db_seated_triceps_press","Seated Triceps Press","triceps",0.69,1,0,{triceps:1.0},"dumbbell"],
["db_seated_two_arm_palms_up_low_pulley","Seated Two-Arm Palms-Up Low-Pulley Wrist Curl","biceps",0.69,0,0,{biceps:1.0},"cable"],
["db_see_saw_press_alternating_side_pre","See-Saw Press (Alternating Side Press)","epaules",1.03,1,0,{epaules:0.7,abdos:0.15,triceps:0.15},"dumbbell"],
["db_shotgun_row","Shotgun Row","dos",1.49,0,0,{dos:0.7,biceps:0.3},"cable"],
["db_shoulder_circles","Shoulder Circles","epaules",1.03,0,0,{epaules:1.0},"autre"],
["db_shoulder_press_with_bands","Shoulder Press - With Bands","epaules",1.03,0,0,{epaules:0.7,triceps:0.3},"bands"],
["db_shoulder_raise","Shoulder Raise","epaules",1.03,0,0,{epaules:0.7,dos:0.3},"autre"],
["db_shoulder_stretch","Shoulder Stretch","epaules",1.03,0,0,{epaules:1.0},"autre"],
["db_side_lying_floor_stretch","Side-Lying Floor Stretch","dos",1.49,0,0,{dos:1.0},"autre"],
["db_side_bridge","Side Bridge","abdos",0.69,0,1,{abdos:0.7,epaules:0.3},"body only"],
["db_side_hop_sprint","Side Hop-Sprint","quads",2.3,0,0,{quads:0.7,fessiers:0.14,mollets:0.07,ischios:0.07},"other"],
["db_side_jackknife","Side Jackknife","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_side_lateral_raise","Side Lateral Raise","epaules",1.03,1,0,{epaules:1.0},"dumbbell"],
["db_side_laterals_to_front_raise","Side Laterals to Front Raise","epaules",1.03,1,0,{epaules:1.0},"dumbbell"],
["db_side_leg_raises","Side Leg Raises","fessiers",1.72,0,1,{fessiers:1.0},"body only"],
["db_side_lying_groin_stretch","Side Lying Groin Stretch","fessiers",1.72,0,0,{fessiers:0.7,ischios:0.3},"autre"],
["db_side_neck_stretch","Side Neck Stretch","epaules",1.03,0,0,{epaules:1.0},"autre"],
["db_side_standing_long_jump","Side Standing Long Jump","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"autre"],
["db_side_to_side_chins","Side To Side Chins","dos",1.49,0,0,{dos:0.7,biceps:0.2,epaules:0.1},"other"],
["db_side_wrist_pull","Side Wrist Pull","epaules",1.03,0,0,{epaules:0.7,biceps:0.15,dos:0.15},"autre"],
["db_side_to_side_box_shuffle","Side to Side Box Shuffle","quads",2.3,0,0,{quads:0.7,fessiers:0.14,mollets:0.07,ischios:0.07},"other"],
["db_single_arm_cable_crossover","Single-Arm Cable Crossover","pecs",1.49,0,0,{pecs:1.0},"cable"],
["db_single_arm_linear_jammer","Single-Arm Linear Jammer","epaules",1.03,0,0,{epaules:0.7,pecs:0.15,triceps:0.15},"barbell"],
["db_single_arm_push_up","Single-Arm Push-Up","pecs",1.49,0,1,{pecs:0.7,epaules:0.15,triceps:0.15},"body only"],
["db_single_cone_sprint_drill","Single-Cone Sprint Drill","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"other"],
["db_single_leg_high_box_squat","Single-Leg High Box Squat","quads",2.3,0,0,{quads:0.7,fessiers:0.15,ischios:0.15},"other"],
["db_single_leg_hop_progression","Single-Leg Hop Progression","quads",2.3,0,0,{quads:0.7,fessiers:0.14,mollets:0.07,ischios:0.07},"other"],
["db_single_leg_lateral_hop","Single-Leg Lateral Hop","quads",2.3,0,0,{quads:0.7,fessiers:0.14,mollets:0.07,ischios:0.07},"other"],
["db_single_leg_leg_extension","Single-Leg Leg Extension","quads",2.3,0,0,{quads:1.0},"machine"],
["db_single_leg_stride_jump","Single-Leg Stride Jump","quads",2.3,0,0,{quads:0.7,fessiers:0.14,mollets:0.07,ischios:0.07},"other"],
["db_single_dumbbell_raise","Single Dumbbell Raise","epaules",1.03,1,0,{epaules:0.7,biceps:0.3},"dumbbell"],
["db_single_leg_butt_kick","Single Leg Butt Kick","quads",2.3,0,1,{quads:0.7,mollets:0.15,ischios:0.15},"body only"],
["db_single_leg_glute_bridge","Single Leg Glute Bridge","fessiers",1.72,0,1,{fessiers:0.7,ischios:0.3},"body only"],
["db_single_leg_push_off","Single Leg Push-off","quads",2.3,0,0,{quads:0.7,mollets:0.15,ischios:0.15},"other"],
["db_sit_up","Sit-Up","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_sit_squats","Sit Squats","quads",2.3,0,0,{quads:0.7,fessiers:0.2,ischios:0.1},"autre"],
["db_skating","Skating","quads",2.3,0,0,{quads:0.7,fessiers:0.18,mollets:0.06,ischios:0.06},"other"],
["db_sled_drag_harness","Sled Drag - Harness","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"other"],
["db_sled_overhead_backward_walk","Sled Overhead Backward Walk","epaules",1.03,0,0,{epaules:0.7,mollets:0.1,dos:0.1,quads:0.1},"other"],
["db_sled_overhead_triceps_extension","Sled Overhead Triceps Extension","triceps",0.69,0,0,{triceps:1.0},"other"],
["db_sled_push","Sled Push","quads",2.3,0,0,{quads:0.7,mollets:0.06,pecs:0.06,fessiers:0.06,ischios:0.06,triceps:0.06},"other"],
["db_sled_reverse_flye","Sled Reverse Flye","epaules",1.03,0,0,{epaules:1.0},"other"],
["db_sled_row","Sled Row","dos",1.49,0,0,{dos:0.7,biceps:0.3},"other"],
["db_sledgehammer_swings","Sledgehammer Swings","abdos",0.69,0,0,{abdos:0.7,mollets:0.06,biceps:0.06,dos:0.12,epaules:0.06},"other"],
["db_smith_incline_shoulder_raise","Smith Incline Shoulder Raise","epaules",1.03,0,0,{epaules:0.7,pecs:0.3},"barbell"],
["db_smith_machine_behind_the_back_shru","Smith Machine Behind the Back Shrug","epaules",1.03,0,0,{epaules:1.0},"machine"],
["db_smith_machine_bench_press","Smith Machine Bench Press","pecs",1.49,0,0,{pecs:0.7,epaules:0.15,triceps:0.15},"machine"],
["db_smith_machine_bent_over_row","Smith Machine Bent Over Row","dos",1.49,0,0,{dos:0.7,biceps:0.15,epaules:0.15},"machine"],
["db_smith_machine_calf_raise","Smith Machine Calf Raise","mollets",2.07,0,0,{mollets:1.0},"machine"],
["db_smith_machine_close_grip_bench_pre","Smith Machine Close-Grip Bench Press","triceps",0.69,0,0,{triceps:0.7,pecs:0.15,epaules:0.15},"machine"],
["db_smith_machine_decline_press","Smith Machine Decline Press","pecs",1.49,0,0,{pecs:0.7,epaules:0.15,triceps:0.15},"machine"],
["db_smith_machine_hang_power_clean","Smith Machine Hang Power Clean","ischios",1.72,0,0,{ischios:0.7,fessiers:0.06,dos:0.06,quads:0.06,epaules:0.12},"machine"],
["db_smith_machine_hip_raise","Smith Machine Hip Raise","abdos",0.69,0,0,{abdos:1.0},"machine"],
["db_smith_machine_incline_bench_press","Smith Machine Incline Bench Press","pecs",1.49,0,0,{pecs:0.7,epaules:0.15,triceps:0.15},"machine"],
["db_smith_machine_leg_press","Smith Machine Leg Press","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"machine"],
["db_smith_machine_one_arm_upright_row","Smith Machine One-Arm Upright Row","epaules",1.03,0,0,{epaules:0.7,biceps:0.3},"machine"],
["db_smith_machine_overhead_shoulder_pr","Smith Machine Overhead Shoulder Press","epaules",1.03,0,0,{epaules:0.7,triceps:0.3},"machine"],
["db_smith_machine_pistol_squat","Smith Machine Pistol Squat","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"machine"],
["db_smith_machine_reverse_calf_raises","Smith Machine Reverse Calf Raises","mollets",2.07,0,0,{mollets:1.0},"machine"],
["db_smith_machine_squat","Smith Machine Squat","quads",2.3,0,0,{quads:0.7,mollets:0.07,fessiers:0.07,ischios:0.07,dos:0.07},"machine"],
["db_smith_machine_stiff_legged_deadlif","Smith Machine Stiff-Legged Deadlift","ischios",1.72,0,0,{ischios:0.7,fessiers:0.15,dos:0.15},"machine"],
["db_smith_machine_upright_row","Smith Machine Upright Row","epaules",1.03,0,0,{epaules:0.7,biceps:0.15,dos:0.15},"machine"],
["db_smith_single_leg_split_squat","Smith Single-Leg Split Squat","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"machine"],
["db_snatch","Snatch","quads",2.3,0,0,{quads:0.7,biceps:0.04,fessiers:0.04,ischios:0.04,dos:0.04,epaules:0.08,triceps:0.04},"barbell"],
["db_snatch_balance","Snatch Balance","quads",2.3,0,0,{quads:0.7,mollets:0.06,fessiers:0.06,ischios:0.06,epaules:0.06,triceps:0.06},"barbell"],
["db_snatch_deadlift","Snatch Deadlift","ischios",1.72,0,0,{ischios:0.7,biceps:0.06,fessiers:0.06,dos:0.06,quads:0.06,epaules:0.06},"barbell"],
["db_snatch_pull","Snatch Pull","ischios",1.72,0,0,{ischios:0.7,mollets:0.06,fessiers:0.06,dos:0.06,quads:0.06,epaules:0.06},"barbell"],
["db_snatch_shrug","Snatch Shrug","epaules",1.03,0,0,{epaules:0.7,biceps:0.3},"barbell"],
["db_snatch_from_blocks","Snatch from Blocks","quads",2.3,0,0,{quads:0.7,mollets:0.04,biceps:0.04,fessiers:0.04,ischios:0.04,dos:0.04,epaules:0.08,triceps:0.04},"barbell"],
["db_speed_band_overhead_triceps","Speed Band Overhead Triceps","triceps",0.69,0,0,{triceps:1.0},"bands"],
["db_speed_box_squat","Speed Box Squat","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"barbell"],
["db_speed_squats","Speed Squats","quads",2.3,0,0,{quads:0.7,mollets:0.07,fessiers:0.07,ischios:0.07,dos:0.07},"barbell"],
["db_spell_caster","Spell Caster","abdos",0.69,1,0,{abdos:0.7,fessiers:0.15,epaules:0.15},"dumbbell"],
["db_spider_crawl","Spider Crawl","abdos",0.69,0,1,{abdos:0.7,pecs:0.1,epaules:0.1,triceps:0.1},"body only"],
["db_spider_curl","Spider Curl","biceps",0.69,0,0,{biceps:1.0},"e-z curl bar"],
["db_spinal_stretch","Spinal Stretch","dos",1.49,0,0,{dos:0.7,epaules:0.3},"autre"],
["db_split_clean","Split Clean","quads",2.3,0,0,{quads:0.7,mollets:0.04,biceps:0.04,fessiers:0.04,ischios:0.04,dos:0.04,epaules:0.08},"barbell"],
["db_split_jerk","Split Jerk","quads",2.3,0,0,{quads:0.7,fessiers:0.07,ischios:0.07,epaules:0.07,triceps:0.07},"barbell"],
["db_split_jump","Split Jump","quads",2.3,0,1,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"body only"],
["db_split_snatch","Split Snatch","ischios",1.72,0,0,{ischios:0.7,mollets:0.04,biceps:0.04,fessiers:0.04,dos:0.04,quads:0.04,epaules:0.08,triceps:0.04},"barbell"],
["db_split_squat_with_dumbbells","Split Squat with Dumbbells","quads",2.3,1,0,{quads:0.7,fessiers:0.15,ischios:0.15},"dumbbell"],
["db_split_squats","Split Squats","ischios",1.72,0,0,{ischios:0.7,mollets:0.1,fessiers:0.1,quads:0.1},"autre"],
["db_squat_jerk","Squat Jerk","quads",2.3,0,0,{quads:0.7,mollets:0.06,fessiers:0.06,ischios:0.06,epaules:0.06,triceps:0.06},"barbell"],
["db_squat_with_bands","Squat with Bands","quads",2.3,0,0,{quads:0.7,fessiers:0.12,mollets:0.06,ischios:0.06,dos:0.06},"barbell"],
["db_squat_with_chains","Squat with Chains","quads",2.3,0,0,{quads:0.7,fessiers:0.12,mollets:0.06,ischios:0.06,dos:0.06},"barbell"],
["db_squat_with_plate_movers","Squat with Plate Movers","quads",2.3,0,0,{quads:0.7,fessiers:0.18,mollets:0.06,ischios:0.06},"barbell"],
["db_squats_with_bands","Squats - With Bands","quads",2.3,0,0,{quads:0.7,mollets:0.07,fessiers:0.07,ischios:0.07,dos:0.07},"bands"],
["db_stairmaster","Stairmaster","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"machine"],
["db_standing_alternating_dumbbell_pres","Standing Alternating Dumbbell Press","epaules",1.03,1,0,{epaules:0.7,triceps:0.3},"dumbbell"],
["db_standing_barbell_calf_raise","Standing Barbell Calf Raise","mollets",2.07,0,0,{mollets:1.0},"barbell"],
["db_standing_barbell_press_behind_neck","Standing Barbell Press Behind Neck","epaules",1.03,0,0,{epaules:0.7,triceps:0.3},"barbell"],
["db_standing_bent_over_one_arm_dumbbel","Standing Bent-Over One-Arm Dumbbell Triceps Extension","triceps",0.69,1,0,{triceps:0.7,epaules:0.3},"dumbbell"],
["db_standing_bent_over_two_arm_dumbbel","Standing Bent-Over Two-Arm Dumbbell Triceps Extension","triceps",0.69,1,0,{triceps:1.0},"dumbbell"],
["db_standing_biceps_cable_curl","Standing Biceps Cable Curl","biceps",0.69,0,0,{biceps:1.0},"cable"],
["db_standing_biceps_stretch","Standing Biceps Stretch","biceps",0.69,0,0,{biceps:0.7,pecs:0.15,epaules:0.15},"other"],
["db_standing_bradford_press","Standing Bradford Press","epaules",1.03,0,0,{epaules:0.7,triceps:0.3},"barbell"],
["db_standing_cable_chest_press","Standing Cable Chest Press","pecs",1.49,0,0,{pecs:0.7,epaules:0.15,triceps:0.15},"cable"],
["db_standing_cable_lift","Standing Cable Lift","abdos",0.69,0,0,{abdos:0.7,epaules:0.3},"cable"],
["db_standing_cable_wood_chop","Standing Cable Wood Chop","abdos",0.69,0,0,{abdos:0.7,epaules:0.3},"cable"],
["db_standing_calf_raises","Standing Calf Raises","mollets",2.07,0,0,{mollets:1.0},"machine"],
["db_standing_concentration_curl","Standing Concentration Curl","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
["db_standing_dumbbell_calf_raise","Standing Dumbbell Calf Raise","mollets",2.07,1,0,{mollets:1.0},"dumbbell"],
["db_standing_dumbbell_press","Standing Dumbbell Press","epaules",1.03,1,0,{epaules:0.7,triceps:0.3},"dumbbell"],
["db_standing_dumbbell_reverse_curl","Standing Dumbbell Reverse Curl","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
["db_standing_dumbbell_straight_arm_fro","Standing Dumbbell Straight-Arm Front Delt Raise Above Head","epaules",1.03,1,0,{epaules:1.0},"dumbbell"],
["db_standing_dumbbell_triceps_extensio","Standing Dumbbell Triceps Extension","triceps",0.69,1,0,{triceps:1.0},"dumbbell"],
["db_standing_dumbbell_upright_row","Standing Dumbbell Upright Row","epaules",1.03,1,0,{epaules:0.7,biceps:0.3},"dumbbell"],
["db_standing_elevated_quad_stretch","Standing Elevated Quad Stretch","quads",2.3,0,0,{quads:1.0},"other"],
["db_standing_front_barbell_raise_over_","Standing Front Barbell Raise Over Head","epaules",1.03,0,0,{epaules:1.0},"barbell"],
["db_standing_gastrocnemius_calf_stretc","Standing Gastrocnemius Calf Stretch","mollets",2.07,0,0,{mollets:0.7,ischios:0.3},"autre"],
["db_standing_hamstring_and_calf_stretc","Standing Hamstring and Calf Stretch","ischios",1.72,0,0,{ischios:1.0},"other"],
["db_standing_hip_circles","Standing Hip Circles","fessiers",1.72,0,1,{fessiers:1.0},"body only"],
["db_standing_hip_flexors","Standing Hip Flexors","quads",2.3,0,0,{quads:1.0},"autre"],
["db_standing_inner_biceps_curl","Standing Inner-Biceps Curl","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
["db_standing_lateral_stretch","Standing Lateral Stretch","abdos",0.69,0,0,{abdos:1.0},"autre"],
["db_standing_leg_curl","Standing Leg Curl","ischios",1.72,0,0,{ischios:1.0},"machine"],
["db_standing_long_jump","Standing Long Jump","quads",2.3,0,1,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"body only"],
["db_standing_low_pulley_deltoid_raise","Standing Low-Pulley Deltoid Raise","epaules",1.03,0,0,{epaules:0.7,biceps:0.3},"cable"],
["db_standing_low_pulley_one_arm_tricep","Standing Low-Pulley One-Arm Triceps Extension","triceps",0.69,0,0,{triceps:0.7,pecs:0.15,epaules:0.15},"cable"],
["db_standing_military_press","Standing Military Press","epaules",1.03,0,0,{epaules:0.7,triceps:0.3},"barbell"],
["db_standing_olympic_plate_hand_squeez","Standing Olympic Plate Hand Squeeze","biceps",0.69,0,0,{biceps:1.0},"other"],
["db_standing_one_arm_cable_curl","Standing One-Arm Cable Curl","biceps",0.69,0,0,{biceps:1.0},"cable"],
["db_standing_one_arm_dumbbell_curl_ove","Standing One-Arm Dumbbell Curl Over Incline Bench","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
["db_standing_one_arm_dumbbell_triceps_","Standing One-Arm Dumbbell Triceps Extension","triceps",0.69,1,0,{triceps:0.7,pecs:0.15,epaules:0.15},"dumbbell"],
["db_standing_overhead_barbell_triceps_","Standing Overhead Barbell Triceps Extension","triceps",0.69,0,0,{triceps:0.7,epaules:0.3},"barbell"],
["db_standing_palm_in_one_arm_dumbbell_","Standing Palm-In One-Arm Dumbbell Press","epaules",1.03,1,0,{epaules:0.7,triceps:0.3},"dumbbell"],
["db_standing_palms_in_dumbbell_press","Standing Palms-In Dumbbell Press","epaules",1.03,1,0,{epaules:0.7,triceps:0.3},"dumbbell"],
["db_standing_palms_up_barbell_behind_t","Standing Palms-Up Barbell Behind The Back Wrist Curl","biceps",0.69,0,0,{biceps:1.0},"barbell"],
["db_standing_pelvic_tilt","Standing Pelvic Tilt","dos",1.49,0,0,{dos:0.7,fessiers:0.3},"autre"],
["db_standing_rope_crunch","Standing Rope Crunch","abdos",0.69,0,0,{abdos:1.0},"cable"],
["db_standing_soleus_and_achilles_stret","Standing Soleus And Achilles Stretch","mollets",2.07,0,0,{mollets:1.0},"autre"],
["db_standing_toe_touches","Standing Toe Touches","ischios",1.72,0,0,{ischios:0.7,mollets:0.3},"autre"],
["db_standing_towel_triceps_extension","Standing Towel Triceps Extension","triceps",0.69,0,1,{triceps:1.0},"body only"],
["db_standing_two_arm_overhead_throw","Standing Two-Arm Overhead Throw","epaules",1.03,0,0,{epaules:0.7,pecs:0.15,dos:0.15},"medicine ball"],
["db_star_jump","Star Jump","quads",2.3,0,1,{quads:0.7,mollets:0.07,fessiers:0.07,ischios:0.07,epaules:0.07},"body only"],
["db_step_up_with_knee_raise","Step-up with Knee Raise","fessiers",1.72,0,1,{fessiers:0.7,ischios:0.15,quads:0.15},"body only"],
["db_step_mill","Step Mill","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"machine"],
["db_stiff_legged_barbell_deadlift","Stiff-Legged Barbell Deadlift","ischios",1.72,0,0,{ischios:0.7,fessiers:0.15,dos:0.15},"barbell"],
["db_stiff_legged_dumbbell_deadlift","Stiff-Legged Dumbbell Deadlift","ischios",1.72,1,0,{ischios:0.7,fessiers:0.15,dos:0.15},"dumbbell"],
["db_stiff_leg_barbell_good_morning","Stiff Leg Barbell Good Morning","dos",1.49,0,0,{dos:0.7,fessiers:0.15,ischios:0.15},"barbell"],
["db_stomach_vacuum","Stomach Vacuum","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_straight_arm_dumbbell_pullover","Straight-Arm Dumbbell Pullover","pecs",1.49,1,0,{pecs:0.7,dos:0.1,epaules:0.1,triceps:0.1},"dumbbell"],
["db_straight_arm_pulldown","Straight-Arm Pulldown","dos",1.49,0,0,{dos:1.0},"cable"],
["db_straight_bar_bench_mid_rows","Straight Bar Bench Mid Rows","dos",1.49,0,0,{dos:0.7,biceps:0.3},"barbell"],
["db_straight_raises_on_incline_bench","Straight Raises on Incline Bench","epaules",1.03,0,0,{epaules:1.0},"barbell"],
["db_stride_jump_crossover","Stride Jump Crossover","quads",2.3,0,0,{quads:0.7,fessiers:0.14,mollets:0.07,ischios:0.07},"other"],
["db_sumo_deadlift","Sumo Deadlift","ischios",1.72,0,0,{ischios:0.7,fessiers:0.08,biceps:0.04,dos:0.08,quads:0.04,epaules:0.04},"barbell"],
["db_sumo_deadlift_with_bands","Sumo Deadlift with Bands","ischios",1.72,0,0,{ischios:0.7,fessiers:0.08,biceps:0.04,dos:0.08,quads:0.04,epaules:0.04},"barbell"],
["db_sumo_deadlift_with_chains","Sumo Deadlift with Chains","ischios",1.72,0,0,{ischios:0.7,fessiers:0.12,biceps:0.04,dos:0.08,quads:0.04,epaules:0.04},"barbell"],
["db_superman","Superman","dos",1.49,0,1,{dos:0.7,fessiers:0.15,ischios:0.15},"body only"],
["db_supine_chest_throw","Supine Chest Throw","triceps",0.69,0,0,{triceps:0.7,pecs:0.15,epaules:0.15},"medicine ball"],
["db_supine_one_arm_overhead_throw","Supine One-Arm Overhead Throw","abdos",0.69,0,0,{abdos:0.7,pecs:0.1,dos:0.1,epaules:0.1},"medicine ball"],
["db_supine_two_arm_overhead_throw","Supine Two-Arm Overhead Throw","abdos",0.69,0,0,{abdos:0.7,pecs:0.1,dos:0.1,epaules:0.1},"medicine ball"],
["db_suspended_fallout","Suspended Fallout","abdos",0.69,0,0,{abdos:0.7,pecs:0.1,dos:0.1,epaules:0.1},"other"],
["db_suspended_push_up","Suspended Push-Up","pecs",1.49,0,0,{pecs:0.7,epaules:0.15,triceps:0.15},"other"],
["db_suspended_reverse_crunch","Suspended Reverse Crunch","abdos",0.69,0,0,{abdos:1.0},"other"],
["db_suspended_row","Suspended Row","dos",1.49,0,0,{dos:0.7,biceps:0.3},"other"],
["db_suspended_split_squat","Suspended Split Squat","quads",2.3,0,0,{quads:0.7,fessiers:0.18,mollets:0.06,ischios:0.06},"other"],
["db_svend_press","Svend Press","pecs",1.49,0,0,{pecs:0.7,biceps:0.1,epaules:0.1,triceps:0.1},"other"],
["db_t_bar_row_with_handle","T-Bar Row with Handle","dos",1.49,0,0,{dos:0.7,biceps:0.3},"barbell"],
["db_tate_press","Tate Press","triceps",0.69,1,0,{triceps:0.7,pecs:0.15,epaules:0.15},"dumbbell"],
["db_the_straddle","The Straddle","ischios",1.72,0,0,{ischios:0.7,fessiers:0.15,mollets:0.15},"autre"],
["db_thigh_abductor","Thigh Abductor","fessiers",1.72,0,0,{fessiers:1.0},"machine"],
["db_thigh_adductor","Thigh Adductor","fessiers",1.72,0,0,{fessiers:0.7,ischios:0.3},"machine"],
["db_tire_flip","Tire Flip","quads",2.3,0,0,{quads:0.7,mollets:0.03,pecs:0.03,biceps:0.03,fessiers:0.03,ischios:0.03,dos:0.03,epaules:0.06,triceps:0.03},"other"],
["db_toe_touchers","Toe Touchers","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_torso_rotation","Torso Rotation","abdos",0.69,0,0,{abdos:1.0},"exercise ball"],
["db_trail_running_walking","Trail Running/Walking","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"autre"],
["db_trap_bar_deadlift","Trap Bar Deadlift","quads",2.3,0,0,{quads:0.7,fessiers:0.15,ischios:0.15},"other"],
["db_tricep_dumbbell_kickback","Tricep Dumbbell Kickback","triceps",0.69,1,0,{triceps:1.0},"dumbbell"],
["db_tricep_side_stretch","Tricep Side Stretch","triceps",0.69,0,0,{triceps:0.7,epaules:0.3},"autre"],
["db_triceps_overhead_extension_with_ro","Triceps Overhead Extension with Rope","triceps",0.69,0,0,{triceps:1.0},"cable"],
["db_triceps_pushdown","Triceps Pushdown","triceps",0.69,0,0,{triceps:1.0},"cable"],
["db_triceps_pushdown_rope_attachment","Triceps Pushdown - Rope Attachment","triceps",0.69,0,0,{triceps:1.0},"cable"],
["db_triceps_pushdown_v_bar_attachment","Triceps Pushdown - V-Bar Attachment","triceps",0.69,0,0,{triceps:1.0},"cable"],
["db_triceps_stretch","Triceps Stretch","triceps",0.69,0,0,{triceps:0.7,dos:0.3},"autre"],
["db_tuck_crunch","Tuck Crunch","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_two_arm_dumbbell_preacher_curl","Two-Arm Dumbbell Preacher Curl","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
["db_two_arm_kettlebell_clean","Two-Arm Kettlebell Clean","epaules",1.03,0,0,{epaules:0.7,mollets:0.07,fessiers:0.07,ischios:0.07,dos:0.07},"kettlebells"],
["db_two_arm_kettlebell_jerk","Two-Arm Kettlebell Jerk","epaules",1.03,0,0,{epaules:0.7,mollets:0.1,quads:0.1,triceps:0.1},"kettlebells"],
["db_two_arm_kettlebell_military_press","Two-Arm Kettlebell Military Press","epaules",1.03,0,0,{epaules:0.7,triceps:0.3},"kettlebells"],
["db_two_arm_kettlebell_row","Two-Arm Kettlebell Row","dos",1.49,0,0,{dos:0.7,biceps:0.3},"kettlebells"],
["db_underhand_cable_pulldowns","Underhand Cable Pulldowns","dos",1.49,0,0,{dos:0.7,biceps:0.15,epaules:0.15},"cable"],
["db_upper_back_leg_grab","Upper Back-Leg Grab","ischios",1.72,0,0,{ischios:0.7,dos:0.3},"autre"],
["db_upper_back_stretch","Upper Back Stretch","dos",1.49,0,0,{dos:1.0},"autre"],
["db_upright_barbell_row","Upright Barbell Row","epaules",1.03,0,0,{epaules:1.0},"barbell"],
["db_upright_cable_row","Upright Cable Row","epaules",1.03,0,0,{epaules:1.0},"cable"],
["db_upright_row_with_bands","Upright Row - With Bands","epaules",1.03,0,0,{epaules:1.0},"bands"],
["db_upward_stretch","Upward Stretch","epaules",1.03,0,0,{epaules:0.7,pecs:0.15,dos:0.15},"autre"],
["db_v_bar_pulldown","V-Bar Pulldown","dos",1.49,0,0,{dos:0.7,biceps:0.15,epaules:0.15},"cable"],
["db_v_bar_pullup","V-Bar Pullup","dos",1.49,0,1,{dos:0.7,biceps:0.15,epaules:0.15},"body only"],
["db_vertical_swing","Vertical Swing","ischios",1.72,1,0,{ischios:0.7,fessiers:0.1,quads:0.1,epaules:0.1},"dumbbell"],
["db_walking_treadmill","Walking, Treadmill","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"machine"],
["db_weighted_ball_hyperextension","Weighted Ball Hyperextension","dos",1.49,0,0,{dos:0.7,fessiers:0.15,ischios:0.15},"exercise ball"],
["db_weighted_ball_side_bend","Weighted Ball Side Bend","abdos",0.69,0,0,{abdos:1.0},"exercise ball"],
["db_weighted_bench_dip","Weighted Bench Dip","triceps",0.69,0,0,{triceps:0.7,pecs:0.15,epaules:0.15},"other"],
["db_weighted_crunches","Weighted Crunches","abdos",0.69,0,0,{abdos:1.0},"medicine ball"],
["db_weighted_jump_squat","Weighted Jump Squat","quads",2.3,0,0,{quads:0.7,mollets:0.07,fessiers:0.07,ischios:0.07,dos:0.07},"barbell"],
["db_weighted_pull_ups","Weighted Pull Ups","dos",1.49,0,0,{dos:0.7,biceps:0.3},"other"],
["db_weighted_sissy_squat","Weighted Sissy Squat","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"barbell"],
["db_weighted_sit_ups_with_bands","Weighted Sit-Ups - With Bands","abdos",0.69,0,0,{abdos:1.0},"other"],
["db_weighted_squat","Weighted Squat","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"other"],
["db_wide_grip_barbell_bench_press","Wide-Grip Barbell Bench Press","pecs",1.49,0,0,{pecs:0.7,epaules:0.15,triceps:0.15},"barbell"],
["db_wide_grip_decline_barbell_bench_pr","Wide-Grip Decline Barbell Bench Press","pecs",1.49,0,0,{pecs:0.7,epaules:0.15,triceps:0.15},"barbell"],
["db_wide_grip_decline_barbell_pullover","Wide-Grip Decline Barbell Pullover","pecs",1.49,0,0,{pecs:0.7,epaules:0.15,triceps:0.15},"barbell"],
["db_wide_grip_lat_pulldown","Wide-Grip Lat Pulldown","dos",1.49,0,0,{dos:0.7,biceps:0.15,epaules:0.15},"cable"],
["db_wide_grip_pulldown_behind_the_neck","Wide-Grip Pulldown Behind The Neck","dos",1.49,0,0,{dos:0.7,biceps:0.15,epaules:0.15},"cable"],
["db_wide_grip_rear_pull_up","Wide-Grip Rear Pull-Up","dos",1.49,0,1,{dos:0.7,biceps:0.15,epaules:0.15},"body only"],
["db_wide_grip_standing_barbell_curl","Wide-Grip Standing Barbell Curl","biceps",0.69,0,0,{biceps:1.0},"barbell"],
["db_wide_stance_barbell_squat","Wide Stance Barbell Squat","quads",2.3,0,0,{quads:0.7,mollets:0.07,fessiers:0.07,ischios:0.07,dos:0.07},"barbell"],
["db_wide_stance_stiff_legs","Wide Stance Stiff Legs","ischios",1.72,0,0,{ischios:0.7,fessiers:0.2,dos:0.1},"barbell"],
["db_wind_sprints","Wind Sprints","abdos",0.69,0,1,{abdos:1.0},"body only"],
["db_windmills","Windmills","fessiers",1.72,0,0,{fessiers:0.7,ischios:0.15,dos:0.15},"autre"],
["db_world_s_greatest_stretch","World's Greatest Stretch","ischios",1.72,0,0,{ischios:0.7,mollets:0.1,fessiers:0.1,quads:0.1},"autre"],
["db_wrist_circles","Wrist Circles","biceps",0.69,0,1,{biceps:1.0},"body only"],
["db_wrist_roller","Wrist Roller","biceps",0.69,0,0,{biceps:0.7,epaules:0.3},"other"],
["db_wrist_rotations_with_straight_bar","Wrist Rotations with Straight Bar","biceps",0.69,0,0,{biceps:1.0},"barbell"],
["db_yoke_walk","Yoke Walk","quads",2.3,0,0,{quads:0.7,abdos:0.04,fessiers:0.12,mollets:0.04,ischios:0.04,dos:0.04},"other"],
["db_zercher_squats","Zercher Squats","quads",2.3,0,0,{quads:0.7,mollets:0.1,fessiers:0.1,ischios:0.1},"barbell"],
["db_zottman_curl","Zottman Curl","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
["db_zottman_preacher_curl","Zottman Preacher Curl","biceps",0.69,1,0,{biceps:1.0},"dumbbell"],
];

/* Fusionne la base étendue dans EXERCISES (en évitant les doublons). */
(function mergeExtraDB() {
  const existingKeys = new Set(EXERCISES.map((e) => e.key));
  const existingNames = new Set(EXERCISES.map((e) => e.name.toLowerCase()));
  EXTRA_DB.forEach(([key, name, primary, eliteRatio, ph, bw, muscles, equipment]) => {
    if (existingKeys.has(key) || existingNames.has(name.toLowerCase())) return;
    EXERCISES.push({
      key, name, icon: "●", primary, eliteRatio, bw: !!bw, perHand: !!ph,
      muscles, equipment, extra: true,
      yt: yt(name),
      aliases: [name.toLowerCase()],
      tips: ["Exercice de la base étendue — ajuste la charge et progresse régulièrement."],
    });
  });
})();

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
   - Bonus PERFORMANCE : plus la perf est élevée (proche du rang Élite), plus
     la série rapporte (×1 à ×3).
   - Bonus RÉGULARITÉ : un multiplicateur global selon le nb de séances sur 28 j.
   - L'XP décroît lentement si le muscle n'est pas retravaillé (demi-vie 45 j),
     avec un plancher : on ne retombe jamais sous une "base acquise".
   - XP RÉTROACTIF : tout l'historique importé compte (calcul à la date réelle). */
const XP_PER_SET = 10;            // XP de base par série
const XP_HALFLIFE_DAYS = 45;      // demi-vie de la part "fraîcheur" (lente)
const XP_FLOOR_RATIO = 0.55;      // part d'XP qui ne décroît jamais (acquis durable)
const LEVEL_BASE = 60;

function xpForLevel(level) { return Math.round(LEVEL_BASE * Math.pow(level, 1.5)); }
function levelFromXP(totalXp) {
  let lvl = 1, need = xpForLevel(1), acc = 0;
  while (totalXp >= acc + need) { acc += need; lvl++; need = xpForLevel(lvl); }
  return { level: lvl, into: totalXp - acc, need, pct: (totalXp - acc) / need };
}
// décroissance avec plancher : une partie de l'XP reste acquise pour toujours
function decayXp(xp, lastTs, now = Date.now()) {
  if (!xp || !lastTs) return xp || 0;
  const days = (now - lastTs) / 864e5; if (days <= 0) return xp;
  const floor = xp * XP_FLOOR_RATIO;
  const fading = xp * (1 - XP_FLOOR_RATIO) * Math.pow(0.5, days / XP_HALFLIFE_DAYS);
  return floor + fading;
}
// multiplicateur de performance d'une série (1 à 3 selon la qualité vs le rang)
function perfMultiplier(ex, set, bw) {
  if (!ex || !bw) return 1;
  const e = ex.isTime ? Number(set.secs) || 0 : estimate1RM(set.weight, set.reps);
  if (!e) return 1;
  const score = perfToScore(ex, e, bw);
  return 1 + score * 2;
}
// bonus de régularité : 1.0 à 1.5 selon le nb de séances sur 28 jours
function regularityMultiplier(history, refTs = Date.now()) {
  const c = history.filter((s) => { const d = (refTs - +new Date(s.date)) / 864e5; return d >= 0 && d <= 28; }).length;
  return 1 + Math.min(0.5, c * 0.05);
}
/* Recalcule TOUTE l'XP par muscle à partir de l'historique complet (rétroactif). */
function computeXpFromHistory(history, bw, now = Date.now()) {
  const acc = {}, lastTs = {};
  const sorted = [...history].sort((a, b) => +new Date(a.date) - +new Date(b.date));
  sorted.forEach((s) => {
    const ts = +new Date(s.date);
    const reg = regularityMultiplier(sorted, ts);
    const gain = {};
    (s.exercises || []).forEach((se) => {
      const ex = EX_BY_KEY[se.key]; if (!ex) return;
      se.sets.forEach((set) => {
        const valid = set.secs || (set.weight && set.reps); if (!valid) return;
        const mult = perfMultiplier(ex, set, bw) * reg;
        Object.entries(ex.muscles).forEach(([mk, w]) => { gain[mk] = (gain[mk] || 0) + XP_PER_SET * w * mult; });
      });
    });
    Object.entries(gain).forEach(([mk, g]) => {
      const prev = acc[mk] ? decayXp(acc[mk], lastTs[mk], ts) : 0;
      acc[mk] = prev + g; lastTs[mk] = ts;
    });
  });
  const out = {};
  MUSCLES.forEach((m) => { out[m.key] = acc[m.key] ? { xp: decayXp(acc[m.key], lastTs[m.key], now), lastTs: lastTs[m.key] } : { xp: 0, lastTs: now }; });
  return out;
}

/* ===================== SÉANCES PRÉCONSTRUITES ======================== */
/* ====================== CALLISTHÉNIE ================================= */
/* Pour chaque figure : niveau + progressions (étapes pour la débloquer). */
const CALISTHENICS = [
  { fig: "Pistol squat", level: "Débutant", emoji: "🦵", muscle: "Quadriceps / Équilibre",
    goal: "Squat complet sur une jambe.",
    steps: ["Squats sur boîte une jambe (3×6).", "Pistol assisté (TRX, poteau) (3×5).", "Mobilité cheville + équilibre.", "Négatives : descente lente sur une jambe."] },
  { fig: "L-sit", level: "Débutant", emoji: "📐", muscle: "Abdos / Triceps",
    goal: "Tenir l'L-sit 10 s, jambes tendues.",
    steps: ["Support hold (appui bras tendus) 20 s.", "Tuck L-sit (genoux pliés) 10 s.", "Une jambe tendue (alterne).", "Renforce la compression (relevés de jambes)."] },
  { fig: "Pull-up strict", level: "Débutant", emoji: "🆙", muscle: "Dos / Biceps",
    goal: "Réussir des tractions strictes propres.",
    steps: ["Tractions négatives, descente 5 s (3×5).", "Tractions assistées élastique (3×8).", "Dead hang 30 s pour la prise.", "Tractions strictes par petites séries."] },
  { fig: "Dips", level: "Débutant", emoji: "🔻", muscle: "Triceps / Pecs",
    goal: "Réussir 8 dips complets aux barres.",
    steps: ["Dips sur banc, pieds au sol (3×10).", "Dips négatifs aux barres (3×5).", "Dips assistés élastique (3×8).", "Tenue verrouillée en haut 10 s."] },

  { fig: "Muscle-up", level: "Intermédiaire", emoji: "💥", muscle: "Dos / Triceps / Explosivité",
    goal: "Passer de la traction au dip au-dessus de la barre.",
    steps: ["Tractions explosives poitrine à la barre (3×5).", "Dips lestés (3×6).", "Transition négative depuis l'appui.", "Muscle-up assisté élastique."] },
  { fig: "Handstand", level: "Intermédiaire", emoji: "🤸", muscle: "Épaules / Gainage",
    goal: "Tenir l'équilibre sur les mains 15 s.",
    steps: ["Pike push-up pour les épaules.", "Handstand au mur, ventre au mur, 30 s.", "Petits décollages du mur pour l'équilibre.", "Corrections aux doigts."] },
  { fig: "Front lever", level: "Intermédiaire", emoji: "➖", muscle: "Dos / Gainage",
    goal: "Tenir le corps horizontal sous la barre.",
    steps: ["Tuck front lever 10 s.", "Advanced tuck (dos plat).", "Une jambe tendue.", "Négatives front lever depuis l'inversé."] },
  { fig: "Pull-up lesté lourd", level: "Intermédiaire", emoji: "🏋️", muscle: "Dos / Force",
    goal: "Traction avec +30 % du poids de corps.",
    steps: ["Tractions strictes 3×8 propres d'abord.", "Ajoute du lest progressivement (+2,5 kg).", "Séries lourdes 4-6 reps.", "Travaille la prise (dead hang lesté)."] },

  { fig: "Muscle-up explosif", level: "Avancé", emoji: "🚀", muscle: "Explosivité / Dos / Triceps",
    goal: "Muscle-up strict puissant, sans élan, voire consécutifs.",
    steps: ["Muscle-up strict maîtrisé d'abord.", "Tractions explosives lestées.", "Dips profonds lestés.", "Enchaîne 2-3 muscle-ups consécutifs."] },
  { fig: "Planche (full planche)", level: "Avancé", emoji: "🛩️", muscle: "Épaules / Gainage extrême",
    goal: "Tenir le corps horizontal au-dessus du sol, bras tendus.",
    steps: ["Planche lean (bascule épaules en avant).", "Tuck planche.", "Advanced tuck planche.", "Straddle planche puis full planche."] },
  { fig: "L-sit to Handstand", level: "Avancé", emoji: "🔝", muscle: "Épaules / Compression / Force",
    goal: "Monter de l'L-sit jusqu'au poirier, bras tendus.",
    steps: ["L-sit solide 15 s + handstand au mur solide.", "Travail de compression (pancake, leg raises).", "Press to handstand jambes écartées (assisté).", "Press to handstand depuis l'L-sit, contrôlé."] },
  { fig: "Front lever complet", level: "Avancé", emoji: "📏", muscle: "Dos / Gainage extrême",
    goal: "Front lever jambes tendues, corps parfaitement horizontal.",
    steps: ["Advanced tuck solide 15 s.", "Une jambe tendue 10 s.", "Straddle front lever.", "Front lever complet + tractions en front lever."] },
  { fig: "Human flag (drapeau)", level: "Avancé", emoji: "🚩", muscle: "Obliques / Épaules / Dos",
    goal: "Corps horizontal accroché à un poteau vertical.",
    steps: ["Renforcement obliques et épaules.", "Support vertical sur barre, gainage latéral.", "Flag jambes pliées (tuck).", "Extension progressive jusqu'au drapeau complet."] },
];

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
/* ============================ THÈMES ================================= */
const THEMES = {
  nuit:    { label: "Nuit (défaut)", bg: "#0d1015", card: "#141921", accent: "#e0245e", accentGlow: "#ff5c8a" },
  abysse:  { label: "Abysse", bg: "#0a0f1a", card: "#111a2b", accent: "#2f7bff", accentGlow: "#7ea8ff" },
  foret:   { label: "Forêt", bg: "#0b130f", card: "#121f17", accent: "#27a34a", accentGlow: "#5ce087" },
  braise:  { label: "Braise", bg: "#140b0a", card: "#1f1310", accent: "#ff6a1a", accentGlow: "#ffb55c" },
  amethyste: { label: "Améthyste", bg: "#100a18", card: "#1a1228", accent: "#8e44ec", accentGlow: "#c08bff" },
  carbone: { label: "Carbone", bg: "#0e0e10", card: "#17181b", accent: "#9aa0a8", accentGlow: "#d6dce4" },
  aurore:  { label: "Aurore", bg: "#0a1414", card: "#102020", accent: "#27a3a3", accentGlow: "#5ce0e0" },
  clair:   { label: "Clair", bg: "#f2f4f8", card: "#ffffff", accent: "#e0245e", accentGlow: "#ff5c8a", light: true },
};
function applyTheme(key) {
  const t = THEMES[key] || THEMES.nuit;
  const root = document.documentElement.style;
  root.setProperty("--bg", t.bg);
  root.setProperty("--card", t.card);
  root.setProperty("--accent", t.accent);
  root.setProperty("--accent-glow", t.accentGlow);
  root.setProperty("--text", t.light ? "#1a1f28" : "#e8ecf2");
  root.setProperty("--card-border", t.light ? "#e2e6ee" : "#1f2530");
  root.setProperty("--inner", t.light ? "#f6f8fb" : "#10151d");
  try { document.body.style.background = t.bg; } catch {}
}

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

/* 7 routines alimentaires par objectif. Chaque routine = 4 repas type (idées).
   Les quantités exactes restent calculées par buildMeals selon le poids ;
   ces routines donnent la VARIÉTÉ (quoi manger). */
const NUTRITION_PLANS = {
  seche: [
    { n: "Classique protéinée", meals: ["Œufs brouillés + flocons d'avoine", "Poulet, riz complet, brocolis", "Skyr + amandes", "Cabillaud, haricots verts, salade"] },
    { n: "Méditerranéenne", meals: ["Yaourt grec, fruits rouges, graines", "Thon, quinoa, légumes grillés", "Blanc de dinde, concombre", "Saumon, courgettes, salade d'épinards"] },
    { n: "Végétarienne", meals: ["Tofu brouillé, pain complet", "Lentilles, riz, légumes", "Fromage blanc 0%, noix", "Tempeh, patate douce, brocolis"] },
    { n: "Express bureau", meals: ["Skyr + banane", "Wrap poulet-crudités", "Œufs durs + pomme", "Steak haché 5%, salade composée"] },
    { n: "Faible glucides", meals: ["Omelette jambon-fromage", "Poulet, avocat, salade", "Thon nature", "Saumon, asperges, beurre"] },
    { n: "Volume rassasiant", meals: ["Blancs d'œufs, gros bol de légumes", "Dinde, courge, salade verte", "Soupe + skyr", "Poisson blanc, ratatouille"] },
    { n: "Sucré-salé léger", meals: ["Pancakes flocons-œufs", "Poulet teriyaki, riz, edamame", "Cottage cheese + ananas", "Crevettes, wok de légumes"] },
  ],
  maintien: [
    { n: "Équilibrée standard", meals: ["Pain complet, œufs, avocat", "Bœuf maigre, pâtes complètes, légumes", "Fromage blanc + banane + miel", "Saumon, quinoa, courgettes"] },
    { n: "Méditerranéenne", meals: ["Yaourt grec, miel, noix", "Poulet, boulgour, ratatouille", "Houmous + crudités", "Sardines, pommes de terre, salade"] },
    { n: "Asiatique", meals: ["Riz, œufs, edamame", "Bœuf sauté, nouilles, légumes", "Yaourt + fruits", "Saumon teriyaki, riz, brocolis"] },
    { n: "Végétarienne", meals: ["Porridge lait-avoine, beurre de cacahuète", "Pois chiches, riz, légumes rôtis", "Fromage blanc + granola", "Omelette, patate douce, salade"] },
    { n: "Sportif simple", meals: ["Tartines beurre de cacahuète, banane", "Poulet, riz, légumes, huile d'olive", "Lait + flocons + whey", "Steak, pâtes, légumes"] },
    { n: "Batch cooking", meals: ["Overnight oats", "Chili con carne, riz", "Skyr + fruits secs", "Curry de poulet, riz basmati"] },
    { n: "Gourmande maîtrisée", meals: ["Pain perdu protéiné", "Burger maison (pain complet, steak 5%)", "Yaourt + chocolat noir", "Pâtes bolognaise maison"] },
  ],
  prise: [
    { n: "Prise propre", meals: ["Porridge avoine-lait, beurre de cacahuète, banane", "Riz, poulet, huile d'olive, légumes", "Smoothie lait-whey-flocons-fruits", "Steak, pommes de terre, légumes au beurre"] },
    { n: "Hypercalorique", meals: ["6 œufs, pain complet, avocat, fromage", "Pâtes, bœuf, sauce tomate, parmesan", "Sandwich poulet + lait entier", "Saumon, riz, huile d'olive"] },
    { n: "Méditerranéenne", meals: ["Yaourt grec, miel, granola, noix", "Agneau, semoule, légumes, huile", "Pain, houmous, fromage", "Poisson gras, pommes de terre, salade"] },
    { n: "Végétarienne", meals: ["Tofu, riz complet, oléagineux", "Lentilles, quinoa, fromage, huile", "Smoothie lait-banane-beurre de cacahuète", "Omelette 4 œufs, patate douce, avocat"] },
    { n: "Shakes & solides", meals: ["Gainer maison (avoine, lait, whey, banane)", "Riz, poulet, huile, légumes", "Pain complet, beurre d'amande, miel", "Bœuf, pâtes, fromage"] },
    { n: "Asiatique riche", meals: ["Riz frit aux œufs", "Bœuf bulgogi, riz, edamame", "Lait + flocons + cacahuètes", "Saumon teriyaki, nouilles, légumes"] },
    { n: "Maxi gourmande", meals: ["Pancakes banane-avoine, sirop, œufs", "Burger maison double + frites de patate douce", "Milkshake protéiné", "Lasagnes maison, salade"] },
  ],
};

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
/* Que faut-il pour atteindre le prochain rang sur un exo ?
   Renvoie la charge 1RM cible et un texte d'explication. */
function nextRankTarget(ex, best1RM, bw) {
  if (!bw) return null;
  const cur = best1RM ? perfToScore(ex, best1RM, bw) : 0;
  const { tier, sub, tierIdx, within } = scoreToRank(cur);
  const perTier = 1 / TIERS.length;
  // score du palier suivant (sous-niveau supérieur, ou tier suivant)
  let nextScore;
  if (cur <= 0) nextScore = perTier / 3;
  else { const step = perTier / 3; nextScore = Math.min(0.999, (Math.floor(cur / step) + 1) * step); }
  if (nextScore >= 0.999 && cur >= (TIERS.length - 1) / TIERS.length) return { top: true };
  // inverse de perfToScore pour trouver la charge cible
  let target1RM;
  if (ex.isTime) target1RM = Math.ceil(nextScore * ex.eliteSeconds);
  else { const eff = nextScore * ex.eliteRatio * bw; target1RM = Math.ceil(ex.bw ? eff - bw : eff); }
  const nr = scoreToRank(nextScore);
  return { top: false, target1RM, nextLabel: `${nr.tier.label} ${nr.sub}`, isTime: ex.isTime,
    delta: best1RM ? Math.max(0, target1RM - best1RM) : target1RM };
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
/* Mini schéma anatomique : silhouette avec le(s) muscle(s) ciblé(s) surligné(s).
   muscles = { muscleKey: poids }. La couleur reflète l'intensité du ciblage. */
const MUSCLE_REGIONS = {
  // coords approximatives sur une silhouette 44x60 (vue de face)
  pecs:    [[22,18,"M15,16 h14 v6 q-7,4 -14,0 z"]],
  epaules: [[22,15,"M11,15 a4,4 0 0,1 8,0 z"],[22,15,"M25,15 a4,4 0 0,1 8,0 z"]],
  biceps:  [[12,22,"M10,19 q-3,4 0,8 q3,-1 3,-4 z"],[32,22,"M34,19 q3,4 0,8 q-3,-1 -3,-4 z"]],
  triceps: [[11,23,"M9,20 q-2,4 0,7 z"],[33,23,"M35,20 q2,4 0,7 z"]],
  dos:     [[22,20,"M15,16 h14 v10 h-14 z"]],
  abdos:   [[22,30,"M17,25 h10 v12 h-10 z"]],
  quads:   [[17,42,"M15,36 q-2,8 1,14 q3,-1 3,-3 z"],[27,42,"M29,36 q2,8 -1,14 q-3,-1 -3,-3 z"]],
  ischios: [[17,44,"M15,38 q-2,8 1,13 z"],[27,44,"M29,38 q2,8 -1,13 z"]],
  fessiers:[[22,34,"M16,31 q6,4 12,0 v4 q-6,4 -12,0 z"]],
  mollets: [[17,53,"M16,49 q-2,5 0,8 z"],[27,53,"M28,49 q2,5 0,8 z"]],
};
function MuscleIcon({ muscles, size = 44, color = "#ff5c8a" }) {
  const primary = Object.entries(muscles || {}).sort((a, b) => b[1] - a[1])[0]?.[0];
  return (
    <div style={{ width: size, height: size, borderRadius: 12, background: "#1c2230", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, overflow: "hidden" }}>
      <svg viewBox="0 0 44 60" width={size * 0.62} height={size * 0.84}>
        {/* silhouette */}
        <g fill="#2f3645">
          <circle cx="22" cy="8" r="5" />
          <path d="M14,14 h16 v18 q0,3 -3,3 h-10 q-3,0 -3,-3 z" />
          <path d="M14,15 l-5,2 q-2,1 -2,4 l1,8 h4 l1,-9 z" />
          <path d="M30,15 l5,2 q2,1 2,4 l-1,8 h-4 l-1,-9 z" />
          <path d="M16,35 h5 l-1,20 h-4 l-1,-15 z" />
          <path d="M28,35 h-5 l1,20 h4 l1,-15 z" />
        </g>
        {/* muscle ciblé surligné */}
        {primary && MUSCLE_REGIONS[primary]?.map((r, i) => (
          <path key={i} d={r[2]} fill={color} opacity="0.9" />
        ))}
      </svg>
    </div>
  );
}

/* Avatar silhouette face/dos avec muscles colorés selon le rang du muscle.
   muscleScores = { muscleKey: score 0..1 }. */
function Avatar({ muscleScores, size = 230 }) {
  const [back, setBack] = useState(false);
  const col = (mk) => { const s = muscleScores[mk] || 0; return s > 0 ? scoreToRank(s).tier.glow : "#262c36"; };
  // Anatomie détaillée sur un canevas 200x340. Chaque muscle = plusieurs formes (gauche/droite, têtes).
  const FRONT = {
    epaules: ["M62,86 q-16,-2 -22,12 q-2,8 2,14 q8,-12 22,-14 z", "M138,86 q16,-2 22,12 q2,8 -2,14 q-8,-12 -22,-14 z"],
    pecs: ["M74,94 q14,10 25,9 v26 q-16,1 -27,-9 q-3,-14 2,-26 z", "M126,94 q-14,10 -25,9 v26 q16,1 27,-9 q3,-14 -2,-26 z"],
    abdos: ["M88,134 h11 v11 h-11 z", "M101,134 h11 v11 h-11 z", "M88,147 h11 v11 h-11 z", "M101,147 h11 v11 h-11 z", "M88,160 h11 v12 h-11 z", "M101,160 h11 v12 h-11 z", "M86,128 q14,5 28,0 v4 q-14,5 -28,0 z"],
    biceps: ["M52,112 q-7,14 -5,30 q6,2 11,-2 q-1,-15 4,-26 z", "M148,112 q7,14 5,30 q-6,2 -11,-2 q1,-15 -4,-26 z"],
    quads: ["M80,202 q-8,30 -3,58 q8,3 14,-1 q1,-30 1,-56 z", "M120,202 q8,30 3,58 q-8,3 -14,-1 q-1,-30 -1,-56 z", "M96,204 v54 q4,2 8,0 v-54 z"],
    mollets: ["M82,278 q-5,20 -1,38 q7,2 12,-1 q1,-18 -1,-36 z", "M118,278 q5,20 1,38 q-7,2 -12,-1 q-1,-18 1,-36 z"],
  };
  const BACK = {
    epaules: ["M62,86 q-16,-2 -22,12 q-2,8 2,14 q8,-12 22,-14 z", "M138,86 q16,-2 22,12 q2,8 -2,14 q-8,-12 -22,-14 z", "M82,90 q18,-6 36,0 l-3,12 q-15,-5 -30,0 z"],
    dos: ["M76,104 q12,8 24,7 v34 q-14,2 -24,-6 q-4,-18 0,-35 z", "M124,104 q-12,8 -24,7 v34 q14,2 24,-6 q4,-18 0,-35 z"],
    triceps: ["M52,112 q-8,15 -5,30 q6,2 11,-2 q-1,-16 4,-26 z", "M148,112 q8,15 5,30 q-6,2 -11,-2 q1,-16 -4,-26 z"],
    fessiers: ["M82,168 q9,8 18,7 v22 q-12,2 -20,-7 q-2,-12 2,-22 z", "M118,168 q-9,8 -18,7 v22 q12,2 20,-7 q2,-12 -2,-22 z"],
    ischios: ["M80,202 q-7,28 -2,52 q8,3 13,-1 q1,-28 0,-50 z", "M120,202 q7,28 2,52 q-8,3 -13,-1 q-1,-28 0,-50 z"],
    mollets: ["M82,276 q-5,22 -1,40 q7,2 12,-1 q1,-20 -1,-38 z", "M118,276 q5,22 1,40 q-7,2 -12,-1 q-1,-20 1,-38 z"],
  };
  const regions = back ? BACK : FRONT;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
      <svg viewBox="0 0 200 340" width={size} height={size * 1.35} style={{ filter: "drop-shadow(0 4px 14px rgba(0,0,0,.45))" }}>
        <defs>
          <linearGradient id="bodyG" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#222a36" /><stop offset="100%" stopColor="#1a202a" /></linearGradient>
        </defs>
        {/* corps de base anatomique */}
        <g fill="url(#bodyG)" stroke="#2e3644" strokeWidth="1.2">
          {/* tête + cou */}
          <circle cx="100" cy="40" r="22" />
          <path d="M90,58 h20 v10 q-10,5 -20,0 z" />
          {/* torse (trapèze épaules -> taille) */}
          <path d="M66,80 q34,-12 68,0 l-8,92 q-26,10 -52,0 z" />
          {/* bras gauche */}
          <path d="M66,82 l-20,8 q-9,5 -9,16 l9,50 q2,8 10,5 l8,-4 l8,-30 z" />
          {/* bras droit */}
          <path d="M134,82 l20,8 q9,5 9,16 l-9,50 q-2,8 -10,5 l-8,-4 l-8,-30 z" />
          {/* avant-bras G/D */}
          <path d="M46,156 l-6,40 q-1,7 6,7 h6 q5,0 5,-7 l2,-38 z" />
          <path d="M154,156 l6,40 q1,7 -6,7 h-6 q-5,0 -5,-7 l-2,-38 z" />
          {/* hanches/bassin */}
          <path d="M74,168 q26,10 52,0 l-2,24 q-24,10 -48,0 z" />
          {/* jambe gauche */}
          <path d="M76,190 q-2,60 0,86 l-2,42 q0,8 8,8 h6 q7,0 7,-8 l2,-128 z" />
          {/* jambe droite */}
          <path d="M124,190 q2,60 0,86 l2,42 q0,8 -8,8 h-6 q-7,0 -7,-8 l-2,-128 z" />
        </g>
        {/* muscles colorés selon le rang */}
        {Object.entries(regions).map(([mk, paths]) => paths.map((d, i) => (
          <path key={mk + i} d={d} fill={col(mk)} opacity="0.95" stroke="rgba(0,0,0,.25)" strokeWidth="0.6" />
        )))}
        {/* lignes de séparation pour le relief */}
        <g stroke="rgba(0,0,0,.18)" strokeWidth="0.8" fill="none">
          <line x1="100" y1="92" x2="100" y2="172" />
        </g>
      </svg>
      <button onClick={() => setBack(!back)} style={{ ...S.btnGhost, fontSize: 13 }}>🔄 {back ? "Voir de face" : "Voir de dos"}</button>
    </div>
  );
}

/* Emblème de rang façon Apex Legends : menaçant et travaillé en haut,
   épuré en bas. tierIdx 0..8 (Fer -> Mythique). */
function RankBadge({ score, size = 64 }) {
  const { tier, sub, tierIdx } = scoreToRank(score);
  const c = size / 2, r = size / 2;
  const gid = `rb-${tier.key}-${size}`;
  const lvl = tierIdx;
  const sc = (n) => (n / 100) * size; // helper d'échelle sur base 100

  // Couches décoratives selon le niveau
  const spikes = []; // pointes/crocs agressifs (hauts rangs)
  if (lvl >= 6) {
    const n = 8 + (lvl - 6) * 2;
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n - Math.PI / 2;
      const r1 = r - sc(8), r2 = r + sc(lvl >= 8 ? 9 : 6);
      const aw = 0.12;
      spikes.push(`${c + r1 * Math.cos(a - aw)},${c + r1 * Math.sin(a - aw)} ${c + r2 * Math.cos(a)},${c + r2 * Math.sin(a)} ${c + r1 * Math.cos(a + aw)},${c + r1 * Math.sin(a + aw)}`);
    }
  }
  const rays = [];
  if (lvl >= 3 && lvl < 6) {
    const n = 6 + lvl;
    for (let i = 0; i < n; i++) { const a = (Math.PI * 2 * i) / n - Math.PI / 2; const r1 = r - sc(6), r2 = r + sc(4);
      rays.push(<line key={i} x1={c + r1 * Math.cos(a)} y1={c + r1 * Math.sin(a)} x2={c + r2 * Math.cos(a)} y2={c + r2 * Math.sin(a)} stroke={tier.glow} strokeWidth={sc(2)} strokeLinecap="round" opacity="0.85" />); }
  }

  // forme centrale : hexagone (bas), bouclier cranté (milieu), emblème prédateur anguleux (haut)
  let core;
  if (lvl <= 1) {
    core = <polygon points={hexPoints(c, c, r - sc(6))} fill={`url(#${gid})`} stroke="rgba(255,255,255,.2)" strokeWidth={sc(1.5)} />;
  } else if (lvl <= 4) {
    core = <polygon points={starPoints(c, c, r - sc(5), r - sc(13), 6 + lvl)} fill={`url(#${gid})`} stroke="rgba(255,255,255,.28)" strokeWidth={sc(1.2)} />;
  } else {
    // emblème anguleux type "predator" : losange acéré + ailerons intégrés + pointe
    const top = c - r + sc(4), bot = c + r - sc(4), w = r - sc(6);
    core = (
      <g stroke="rgba(255,255,255,.4)" strokeWidth={sc(1)} strokeLinejoin="round">
        {/* ailerons latéraux qui prolongent le losange (menaçant) */}
        <polygon points={`${c - w},${c} ${c - w - sc(7)},${c - sc(12)} ${c - w + sc(3)},${c - sc(2)} ${c - w - sc(4)},${c + sc(11)} ${c - w + sc(4)},${c + sc(3)}`} fill={tier.color} stroke="none" />
        <polygon points={`${c + w},${c} ${c + w + sc(7)},${c - sc(12)} ${c + w - sc(3)},${c - sc(2)} ${c + w + sc(4)},${c + sc(11)} ${c + w - sc(4)},${c + sc(3)}`} fill={tier.color} stroke="none" />
        {/* corps losange acéré (pointe haute allongée) */}
        <polygon points={`${c},${top} ${c + w},${c - sc(3)} ${c + sc(6)},${bot} ${c - sc(6)},${bot} ${c - w},${c - sc(3)}`} fill={`url(#${gid})`} />
        {/* facette intérieure sombre pour le relief */}
        <polygon points={`${c},${top + sc(7)} ${c + w - sc(6)},${c - sc(3)} ${c},${c + sc(10)} ${c - w + sc(6)},${c - sc(3)}`} fill="rgba(0,0,0,.22)" stroke="none" />
        {/* arête centrale brillante */}
        <line x1={c} y1={top + sc(2)} x2={c} y2={bot - sc(2)} stroke={tier.glow} strokeWidth={sc(1.2)} opacity="0.7" />
      </g>
    );
  }

  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ overflow: "visible" }}>
        <defs>
          <radialGradient id={gid} cx="50%" cy="30%" r="75%"><stop offset="0%" stopColor={tier.glow} /><stop offset="65%" stopColor={tier.color} /><stop offset="100%" stopColor={tier.color} /></radialGradient>
          {lvl >= 5 && <filter id={gid + "-g"} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation={sc(3)} result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>}
        </defs>
        {lvl >= 5 && <circle cx={c} cy={c} r={r - sc(2)} fill={tier.glow} opacity="0.16" filter={`url(#${gid}-g)`} />}
        {spikes.length > 0 && <g filter={lvl >= 5 ? `url(#${gid}-g)` : undefined}>{spikes.map((p, i) => <polygon key={i} points={p} fill={tier.glow} opacity="0.9" />)}</g>}
        {rays}
        <g filter={lvl >= 7 ? `url(#${gid}-g)` : undefined}>{core}</g>
        {lvl >= 3 && lvl < 5 && <polygon points={hexPoints(c, c, r - sc(14))} fill="none" stroke="rgba(255,255,255,.3)" strokeWidth={sc(0.8)} />}
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 900, textShadow: "0 1px 4px rgba(0,0,0,.6)", fontSize: size * (lvl >= 5 ? 0.28 : 0.34), lineHeight: 1 }}>
        {tier.label[0]}<span style={{ fontSize: size * 0.16, fontWeight: 700, opacity: 0.95 }}>{sub}</span>
      </div>
    </div>
  );
}
function starPoints(cx, cy, rOut, rIn, n) {
  let pts = [];
  for (let i = 0; i < n * 2; i++) {
    const rr = i % 2 === 0 ? rOut : rIn;
    const a = (Math.PI * i) / n - Math.PI / 2;
    pts.push(`${cx + rr * Math.cos(a)},${cy + rr * Math.sin(a)}`);
  }
  return pts.join(" ");
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
  const [tab, setTab] = useState("profil");
  const [profilSub, setProfilSub] = useState("apercu");
  const [seancesSub, setSeancesSub] = useState("base");
  const [lifts, setLifts] = useState(() => store.get(K.lifts, {}));
  const [prs, setPrs] = useState(() => store.get(K.prs, {}));
  const [routines, setRoutines] = useState(() => store.get(K.routines, []));
  const [history, setHistory] = useState(() => store.get(K.history, []));
  const [cardio, setCardio] = useState(() => store.get(K.cardio, []));
  // xp: { muscleKey: { xp, lastTs } }
  const [xpRaw, setXpRaw] = useState(() => store.get(K.xp, {}));
  const [editingRoutine, setEditingRoutine] = useState(null);
  const [liveSession, setLiveSession] = useState(null);
  const [celebration, setCelebration] = useState(null);
  const [toast, setToast] = useState("");
  const [account, setAccount] = useState(null);

  useEffect(() => { if (profile) store.set(K.profile, profile); }, [profile]);
  useEffect(() => { applyTheme(profile?.theme || "nuit"); }, [profile?.theme]);
  useEffect(() => store.set(K.onboarded, onboarded), [onboarded]);
  useEffect(() => store.set(K.lifts, lifts), [lifts]);
  useEffect(() => store.set(K.prs, prs), [prs]);
  useEffect(() => store.set(K.routines, routines), [routines]);
  useEffect(() => store.set(K.history, history), [history]);
  useEffect(() => store.set(K.cardio, cardio), [cardio]);
  useEffect(() => store.set(K.xp, xpRaw), [xpRaw]);

  /* --------- SYNCHRO CLOUD : tire à la connexion, pousse aux changements --------- */
  const syncReady = useRef(false);
  // À la connexion : on récupère les données cloud (ou on pousse le local la 1ère fois)
  useEffect(() => {
    if (!account?.id) { syncReady.current = false; return; }
    let cancelled = false;
    (async () => {
      const client = await getSupabase();
      if (!client || cancelled) return;
      const res = await cloudSync.pull(client, account.id);
      if (cancelled || !res.ok) { if (!res.ok) console.warn("APEX pull:", res.error?.message); return; }
      if (res.data && Object.keys(res.data).length) {
        // Données cloud existantes -> on écrase le local puis on rehydrate
        const changed = writeLocalBundle(res.data);
        if (changed && !sessionStorage.getItem("apex_synced_once")) {
          sessionStorage.setItem("apex_synced_once", "1");
          window.location.reload();
          return;
        }
      } else {
        // Aucune donnée cloud -> première synchro, on envoie le local
        await cloudSync.push(client, account.id);
      }
      syncReady.current = true;
    })();
    return () => { cancelled = true; };
  }, [account?.id]);

  // Pousse (anti-rebond) à chaque modification quand l'utilisateur est connecté
  useEffect(() => {
    if (!account?.id || !syncReady.current) return;
    const t = setTimeout(async () => {
      const client = await getSupabase();
      if (client) cloudSync.push(client, account.id);
    }, 1200);
    return () => clearTimeout(t);
  }, [account?.id, profile, lifts, prs, routines, history, cardio, xpRaw, onboarded]);

  // Filet de sécurité : pousse aussi quand l'onglet passe en arrière-plan (capte les mesures)
  useEffect(() => {
    if (!account?.id) return;
    const flush = async () => {
      if (document.visibilityState === "hidden" && syncReady.current) {
        const client = await getSupabase();
        if (client) cloudSync.push(client, account.id);
      }
    };
    document.addEventListener("visibilitychange", flush);
    return () => document.removeEventListener("visibilitychange", flush);
  }, [account?.id]);

  const flash = (m) => { setToast(m); setTimeout(() => setToast(""), 2400); };
  const bw = Number(profile?.bodyweight) || 0;

  // XP dérivée de TOUT l'historique (rétroactif : les imports comptent)
  const xpData = useMemo(() => computeXpFromHistory(history, bw), [history, bw]);
  const xpNow = useMemo(() => {
    const out = {}; MUSCLES.forEach((m) => (out[m.key] = xpData[m.key]?.xp || 0)); return out;
  }, [xpData]);
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
  // nombre de séances où l'exo apparaît
  const exoCount = (exKey) => history.filter((s) => s.exercises?.some((e) => e.key === exKey)).length;
  // poids max soulevé par séance (pour le graphe poids/date)
  const weightHistoryFor = (exKey) => {
    const pts = [];
    [...history].reverse().forEach((s) => { const f = s.exercises?.find((e) => e.key === exKey); if (!f) return;
      let maxW = 0; f.sets.forEach((st) => { const w = Number(st.weight) || 0; if (w > maxW) maxW = w; });
      if (maxW > 0) pts.push({ date: s.date, value: maxW }); });
    return pts;
  };

  const setBestLift = (exKey, e1rm, weight, reps) => setLifts((prev) => {
    const rec = prev[exKey] || { history: [] };
    const hist = [{ date: new Date().toISOString(), weight, reps, e1rm }, ...(rec.history || [])].slice(0, 50);
    return { ...prev, [exKey]: { best1RM: Math.max(e1rm, rec.best1RM || 0), history: hist } };
  });
  const setPR = (exKey, val) => setPrs((prev) => ({ ...prev, [exKey]: val }));

  // estime l'XP d'une séance (pour le message ; l'XP réelle est recalculée depuis l'historique)
  const grantXp = (sessionExercises) => {
    const reg = regularityMultiplier(history);
    const gain = {};
    sessionExercises.forEach((se) => {
      const ex = EX_BY_KEY[se.key]; if (!ex) return;
      se.sets.forEach((set) => {
        const valid = set.secs || (set.weight && set.reps); if (!valid) return;
        const mult = perfMultiplier(ex, set, bw) * reg;
        Object.entries(ex.muscles).forEach(([mk, w]) => { gain[mk] = (gain[mk] || 0) + XP_PER_SET * w * mult; });
      });
    });
    return gain;
  };

  const saveRoutine = (r) => { setRoutines((prev) => prev.some((x) => x.id === r.id) ? prev.map((x) => x.id === r.id ? r : x) : [...prev, r]); setEditingRoutine(null); flash("Séance enregistrée ✓"); setTab("seances"); };
  const deleteRoutine = (id) => setRoutines((prev) => prev.filter((r) => r.id !== id));
  const addPreset = (preset) => { setRoutines((prev) => [...prev, { ...preset, id: uid(), preset: false, exercises: preset.exercises.map((e) => ({ ...e })) }]); flash("Séance ajoutée à tes séances ✓"); };

  const completeSession = (session) => {
    // état AVANT
    const beforeLevel = levelInfo.level;
    const beforeRanks = {}; MUSCLES.forEach((m) => (beforeRanks[m.key] = scoreToRank(muscleScores[m.key]).tierIdx));
    const gain = grantXp(session.exercises);

    const newHistory = [{ ...session, id: uid(), date: new Date().toISOString() }, ...history].slice(0, 300);
    setHistory(newHistory);
    const newLifts = { ...lifts };
    session.exercises.forEach((se) => { const ex = EX_BY_KEY[se.key]; if (!ex) return;
      let best = 0; se.sets.forEach((set) => { const e = ex.isTime ? Number(set.secs) || 0 : estimate1RM(set.weight, set.reps); if (e > best) best = e; });
      if (best > 0) { const rec = newLifts[ex.key] || { history: [] }; newLifts[ex.key] = { best1RM: Math.max(best, rec.best1RM || 0), history: rec.history || [] }; } });
    setLifts(newLifts);
    setLiveSession(null);

    // état APRÈS (recalculé sur les nouvelles données)
    const afterXpData = computeXpFromHistory(newHistory, bw);
    const afterTotalXp = Object.values(afterXpData).reduce((a, v) => a + (v.xp || 0), 0);
    const afterLevel = levelFromXP(afterTotalXp).level;
    const afterScores = {}; const accM = {}; MUSCLES.forEach((m) => (accM[m.key] = { sum: 0, w: 0 }));
    EXERCISES.forEach((ex) => { const rec = newLifts[ex.key]; if (!rec?.best1RM) return; const s = perfToScore(ex, rec.best1RM, bw); Object.entries(ex.muscles).forEach(([mk, w]) => { accM[mk].sum += s * w; accM[mk].w += w; }); });
    MUSCLES.forEach((m) => (afterScores[m.key] = accM[m.key].w > 0 ? accM[m.key].sum / accM[m.key].w : 0));
    const rankUps = MUSCLES.filter((m) => scoreToRank(afterScores[m.key]).tierIdx > beforeRanks[m.key])
      .map((m) => ({ muscle: m.label, tier: scoreToRank(afterScores[m.key]).tier, tierIdx: scoreToRank(afterScores[m.key]).tierIdx }));

    const xpTotal = Math.round(Object.values(gain).reduce((a, b) => a + b, 0));
    setCelebration({ xp: xpTotal, levelUp: afterLevel > beforeLevel ? afterLevel : null, rankUps });
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
    flash(`${sessions.length} séances importées depuis Hevy ✓`); setTab("profil"); setProfilSub("historique");
  };
  const importRoutine = (r) => { setRoutines((prev) => [...prev, { ...r, id: uid() }]); flash("Séance importée ✓"); setTab("seances"); };

  // -------- onboarding (1er lancement) --------
  if (!onboarded || !profile) {
    return <Onboarding onDone={(p) => { setProfile(p); setOnboarded(true); }} onImportHevy={(sessions) => importHevy(sessions)} />;
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
        {[["profil","Profil"],["exos","Exercices"],["seances","Séances"],["nutrition","Nutrition"]].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={{ ...S.tab, ...(tab === k ? S.tabActive : {}) }}>{label}</button>
        ))}
      </nav>

      <main style={S.main}>
        {tab === "profil" && <Profil sub={profilSub} setSub={setProfilSub}
          overall={overall} muscleScores={muscleScores} loggedCount={loggedCount} history={history} cardio={cardio}
          levelInfo={levelInfo} totalXp={totalXp} xpNow={xpNow} bw={bw} profile={profile} setProfile={setProfile}
          lifts={lifts} prs={prs} flash={flash} account={account} setAccount={setAccount} onResetOnboarding={() => { setOnboarded(false); }}
          dataTabProps={{ profile, routines, lifts, prs, history, cardio, xp: xpRaw, onImportBackup: importBackup, onImportHevy: importHevy, onImportRoutine: importRoutine, flash,
            onClearHistory: () => setHistory([]), onDeleteSession: (id) => setHistory((p) => p.filter((s) => s.id !== id)), onUpdateSession: (id, upd) => setHistory((p) => p.map((s) => s.id === id ? { ...s, ...upd } : s)) }} />}
        {tab === "exos" && <ExoByMuscle lifts={lifts} prs={prs} bw={bw} setBestLift={setBestLift} setPR={setPR} progressionFor={progressionFor} exoCount={exoCount} weightHistoryFor={weightHistoryFor} flash={flash} />}
        {tab === "seances" && (editingRoutine
          ? <RoutineEditor routine={editingRoutine} onSave={saveRoutine} onCancel={() => setEditingRoutine(null)} />
          : <SeancesHub sub={seancesSub} setSub={setSeancesSub} routines={routines} history={history}
              onNew={() => setEditingRoutine({ id: uid(), name: "", exercises: [] })} onEdit={setEditingRoutine} onDelete={deleteRoutine}
              onStart={(r) => setLiveSession(r)} onExport={(r) => exportRoutine(r, flash)} onAddPreset={addPreset}
              cardio={cardio} bw={bw} onAddCardio={addCardio} onClearCardio={() => setCardio([])} />)}
        {tab === "nutrition" && <Nutrition profile={profile} setProfile={setProfile} />}
      </main>

      {liveSession && <SessionLogger routine={liveSession} lastSessionSets={lastSessionSets} prs={prs} onFinish={completeSession} onCancel={() => setLiveSession(null)} />}
      {celebration && <Celebration data={celebration} onClose={() => { setCelebration(null); setTab("profil"); setProfilSub("historique"); }} />}
      <footer style={S.footer}>Données sur ton appareil. Pense à exporter une sauvegarde (onglet Données).</footer>
    </div>
  );
}

/* --------------------- CÉLÉBRATION (fin de séance) ------------------- */
function Celebration({ data, onClose }) {
  const [xpShown, setXpShown] = useState(0);
  const [phase, setPhase] = useState(0); // 0 xp, 1 ranks, 2 level
  useEffect(() => {
    let raf; const start = performance.now(); const dur = 1100;
    const tick = (t) => { const p = Math.min(1, (t - start) / dur); setXpShown(Math.round(data.xp * (1 - Math.pow(1 - p, 3)))); if (p < 1) raf = requestAnimationFrame(tick); else setTimeout(() => setPhase(1), 350); };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
  }, [data.xp]);
  useEffect(() => { if (phase === 1 && (!data.rankUps || !data.rankUps.length)) setPhase(2); }, [phase, data.rankUps]);

  const confetti = Array.from({ length: 28 }).map((_, i) => {
    const colors = ["#e0245e", "#ffb55c", "#5ce0e0", "#c08bff", "#4ade80", "#f4d03f"];
    const left = Math.random() * 100, delay = Math.random() * 0.5, dur = 1.8 + Math.random() * 1.2;
    return <div key={i} style={{ position: "absolute", top: -20, left: `${left}%`, width: 8, height: 8, background: colors[i % colors.length], borderRadius: 2, animation: `confettiFall ${dur}s linear ${delay}s infinite` }} />;
  });

  return (
    <div style={{ ...S.overlay, alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}>{confetti}</div>
      <div style={{ ...S.card, maxWidth: 360, width: "88%", textAlign: "center", padding: 28, animation: "popIn .4s cubic-bezier(.2,1.2,.4,1)", position: "relative", zIndex: 1 }}>
        <div style={{ fontSize: 13, letterSpacing: 2, opacity: 0.5, textTransform: "uppercase", marginBottom: 4 }}>Séance terminée</div>
        <div style={{ fontSize: 44, marginBottom: 6 }}>🔥</div>
        <div style={{ fontSize: 16, opacity: 0.7 }}>Tu as gagné</div>
        <div style={{ fontSize: 48, fontWeight: 900, color: "var(--accent-glow,#ff5c8a)", lineHeight: 1.1, fontVariantNumeric: "tabular-nums" }}>+{xpShown} <span style={{ fontSize: 22 }}>XP</span></div>

        {phase >= 1 && data.rankUps && data.rankUps.length > 0 && (
          <div style={{ marginTop: 18, animation: "popIn .4s ease" }}>
            <div style={{ fontSize: 12, letterSpacing: 1, opacity: 0.5, textTransform: "uppercase" }}>Rang supérieur !</div>
            {data.rankUps.map((r, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginTop: 8 }}>
                <RankBadge score={(r.tierIdx + 0.5) / 9} size={36} />
                <span style={{ fontWeight: 700 }}>{r.muscle} → <span style={{ color: r.tier.glow }}>{r.tier.label}</span></span>
              </div>
            ))}
          </div>
        )}

        {data.levelUp && (
          <div style={{ marginTop: 18, animation: "popIn .5s ease", background: "var(--inner,#10151d)", borderRadius: 12, padding: "12px 16px" }}>
            <div style={{ fontSize: 12, letterSpacing: 1, opacity: 0.5, textTransform: "uppercase" }}>Niveau supérieur</div>
            <div style={{ fontSize: 30, fontWeight: 900, color: "#ffb55c" }}>Niveau {data.levelUp} ⬆</div>
          </div>
        )}

        <button style={{ ...S.btnPrimary, width: "100%", padding: 14, marginTop: 22, fontSize: 15 }} onClick={onClose}>Continuer</button>
      </div>
    </div>
  );
}

/* ----------------------- ONBOARDING (1er lancement) ------------------- */
function Onboarding({ onDone, onImportHevy }) {
  const [step, setStep] = useState(0);
  const importRef = React.useRef();
  const [pendingProfile, setPendingProfile] = useState(null);
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
            {(() => { const w = Number(poids), h = Number(taille); const warns = [];
              if (w && (w < 35 || w > 200)) warns.push("Ce poids semble inhabituel.");
              if (w && h) { const bmi = w / ((h / 100) ** 2); if (bmi < 14 || bmi > 45) warns.push("Vérifie taille et poids."); }
              return warns.length ? <div style={{ ...S.suggBox, background: "#2a1d10", borderColor: "#5a3a1a", color: "#ffb55c" }}>⚠️ {warns.join(" ")} Le poids sert au calcul de tes rangs.</div> : null;
            })()}
            <div><span style={S.obLabel}>Ton objectif</span>
              <div style={{ display: "flex", gap: 8 }}>
                {Object.entries(GOALS).map(([k, v]) => <button key={k} onClick={() => setGoal(k)} style={{ ...S.goalBtn, ...(goal === k ? S.goalBtnActive : {}) }}>{v.label}</button>)}
              </div></div>
            <div style={{ display: "flex", gap: 10 }}>
              <button style={S.btnGhost} onClick={() => setStep(0)}>← Retour</button>
              <button style={{ ...S.btnPrimary, flex: 1, padding: 14, opacity: canFinish ? 1 : 0.4 }} disabled={!canFinish}
                onClick={() => { setPendingProfile({ pseudo: pseudo.trim(), sexe, age: Number(age) || null, height: Number(taille) || null, bodyweight: Number(poids) || 75, goal }); setStep(2); }}>
                Continuer →
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div style={{ ...S.card, display: "grid", gap: 14, animation: "fadeIn .3s" }}>
            <div style={{ fontWeight: 800, fontSize: 18 }}>Importer tes séances ?</div>
            <div style={{ opacity: 0.7, fontSize: 14, lineHeight: 1.5 }}>Tu utilises déjà Hevy (ou une autre app) ? Importe ton historique pour démarrer avec ton vrai niveau, tes rangs et tes courbes. Sinon, tu pourras le faire plus tard dans Profil → Paramètres.</div>
            <input ref={importRef} type="file" accept=".csv" style={{ display: "none" }}
              onChange={() => { const f = importRef.current?.files?.[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => { try { const { sessions } = parseHevy(rd.result); if (sessions.length) onImportHevy(sessions); } catch {} onDone(pendingProfile); }; rd.readAsText(f); }} />
            <button style={{ ...S.btnPrimary, padding: 14 }} onClick={() => importRef.current?.click()}>📥 Importer depuis Hevy (.csv)</button>
            <button style={{ ...S.btnGhost, padding: 12 }} onClick={() => onDone(pendingProfile)}>Commencer sans importer</button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------- OVERVIEW -------------------------------- */
function Overview({ overall, muscleScores, loggedCount, setTab, history, levelInfo, totalXp, xpNow, hideHero }) {
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
      {!hideHero && <section style={{ ...S.card, ...S.heroCard }}>
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
      </section>}

      {/* rang global */}
      {!hideHero && <section style={S.card}>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ animation: "float 4s ease-in-out infinite" }}><RankBadge score={overall} size={76} /></div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, letterSpacing: 2, opacity: 0.5, textTransform: "uppercase" }}>Rang global</div>
            <div style={{ fontSize: 26, fontWeight: 800, color: tier.glow, lineHeight: 1.1 }}>{tier.label} {sub}</div>
            <div style={{ marginTop: 8 }}><ProgressBar value={within} color={tier.glow} /></div>
          </div>
        </div>
      </section>}

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

/* -------------------------- CALLISTHÉNIE ----------------------------- */
function Callisthenie() {
  const [level, setLevel] = useState("Débutant");
  const [openFig, setOpenFig] = useState(null);
  const levels = ["Débutant", "Intermédiaire", "Avancé"];
  const list = CALISTHENICS.filter((c) => c.level === level);
  const lvlColor = { "Débutant": "#4ade80", "Intermédiaire": "#f4d03f", "Avancé": "#ff5c8a" };
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <section style={S.card}>
        <div style={S.cardTitle}>Débloque des figures</div>
        <div style={{ fontSize: 12.5, opacity: 0.6, marginTop: 4, lineHeight: 1.5 }}>Choisis ton niveau et suis les étapes pour débloquer chaque figure de callisthénie.</div>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          {levels.map((l) => <button key={l} onClick={() => setLevel(l)} style={{ ...S.goalBtn, ...(level === l ? { ...S.goalBtnActive, background: lvlColor[l], borderColor: lvlColor[l], color: "#0d1015" } : {}) }}>{l}</button>)}
        </div>
      </section>
      {list.map((c) => {
        const isOpen = openFig === c.fig;
        return (
          <section key={c.fig} style={S.card}>
            <div onClick={() => setOpenFig(isOpen ? null : c.fig)} style={{ display: "flex", alignItems: "center", gap: 12, cursor: "pointer" }}>
              <div style={{ fontSize: 30 }}>{c.emoji}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 800, fontSize: 16 }}>{c.fig}</div>
                <div style={{ fontSize: 12, opacity: 0.55 }}>{c.muscle}</div>
              </div>
              <span style={{ fontSize: 11, fontWeight: 700, color: lvlColor[c.level], background: "#0e1218", padding: "3px 8px", borderRadius: 6 }}>{c.level}</span>
              <span style={{ opacity: 0.4, fontSize: 20, transform: isOpen ? "rotate(90deg)" : "none", transition: ".2s" }}>›</span>
            </div>
            {isOpen && (
              <div style={{ marginTop: 12, borderTop: "1px solid #232833", paddingTop: 12 }}>
                <div style={{ ...S.suggBox, marginBottom: 12 }}>🎯 Objectif : {c.goal}</div>
                <div style={S.miniLabel}>Progression (étapes)</div>
                <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                  {c.steps.map((s, i) => (
                    <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", background: "#0e1218", borderRadius: 10, padding: "10px 12px" }}>
                      <div style={{ width: 22, height: 22, borderRadius: 99, background: lvlColor[c.level], color: "#0d1015", fontWeight: 800, fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{i + 1}</div>
                      <span style={{ fontSize: 13.5, lineHeight: 1.4 }}>{s}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/* ----------------------------- STATS --------------------------------- */
const PERIODS = [
  { key: "1m", label: "1 mois", days: 30 },
  { key: "3m", label: "3 mois", days: 90 },
  { key: "6m", label: "6 mois", days: 182 },
  { key: "1y", label: "1 an", days: 365 },
  { key: "all", label: "Tout", days: 99999 },
];
/* Grande courbe avec axes et grille, plusieurs points. */
function BigChart({ points, color = "#e0245e", unit = "" }) {
  if (!points || points.length < 1) return <div style={{ fontSize: 13, opacity: 0.45, padding: "24px 0", textAlign: "center" }}>Aucune donnée sur cette période.</div>;
  if (points.length === 1) {
    return <div style={{ fontSize: 13, opacity: 0.6, padding: "24px 0", textAlign: "center" }}>1 seul point : {Math.round(points[0].value)}{unit}. Il en faut 2+ pour une courbe.</div>;
  }
  const W = 320, H = 160, padL = 34, padB = 22, padT = 10, padR = 8;
  const xs = points.map((p) => +new Date(p.date));
  const ys = points.map((p) => p.value);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  let minY = Math.min(...ys), maxY = Math.max(...ys);
  if (minY === maxY) { minY = minY * 0.9; maxY = maxY * 1.1 || 1; }
  const sx = (x) => padL + ((x - minX) / (maxX - minX || 1)) * (W - padL - padR);
  const sy = (y) => H - padB - ((y - minY) / (maxY - minY || 1)) * (H - padT - padB);
  const d = points.map((p, i) => `${i ? "L" : "M"}${sx(+new Date(p.date)).toFixed(1)},${sy(p.value).toFixed(1)}`).join(" ");
  const area = `${d} L${sx(maxX).toFixed(1)},${H - padB} L${sx(minX).toFixed(1)},${H - padB} Z`;
  const gid = "bg" + color.replace("#", "");
  const yticks = [minY, (minY + maxY) / 2, maxY];
  const fmtDate = (t) => new Date(t).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }}>
      <defs><linearGradient id={gid} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity="0.28" /><stop offset="100%" stopColor={color} stopOpacity="0" /></linearGradient></defs>
      {yticks.map((y, i) => (<g key={i}><line x1={padL} y1={sy(y)} x2={W - padR} y2={sy(y)} stroke="#222831" strokeWidth="1" /><text x={4} y={sy(y) + 3} fontSize="8.5" fill="#8a92a0">{Math.round(y)}</text></g>))}
      <path d={area} fill={`url(#${gid})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {points.map((p, i) => <circle key={i} cx={sx(+new Date(p.date))} cy={sy(p.value)} r="2.5" fill={color} />)}
      <text x={padL} y={H - 6} fontSize="8.5" fill="#8a92a0">{fmtDate(minX)}</text>
      <text x={W - padR} y={H - 6} fontSize="8.5" fill="#8a92a0" textAnchor="end">{fmtDate(maxX)}</text>
    </svg>
  );
}

function StatsTab({ history, cardio, bw }) {
  const [period, setPeriod] = useState("6m");
  const [exKey, setExKey] = useState("__volume__");
  const cutoff = Date.now() - (PERIODS.find((p) => p.key === period).days) * 864e5;

  // liste des exos présents dans l'historique
  const exosInHistory = useMemo(() => {
    const set = new Set();
    history.forEach((s) => s.exercises?.forEach((e) => set.add(e.key)));
    return [...set].map((k) => ({ key: k, name: EX_BY_KEY[k]?.name || k })).sort((a, b) => a.name.localeCompare(b.name));
  }, [history]);

  // points selon sélection
  const data = useMemo(() => {
    const inRange = history.filter((s) => +new Date(s.date) >= cutoff);
    if (exKey === "__volume__") {
      // volume total par séance
      return inRange.map((s) => {
        let v = 0; s.exercises?.forEach((e) => e.sets.forEach((st) => { v += (Number(st.weight) || 0) * (Number(st.reps) || 0); }));
        return { date: s.date, value: v };
      }).filter((p) => p.value > 0).sort((a, b) => +new Date(a.date) - +new Date(b.date));
    }
    if (exKey === "__cardio__") {
      return cardio.filter((c) => +new Date(c.date) >= cutoff).map((c) => ({ date: c.date, value: c.kcal })).sort((a, b) => +new Date(a.date) - +new Date(b.date));
    }
    // 1RM estimé max par séance pour l'exo choisi
    const ex = EX_BY_KEY[exKey];
    const pts = [];
    inRange.forEach((s) => {
      const f = s.exercises?.find((e) => e.key === exKey); if (!f) return;
      let best = 0; f.sets.forEach((st) => { const e = ex?.isTime ? Number(st.secs) || 0 : estimate1RM(st.weight, st.reps); if (e > best) best = e; });
      if (best > 0) pts.push({ date: s.date, value: best });
    });
    return pts.sort((a, b) => +new Date(a.date) - +new Date(b.date));
  }, [history, cardio, exKey, cutoff]);

  // résumé chiffré
  const summary = useMemo(() => {
    if (data.length < 1) return null;
    const first = data[0].value, last = data[data.length - 1].value;
    const max = Math.max(...data.map((d) => d.value));
    const diff = last - first;
    const pct = first > 0 ? Math.round((diff / first) * 100) : 0;
    return { first, last, max, diff, pct, n: data.length };
  }, [data]);

  const unit = exKey === "__volume__" ? " kg" : exKey === "__cardio__" ? " kcal" : EX_BY_KEY[exKey]?.isTime ? " s" : " kg";
  const color = exKey === "__cardio__" ? "#5ce0e0" : exKey === "__volume__" ? "#ffb55c" : "#e0245e";

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <section style={S.card}>
        <div style={S.cardTitle}>Que veux-tu suivre ?</div>
        <select value={exKey} onChange={(e) => setExKey(e.target.value)} style={{ ...S.input, marginTop: 8, appearance: "auto" }}>
          <option value="__volume__">📊 Volume total (toutes séances)</option>
          <option value="__cardio__">🏃 Cardio (calories)</option>
          <optgroup label="Par exercice">
            {exosInHistory.map((e) => <option key={e.key} value={e.key}>{e.name}</option>)}
          </optgroup>
        </select>
        <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
          {PERIODS.map((p) => <button key={p.key} onClick={() => setPeriod(p.key)} style={{ ...S.periodBtn, ...(period === p.key ? S.periodBtnOn : {}) }}>{p.label}</button>)}
        </div>
      </section>

      <section style={S.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{exKey === "__volume__" ? "Volume par séance" : exKey === "__cardio__" ? "Calories par sortie" : EX_BY_KEY[exKey]?.name}</div>
          {summary && <div style={{ fontSize: 12, fontWeight: 700, color: summary.diff >= 0 ? "#4ade80" : "#ff6b6b" }}>{summary.diff >= 0 ? "▲" : "▼"} {summary.pct >= 0 ? "+" : ""}{summary.pct}%</div>}
        </div>
        <BigChart points={data} color={color} unit={unit} />
        {summary && (
          <div style={{ display: "flex", justifyContent: "space-around", textAlign: "center", marginTop: 12, paddingTop: 12, borderTop: "1px solid #232833" }}>
            <div><div style={{ fontSize: 11, opacity: 0.5 }}>Début</div><div style={{ fontWeight: 800 }}>{Math.round(summary.first)}{unit}</div></div>
            <div><div style={{ fontSize: 11, opacity: 0.5 }}>Actuel</div><div style={{ fontWeight: 800, color }}>{Math.round(summary.last)}{unit}</div></div>
            <div><div style={{ fontSize: 11, opacity: 0.5 }}>Record</div><div style={{ fontWeight: 800 }}>{Math.round(summary.max)}{unit}</div></div>
            <div><div style={{ fontSize: 11, opacity: 0.5 }}>Points</div><div style={{ fontWeight: 800 }}>{summary.n}</div></div>
          </div>
        )}
      </section>
    </div>
  );
}

/* ---------------------------- CALENDRIER ----------------------------- */
function Calendar({ history, cardio }) {
  const [month, setMonth] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const days = new Date(month.y, month.m + 1, 0).getDate();
  const firstDay = (new Date(month.y, month.m, 1).getDay() + 6) % 7; // lundi=0
  const sessionsByDay = {};
  [...history.map((s) => ({ ...s, kind: "muscu" })), ...cardio.map((c) => ({ ...c, kind: "cardio" }))].forEach((e) => {
    const d = new Date(e.date); if (d.getFullYear() === month.y && d.getMonth() === month.m) { const day = d.getDate(); (sessionsByDay[day] = sessionsByDay[day] || []).push(e.kind); }
  });
  const monthNames = ["Janvier","Février","Mars","Avril","Mai","Juin","Juillet","Août","Septembre","Octobre","Novembre","Décembre"];
  const prevM = () => setMonth((p) => p.m === 0 ? { y: p.y - 1, m: 11 } : { y: p.y, m: p.m - 1 });
  const nextM = () => setMonth((p) => p.m === 11 ? { y: p.y + 1, m: 0 } : { y: p.y, m: p.m + 1 });
  const totalMonth = Object.keys(sessionsByDay).length;
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <section style={S.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <button style={S.stepBtn} onClick={prevM}>‹</button>
          <div style={{ fontWeight: 800, fontSize: 16 }}>{monthNames[month.m]} {month.y}</div>
          <button style={S.stepBtn} onClick={nextM}>›</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4, marginBottom: 6 }}>
          {["L","M","M","J","V","S","D"].map((d, i) => <div key={i} style={{ textAlign: "center", fontSize: 11, opacity: 0.4, fontWeight: 700 }}>{d}</div>)}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4 }}>
          {Array.from({ length: firstDay }).map((_, i) => <div key={"e" + i} />)}
          {Array.from({ length: days }).map((_, i) => {
            const day = i + 1; const kinds = sessionsByDay[day]; const has = !!kinds;
            const muscu = kinds?.includes("muscu"); const card = kinds?.includes("cardio");
            return (
              <div key={day} style={{ aspectRatio: "1", borderRadius: 8, background: has ? "#1a1016" : "#10151d", border: "1px solid", borderColor: has ? "#e0245e" : "#1c222d", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontSize: 12, position: "relative" }}>
                <span style={{ opacity: has ? 1 : 0.4, fontWeight: has ? 700 : 400 }}>{day}</span>
                {has && <div style={{ display: "flex", gap: 2, marginTop: 2 }}>{muscu && <div style={{ width: 5, height: 5, borderRadius: 99, background: "#e0245e" }} />}{card && <div style={{ width: 5, height: 5, borderRadius: 99, background: "#5ce0e0" }} />}</div>}
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 14, marginTop: 12, fontSize: 11.5, opacity: 0.6, justifyContent: "center" }}>
          <span>🔴 Muscu</span><span>🔵 Cardio</span><span>{totalMonth} jour(s) actif(s)</span>
        </div>
      </section>
    </div>
  );
}

/* ----------------------------- MESURES ------------------------------- */
function Measures({ profile, setProfile, flash }) {
  const [measures, setMeasures] = useState(() => store.get("apex_measures", []));
  useEffect(() => store.set("apex_measures", measures), [measures]);
  const [poids, setPoids] = useState("");
  const num = (set) => (e) => { const v = e.target.value.replace(",", "."); if (v === "" || /^\d*\.?\d*$/.test(v)) set(v); };
  const add = () => { if (!poids) return; const entry = { date: new Date().toISOString(), poids: Number(poids) }; setMeasures((p) => [entry, ...p].slice(0, 200)); setProfile({ ...profile, bodyweight: Number(poids) }); setPoids(""); flash("Mesure enregistrée ✓"); };
  const pts = [...measures].reverse().map((m) => ({ date: m.date, value: m.poids }));
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <section style={S.card}>
        <div style={S.cardTitle}>Suivi du poids de corps</div>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end", marginTop: 10 }}>
          <label style={{ flex: 1 }}><span style={S.obLabel}>Poids actuel (kg)</span><input inputMode="decimal" value={poids} onChange={num(setPoids)} placeholder={String(profile.bodyweight || "75")} style={S.input} /></label>
          <button style={S.btnPrimary} onClick={add}>Ajouter</button>
        </div>
      </section>
      {pts.length >= 1 && <section style={S.card}><div style={S.cardTitle}>Évolution</div><div style={{ marginTop: 8 }}><ProgressChart points={pts} /></div></section>}
      {measures.length > 0 && (
        <section style={S.card}>
          <div style={S.miniLabel}>Historique</div>
          <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
            {measures.slice(0, 20).map((m, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5, padding: "6px 0", borderBottom: "1px solid #1c222d" }}>
                <span style={{ opacity: 0.6 }}>{new Date(m.date).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" })}</span>
                <span style={{ fontWeight: 700 }}>{m.poids} kg</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/* ------------------------- COMPTE / SYNCHRO (Supabase) ---------------- */
function AccountBox({ account, onAccountChange }) {
  const [status, setStatus] = useState("idle"); // idle | loading | logged | error
  const [user, setUser] = useState(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState("login"); // login | signup
  const [msg, setMsg] = useState("");
  const [sb, setSb] = useState(null);

  useEffect(() => {
    getSupabase().then((client) => {
      if (!client) { setStatus("disabled"); return; }
      setSb(client);
      client.auth.getSession().then(({ data }) => {
        if (data?.session?.user) { setUser(data.session.user); setStatus("logged"); }
        else setStatus("idle");
      });
      const { data: sub } = client.auth.onAuthStateChange((_ev, session) => {
        if (session?.user) { setUser(session.user); setStatus("logged"); onAccountChange?.(session.user); }
        else { setUser(null); setStatus("idle"); onAccountChange?.(null); }
      });
      return () => sub.subscription.unsubscribe();
    });
  }, []);

  if (status === "disabled") return (
    <section style={{ ...S.card, marginBottom: 14 }}>
      <div style={S.cardTitle}>Compte & synchronisation</div>
      <div style={{ fontSize: 13, opacity: 0.55, marginTop: 8, lineHeight: 1.6 }}>
        La synchro entre appareils n'est pas activée.<br />
        Consulte le guide <strong>GUIDE_synchro_Supabase.txt</strong> fourni avec l'app pour la configurer (gratuit, ~10 min).
      </div>
    </section>
  );

  if (status === "loading") return (
    <section style={{ ...S.card, marginBottom: 14 }}>
      <div style={{ fontSize: 13, opacity: 0.5, textAlign: "center", padding: "12px 0" }}>Connexion…</div>
    </section>
  );

  if (status === "logged" && user) return (
    <section style={{ ...S.card, marginBottom: 14 }}>
      <div style={S.cardTitle}>Compte & synchronisation ✓</div>
      <div style={{ fontSize: 13, opacity: 0.7, marginTop: 6 }}>Connecté en tant que <strong>{user.email}</strong></div>
      <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
        <button style={S.btnGhost} onClick={async () => { await sb.auth.signOut(); }}>Se déconnecter</button>
      </div>
      {msg && <div style={{ fontSize: 12.5, marginTop: 8, color: "#8fe0b0" }}>{msg}</div>}
    </section>
  );

  return (
    <section style={{ ...S.card, marginBottom: 14 }}>
      <div style={S.cardTitle}>Compte & synchronisation</div>
      <div style={{ fontSize: 13, opacity: 0.6, marginTop: 4, marginBottom: 12, lineHeight: 1.5 }}>
        Crée un compte gratuit pour synchroniser tes données entre appareils.
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {["login","signup"].map((m) => (
          <button key={m} style={{ ...S.btnGhost, ...(mode===m ? { background:"#e0245e", color:"#fff", borderColor:"#e0245e" } : {}) }}
            onClick={() => { setMode(m); setMsg(""); }}>
            {m === "login" ? "Connexion" : "Créer un compte"}
          </button>
        ))}
      </div>
      <input style={{ ...S.input, marginBottom: 10 }} type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input style={{ ...S.input, marginBottom: 12 }} type="password" placeholder="Mot de passe" value={password} onChange={(e) => setPassword(e.target.value)} />
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button style={S.btnPrimary} onClick={async () => {
          setStatus("loading"); setMsg("");
          const { error } = mode === "login"
            ? await sb.auth.signInWithPassword({ email, password })
            : await sb.auth.signUp({ email, password });
          if (error) { setMsg("Erreur : " + error.message); setStatus("idle"); }
          else if (mode === "signup") { setMsg("Vérifie ta boîte mail pour confirmer le compte."); setStatus("idle"); }
        }}>
          {mode === "login" ? "Se connecter" : "S'inscrire"}
        </button>
        {sb && <button style={S.btnGhost} onClick={async () => {
          setStatus("loading"); setMsg("");
          const { error } = await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin } });
          if (error) { setMsg("Erreur Google : " + error.message); setStatus("idle"); }
        }}>
          Continuer avec Google
        </button>}
      </div>
      {msg && <div style={{ fontSize: 12.5, marginTop: 10, color: "#8fe0b0", lineHeight: 1.5 }}>{msg}</div>}
    </section>
  );
}

/* --------------------------- PARAMÈTRES ------------------------------ */
function Settings({ profile, setProfile, dataTabProps, onResetOnboarding, account, setAccount }) {
  const [section, setSection] = useState(null);
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <AccountBox account={account} onAccountChange={setAccount} />
      <section style={S.card}>
        <div style={S.cardTitle}>Mon profil</div>
        <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
          <label><span style={S.obLabel}>Pseudo</span><input value={profile.pseudo || ""} onChange={(e) => setProfile({ ...profile, pseudo: e.target.value })} style={S.input} /></label>
          <div style={{ display: "flex", gap: 10 }}>
            <label style={{ flex: 1 }}><span style={S.obLabel}>Taille (cm)</span><input inputMode="numeric" value={profile.height || ""} onChange={(e) => { const v = e.target.value.replace(/[^\d]/g, ""); setProfile({ ...profile, height: v ? Number(v) : null }); }} style={S.input} /></label>
            <label style={{ flex: 1 }}><span style={S.obLabel}>Âge</span><input inputMode="numeric" value={profile.age || ""} onChange={(e) => { const v = e.target.value.replace(/[^\d]/g, ""); setProfile({ ...profile, age: v ? Number(v) : null }); }} style={S.input} /></label>
          </div>
          <label><span style={S.obLabel}>Poids de corps (kg) — sert au calcul des rangs</span>
            <input inputMode="decimal" value={profile.bodyweight ?? ""} onChange={(e) => { const v = e.target.value.replace(",", "."); if (v === "" || /^\d*\.?\d*$/.test(v)) setProfile({ ...profile, bodyweight: v === "" ? "" : Number(v) }); }} style={S.input} /></label>
          {(() => {
            const w = Number(profile.bodyweight), h = Number(profile.height);
            const warns = [];
            if (w && (w < 35 || w > 200)) warns.push("Ce poids semble inhabituel.");
            if (w && h) { const bmi = w / ((h / 100) ** 2); if (bmi < 14 || bmi > 45) warns.push(`IMC = ${bmi.toFixed(0)} : vérifie taille et poids.`); }
            return warns.length ? <div style={{ ...S.suggBox, background: "#2a1d10", borderColor: "#5a3a1a", color: "#ffb55c" }}>⚠️ {warns.join(" ")} Un poids erroné fausse tous tes rangs.</div> : null;
          })()}
        </div>
      </section>

      <section style={S.card}>
        <div onClick={() => setSection(section === "data" ? null : "data")} style={{ display: "flex", justifyContent: "space-between", cursor: "pointer" }}>
          <span style={{ fontWeight: 700 }}>💾 Données & import/export</span><span style={{ opacity: 0.4 }}>{section === "data" ? "−" : "+"}</span>
        </div>
        {section === "data" && <div style={{ marginTop: 12 }}><DataTab {...dataTabProps} /></div>}
      </section>

      <section style={S.card}>
        <div onClick={() => setSection(section === "cgu" ? null : "cgu")} style={{ display: "flex", justifyContent: "space-between", cursor: "pointer" }}>
          <span style={{ fontWeight: 700 }}>📜 Conditions d'utilisation & confidentialité</span><span style={{ opacity: 0.4 }}>{section === "cgu" ? "−" : "+"}</span>
        </div>
        {section === "cgu" && (
          <div style={{ marginTop: 12, fontSize: 12.5, opacity: 0.7, lineHeight: 1.6 }}>
            <p><b>Confidentialité.</b> APEX stocke toutes tes données localement sur ton appareil (navigateur). Aucune donnée n'est envoyée à un serveur tant que tu n'actives pas de fonctionnalité de synchronisation. Tu peux exporter ou effacer tes données à tout moment.</p>
            <p><b>Données de santé.</b> Les estimations de rang, calories et macros sont indicatives et ne remplacent pas l'avis d'un professionnel de santé. Consulte un médecin avant tout programme intensif.</p>
            <p><b>Utilisation.</b> APEX est fourni « tel quel », sans garantie. Tu es responsable de l'exécution sûre des exercices. Les liens YouTube renvoient vers des contenus tiers.</p>
            <p style={{ opacity: 0.5 }}>APEX — application personnelle de suivi physique.</p>
          </div>
        )}
      </section>

      <section style={S.card}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>🎨 Apparence</div>
        <div style={{ fontSize: 12.5, opacity: 0.6, marginBottom: 12 }}>Choisis l'ambiance de couleur de l'application.</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {Object.entries(THEMES).map(([k, t]) => {
            const active = (profile.theme || "nuit") === k;
            return (
              <button key={k} onClick={() => setProfile({ ...profile, theme: k })}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderRadius: 10, cursor: "pointer",
                  border: active ? `2px solid ${t.accent}` : "1px solid #2a313d", background: t.bg, color: t.light ? "#1a1f28" : "#e8ecf2" }}>
                <span style={{ display: "flex", gap: 3 }}>
                  <span style={{ width: 12, height: 12, borderRadius: 3, background: t.card, border: "1px solid rgba(128,128,128,.3)" }} />
                  <span style={{ width: 12, height: 12, borderRadius: 3, background: t.accent }} />
                </span>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>{t.label}</span>
                {active && <span style={{ marginLeft: "auto", color: t.accent, fontWeight: 800 }}>✓</span>}
              </button>
            );
          })}
        </div>
      </section>

      <section style={S.card}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>⚙️ Avancé</div>
        <button style={{ ...S.btnGhost, width: "100%" }} onClick={onResetOnboarding}>Refaire la configuration initiale</button>
      </section>
    </div>
  );
}

/* ----------------------------- PROFIL (hub) -------------------------- */
function Profil({ sub, setSub, overall, muscleScores, loggedCount, history, cardio, levelInfo, totalXp, xpNow, bw, profile, setProfile, lifts, prs, dataTabProps, onResetOnboarding, account, setAccount, flash }) {
  const subs = [["apercu","Aperçu"],["rangs","Rangs"],["historique","Historique"],["stats","Stats"],["calendrier","Calendrier"],["mesures","Mesures"],["parametres","Paramètres"]];
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4 }}>
        {subs.map(([k, l]) => <button key={k} onClick={() => setSub(k)} style={{ ...S.subTab, ...(sub === k ? S.subTabOn : {}) }}>{l}</button>)}
      </div>
      {sub === "apercu" && (
        <>
          <section style={{ ...S.card, ...S.heroCard }}>
            <div style={{ display: "flex", gap: 16 }}>
              <Avatar muscleScores={muscleScores} size={150} />
              <div style={{ flex: 1, display: "grid", gap: 8, alignContent: "start" }}>
                <div style={{ fontWeight: 800, fontSize: 20 }}>{profile.pseudo || "Athlète"}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}><div style={S.levelBadge}><div style={{ fontSize: 9, opacity: 0.7 }}>NIV</div><div style={{ fontSize: 22, fontWeight: 900, color: "#ffb55c", lineHeight: 1 }}>{levelInfo.level}</div></div>
                  <div style={{ flex: 1 }}><RankBadge score={overall} size={48} /></div></div>
                <div style={{ fontSize: 11.5, opacity: 0.6 }}>{profile.height ? `${profile.height} cm · ` : ""}{bw} kg</div>
              </div>
            </div>
          </section>
          {/* rappel des rangs par muscle à côté de l'avatar */}
          <section style={S.card}>
            <div style={S.cardTitle}>Rangs par muscle</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 }}>
              {[...MUSCLES].sort((a, b) => muscleScores[b.key] - muscleScores[a.key]).map((m) => {
                const s = muscleScores[m.key]; const { tier, sub: sb } = scoreToRank(s);
                return (
                  <div key={m.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 12, height: 12, borderRadius: 3, background: s > 0 ? tier.glow : "#2a3038", flexShrink: 0 }} />
                    <span style={{ fontSize: 12.5, flex: 1 }}>{m.label}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: s > 0 ? tier.glow : "#5a626e" }}>{s > 0 ? `${tier.label[0]}${sb}` : "—"}</span>
                  </div>
                );
              })}
            </div>
          </section>
          <Overview overall={overall} muscleScores={muscleScores} loggedCount={loggedCount} setTab={() => setSub("rangs")} history={history} levelInfo={levelInfo} totalXp={totalXp} xpNow={xpNow} hideHero />
        </>
      )}
      {sub === "rangs" && <RanksTab muscleScores={muscleScores} bw={bw} />}
      {sub === "historique" && <History history={history} bw={bw} profile={profile} routines={[]} lifts={lifts} prs={prs} onClear={dataTabProps.onClearHistory} onDeleteSession={dataTabProps.onDeleteSession} onUpdateSession={dataTabProps.onUpdateSession} flash={flash} />}
      {sub === "stats" && <StatsTab history={history} cardio={cardio} bw={bw} />}
      {sub === "calendrier" && <Calendar history={history} cardio={cardio} />}
      {sub === "mesures" && <Measures profile={profile} setProfile={setProfile} flash={flash} />}
      {sub === "parametres" && <Settings profile={profile} setProfile={setProfile} dataTabProps={dataTabProps} onResetOnboarding={onResetOnboarding} account={account} setAccount={setAccount} />}
    </div>
  );
}

/* --------------------------- SÉANCES (hub) --------------------------- */
function SeancesHub({ sub, setSub, routines, history, onNew, onEdit, onDelete, onStart, onExport, onAddPreset, cardio, bw, onAddCardio, onClearCardio }) {
  const subs = [["base","Musculation"],["cardio","Cardio"],["callisthenie","Callisthénie"]];
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", gap: 6 }}>
        {subs.map(([k, l]) => <button key={k} onClick={() => setSub(k)} style={{ ...S.subTab, flex: 1, ...(sub === k ? S.subTabOn : {}) }}>{l}</button>)}
      </div>
      {sub === "base" && <Seances routines={routines} history={history} onNew={onNew} onEdit={onEdit} onDelete={onDelete} onStart={onStart} onExport={onExport} onAddPreset={onAddPreset} />}
      {sub === "cardio" && <Cardio cardio={cardio} bw={bw} onAdd={onAddCardio} onClear={onClearCardio} />}
      {sub === "callisthenie" && <Callisthenie />}
    </div>
  );
}

/* ----------------------------- RANGS --------------------------------- */
function RanksTab({ muscleScores, bw }) {
  const ordered = [...MUSCLES].sort((a, b) => muscleScores[b.key] - muscleScores[a.key]);
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <section style={{ ...S.card, background: "#141a14", borderColor: "#2a3a2a" }}>
        <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>
          ⚖️ Tes rangs dépendent de ta <b>force relative à ton poids de corps</b>, actuellement réglé sur <b>{bw} kg</b>.
          Si ce poids est faux, tes rangs seront faussés. Corrige-le dans <b>Profil → Paramètres</b> ou <b>Mesures</b>.
        </div>
      </section>
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
function ExoByMuscle({ lifts, prs, bw, setBestLift, setPR, progressionFor, exoCount, weightHistoryFor, flash }) {
  const [openMuscle, setOpenMuscle] = useState(MUSCLES[0].key);
  const [openExo, setOpenExo] = useState(null);
  const [search, setSearch] = useState("");
  const [filterMuscles, setFilterMuscles] = useState([]); // [] = tous

  const toggleFilter = (k) => setFilterMuscles((p) => p.includes(k) ? p.filter((x) => x !== k) : [...p, k]);
  const q = search.trim().toLowerCase();

  // mode recherche/filtre : liste plate de résultats
  const searching = q.length > 0 || filterMuscles.length > 0;
  const results = useMemo(() => {
    if (!searching) return [];
    return EXERCISES.filter((e) => {
      if (filterMuscles.length && !filterMuscles.includes(e.primary) && !filterMuscles.some((m) => e.muscles[m])) return false;
      if (q && !e.name.toLowerCase().includes(q)) return false;
      return true;
    }).slice(0, 80);
  }, [q, filterMuscles, searching]);

  const renderExoCard = (ex) => {
    const rec = lifts[ex.key];
    const score = rec?.best1RM ? perfToScore(ex, rec.best1RM, bw) : 0;
    const isOpen = openExo === ex.key;
    return (
      <div key={ex.key} style={S.exoInner}>
        <div onClick={() => setOpenExo(isOpen ? null : ex.key)} style={{ display: "flex", alignItems: "center", gap: 12, cursor: "pointer" }}>
          <MuscleIcon muscles={ex.muscles} size={44} />
          <div style={{ flex: 1 }}><div style={{ fontWeight: 700, fontSize: 14 }}>{ex.name}{ex.perHand ? <span style={{ fontSize: 11, opacity: 0.5, fontWeight: 500 }}> /main</span> : null}</div>
            <div style={{ fontSize: 12, opacity: 0.55 }}>{rec?.best1RM ? (ex.isTime ? `Record : ${rec.best1RM}s` : `1RM estimé : ${rec.best1RM} kg`) : (ex.equipment ? ex.equipment : "Aucune donnée")}{prs[ex.key] ? ` · PR ${prs[ex.key]}kg` : ""}{exoCount(ex.key) > 0 ? ` · fait ${exoCount(ex.key)}×` : ""}</div></div>
          {rec?.best1RM ? <RankBadge score={score} size={36} /> : <span style={{ fontSize: 12, color: "#e0245e", fontWeight: 600 }}>+ Ajouter</span>}
        </div>
        {isOpen && (
          <div style={{ marginTop: 12, borderTop: "1px solid #232833", paddingTop: 12 }}>
            <ExoForm ex={ex} bw={bw} onSave={(e, w, r) => { setBestLift(ex.key, e, w, r); flash("Performance enregistrée ✓"); }} />
            {(() => { const t = nextRankTarget(ex, rec?.best1RM, bw); if (!t) return null;
              return t.top
                ? <div style={{ ...S.suggBox, marginTop: 12, background: "#1f1c10", borderColor: "#5a4a1a", color: "#f4d03f" }}>🔥 Rang maximal atteint sur cet exercice — tu domines !</div>
                : <div style={{ ...S.suggBox, marginTop: 12 }}>🎯 Pour passer <b>{t.nextLabel}</b> : {t.isTime ? `tiens ${t.target1RM}s` : `atteins ~${t.target1RM} kg en 1RM`}{!t.isTime && rec?.best1RM ? ` (soit +${t.delta} kg)` : ""}.</div>;
            })()}
            <PRInput ex={ex} value={prs[ex.key]} onSave={(v) => { setPR(ex.key, v); flash("PR enregistré ✓"); }} />
            <div style={{ marginTop: 14 }}><div style={S.miniLabel}>Progression du 1RM estimé</div><div style={{ marginTop: 6 }}><ProgressChart points={progressionFor(ex.key)} /></div></div>
            {!ex.isTime && <div style={{ marginTop: 14 }}><div style={S.miniLabel}>Charge max par séance (kg)</div><div style={{ marginTop: 6 }}><ProgressChart points={weightHistoryFor(ex.key)} /></div></div>}
            <div style={{ marginTop: 10, fontSize: 12.5, opacity: 0.6 }}>📊 Réalisé <b>{exoCount(ex.key)}</b> fois au total.</div>
            <div style={{ marginTop: 14 }}><div style={S.miniLabel}>Muscles ciblés</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                {Object.entries(ex.muscles).sort((a, b) => b[1] - a[1]).map(([mk, w]) => <span key={mk} style={{ ...S.chip, opacity: 0.4 + w * 0.6 }}>{muscleLabel(mk)} {Math.round(w * 100)}%</span>)}
              </div></div>
            {ex.tips && <div style={{ marginTop: 14 }}><div style={S.miniLabel}>Conseils de forme</div><ul style={S.tipList}>{ex.tips.map((t, i) => <li key={i} style={S.tipItem}>{t}</li>)}</ul></div>}
            {ex.yt && <a href={ex.yt} target="_blank" rel="noopener noreferrer" style={{ ...S.btnGhost, display: "block", textAlign: "center", textDecoration: "none", marginTop: 12, color: "#ff5c8a" }}>▶ Voir la technique sur YouTube</a>}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {/* recherche + filtres */}
      <section style={S.card}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="🔍 Rechercher un exercice…" style={S.input} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
          {MUSCLES.map((m) => (
            <button key={m.key} onClick={() => toggleFilter(m.key)} style={{ ...S.chip, cursor: "pointer", border: "1px solid", borderColor: filterMuscles.includes(m.key) ? "#e0245e" : "#2a313d", background: filterMuscles.includes(m.key) ? "#e0245e" : "#1c2230", color: filterMuscles.includes(m.key) ? "#fff" : "#cdd4de" }}>{m.label}</button>
          ))}
          {searching && <button onClick={() => { setSearch(""); setFilterMuscles([]); }} style={{ ...S.chip, cursor: "pointer", background: "#0e1218", color: "#ff6b6b" }}>✕ Réinitialiser</button>}
        </div>
        <div style={{ fontSize: 11, opacity: 0.45, marginTop: 8 }}>{EXERCISES.length} exercices disponibles{searching ? ` · ${results.length} résultat(s)` : ""}</div>
      </section>

      {searching ? (
        <div style={{ display: "grid", gap: 8 }}>
          {results.length === 0 ? <div style={{ ...S.card, textAlign: "center", opacity: 0.5, padding: 24 }}>Aucun exercice trouvé.</div> : results.map(renderExoCard)}
        </div>
      ) : (
      <>
      {MUSCLES.map((m) => {
        const list = EXERCISES.filter((e) => e.primary === m.key);
        if (!list.length) return null;
        const isMuscleOpen = openMuscle === m.key;
        const doneCount = list.filter((e) => lifts[e.key]?.best1RM).length;
        const shown = list.slice(0, 12);
        return (
          <div key={m.key} style={S.card}>
            <div onClick={() => setOpenMuscle(isMuscleOpen ? null : m.key)} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
              <div style={S.muscleDot} />
              <div style={{ flex: 1 }}><div style={{ fontWeight: 800, fontSize: 16 }}>{m.label}</div><div style={{ fontSize: 11.5, opacity: 0.5 }}>{list.length} exercices · {doneCount} renseignés</div></div>
              <span style={{ opacity: 0.4, fontSize: 20, transform: isMuscleOpen ? "rotate(90deg)" : "none", transition: ".2s" }}>›</span>
            </div>
            {isMuscleOpen && (
              <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
                {shown.map(renderExoCard)}
                {list.length > 12 && <div style={{ fontSize: 12, opacity: 0.5, textAlign: "center", padding: "4px 0" }}>+ {list.length - 12} autres — utilise la recherche ci-dessus</div>}
              </div>
            )}
          </div>
        );
      })}
      </>
      )}
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
function Seances({ routines, history, onNew, onEdit, onDelete, onStart, onExport, onAddPreset }) {
  const [showPresets, setShowPresets] = useState(routines.length === 0);
  // dernière date où chaque routine a été faite (par nom)
  const lastDone = {};
  (history || []).forEach((s) => { const t = +new Date(s.date); routines.forEach((r) => { if (s.routineId === r.id || s.name === r.name) { if (!lastDone[r.id] || t > lastDone[r.id]) lastDone[r.id] = t; } }); });
  // recommandée = celle faite il y a le plus longtemps (ou jamais faite)
  let recommendedId = null, oldest = Infinity;
  routines.forEach((r) => { const t = lastDone[r.id] || 0; if (t < oldest) { oldest = t; recommendedId = r.id; } });
  const daysSince = (id) => lastDone[id] ? Math.floor((Date.now() - lastDone[id]) / 864e5) : null;

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
              <div key={p.id} style={{ ...S.exoInner, borderLeft: "3px solid #4f7bd6", background: "#0e1420" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 9.5, fontWeight: 800, color: "#7ea8ff", background: "#0d1424", border: "1px solid #2a3a55", padding: "2px 6px", borderRadius: 5 }}>PRÉCONSTRUITE</span>
                </div>
                <div style={{ fontWeight: 700, fontSize: 14.5, marginTop: 6 }}>{p.name}</div>
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

      {routines.length > 0 && (
        <div style={{ display: "flex", gap: 12, fontSize: 11, opacity: 0.6, padding: "0 2px" }}>
          <span>🟢 Recommandée</span><span>🔴 Faite récemment</span>
        </div>
      )}
      {routines.length > 0 && <div style={{ ...S.miniLabel, marginTop: 2 }}>Mes séances</div>}
      {routines.map((r) => {
        const d = daysSince(r.id);
        const isReco = r.id === recommendedId;
        const recent = d != null && d <= 3;
        const borderColor = isReco ? "#2e7d4f" : recent ? "#e0245e" : "#1f2530";
        const bg = isReco ? "#101c14" : recent ? "#1a1016" : "#141921";
        return (
        <div key={r.id} style={{ ...S.card, borderColor, background: bg }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div style={{ fontWeight: 800, fontSize: 17 }}>{r.name || "Séance sans nom"}</div>
            {isReco ? <span style={{ fontSize: 10.5, fontWeight: 700, color: "#4ade80", background: "#0d1f14", padding: "3px 8px", borderRadius: 6, whiteSpace: "nowrap" }}>RECOMMANDÉE</span>
              : recent ? <span style={{ fontSize: 10.5, fontWeight: 700, color: "#ff8fb0", background: "#1f0d14", padding: "3px 8px", borderRadius: 6, whiteSpace: "nowrap" }}>RÉCENTE</span> : null}
          </div>
          <div style={{ fontSize: 12.5, opacity: 0.55, marginTop: 2 }}>{r.exercises.length} exercices{d != null ? ` · faite il y a ${d === 0 ? "aujourd'hui" : d === 1 ? "1 jour" : d + " jours"}` : " · jamais faite"}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>{r.exercises.map((e) => <span key={e.key} style={S.chip}>{EX_BY_KEY[e.key]?.name || e.key}</span>)}</div>
          <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
            <button style={{ ...S.btnPrimary, flex: 1 }} onClick={() => onStart(r)}>▶ Démarrer</button>
            <button style={S.btnGhost} onClick={() => onEdit(r)}>Modifier</button>
            <button style={S.btnGhost} onClick={() => onExport(r)}>Partager</button>
            <button style={{ ...S.btnGhost, color: "#ff6b6b" }} onClick={() => onDelete(r.id)}>Suppr.</button>
          </div>
        </div>
      ); })}
    </div>
  );
}

/* ------------------------- ROUTINE EDITOR ----------------------------- */
function RoutineEditor({ routine, onSave, onCancel }) {
  const [name, setName] = useState(routine.name || "");
  const [exercises, setExercises] = useState(routine.exercises || []);
  const [picker, setPicker] = useState(false);
  const [pSearch, setPSearch] = useState("");
  const [pMuscle, setPMuscle] = useState(null);
  const toggle = (key) => setExercises((prev) => prev.some((e) => e.key === key) ? prev.filter((e) => e.key !== key) : [...prev, { key, sets: 3, targetReps: 8, rest: 90 }]);
  const isSel = (key) => exercises.some((e) => e.key === key);
  const pq = pSearch.trim().toLowerCase();
  const pickerResults = (pq || pMuscle) ? EXERCISES.filter((e) => (!pMuscle || e.primary === pMuscle) && (!pq || e.name.toLowerCase().includes(pq))).slice(0, 60) : null;
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
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}><MuscleIcon muscles={ex.muscles} size={32} />
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
          <div style={{ marginTop: 10 }}>
            <input value={pSearch} onChange={(e) => setPSearch(e.target.value)} placeholder="🔍 Rechercher un exercice…" style={S.input} />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 8 }}>
              {MUSCLES.map((m) => <button key={m.key} onClick={() => setPMuscle(pMuscle === m.key ? null : m.key)} style={{ ...S.chip, cursor: "pointer", border: "1px solid", borderColor: pMuscle === m.key ? "#e0245e" : "#2a313d", background: pMuscle === m.key ? "#e0245e" : "#1c2230", color: pMuscle === m.key ? "#fff" : "#cdd4de" }}>{m.label}</button>)}
            </div>
            <div style={{ marginTop: 10, display: "grid", gap: 12 }}>
              {pickerResults ? (
                <div style={{ display: "grid", gap: 6 }}>
                  {pickerResults.length === 0 ? <div style={{ opacity: 0.5, fontSize: 13, textAlign: "center", padding: 16 }}>Aucun exercice trouvé.</div> :
                   pickerResults.map((ex) => (
                    <div key={ex.key} onClick={() => toggle(ex.key)} style={{ ...S.pickRow, ...(isSel(ex.key) ? S.pickRowOn : {}) }}>
                      <MuscleIcon muscles={ex.muscles} size={32} />
                      <span style={{ flex: 1, fontWeight: 600, fontSize: 13.5 }}>{ex.name}</span>
                      <span style={{ fontSize: 18, color: isSel(ex.key) ? "#e0245e" : "#3a3f4a", fontWeight: 800 }}>{isSel(ex.key) ? "✓" : "+"}</span>
                    </div>
                  ))}
                </div>
              ) : MUSCLES.map((m) => { const list = EXERCISES.filter((e) => e.primary === m.key).slice(0, 10); if (!list.length) return null;
                return (
                  <div key={m.key}><div style={{ ...S.miniLabel, marginBottom: 6 }}>{m.label} <span style={{ opacity: 0.5, fontWeight: 400 }}>(cherche pour voir tout)</span></div>
                    <div style={{ display: "grid", gap: 6 }}>
                      {list.map((ex) => (
                        <div key={ex.key} onClick={() => toggle(ex.key)} style={{ ...S.pickRow, ...(isSel(ex.key) ? S.pickRowOn : {}) }}>
                          <MuscleIcon muscles={ex.muscles} size={32} />
                          <span style={{ flex: 1, fontWeight: 600, fontSize: 13.5 }}>{ex.name}</span>
                          <span style={{ fontSize: 18, color: isSel(ex.key) ? "#e0245e" : "#3a3f4a", fontWeight: 800 }}>{isSel(ex.key) ? "✓" : "+"}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ); })}
            </div>
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
function History({ history, bw, profile, routines, lifts, prs, onClear, onDeleteSession, onUpdateSession, flash }) {
  const volumeOf = (s) => { let v = 0; s.exercises.forEach((ex) => ex.sets.forEach((st) => { v += (Number(st.weight) || 0) * (Number(st.reps) || 0); })); return Math.round(v); };
  const prevSameName = (s, idx) => history.slice(idx + 1).find((h) => h.name === s.name && h.routineId === s.routineId);
  const [openId, setOpenId] = useState(null);
  const [editing, setEditing] = useState(null); // session en cours d'édition (copie)

  const startEdit = (s) => setEditing(JSON.parse(JSON.stringify(s)));
  const editSet = (ei, si, field, val) => {
    const v = val.replace(",", "."); if (v !== "" && !/^\d*\.?\d*$/.test(v)) return;
    setEditing((p) => ({ ...p, exercises: p.exercises.map((ex, i) => i !== ei ? ex : { ...ex, sets: ex.sets.map((st, j) => j !== si ? st : { ...st, [field]: v }) }) }));
  };
  const delSet = (ei, si) => setEditing((p) => ({ ...p, exercises: p.exercises.map((ex, i) => i !== ei ? ex : { ...ex, sets: ex.sets.filter((_, j) => j !== si) }) }));
  const saveEdit = () => { onUpdateSession(editing.id, { name: editing.name, exercises: editing.exercises }); setEditing(null); flash("Séance modifiée ✓"); };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {history.length === 0 ? (
        <div style={{ ...S.card, textAlign: "center", padding: 28, opacity: 0.6 }}>Aucune séance terminée. Démarre une séance depuis l'onglet « Séances », ou importe ton historique Hevy depuis « Données ».</div>
      ) : (
        <>
          <div style={{ fontSize: 12, opacity: 0.5 }}>{history.length} séances enregistrées</div>
          {history.map((s, idx) => {
            const vol = volumeOf(s); const prev = prevSameName(s, idx); const prevVol = prev ? volumeOf(prev) : null;
            const diff = prevVol != null ? vol - prevVol : null;
            const isOpen = openId === s.id;
            return (
              <div key={s.id} style={S.card}>
                <div onClick={() => setOpenId(isOpen ? null : s.id)} style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", cursor: "pointer" }}>
                  <div><div style={{ fontWeight: 800, fontSize: 16 }}>{s.name || "Séance"}</div>
                    <div style={{ fontSize: 12, opacity: 0.55 }}>{new Date(s.date).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}{s.durationSec ? ` · ${fmtTime(s.durationSec)}` : ""}{s.source === "hevy" ? " · Hevy" : ""}</div></div>
                  <div style={{ textAlign: "right" }}><div style={{ fontSize: 11, opacity: 0.4 }}>Volume</div>
                    <div style={{ fontWeight: 800, color: "#ff5c8a" }}>{vol} kg</div>
                    {diff != null && <div style={{ fontSize: 11, fontWeight: 700, color: diff >= 0 ? "#4ade80" : "#ff6b6b" }}>{diff >= 0 ? "▲" : "▼"} {Math.abs(diff)} kg</div>}</div>
                </div>

                {!isOpen && (
                  <div style={{ display: "grid", gap: 4, marginTop: 10 }}>
                    {s.exercises.map((ex) => { const meta = EX_BY_KEY[ex.key]; const done = ex.sets.filter((st) => (st.weight && st.reps) || st.secs).length;
                      return <div key={ex.key} style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}><span style={{ opacity: 0.85 }}>{meta?.name || ex.key}</span><span style={{ opacity: 0.5 }}>{done} séries</span></div>; })}
                  </div>
                )}

                {isOpen && (
                  <div style={{ marginTop: 12, borderTop: "1px solid #232833", paddingTop: 12 }}>
                    {s.exercises.map((ex) => { const meta = EX_BY_KEY[ex.key];
                      return (
                        <div key={ex.key} style={{ marginBottom: 12 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}><MuscleIcon muscles={meta?.muscles || {}} size={28} /><span style={{ fontWeight: 700, fontSize: 13.5 }}>{meta?.name || ex.key}</span></div>
                          <div style={{ display: "grid", gap: 3 }}>
                            {ex.sets.map((st, i) => (
                              <div key={i} style={{ display: "flex", gap: 10, fontSize: 13, opacity: 0.8, paddingLeft: 36 }}>
                                <span style={{ width: 16, opacity: 0.5 }}>{i + 1}</span>
                                {meta?.isTime ? <span>{st.secs}s</span> : <span>{st.weight || "—"} kg × {st.reps || "—"}{st.weight && st.reps ? ` · 1RM ${estimate1RM(st.weight, st.reps)}kg` : ""}</span>}
                              </div>
                            ))}
                          </div>
                        </div>
                      ); })}
                    <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                      <button style={{ ...S.btnGhost, flex: 1 }} onClick={() => startEdit(s)}>✏️ Modifier</button>
                      <button style={{ ...S.btnGhost, color: "#ff6b6b" }} onClick={() => { if (confirm("Supprimer cette séance ?")) onDeleteSession(s.id); }}>🗑 Supprimer</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          <button style={{ ...S.btnGhost, color: "#ff6b6b" }} onClick={() => { if (confirm("Effacer TOUT l'historique ?")) onClear(); }}>Effacer tout l'historique</button>
        </>
      )}

      {/* Overlay d'édition */}
      {editing && (
        <div style={S.overlay}>
          <div style={S.sheet}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={{ fontWeight: 800, fontSize: 18 }}>Modifier la séance</div>
              <button style={S.btnGhost} onClick={() => setEditing(null)}>Annuler</button>
            </div>
            <input value={editing.name || ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Nom de la séance" style={{ ...S.input, marginBottom: 12 }} />
            <div style={{ display: "grid", gap: 12 }}>
              {editing.exercises.map((ex, ei) => { const meta = EX_BY_KEY[ex.key];
                return (
                  <div key={ei} style={S.card}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}><MuscleIcon muscles={meta?.muscles || {}} size={28} /><span style={{ fontWeight: 700 }}>{meta?.name || ex.key}</span></div>
                    <div style={{ display: "grid", gap: 6 }}>
                      {ex.sets.map((st, si) => (
                        <div key={si} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ width: 18, fontSize: 12, opacity: 0.5 }}>{si + 1}</span>
                          {meta?.isTime ? (
                            <input inputMode="decimal" placeholder="s" value={st.secs || ""} onChange={(e) => editSet(ei, si, "secs", e.target.value)} style={S.logInput} />
                          ) : (
                            <>
                              <input inputMode="decimal" placeholder="kg" value={st.weight || ""} onChange={(e) => editSet(ei, si, "weight", e.target.value)} style={S.logInput} />
                              <span style={{ opacity: 0.4 }}>×</span>
                              <input inputMode="numeric" placeholder="reps" value={st.reps || ""} onChange={(e) => editSet(ei, si, "reps", e.target.value)} style={S.logInput} />
                            </>
                          )}
                          <button style={{ ...S.btnGhost, color: "#ff6b6b", padding: "6px 10px" }} onClick={() => delSet(ei, si)}>×</button>
                        </div>
                      ))}
                    </div>
                  </div>
                ); })}
            </div>
            <button style={{ ...S.btnPrimary, width: "100%", padding: 14, marginTop: 16 }} onClick={saveEdit}>Enregistrer les modifications</button>
          </div>
        </div>
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
  const [planIdx, setPlanIdx] = useState(0);
  const [openMeal, setOpenMeal] = useState(null);
  const plans = NUTRITION_PLANS[profile.goal] || NUTRITION_PLANS.maintien;
  const plan = plans[Math.min(planIdx, plans.length - 1)];
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
          {Object.entries(GOALS).map(([k, v]) => <button key={k} onClick={() => { setProfile({ ...profile, goal: k }); setPlanIdx(0); }} style={{ ...S.goalBtn, ...(profile.goal === k ? S.goalBtnActive : {}) }}>{v.label}</button>)}
        </div></section>
      <section style={S.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={S.cardTitle}>Cibles journalières</div>
          <div style={{ fontSize: 26, fontWeight: 800, color: "#ff5c8a" }}>{macros.kcal} <span style={{ fontSize: 14, opacity: 0.6, fontWeight: 600 }}>kcal</span></div>
        </div>
        <div style={{ display: "flex", height: 12, borderRadius: 99, overflow: "hidden", marginTop: 14 }}>{bars.map((m) => <div key={m.label} style={{ width: `${(m.kcal / totalK) * 100}%`, background: m.color }} />)}</div>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)", gap: 10, marginTop: 14 }}>
          {bars.map((m) => <div key={m.label} style={{ textAlign: "center" }}><div style={{ width: 10, height: 10, borderRadius: 3, background: m.color, margin: "0 auto 4px" }} /><div style={{ fontWeight: 800, fontSize: 18 }}>{m.g}g</div><div style={{ fontSize: 11, opacity: 0.55 }}>{m.label}</div></div>)}
        </div>
      </section>
      <section style={S.card}><div style={S.cardTitle}>Conseils {goalLabel.toLowerCase()}</div><ul style={S.tipList}>{MEAL_TIPS[profile.goal].map((t, i) => <li key={i} style={S.tipItem}>{t}</li>)}</ul></section>

      <section style={S.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={S.cardTitle}>Routine alimentaire</div>
          <div style={{ fontSize: 12, opacity: 0.5 }}>{planIdx + 1}/{plans.length}</div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
          {plans.map((p, i) => <button key={i} onClick={() => setPlanIdx(i)} style={{ ...S.periodBtn, flex: "0 1 auto", minWidth: 0, whiteSpace: "normal", lineHeight: 1.2, ...(planIdx === i ? S.periodBtnOn : {}) }}>{p.n}</button>)}
        </div>
        <div style={{ fontSize: 11, opacity: 0.45, marginTop: 8 }}>Touche un repas pour voir le détail des macros.</div>
        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
          {meals.map((meal, i) => {
            const open = openMeal === i;
            return (
              <div key={i} onClick={() => setOpenMeal(open ? null : i)} style={{ background: "#0e1218", borderRadius: 10, padding: "11px 13px", cursor: "pointer" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span style={{ fontWeight: 700, color: "#ff8fb0", fontSize: 13.5 }}>{meal.t}</span>
                  <span style={{ fontSize: 12, opacity: 0.6 }}>{meal.kcal} kcal</span>
                </div>
                <div style={{ fontSize: 13, opacity: 0.85, marginTop: 4, fontWeight: 600 }}>{plan.meals[i]}</div>
                {open ? (
                  <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)", gap: 8 }}>
                    {[["Protéines", meal.p, meal.p * 4, "#e0245e"], ["Glucides", meal.c, meal.c * 4, "#27a3a3"], ["Lipides", meal.f, meal.f * 9, "#c9a227"]].map(([l, g, k, c]) => (
                      <div key={l} style={{ textAlign: "center", background: "#141921", borderRadius: 8, padding: "8px 4px" }}>
                        <div style={{ width: 8, height: 8, borderRadius: 2, background: c, margin: "0 auto 4px" }} />
                        <div style={{ fontWeight: 800, fontSize: 16 }}>{g}g</div>
                        <div style={{ fontSize: 10, opacity: 0.5 }}>{l}</div>
                        <div style={{ fontSize: 10, opacity: 0.4 }}>{k} kcal</div>
                      </div>
                    ))}
                    <div style={{ gridColumn: "1 / -1", fontSize: 11.5, opacity: 0.5 }}>Repère quantités : {meal.ex}</div>
                  </div>
                ) : (
                  <div style={{ fontSize: 11.5, opacity: 0.5, marginTop: 2 }}>P{meal.p} · G{meal.c} · L{meal.f} — toucher pour le détail</div>
                )}
              </div>
            );
          })}
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
const FR_MONTHS = { "janv": 0, "févr": 1, "fevr": 1, "mars": 2, "avr": 3, "mai": 4, "juin": 5, "juil": 6, "août": 7, "aout": 7, "sept": 8, "oct": 9, "nov": 10, "déc": 11, "dec": 11 };
function parseHevyDate(str) {
  if (!str) return new Date().toISOString();
  // format FR : "17 juin 2026, 16:56" ou "21 oct. 2024, 11:51"
  const m = str.match(/(\d{1,2})\s+([a-zéèûôîà.]+)\.?\s+(\d{4})(?:,?\s+(\d{1,2}):(\d{2}))?/i);
  if (m) {
    const day = +m[1], mon = m[2].toLowerCase().replace(".", "").slice(0, 4);
    const monIdx = FR_MONTHS[mon] ?? FR_MONTHS[mon.slice(0, 3)];
    if (monIdx != null) {
      const d = new Date(+m[3], monIdx, day, +(m[4] || 0), +(m[5] || 0));
      if (!isNaN(d)) return d.toISOString();
    }
  }
  const d = new Date(str); if (!isNaN(d)) return d.toISOString();
  const d2 = new Date(str.replace(",", "")); return isNaN(d2) ? new Date().toISOString() : d2.toISOString();
}
/* ----------------------------- STYLES --------------------------------- */
const S = {
  subTab: { padding: "8px 14px", borderRadius: 8, border: "1px solid #2a313d", background: "#0e1218", color: "#8a92a0", fontWeight: 600, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 },
  subTabOn: { background: "#1c2230", color: "#fff", borderColor: "#e0245e" },
  periodBtn: { flex: 1, minWidth: 56, padding: "7px 8px", borderRadius: 8, border: "1px solid #2a313d", background: "#0e1218", color: "#8a92a0", fontWeight: 600, fontSize: 12.5, cursor: "pointer" },
  periodBtnOn: { background: "#e0245e", color: "#fff", borderColor: "#e0245e" },
  levelPill: { display: "flex", alignItems: "center", gap: 6, background: "#161b22", padding: "6px 14px", borderRadius: 99, border: "1px solid #2a3140" },
  levelBadge: { width: 70, height: 70, borderRadius: 16, background: "#0e1218", border: "1px solid #2a3140", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  obLabel: { fontSize: 11, opacity: 0.55, display: "block", marginBottom: 5, marginTop: 2 },
  app: { maxWidth: 560, margin: "0 auto", minHeight: "100vh", background: "var(--bg,#0d1015)", color: "var(--text,#e8ecf2)", fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", display: "flex", flexDirection: "column" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 18px 14px", position: "sticky", top: 0, zIndex: 10, background: "linear-gradient(180deg, #0d1015 70%, rgba(13,16,21,0))" },
  logo: { fontSize: 24, fontWeight: 900, letterSpacing: 1 },
  tagline: { fontSize: 11, opacity: 0.4, letterSpacing: 1, textTransform: "uppercase" },
  bwPill: { display: "flex", alignItems: "center", gap: 6, background: "#161b22", padding: "6px 12px", borderRadius: 99, border: "1px solid #232833" },
  bwInput: { width: 48, background: "transparent", border: "none", color: "#fff", fontWeight: 700, fontSize: 15, textAlign: "right", outline: "none" },
  tabs: { display: "flex", gap: 4, padding: "0 12px 8px", overflowX: "auto" },
  tab: { flexShrink: 0, padding: "8px 14px", borderRadius: 99, border: "none", background: "transparent", color: "#8a92a0", fontSize: 13.5, fontWeight: 600, cursor: "pointer", transition: ".2s", whiteSpace: "nowrap" },
  tabActive: { background: "var(--accent,#e0245e)", color: "#fff" },
  main: { flex: 1, padding: "8px 14px 24px" },
  footer: { padding: "16px 18px 28px", fontSize: 11, opacity: 0.35, lineHeight: 1.5, textAlign: "center" },
  card: { background: "var(--card,#141921)", border: "1px solid var(--card-border,#1f2530)", borderRadius: 16, padding: 18 },
  heroCard: { background: "linear-gradient(135deg, #1a1f2b 0%, #141921 60%)", border: "1px solid #2a3140" },
  cardTitle: { fontWeight: 700, fontSize: 15, marginBottom: 4 },
  miniLabel: { fontSize: 11, letterSpacing: 1, opacity: 0.5, textTransform: "uppercase", fontWeight: 600 },
  muscleDot: { width: 10, height: 10, borderRadius: 99, background: "#e0245e", boxShadow: "0 0 8px #e0245e" },
  exoInner: { background: "var(--inner,#10151d)", border: "1px solid var(--card-border,#1c222d)", borderRadius: 12, padding: 12 },
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
  btnPrimary: { background: "var(--accent,#e0245e)", color: "#fff", border: "none", borderRadius: 10, padding: "10px 18px", fontWeight: 700, fontSize: 14, cursor: "pointer", whiteSpace: "nowrap" },
  btnGhost: { background: "#1c2230", color: "#cdd4de", border: "1px solid #2a313d", borderRadius: 10, padding: "10px 14px", fontWeight: 600, fontSize: 13.5, cursor: "pointer", whiteSpace: "nowrap" },
  stepBtn: { width: 30, height: 30, borderRadius: 8, border: "1px solid #2a313d", background: "#1c2230", color: "#fff", fontSize: 18, fontWeight: 700, cursor: "pointer", lineHeight: 1 },
  checkBtn: { width: 34, height: 34, borderRadius: 8, border: "1px solid #2a313d", background: "#1c2230", color: "#4a5160", fontSize: 16, fontWeight: 800, cursor: "pointer", flexShrink: 0 },
  checkOn: { background: "#2e7d4f", color: "#fff", borderColor: "#2e7d4f" },
  pickRow: { display: "flex", alignItems: "center", gap: 10, background: "#10151d", border: "1px solid #1c222d", borderRadius: 10, padding: "8px 12px", cursor: "pointer", transition: ".15s" },
  pickRowOn: { borderColor: "#e0245e", background: "#1a1016" },
  goalBtn: { flex: 1, minWidth: 0, padding: "10px 6px", borderRadius: 10, border: "1px solid #2a313d", background: "#0e1218", color: "#8a92a0", fontWeight: 600, fontSize: 13, cursor: "pointer", lineHeight: 1.2, textAlign: "center" },
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
  @keyframes popIn { from{opacity:0;transform:scale(.8)} to{opacity:1;transform:scale(1)} }
  @keyframes confettiFall { 0%{transform:translateY(0) rotate(0deg);opacity:1} 100%{transform:translateY(105vh) rotate(540deg);opacity:.7} }
  @keyframes slideUp { from{transform:translateY(40px);opacity:0} to{transform:translateY(0);opacity:1} }
  @keyframes slideDown { from{transform:translate(-50%,-16px);opacity:0} to{transform:translate(-50%,0);opacity:1} }
  ::-webkit-scrollbar { height:0; width:0; }
  input::-webkit-outer-spin-button, input::-webkit-inner-spin-button { -webkit-appearance:none; margin:0; }
  ul li::before { content:"›"; position:absolute; left:4px; color:#e0245e; font-weight:700; }
`;
