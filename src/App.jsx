import React, { useState, useEffect, useMemo, useRef } from "react";

/* ----------------------------- SUPABASE -------------------------------- */
// supabase est initialisé de façon lazy au 1er montage du composant AccountBox.
// Si les variables VITE_ ne sont pas définies, toute la section "Compte" est
// désactivée — l'app fonctionne normalement en mode local uniquement.
let _supabaseClient = null;
async function getSupabase() {
  if (_supabaseClient) return _supabaseClient;
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
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

const LOCAL_TS_KEY = "apex_updated_at"; // horodatage (ms) de la dernière modif locale

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
// Le paquet contient-il de vraies données ? (évite d'écraser du plein par du vide)
function bundleHasData(bundle) {
  if (!bundle || typeof bundle !== "object") return false;
  for (const k of SYNC_KEYS) {
    const v = bundle[k];
    if (v == null) continue;
    if (Array.isArray(v) && v.length) return true;
    if (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length) return true;
    if (typeof v === "number" && v > 0) return true;
    if (typeof v === "boolean" && v) continue; // onboarded seul ne compte pas
    if (typeof v === "string" && v && v !== "null" && v !== "{}" && v !== "[]") return true;
  }
  return false;
}
function getLocalTs() { const n = Number(window.localStorage.getItem(LOCAL_TS_KEY)); return Number.isFinite(n) ? n : 0; }
function setLocalTs(ms) { try { window.localStorage.setItem(LOCAL_TS_KEY, String(ms)); } catch {} }

const cloudSync = {
  async pull(client, userId) {
    const { data, error } = await client.from("apex_data").select("data, updated_at").eq("user_id", userId).maybeSingle();
    if (error) return { ok: false, error };
    return { ok: true, data: data?.data ?? null, updatedAt: data?.updated_at ? Date.parse(data.updated_at) : 0 };
  },
  async push(client, userId) {
    const bundle = readLocalBundle();
    const now = new Date();
    const { error } = await client.from("apex_data").upsert({ user_id: userId, data: bundle, updated_at: now.toISOString() });
    if (!error) setLocalTs(now.getTime());
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
// Lecteur YouTube intégrable (résultats de recherche) pour regarder sans quitter l'app
const ytSearchEmbed = (q) => `https://www.youtube-nocookie.com/embed?listType=search&list=${encodeURIComponent(q + " technique musculation")}`;
const APEX_LOGO_IMG = "data:image/webp;base64,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";
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
  // --- Ambiances ---
  competition: { label: "🔥 Compétition", bg: "#120406", card: "#220a0e", accent: "#ff1f3d", accentGlow: "#ff6173", grad: "radial-gradient(1200px 600px at 50% -10%, #3a0a14 0%, #120406 60%)" },
  focus:    { label: "🎯 Focus", bg: "#0d1117", card: "#151b24", accent: "#3d7dd6", accentGlow: "#8fb8e8", grad: "linear-gradient(180deg, #0f141c 0%, #0a0d12 100%)" },
  neon:     { label: "⚡ Néon", bg: "#0a0613", card: "#160d26", accent: "#d61fff", accentGlow: "#ff5ef0", grad: "radial-gradient(900px 500px at 80% 0%, #2a0f44 0%, #0a0613 55%)" },
  ocean:    { label: "🌊 Océan", bg: "#06121a", card: "#0d2230", accent: "#15b8c7", accentGlow: "#5ce0e8", grad: "linear-gradient(180deg, #0a2230 0%, #06121a 100%)" },
  crepuscule: { label: "🌆 Crépuscule", bg: "#160a16", card: "#241023", accent: "#ff5e7e", accentGlow: "#ffb37a", grad: "linear-gradient(180deg, #2a1030 0%, #160a16 70%)" },
  or:       { label: "🏆 Or & Noir", bg: "#0e0c06", card: "#1c1810", accent: "#e8b13a", accentGlow: "#ffd778", grad: "radial-gradient(1000px 500px at 50% -10%, #2a2210 0%, #0e0c06 60%)" },
  // --- Clairs / chaleureux ---
  clair:   { label: "☀️ Clair", bg: "#f2f4f8", card: "#ffffff", accent: "#e0245e", accentGlow: "#ff5c8a", light: true },
  chaleureux: { label: "🤎 Chaleureux", bg: "#f4ece1", card: "#fffaf2", accent: "#c2691f", accentGlow: "#e8954a", light: true, grad: "linear-gradient(180deg, #f8f0e4 0%, #efe3d2 100%)" },
  menthe:  { label: "🌿 Menthe claire", bg: "#eef6f0", card: "#ffffff", accent: "#1f9e6a", accentGlow: "#46c994", light: true },
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
  try { document.body.style.background = t.grad || t.bg; } catch {}
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

/* Rang Élite : logo ailé fourni par l'utilisateur, fond blanc détouré,
   optimisé en WebP 384px (transparent) et encodé en base64. */
const APEX_ELITE_IMG = "data:image/webp;base64,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";

/* Rang final (Mythique) : image fournie par l'utilisateur, optimisée
   en WebP 384px et encodée en base64 (aucun fichier d'asset à gérer). */
const APEX_MYTHIQUE_IMG = "data:image/webp;base64,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";

/* =======================================================================
   RankBadge — emblème de rang APEX (style démoniaque gradué)
   Rang final (Mythique) = démon complet ; plus le rang est bas, plus
   l'emblème est calme. Drop-in : mêmes props que l'ancien (score, size).
   N'utilise que scoreToRank() et TIERS, déjà présents dans App.jsx.
   ======================================================================= */
const APEX_PLATINE_IMG = "data:image/webp;base64,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";
function RankBadge({ score, size = 64 }) {
  const { tier, tierIdx } = scoreToRank(score);

  // Rang Élite = logo ailé fourni (fond détouré), pas le SVG.
  if (tierIdx === 7) {
    const halo = Math.max(2, size * 0.06);
    return (
      <div style={{ position: "relative", width: size, height: size, flexShrink: 0, lineHeight: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: "radial-gradient(circle at 50% 52%, rgba(255,64,150,0.26), rgba(255,64,150,0) 68%)" }}>
        <img src={APEX_ELITE_IMG} alt={tier.label} draggable={false}
             style={{ width: "100%", height: "100%", objectFit: "contain", display: "block",
                      filter: `drop-shadow(0 0 ${halo.toFixed(1)}px rgba(255,40,130,0.55))` }} />
      </div>
    );
  }
  // Rang final (Mythique) = l'image fournie (emblème démon), pas le SVG.
  if (tierIdx === TIERS.length - 1) {
    const r = Math.round(size * 0.16);
    const glow = Math.max(2, size * 0.14);
    return (
      <div style={{ position: "relative", width: size, height: size, flexShrink: 0,
                    borderRadius: r, overflow: "hidden", lineHeight: 0,
                    boxShadow: `0 0 ${glow.toFixed(1)}px rgba(255,46,28,0.55), inset 0 0 0 1px rgba(255,184,120,0.20)` }}>
        <img src={APEX_MYTHIQUE_IMG} alt={tier.label} draggable={false}
             style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      </div>
    );
  }
  // Rang Platine = logo métallique fourni (bouclier), pas le SVG.
  if (tierIdx === 4) {
    const r = Math.round(size * 0.16);
    const glow = Math.max(2, size * 0.14);
    return (
      <div style={{ position: "relative", width: size, height: size, flexShrink: 0,
                    borderRadius: r, overflow: "hidden", lineHeight: 0,
                    boxShadow: `0 0 ${glow.toFixed(1)}px rgba(92,224,224,0.50), inset 0 0 0 1px rgba(92,224,224,0.22)` }}>
        <img src={APEX_PLATINE_IMG} alt={tier.label} draggable={false}
             style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      </div>
    );
  }
  const m = tierIdx / (TIERS.length - 1);                 // 0..1 menace
  const uid = `${tier.key}-${size}-${Math.round(score * 1e4)}`;

  // --- helpers (locaux pour éviter toute collision) ---
  const h2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  const toRgb = (hex) => { const x = hex.replace("#", ""); return [parseInt(x.slice(0,2),16), parseInt(x.slice(2,4),16), parseInt(x.slice(4,6),16)]; };
  const mixc = (a, b, t) => { const A = toRgb(a), B = toRgb(b); return "#" + h2(A[0]+(B[0]-A[0])*t) + h2(A[1]+(B[1]-A[1])*t) + h2(A[2]+(B[2]-A[2])*t); };
  const dk = (hex, t) => mixc(hex, "#000000", t);
  const lt = (hex, t) => mixc(hex, "#ffffff", t);
  const PT = (x, y) => `${x.toFixed(2)},${y.toFixed(2)}`;
  const dia = (cx, cy, dx, dy) => `M ${PT(cx, cy-dy)} L ${PT(cx+dx, cy)} L ${PT(cx, cy+dy)} L ${PT(cx-dx, cy)} Z`;
  const flame = (x, y, w, h, lean=0) =>
    `M ${PT(x, y-h)} C ${PT(x+w+lean, y-h*0.45)} ${PT(x+w*0.6, y)} ${PT(x, y)}`
    + ` C ${PT(x-w*0.6, y)} ${PT(x-w+lean, y-h*0.45)} ${PT(x, y-h)} Z`;
  const spikePts = (x, y, a, len, half) => {
    const tx = x + Math.cos(a) * len, ty = y + Math.sin(a) * len;
    const px = Math.cos(a + Math.PI/2), py = Math.sin(a + Math.PI/2);
    return `${PT(x + px*half, y + py*half)} ${PT(tx,ty)} ${PT(x - px*half, y - py*half)}`;
  };
  const hornPath = (cx, cy, dir, spread, rise, thick, dyUnit) => {
    const tipUp = rise * dyUnit;
    const bo = [cx + dir * (2.5 + thick), cy - 0.26 * dyUnit];
    const bi = [cx + dir * 2.5,           cy - 0.32 * dyUnit];
    const tip = [cx + dir * spread * 0.55, cy - tipUp];
    const o1 = [cx + dir * spread,        cy + 0.06 * dyUnit];
    const o2 = [cx + dir * spread * 1.02, cy - tipUp * 0.55];
    const i1 = [cx + dir * spread * 0.50, cy - tipUp * 0.50];
    const i2 = [cx + dir * spread * 0.20, cy - 0.02 * dyUnit];
    return `M ${PT(bo[0],bo[1])} C ${PT(o1[0],o1[1])} ${PT(o2[0],o2[1])} ${PT(tip[0],tip[1])}`
         + ` C ${PT(i1[0],i1[1])} ${PT(i2[0],i2[1])} ${PT(bi[0],bi[1])} Z`;
  };

  const c = 50, cy = 53, dx = 33, dy = 36;
  const G = tier.glow, B = tier.color;
  const stoneL = dk(B, 0.55), stoneD = dk(B, 0.80), stoneE = dk(B, 0.90);

  const bg = [], fg = [];

  // halo
  bg.push(`<circle cx="${c}" cy="${cy}" r="${30 + 18*m}" fill="url(#halo-${uid})"/>`);

  // flame tongues behind frame (mid+)
  if (m > 0.25) {
    const nf = Math.round(3 + m * 6); let fl = "";
    for (let i = 0; i < nf; i++) {
      const t = i / (nf - 1);
      const a = -Math.PI/2 + (t - 0.5) * Math.PI * 1.5;
      const rr = dx + 2;
      const fx = c + Math.cos(a) * rr, fy = cy + Math.sin(a) * rr * (dy/dx);
      const fh = (5 + m * 11) * (0.6 + 0.4 * Math.sin(i * 1.7));
      fl += `<path d="${flame(fx, fy - fh*0.3, 3 + m*2, fh, (fx-c)*0.15)}" fill="${G}" opacity="${0.18 + 0.20*m}"/>`;
    }
    bg.push(`<g filter="url(#soft-${uid})">${fl}</g>`);
  }

  // lower wing / blade plates
  for (const dir of [-1, 1]) {
    const wx = c + dir * (dx - 2), wy = cy + 11;
    const spread = 9 + m * 7, drop = 8 + m * 6, jag = m;
    const pts = [
      PT(wx, wy - 4),
      PT(wx + dir * spread, wy - 2 - jag*3),
      PT(wx + dir * (spread*0.55), wy + 1),
      PT(wx + dir * (spread + 2), wy + drop*0.4),
      PT(wx + dir * (spread*0.5), wy + drop*0.5),
      PT(wx + dir * (spread*0.8), wy + drop),
      PT(wx + dir * 2, wy + drop*0.7),
    ].join(" ");
    bg.push(`<polygon points="${pts}" fill="${stoneD}" stroke="${stoneE}" stroke-width="0.6"/>`);
    bg.push(`<polygon points="${pts}" fill="none" stroke="${G}" stroke-width="0.5" opacity="${0.10+0.30*m}"/>`);
  }

  // bottom tail spike
  {
    const ty = cy + dy, len = 7 + m * 12, half = 4 + m * 2.5;
    bg.push(`<polygon points="${PT(c-half, ty-3)} ${PT(c, ty+len)} ${PT(c+half, ty-3)}" fill="${stoneD}" stroke="${stoneE}" stroke-width="0.6"/>`);
    if (m > 0.45) {
      bg.push(`<polygon points="${PT(c-half+0.5, ty+len*0.35)} ${PT(c-half-3-m*3, ty+len*0.2)} ${PT(c-1, ty+len*0.55)}" fill="${stoneD}"/>`);
      bg.push(`<polygon points="${PT(c+half-0.5, ty+len*0.35)} ${PT(c+half+3+m*3, ty+len*0.2)} ${PT(c+1, ty+len*0.55)}" fill="${stoneD}"/>`);
    }
    bg.push(`<line x1="${c}" y1="${ty-1}" x2="${c}" y2="${ty+len-1}" stroke="${G}" stroke-width="0.7" opacity="${0.2+0.4*m}"/>`);
  }

  // edge spikes (left/right)
  {
    const edges = [ [c+dx, cy, 0], [c-dx, cy, Math.PI] ];
    const n = 1 + Math.round(m * 2); let sp = "";
    for (const [ex, ey, a] of edges) {
      for (let k = 0; k < n; k++) {
        const off = (k - (n-1)/2) * 6;
        const ox = ex + Math.cos(a + Math.PI/2) * off;
        const oy = ey + Math.sin(a + Math.PI/2) * off;
        sp += `<polygon points="${spikePts(ox, oy, a, 4 + m*5, 2.2)}" fill="${stoneL}" stroke="${stoneE}" stroke-width="0.5"/>`;
      }
    }
    bg.push(sp);
  }

  // frame + face plate
  fg.push(`<path d="${dia(c, cy, dx, dy)}" fill="url(#stone-${uid})" stroke="${stoneE}" stroke-width="2"/>`);
  fg.push(`<path d="${dia(c, cy, dx-4, dy-4)}" fill="none" stroke="${lt(stoneL,0.25)}" stroke-width="1" opacity="0.8"/>`);
  fg.push(`<path d="${dia(c, cy, dx-8, dy-8)}" fill="url(#plate-${uid})"/>`);

  // magma cracks
  {
    const nc = Math.round(2 + m * 5); let cr = "";
    for (let i = 0; i < nc; i++) {
      const a0 = (i / nc) * Math.PI * 2 + 0.4;
      const r0 = 4 + (i % 2) * 3;
      const x0 = c + Math.cos(a0) * r0, y0 = cy + Math.sin(a0) * r0;
      const x1 = c + Math.cos(a0) * (dx-12), y1 = cy + Math.sin(a0) * (dy-12);
      const mx = (x0+x1)/2 + Math.cos(a0+1.4) * 3, my = (y0+y1)/2 + Math.sin(a0+1.4) * 3;
      cr += `<path d="M ${PT(x0,y0)} Q ${PT(mx,my)} ${PT(x1,y1)}" fill="none" stroke="${G}" stroke-width="${0.7+m*0.5}" opacity="${0.12+0.45*m}"/>`;
    }
    fg.push(`<g filter="url(#soft-${uid})">${cr}</g>`);
  }

  // horns
  if (m > 0.05) {
    const spread = dx * (0.45 + 0.55 * m), rise = 0.55 + 0.55 * m, thick = 3.5 + 5 * m;
    let hh = "";
    for (const dir of [-1, 1]) {
      hh += `<path d="${hornPath(c, cy, dir, spread, rise, thick, dy)}" fill="url(#stone-${uid})" stroke="${stoneE}" stroke-width="1" stroke-linejoin="round"/>`;
      const seamTipX = c + dir * spread * 0.55, seamTipY = cy - rise * dy * 0.92;
      hh += `<path d="M ${PT(c + dir*4, cy - 0.30*dy)} Q ${PT(c + dir*spread*0.92, cy - 0.04*dy)} ${PT(seamTipX, seamTipY)}" fill="none" stroke="${G}" stroke-width="${0.6+m*0.6}" opacity="${0.25+0.45*m}"/>`;
      if (m > 0.5) {
        for (let s = 1; s <= 3; s++) {
          const tt = s / 4;
          const nx = c + dir * spread * (0.75 - tt*0.25);
          const ny = cy - rise * dy * tt * 0.9 + 0.04*dy;
          hh += `<line x1="${nx - dir*2.2}" y1="${ny+1.8}" x2="${nx + dir*2.2}" y2="${ny-1.8}" stroke="${stoneE}" stroke-width="0.7" opacity="0.65"/>`;
        }
      }
    }
    fg.push(hh);
  }

  // brow (V)
  if (m > 0.30) {
    const by = cy - 6, bw = 9 + m*3, drop = 2 + m*4, th = 1.6 + m*2.2;
    for (const dir of [-1, 1]) {
      fg.push(`<path d="M ${PT(c + dir*2, by + drop)} L ${PT(c + dir*bw, by - 2)}" stroke="${stoneE}" stroke-width="${th}" stroke-linecap="round"/>`);
      fg.push(`<path d="M ${PT(c + dir*2.5, by + drop - 0.6)} L ${PT(c + dir*(bw-1), by - 2.4)}" stroke="${lt(stoneL,0.2)}" stroke-width="${th*0.4}" stroke-linecap="round" opacity="0.6"/>`);
    }
  }

  // eyes
  {
    const ey = cy - 1, ex = 8 + m * 1.5, slant = m; let eyes = "";
    for (const dir of [-1, 1]) {
      const x = c + dir * ex;
      if (slant < 0.35) {
        eyes += `<ellipse cx="${x}" cy="${ey}" rx="${2.6 - slant}" ry="2.6" fill="${G}"/>`;
        eyes += `<circle cx="${x}" cy="${ey}" r="1.1" fill="${lt(G,0.7)}"/>`;
      } else {
        const w = 4 + m*1.5, h = 1.8 + m*0.6;
        const innerX = x - dir*w*0.5, innerY = ey + h*0.7*slant;
        const outerX = x + dir*w*0.5, outerY = ey - h*0.5*slant;
        eyes += `<path d="M ${PT(innerX,innerY)} Q ${PT(x, ey-h)} ${PT(outerX,outerY)} Q ${PT(x, ey+h)} ${PT(innerX,innerY)} Z" fill="${G}"/>`;
      }
    }
    fg.push(`<g filter="url(#glow-${uid})">${eyes}</g>`);
  }

  // forehead gem / flame
  {
    const gx = c, gy = cy - 9 - m*1;
    if (m < 0.5) {
      fg.push(`<polygon points="${PT(gx,gy-2.4)} ${PT(gx+1.8,gy)} ${PT(gx,gy+2.4)} ${PT(gx-1.8,gy)}" fill="${G}" stroke="${lt(G,0.5)}" stroke-width="0.4"/>`);
      fg.push(`<polygon points="${PT(gx,gy-2.4)} ${PT(gx+1.8,gy)} ${PT(gx,gy)} ${PT(gx-1.8,gy)}" fill="${lt(G,0.4)}" opacity="0.7"/>`);
    } else {
      fg.push(`<g filter="url(#glow-${uid})"><path d="${flame(gx, gy+2, 2.4, 7 + m*2)}" fill="${G}"/><path d="${flame(gx, gy+1, 1.2, 4)}" fill="${lt(G,0.6)}"/></g>`);
    }
  }

  // mouth / fangs
  if (m > 0.40) {
    const my = cy + 9 + m*2, mw = 6 + m*3;
    fg.push(`<path d="M ${PT(c-mw, my-1)} Q ${PT(c, my+2+m)} ${PT(c+mw, my-1)}" fill="none" stroke="${stoneE}" stroke-width="${1+m}"/>`);
    const nf = Math.round(2 + m*3); let fangs = "";
    for (let i = 0; i < nf; i++) {
      const t = nf === 1 ? 0.5 : i/(nf-1);
      const fxp = c - mw + t*2*mw;
      const fl2 = 2 + m*2.5 - Math.abs(t-0.5)*2;
      fangs += `<polygon points="${PT(fxp-1, my-1)} ${PT(fxp, my+fl2)} ${PT(fxp+1, my-1)}" fill="${lt(stoneL,0.3)}"/>`;
    }
    fg.push(fangs);
  }

  // top crest / flame
  {
    const tx = c, ty = cy - dy;
    if (m < 0.4) {
      fg.push(`<polygon points="${PT(tx,ty-5-m*4)} ${PT(tx+2.4,ty)} ${PT(tx-2.4,ty)}" fill="${stoneL}" stroke="${stoneE}" stroke-width="0.5"/>`);
      fg.push(`<polygon points="${PT(tx,ty-3)} ${PT(tx+1,ty-0.5)} ${PT(tx-1,ty-0.5)}" fill="${G}" opacity="0.7"/>`);
    } else {
      fg.push(`<g filter="url(#glow-${uid})"><path d="${flame(tx, ty+1, 3+m, 9+m*7, 0)}" fill="${G}"/><path d="${flame(tx, ty, 1.6, 5+m*3)}" fill="${lt(G,0.6)}"/></g>`);
    }
  }

  const defs = `<defs>
    <radialGradient id="halo-${uid}" cx="50%" cy="42%" r="55%">
      <stop offset="0%" stop-color="${G}" stop-opacity="${0.30 + 0.35*m}"/>
      <stop offset="60%" stop-color="${G}" stop-opacity="${0.05 + 0.10*m}"/>
      <stop offset="100%" stop-color="${G}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="stone-${uid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${lt(stoneL,0.18)}"/>
      <stop offset="45%" stop-color="${stoneL}"/>
      <stop offset="100%" stop-color="${stoneD}"/>
    </linearGradient>
    <radialGradient id="plate-${uid}" cx="50%" cy="40%" r="65%">
      <stop offset="0%" stop-color="${mixc(stoneD, G, 0.18+0.18*m)}"/>
      <stop offset="55%" stop-color="${stoneD}"/>
      <stop offset="100%" stop-color="${stoneE}"/>
    </radialGradient>
    <filter id="glow-${uid}" x="-80%" y="-80%" width="260%" height="260%">
      <feGaussianBlur stdDeviation="${1.1 + m*1.2}" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="soft-${uid}" x="-80%" y="-80%" width="260%" height="260%">
      <feGaussianBlur stdDeviation="1.6"/>
    </filter>
  </defs>`;

  const svg = `<svg viewBox="0 0 100 110" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" style="overflow:visible" xmlns="http://www.w3.org/2000/svg">${defs}${bg.join("")}${fg.join("")}</svg>`;

  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0, lineHeight: 0, overflow: "visible" }}
         dangerouslySetInnerHTML={{ __html: svg }} />
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
function ProgressChart({ points, unit = "kg", onGoToSession }) {
  const [sel, setSel] = useState(null);
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
  const pt = sel != null ? points[sel] : null;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", touchAction: "manipulation" }}>
        <defs><linearGradient id="pg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--accent,#e0245e)" stopOpacity="0.3" /><stop offset="100%" stopColor="var(--accent,#e0245e)" stopOpacity="0" /></linearGradient></defs>
        <path d={area} fill="url(#pg)" />
        <path d={d} fill="none" stroke="var(--accent,#e0245e)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        {pt && <line x1={sx(+new Date(pt.date))} y1={pad} x2={sx(+new Date(pt.date))} y2={H - pad} stroke="var(--accent-glow,#ff5c8a)" strokeWidth="1" strokeDasharray="3 3" opacity="0.7" />}
        {points.map((p, i) => (
          <g key={i} onClick={() => setSel(i === sel ? null : i)} style={{ cursor: "pointer" }}>
            <circle cx={sx(+new Date(p.date))} cy={sy(p.value)} r="11" fill="transparent" />
            <circle cx={sx(+new Date(p.date))} cy={sy(p.value)} r={i === sel ? 5 : 3} fill={i === sel ? "var(--accent-glow,#ff5c8a)" : "var(--accent-glow,#ff5c8a)"} stroke={i === sel ? "var(--text,#fff)" : "none"} strokeWidth="1.5" />
          </g>
        ))}
        <text x={pad} y={12} fontSize="9" fill="#8a92a0">{maxY}{unit ? " " + unit : ""}</text>
        <text x={pad} y={H - 1} fontSize="9" fill="#8a92a0">{minY}{unit ? " " + unit : ""}</text>
      </svg>
      {pt ? (
        <div style={{ marginTop: 8, padding: 12, borderRadius: 12, background: "var(--inner,#10151d)", border: "1px solid var(--card-border,#2a3038)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div style={{ fontWeight: 800, fontSize: 14 }}>{Math.round(pt.value)}{unit ? " " + unit : ""}</div>
            <div style={{ fontSize: 12, opacity: 0.6 }}>{new Date(pt.date).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}</div>
          </div>
          <div style={{ fontSize: 12.5, opacity: 0.8, marginTop: 4 }}>
            {pt.secs != null && pt.secs !== undefined && pt.weight == null
              ? `Meilleure série : ${pt.secs} s`
              : (pt.weight != null && pt.reps != null)
                ? `Meilleure série : ${pt.weight} kg × ${pt.reps} rép.`
                : "Détail de série indisponible"}
          </div>
          {onGoToSession && pt.sessionId && (
            <button style={{ ...S.btnGhost, width: "100%", marginTop: 10, fontSize: 13 }} onClick={() => onGoToSession(pt.sessionId)}>
              ✏️ Corriger cette séance →
            </button>
          )}
        </div>
      ) : (
        <div style={{ fontSize: 11, opacity: 0.4, marginTop: 6, textAlign: "center" }}>Touche un point pour voir le détail de la séance.</div>
      )}
    </div>
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
  const [focusSessionId, setFocusSessionId] = useState(null);
  const goToSession = (id) => { setFocusSessionId(id); setProfilSub("historique"); setTab("profil"); };
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
  // À la connexion : fusion NON destructive (on n'écrase jamais du plein par du vide)
  useEffect(() => {
    if (!account?.id) { syncReady.current = false; return; }
    let cancelled = false;
    (async () => {
      const client = await getSupabase();
      if (!client || cancelled) return;
      const res = await cloudSync.pull(client, account.id);
      if (cancelled || !res.ok) { if (!res.ok) console.warn("APEX pull:", res.error?.message); return; }

      const localHas = bundleHasData(readLocalBundle());
      const cloudHas = bundleHasData(res.data);
      const localTs = getLocalTs();

      const adoptCloud = () => {
        const changed = writeLocalBundle(res.data);
        setLocalTs(res.updatedAt || Date.now()); // évite une boucle de rechargement
        if (changed && !sessionStorage.getItem("apex_synced_once")) {
          sessionStorage.setItem("apex_synced_once", "1");
          window.location.reload();
          return true;
        }
        return false;
      };

      if (!cloudHas) {
        // Cloud vide/insignifiant -> on envoie le local, JAMAIS l'inverse
        if (localHas) await cloudSync.push(client, account.id);
      } else if (!localHas) {
        // Local vide, cloud plein -> on adopte le cloud
        if (adoptCloud()) return;
      } else {
        // Les deux ont des données -> le plus récent gagne
        if (res.updatedAt > localTs) { if (adoptCloud()) return; }
        else await cloudSync.push(client, account.id);
      }
      syncReady.current = true;
    })();
    return () => { cancelled = true; };
  }, [account?.id]);

  // Pousse (anti-rebond) à chaque modification quand l'utilisateur est connecté
  useEffect(() => {
    if (!account?.id || !syncReady.current) return;
    setLocalTs(Date.now()); // marque le local comme la version la plus récente
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
      let best = 0, bestSet = null; f.sets.forEach((st) => { const e = ex.isTime ? Number(st.secs) || 0 : estimate1RM(st.weight, st.reps); if (e > best) { best = e; bestSet = st; } });
      if (best > 0) pts.push({ date: s.date, value: best, sessionId: s.id,
        weight: bestSet && !ex.isTime ? Number(bestSet.weight) || null : null,
        reps: bestSet && !ex.isTime ? Number(bestSet.reps) || null : null,
        secs: bestSet && ex.isTime ? Number(bestSet.secs) || null : null }); });
    return pts;
  };
  // nombre de séances où l'exo apparaît
  const exoCount = (exKey) => history.filter((s) => s.exercises?.some((e) => e.key === exKey)).length;
  // poids max soulevé par séance (pour le graphe poids/date)
  const weightHistoryFor = (exKey) => {
    const pts = [];
    [...history].reverse().forEach((s) => { const f = s.exercises?.find((e) => e.key === exKey); if (!f) return;
      let maxW = 0, bestSet = null; f.sets.forEach((st) => { const w = Number(st.weight) || 0; if (w > maxW) { maxW = w; bestSet = st; } });
      if (maxW > 0) pts.push({ date: s.date, value: maxW, sessionId: s.id, weight: maxW, reps: bestSet ? Number(bestSet.reps) || null : null }); });
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
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <img src={APEX_LOGO_IMG} alt="APEX" style={{ height: 34, width: "auto", display: "block", filter: "drop-shadow(0 2px 6px rgba(80,140,255,.35))" }} />
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
          focusSessionId={focusSessionId} onFocusHandled={() => setFocusSessionId(null)}
          dataTabProps={{ profile, routines, lifts, prs, history, cardio, xp: xpRaw, onImportBackup: importBackup, onImportHevy: importHevy, onImportRoutine: importRoutine, flash,
            onClearHistory: () => setHistory([]), onDeleteSession: (id) => setHistory((p) => p.filter((s) => s.id !== id)), onUpdateSession: (id, upd) => setHistory((p) => p.map((s) => s.id === id ? { ...s, ...upd } : s)) }} />}
        {tab === "exos" && <ExoByMuscle lifts={lifts} prs={prs} bw={bw} setBestLift={setBestLift} setPR={setPR} progressionFor={progressionFor} exoCount={exoCount} weightHistoryFor={weightHistoryFor} onGoToSession={goToSession} flash={flash} />}
        {tab === "seances" && (editingRoutine
          ? <RoutineEditor routine={editingRoutine} onSave={saveRoutine} onCancel={() => setEditingRoutine(null)} />
          : <SeancesHub sub={seancesSub} setSub={setSeancesSub} routines={routines} history={history}
              onNew={() => setEditingRoutine({ id: uid(), name: "", exercises: [] })} onEdit={setEditingRoutine} onDelete={deleteRoutine}
              onStart={(r) => setLiveSession(r)} onExport={(r) => exportRoutine(r, flash)} onAddPreset={addPreset}
              cardio={cardio} bw={bw} onAddCardio={addCardio} onClearCardio={() => setCardio([])} />)}
        {tab === "nutrition" && <Nutrition profile={profile} setProfile={setProfile} />}
      </main>

      {liveSession && <SessionLogger routine={liveSession} lastSessionSets={lastSessionSets} prs={prs} muscleScores={muscleScores} onFinish={completeSession} onCancel={() => setLiveSession(null)} />}
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
          <img src={APEX_LOGO_IMG} alt="APEX" style={{ height: 96, width: "auto", margin: "0 auto 10px", display: "block", filter: "drop-shadow(0 4px 14px rgba(80,140,255,.4))" }} />
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
/* Streak hebdomadaire : nombre de semaines consécutives (jusqu'à cette semaine
   ou la précédente) avec au moins une séance. + stats utiles. */
function weekKey(d) {
  const dt = new Date(d); dt.setHours(0, 0, 0, 0);
  // jeudi de la semaine ISO
  dt.setDate(dt.getDate() + 3 - ((dt.getDay() + 6) % 7));
  const week1 = new Date(dt.getFullYear(), 0, 4);
  const wn = 1 + Math.round(((dt - week1) / 864e5 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${dt.getFullYear()}-${wn}`;
}
function computeStreak(history) {
  if (!history?.length) return { current: 0, best: 0, weekCount: 0, total: 0 };
  const weeks = new Set(history.map((s) => weekKey(s.date)));
  // semaines consécutives en remontant depuis cette semaine
  const now = new Date();
  let cur = 0; let cursor = new Date(now);
  // tolère que la semaine en cours n'ait pas encore de séance : on démarre à la dernière semaine active
  const thisWk = weekKey(now);
  if (!weeks.has(thisWk)) cursor.setDate(cursor.getDate() - 7);
  while (weeks.has(weekKey(cursor))) { cur++; cursor.setDate(cursor.getDate() - 7); }
  // meilleur streak historique
  const sortedWks = [...weeks].map((k) => k).sort();
  let best = 0, run = 0, prev = null;
  // reconstruit les dates de semaine pour comparer la continuité
  const weekDates = history.map((s) => { const d = new Date(s.date); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); d.setHours(0,0,0,0); return +d; });
  const uniq = [...new Set(weekDates)].sort((a, b) => a - b);
  uniq.forEach((t) => { if (prev != null && t - prev === 7 * 864e5) run++; else run = 1; prev = t; if (run > best) best = run; });
  // séances des 7 derniers jours
  const weekCount = history.filter((s) => Date.now() - +new Date(s.date) < 7 * 864e5).length;
  return { current: cur, best: Math.max(best, cur), weekCount, total: history.length };
}

const BADGES = [
  // Régularité
  { id: "first", cat: "Régularité", emoji: "🌱", label: "Première séance", desc: "Termine ta toute première séance.", test: (c) => c.total >= 1, prog: (c) => ({ cur: c.total, target: 1, unit: "" }) },
  { id: "s10", cat: "Régularité", emoji: "💪", label: "Habitué", desc: "Termine 10 séances au total.", test: (c) => c.total >= 10, prog: (c) => ({ cur: c.total, target: 10, unit: "" }) },
  { id: "s50", cat: "Régularité", emoji: "🏋️", label: "Assidu", desc: "Termine 50 séances au total.", test: (c) => c.total >= 50, prog: (c) => ({ cur: c.total, target: 50, unit: "" }) },
  { id: "s100", cat: "Régularité", emoji: "🦾", label: "Machine", desc: "Termine 100 séances au total.", test: (c) => c.total >= 100, prog: (c) => ({ cur: c.total, target: 100, unit: "" }) },
  { id: "streak4", cat: "Régularité", emoji: "🔥", label: "En feu", desc: "Entraîne-toi 4 semaines consécutives.", test: (c) => c.best >= 4, prog: (c) => ({ cur: c.best, target: 4, unit: " sem" }) },
  { id: "streak12", cat: "Régularité", emoji: "🌋", label: "Inarrêtable", desc: "Entraîne-toi 12 semaines consécutives.", test: (c) => c.best >= 12, prog: (c) => ({ cur: c.best, target: 12, unit: " sem" }) },
  // Niveau & records
  { id: "lvl5", cat: "Progression", emoji: "⭐", label: "Niveau 5", desc: "Atteins le niveau 5.", test: (c) => c.level >= 5, prog: (c) => ({ cur: c.level, target: 5, unit: "" }) },
  { id: "lvl15", cat: "Progression", emoji: "🌟", label: "Niveau 15", desc: "Atteins le niveau 15.", test: (c) => c.level >= 15, prog: (c) => ({ cur: c.level, target: 15, unit: "" }) },
  { id: "pr1", cat: "Progression", emoji: "🏆", label: "Premier record", desc: "Bats ton premier record personnel (PR).", test: (c) => c.prCount >= 1, prog: (c) => ({ cur: c.prCount, target: 1, unit: "" }) },
  { id: "pr10", cat: "Progression", emoji: "👑", label: "Briseur de records", desc: "Enregistre 10 records personnels.", test: (c) => c.prCount >= 10, prog: (c) => ({ cur: c.prCount, target: 10, unit: "" }) },
  { id: "vol5k", cat: "Progression", emoji: "🐘", label: "5 tonnes", desc: "Soulève 5000 kg de volume dans une seule séance.", test: (c) => c.maxVolume >= 5000, prog: (c) => ({ cur: Math.round(c.maxVolume), target: 5000, unit: " kg" }) },
  { id: "explorer", cat: "Progression", emoji: "🧭", label: "Explorateur", desc: "Travaille 8 exercices différents.", test: (c) => c.distinctEx >= 8, prog: (c) => ({ cur: c.distinctEx, target: 8, unit: "" }) },
  // Force relative au poids de corps
  { id: "bench1x", cat: "Force relative", emoji: "🛏️", label: "Couché = ton poids", desc: "Développé couché à 1× ton poids de corps (1RM estimé).", test: (c) => c.rel("bench") >= 1, prog: (c) => ({ cur: c.lift("bench"), target: Math.round(c.bw), unit: " kg" }) },
  { id: "squat15", cat: "Force relative", emoji: "🦵", label: "Squat 1,5×", desc: "Squat à 1,5× ton poids de corps (1RM estimé).", test: (c) => c.rel("squat") >= 1.5, prog: (c) => ({ cur: c.lift("squat"), target: Math.round(c.bw * 1.5), unit: " kg" }) },
  { id: "dead2x", cat: "Force relative", emoji: "🪨", label: "Terre 2×", desc: "Soulevé de terre à 2× ton poids de corps (1RM estimé).", test: (c) => c.rel("deadlift") >= 2, prog: (c) => ({ cur: c.lift("deadlift"), target: Math.round(c.bw * 2), unit: " kg" }) },
  { id: "ohp075", cat: "Force relative", emoji: "🏗️", label: "Militaire 0,75×", desc: "Développé militaire à 0,75× ton poids de corps (1RM estimé).", test: (c) => c.rel("ohp") >= 0.75, prog: (c) => ({ cur: c.lift("ohp"), target: Math.round(c.bw * 0.75), unit: " kg" }) },
  // Calisthénie
  { id: "firstPull", cat: "Calisthénie", emoji: "🧗", label: "Première figure", desc: "Réussis ta première traction (calisthénie).", test: (c) => c.reps("pullup") >= 1, prog: (c) => ({ cur: c.reps("pullup"), target: 1, unit: " rep" }) },
  { id: "pull10", cat: "Calisthénie", emoji: "🚀", label: "10 tractions", desc: "10 tractions sur une même série.", test: (c) => c.reps("pullup") >= 10, prog: (c) => ({ cur: c.reps("pullup"), target: 10, unit: " reps" }) },
  { id: "pull20", cat: "Calisthénie", emoji: "🦅", label: "20 tractions", desc: "20 tractions sur une même série.", test: (c) => c.reps("pullup") >= 20, prog: (c) => ({ cur: c.reps("pullup"), target: 20, unit: " reps" }) },
  { id: "dips20", cat: "Calisthénie", emoji: "💠", label: "20 dips", desc: "20 dips sur une même série.", test: (c) => c.reps("dips") >= 20, prog: (c) => ({ cur: c.reps("dips"), target: 20, unit: " reps" }) },
  { id: "push40", cat: "Calisthénie", emoji: "⊟", label: "40 pompes", desc: "40 pompes sur une même série.", test: (c) => c.reps("pushup") >= 40, prog: (c) => ({ cur: c.reps("pushup"), target: 40, unit: " reps" }) },
  { id: "plank3", cat: "Calisthénie", emoji: "🧘", label: "Gainage 3 min", desc: "Tiens un gainage de 180 secondes.", test: (c) => c.secs("plank") >= 180, prog: (c) => ({ cur: c.secs("plank"), target: 180, unit: " s" }) },
];

function StreakBadges({ history, levelInfo, prs, lifts, bw }) {
  const [sel, setSel] = useState(null);
  const ctx = useMemo(() => {
    const s = computeStreak(history);
    let maxVolume = 0; const exSet = new Set();
    const maxReps = {}; const maxSecs = {};
    history.forEach((se) => {
      let v = 0;
      se.exercises?.forEach((e) => {
        exSet.add(e.key);
        e.sets.forEach((st) => {
          v += (Number(st.weight) || 0) * (Number(st.reps) || 0);
          const r = Number(st.reps) || 0; if (r > (maxReps[e.key] || 0)) maxReps[e.key] = r;
          const sc = Number(st.secs) || 0; if (sc > (maxSecs[e.key] || 0)) maxSecs[e.key] = sc;
        });
      });
      if (v > maxVolume) maxVolume = v;
    });
    const lift = (k) => Number(lifts?.[k]?.best1RM) || 0;
    return {
      ...s, level: levelInfo?.level || 0, prCount: Object.keys(prs || {}).length,
      maxVolume, distinctEx: exSet.size, bw: Number(bw) || 0,
      lift, rel: (k) => (Number(bw) > 0 ? lift(k) / Number(bw) : 0),
      reps: (k) => maxReps[k] || 0, secs: (k) => maxSecs[k] || 0,
    };
  }, [history, levelInfo, prs, lifts, bw]);

  const earned = BADGES.filter((b) => b.test(ctx));
  const cats = [...new Set(BADGES.map((b) => b.cat))];
  const selBadge = BADGES.find((b) => b.id === sel);

  return (
    <>
      <section style={S.card}>
        <div style={S.cardTitle}>Régularité</div>
        <div style={{ display: "flex", gap: 10, marginTop: 10, textAlign: "center" }}>
          <div style={{ flex: 1, background: "var(--inner,#10151d)", borderRadius: 12, padding: "12px 6px" }}>
            <div style={{ fontSize: 26, fontWeight: 900, color: "var(--accent-glow,#ff5c8a)" }}>🔥 {ctx.current}</div>
            <div style={{ fontSize: 11, opacity: 0.6 }}>semaines d'affilée</div>
          </div>
          <div style={{ flex: 1, background: "var(--inner,#10151d)", borderRadius: 12, padding: "12px 6px" }}>
            <div style={{ fontSize: 26, fontWeight: 900 }}>{ctx.weekCount}</div>
            <div style={{ fontSize: 11, opacity: 0.6 }}>séances / 7 j</div>
          </div>
          <div style={{ flex: 1, background: "var(--inner,#10151d)", borderRadius: 12, padding: "12px 6px" }}>
            <div style={{ fontSize: 26, fontWeight: 900 }}>{ctx.best}</div>
            <div style={{ fontSize: 11, opacity: 0.6 }}>record streak</div>
          </div>
        </div>
      </section>

      <section style={S.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div style={S.cardTitle}>Badges</div>
          <div style={{ fontSize: 12, opacity: 0.55 }}>{earned.length}/{BADGES.length}</div>
        </div>

        {selBadge && (() => {
          const got = selBadge.test(ctx); const p = selBadge.prog ? selBadge.prog(ctx) : null;
          const pct = p && p.target ? Math.min(100, Math.round((p.cur / p.target) * 100)) : (got ? 100 : 0);
          return (
            <div style={{ marginTop: 12, padding: 14, borderRadius: 12, background: "var(--inner,#10151d)", border: `1px solid ${got ? "var(--accent,#e0245e)" : "var(--card-border,#2a3038)"}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ fontSize: 30, filter: got ? "none" : "grayscale(1)", opacity: got ? 1 : 0.6 }}>{selBadge.emoji}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 800, fontSize: 15 }}>{selBadge.label} {got && <span style={{ color: "#4ade80" }}>✓</span>}</div>
                  <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>{selBadge.desc}</div>
                </div>
              </div>
              {p && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ height: 8, borderRadius: 99, background: "var(--card,#141921)", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${pct}%`, background: got ? "#4ade80" : "var(--accent,#e0245e)", transition: ".3s" }} />
                  </div>
                  <div style={{ fontSize: 11.5, opacity: 0.65, marginTop: 5, textAlign: "right" }}>{Math.round(p.cur)}{p.unit} / {p.target}{p.unit}</div>
                </div>
              )}
            </div>
          );
        })()}

        {cats.map((cat) => (
          <div key={cat} style={{ marginTop: 14 }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, opacity: 0.5, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>{cat}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
              {BADGES.filter((b) => b.cat === cat).map((b) => {
                const got = b.test(ctx); const isSel = sel === b.id;
                return (
                  <button key={b.id} onClick={() => setSel(isSel ? null : b.id)} style={{
                    textAlign: "center", padding: "10px 4px", borderRadius: 12, cursor: "pointer",
                    background: got ? "var(--inner,#10151d)" : "transparent",
                    border: isSel ? "2px solid var(--accent-glow,#ff5c8a)" : got ? "1px solid var(--accent,#e0245e)" : "1px dashed var(--card-border,#2a3038)",
                    opacity: got ? 1 : 0.45, color: "var(--text,#e8ecf2)",
                  }}>
                    <div style={{ fontSize: 24, filter: got ? "none" : "grayscale(1)" }}>{b.emoji}</div>
                    <div style={{ fontSize: 9.5, fontWeight: 700, marginTop: 4, lineHeight: 1.2 }}>{b.label}</div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <div style={{ fontSize: 11, opacity: 0.45, marginTop: 12, textAlign: "center" }}>Touche un badge pour voir comment le débloquer et ta progression.</div>
      </section>
    </>
  );
}


function Profil({ sub, setSub, overall, muscleScores, loggedCount, history, cardio, levelInfo, totalXp, xpNow, bw, profile, setProfile, lifts, prs, dataTabProps, onResetOnboarding, account, setAccount, focusSessionId, onFocusHandled, flash }) {
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
          <StreakBadges history={history} levelInfo={levelInfo} prs={prs} lifts={lifts} bw={bw} />
        </>
      )}
      {sub === "rangs" && <RanksTab muscleScores={muscleScores} bw={bw} />}
      {sub === "historique" && <History history={history} bw={bw} profile={profile} routines={[]} lifts={lifts} prs={prs} onClear={dataTabProps.onClearHistory} onDeleteSession={dataTabProps.onDeleteSession} onUpdateSession={dataTabProps.onUpdateSession} focusSessionId={focusSessionId} onFocusHandled={onFocusHandled} flash={flash} />}
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
function ExoByMuscle({ lifts, prs, bw, setBestLift, setPR, progressionFor, exoCount, weightHistoryFor, onGoToSession, flash }) {
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
            <div style={{ marginTop: 14 }}><div style={S.miniLabel}>Progression du 1RM estimé</div><div style={{ marginTop: 6 }}><ProgressChart points={progressionFor(ex.key)} unit={ex.isTime ? "s" : "kg"} onGoToSession={onGoToSession} /></div></div>
            {!ex.isTime && <div style={{ marginTop: 14 }}><div style={S.miniLabel}>Charge max par séance (kg)</div><div style={{ marginTop: 6 }}><ProgressChart points={weightHistoryFor(ex.key)} unit="kg" onGoToSession={onGoToSession} /></div></div>}
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

function SessionLogger({ routine, lastSessionSets, prs, muscleScores, onFinish, onCancel }) {
  const [elapsed, setElapsed] = useState(0);            // chrono séance
  const [rest, setRest] = useState(0);                  // chrono repos restant
  const [restTotal, setRestTotal] = useState(0);
  const startRef = useRef(Date.now());
  const [data, setData] = useState(() =>
    routine.exercises.map((e) => {
      const ex = EX_BY_KEY[e.key];
      return { key: e.key, rest: e.rest || 90, note: "", sets: Array.from({ length: e.sets || 3 }, () => (ex.isTime ? { secs: "", done: false } : { weight: "", reps: String(e.targetReps || ""), done: false })) };
    })
  );
  const [openYt, setOpenYt] = useState({});   // { [exKey]: bool } lecteur vidéo ouvert
  const [pinned, setPinned] = useState({});   // { [exKey]: bool } priorité manuelle (override)

  // --- Priorité automatique : muscles en retard (sous la moyenne) = à travailler en priorité ---
  const laggingMuscles = useMemo(() => {
    if (!muscleScores) return new Set();
    const vals = MUSCLES.map((m) => muscleScores[m.key] || 0).filter((v) => v > 0);
    if (!vals.length) return new Set();
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    return new Set(MUSCLES.filter((m) => (muscleScores[m.key] || 0) < avg - 2).map((m) => m.key));
  }, [muscleScores]);
  const isPriority = (exKey) => {
    if (exKey in pinned) return pinned[exKey];
    return laggingMuscles.has(EX_BY_KEY[exKey]?.primary);
  };
  const togglePin = (exKey) => setPinned((p) => ({ ...p, [exKey]: !isPriority(exKey) }));

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
  // signal de fin de repos (vibration + bip)
  const prevRest = useRef(0);
  useEffect(() => {
    if (prevRest.current > 0 && rest === 0) {
      try { if (navigator.vibrate) navigator.vibrate([120, 60, 120]); } catch {}
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) {
          const ac = new Ctx(); const o = ac.createOscillator(); const g = ac.createGain();
          o.connect(g); g.connect(ac.destination); o.frequency.value = 880; o.type = "sine";
          g.gain.setValueAtTime(0.001, ac.currentTime);
          g.gain.exponentialRampToValueAtTime(0.25, ac.currentTime + 0.02);
          g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.35);
          o.start(); o.stop(ac.currentTime + 0.36);
          setTimeout(() => { try { ac.close(); } catch {} }, 600);
        }
      } catch {}
    }
    prevRest.current = rest;
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
  const removeSet = (ei, si) => setData((prev) => prev.map((ex, i) => i !== ei ? ex : { ...ex, sets: ex.sets.length > 1 ? ex.sets.filter((_, j) => j !== si) : ex.sets }));
  const setNote = (ei, val) => setData((prev) => prev.map((ex, i) => i !== ei ? ex : { ...ex, note: val }));
  const move = (ei, dir) => setData((prev) => {
    const j = ei + dir;
    if (j < 0 || j >= prev.length) return prev;
    const next = [...prev]; [next[ei], next[j]] = [next[j], next[ei]]; return next;
  });

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

        {(() => {
          const pris = data.filter((ex) => isPriority(ex.key));
          return pris.length ? (
            <div style={S.priSummary}>
              🎯 À prioriser aujourd'hui : <b>{pris.map((ex) => EX_BY_KEY[ex.key]?.name).join(", ")}</b>
              <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>Muscles en retard sur tes rangs — donne-leur le meilleur de ton énergie.</div>
            </div>
          ) : null;
        })()}

        <div style={{ display: "grid", gap: 12 }}>
          {data.map((ex, ei) => {
            const meta = EX_BY_KEY[ex.key];
            const last = lastSessionSets(ex.key);
            const sugg = !meta.isTime ? suggestNext(meta, last) : null;
            const pr = prs[ex.key];
            const pri = isPriority(ex.key);
            const auto = !(ex.key in pinned) && pri;
            return (
              <div key={ex.key} style={{ ...S.card, ...(pri ? S.cardPriority : {}) }}>
                {pri && (
                  <div style={S.priBanner}>
                    <span>🎯 Priorité{auto ? ` · ${muscleLabel(meta.primary)} en retard` : ""}</span>
                    <button style={S.priPin} onClick={() => togglePin(ex.key)}>{ex.key in pinned ? "retirer" : "épingler"}</button>
                  </div>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  {/* réordonnancement */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <button style={{ ...S.moveBtn, opacity: ei === 0 ? 0.3 : 1 }} disabled={ei === 0} onClick={() => move(ei, -1)}>▲</button>
                    <button style={{ ...S.moveBtn, opacity: ei === data.length - 1 ? 0.3 : 1 }} disabled={ei === data.length - 1} onClick={() => move(ei, 1)}>▼</button>
                  </div>
                  <div style={S.exoIcon}>{meta.icon}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontWeight: 700 }}>{meta.name}</span>
                      <span style={{ fontSize: 10, opacity: 0.45, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>n°{ei + 1}</span>
                    </div>
                    {last && <div style={{ fontSize: 11.5, opacity: 0.5 }}>Dernière fois : {last.filter(s=>s.weight&&s.reps).map((s) => `${s.weight}×${s.reps}`).join(", ") || "—"}</div>}
                  </div>
                  {/* priorité manuelle */}
                  <button title="Marquer en priorité" style={{ ...S.starBtn, ...(pri ? S.starOn : {}) }} onClick={() => togglePin(ex.key)}>{pri ? "★" : "☆"}</button>
                  {/* YouTube */}
                  <button title="Voir la technique sur YouTube" style={{ ...S.ytBtn, ...(openYt[ex.key] ? S.ytBtnOn : {}) }} onClick={() => setOpenYt((o) => ({ ...o, [ex.key]: !o[ex.key] }))}>▶ YT</button>
                </div>

                {/* lecteur YouTube intégré */}
                {openYt[ex.key] && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={S.ytWrap}>
                      <iframe style={S.ytFrame} src={ytSearchEmbed(meta.name)} title={`YouTube ${meta.name}`}
                        frameBorder="0" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
                    </div>
                    <a href={meta.yt || yt(meta.name)} target="_blank" rel="noopener noreferrer" style={S.ytLink}>Ouvrir dans YouTube ↗</a>
                  </div>
                )}

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
                        {ex.sets.length > 1 && <button title="Retirer cette série" style={S.delSetBtn} onClick={() => removeSet(ei, si)}>−</button>}
                      </div>
                    );
                  })}
                </div>
                <button style={{ ...S.btnGhost, marginTop: 8, fontSize: 12 }} onClick={() => addSet(ei)}>+ série</button>

                {/* commentaire de l'exercice */}
                <textarea value={ex.note} onChange={(e) => setNote(ei, e.target.value)} placeholder="📝 Note (sensations, réglage machine, douleur…)"
                  rows={ex.note ? 2 : 1} style={S.noteInput} />
              </div>
            );
          })}
        </div>

        <button style={{ ...S.btnPrimary, width: "100%", padding: 15, marginTop: 16, fontSize: 15 }}
          onClick={() => onFinish({ routineId: routine.id, name: routine.name, durationSec: elapsed, exercises: data.map((ex) => ({ key: ex.key, note: ex.note || "", sets: ex.sets.map(({ done, ...rest }) => rest) })) })}>
          ✓ Terminer la séance ({fmtTime(elapsed)})
        </button>
      </div>
    </div>
  );
}

/* --------------------------- HISTORIQUE ------------------------------- */
function History({ history, bw, profile, routines, lifts, prs, onClear, onDeleteSession, onUpdateSession, focusSessionId, onFocusHandled, flash }) {
  const volumeOf = (s) => { let v = 0; s.exercises.forEach((ex) => ex.sets.forEach((st) => { v += (Number(st.weight) || 0) * (Number(st.reps) || 0); })); return Math.round(v); };
  const prevSameName = (s, idx) => history.slice(idx + 1).find((h) => h.name === s.name && h.routineId === s.routineId);
  const [openId, setOpenId] = useState(null);
  const [editing, setEditing] = useState(null); // session en cours d'édition (copie)

  const startEdit = (s) => setEditing(JSON.parse(JSON.stringify(s)));

  // Arrivée depuis un graphe : ouvrir + éditer directement la séance ciblée
  useEffect(() => {
    if (!focusSessionId) return;
    const s = history.find((h) => h.id === focusSessionId);
    if (s) { setOpenId(focusSessionId); setEditing(JSON.parse(JSON.stringify(s))); }
    onFocusHandled?.();
  }, [focusSessionId]);

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
                          {ex.note && <div style={{ fontSize: 12.5, opacity: 0.75, fontStyle: "italic", paddingLeft: 36, marginTop: 4, color: "#8fe0b0" }}>📝 {ex.note}</div>}
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
  moveBtn: { width: 24, height: 18, borderRadius: 5, border: "1px solid #2a313d", background: "#1c2230", color: "#cdd4de", fontSize: 9, fontWeight: 700, cursor: "pointer", lineHeight: 1, padding: 0, display: "flex", alignItems: "center", justifyContent: "center" },
  ytBtn: { background: "#1c2230", border: "1px solid #2a313d", color: "#ff6b6b", borderRadius: 8, padding: "6px 9px", fontSize: 12, fontWeight: 800, cursor: "pointer", flexShrink: 0, letterSpacing: 0.3 },
  ytBtnOn: { background: "#ff0000", borderColor: "#ff0000", color: "#fff" },
  ytWrap: { position: "relative", width: "100%", paddingTop: "56.25%", borderRadius: 10, overflow: "hidden", background: "#000", border: "1px solid #232833" },
  ytFrame: { position: "absolute", inset: 0, width: "100%", height: "100%", border: "none" },
  ytLink: { display: "inline-block", marginTop: 6, fontSize: 12, color: "#5ce0e0", textDecoration: "none", fontWeight: 600 },
  delSetBtn: { width: 30, height: 30, borderRadius: 8, border: "1px solid #3a2730", background: "#231318", color: "#ff6b6b", fontSize: 20, fontWeight: 800, cursor: "pointer", flexShrink: 0, lineHeight: 1 },
  noteInput: { width: "100%", boxSizing: "border-box", marginTop: 8, background: "#0e1218", border: "1px solid #2a313d", borderRadius: 8, padding: "8px 10px", color: "#cdd4de", fontSize: 13, outline: "none", resize: "vertical", fontFamily: "inherit", lineHeight: 1.4 },
  cardPriority: { borderColor: "#e8b13a", boxShadow: "0 0 0 1px #e8b13a, 0 0 18px rgba(232,177,58,.18)" },
  priBanner: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, background: "#1f1c10", border: "1px solid #5a4a1a", borderRadius: 8, padding: "5px 10px", marginBottom: 10, fontSize: 12, fontWeight: 700, color: "#f4d03f" },
  priPin: { background: "transparent", border: "1px solid #5a4a1a", color: "#f4d03f", borderRadius: 6, padding: "2px 8px", fontSize: 11, fontWeight: 600, cursor: "pointer" },
  priSummary: { background: "#1f1c10", border: "1px solid #5a4a1a", borderRadius: 10, padding: "10px 12px", marginBottom: 12, fontSize: 13, color: "#f4d03f", lineHeight: 1.4 },
  starBtn: { background: "transparent", border: "none", color: "#3a3f4a", fontSize: 20, cursor: "pointer", flexShrink: 0, lineHeight: 1, padding: 2 },
  starOn: { color: "#e8b13a" },
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
