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
const SYNC_KEYS = ["apex_profile","apex_lifts","apex_routines","apex_history","apex_prs","apex_xp","apex_cardio","apex_onboarded","apex_measures","apex_exphotos","apex_exvids"];

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

/* Fusion NON destructive des données locales et cloud.
   - Listes "journal" (séances créées, historique, cardio, mesures) : fusionnées par id/date,
     donc une séance créée n'est JAMAIS supprimée par une synchro ou une mise à jour.
   - Dictionnaires (lifts, prs, xp, photos) : union des clés, la version la plus récente l'emporte en cas de conflit.
   - Profil : version la plus récente. */
function unionBy(a, b, preferB) {
  const map = new Map();
  const keyOf = (x) => (x && (x.id != null ? x.id : (x.date != null ? x.date : null)));
  const extra = [];
  for (const side of [preferB ? a : b, preferB ? b : a]) {
    if (!Array.isArray(side)) continue;
    for (const x of side) { const k = keyOf(x); if (k != null) map.set(k, x); else if (x) extra.push(x); }
  }
  return [...map.values(), ...extra];
}
function mergeBundles(localB, cloudB, cloudNewer) {
  localB = localB || {}; cloudB = cloudB || {};
  const mergeObj = (lo, co) => {
    const l = (lo && typeof lo === "object" && !Array.isArray(lo)) ? lo : {};
    const c = (co && typeof co === "object" && !Array.isArray(co)) ? co : {};
    return cloudNewer ? { ...l, ...c } : { ...c, ...l };
  };
  const out = {};
  for (const k of SYNC_KEYS) {
    const lv = localB[k], cv = cloudB[k];
    if (k === "apex_routines" || k === "apex_history" || k === "apex_cardio" || k === "apex_measures") {
      out[k] = unionBy(lv, cv, cloudNewer);
    } else if (k === "apex_lifts" || k === "apex_prs" || k === "apex_xp" || k === "apex_exphotos" || k === "apex_exvids") {
      out[k] = mergeObj(lv, cv);
    } else if (k === "apex_onboarded") {
      out[k] = !!(lv || cv);
    } else { // apex_profile : la plus récente
      out[k] = cloudNewer ? (cv !== undefined ? cv : lv) : (lv !== undefined ? lv : cv);
    }
  }
  return out;
}

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
  { key: "fer",      label: "Fer",      color: "#6f757e", glow: "#9aa0a8",
    motto: "Le début du chemin. Chaque victoire te rend plus fort." },
  { key: "bronze",   label: "Bronze",   color: "#a9682f", glow: "#e0913f",
    motto: "Tu apprends. Tu progresses. Tu te bats." },
  { key: "argent",   label: "Argent",   color: "#9ca3af", glow: "#dbe2ea",
    motto: "Ta régularité te fait monter. Continue." },
  { key: "or",       label: "Or",       color: "#c9a227", glow: "#ffd24a",
    motto: "Ton dévouement te place parmi les meilleurs." },
  { key: "platine",  label: "Platine",  color: "#14a48f", glow: "#5eead4",
    motto: "Régulier et constant. Tu te rapproches du sommet." },
  { key: "diamant",  label: "Diamant",  color: "#2f6fd0", glow: "#7fb2ff",
    motto: "Ta précision te distingue. Tu es parmi l'élite." },
  { key: "maitre",   label: "Maître",   color: "#d62828", glow: "#ff5c5c",
    motto: "Ton nom inspire respect et crée l'admiration." },
  { key: "elite",    label: "Élite",    color: "#6c4de6", glow: "#a68bff",
    motto: "Peu y parviennent. Toi, tu as dépassé tes limites. Tu es légende." },
  { key: "mythique", label: "Mythique", color: "#d6209c", glow: "#ff7ae0",
    motto: "Au sommet absolu. Inatteignable pour la plupart. Une légende parmi les légendes." },
];
function scoreToRank(score) {
  const s = Math.max(0, Math.min(0.9999, score));
  const perTier = 1 / TIERS.length;
  const tierIdx = Math.floor(s / perTier);
  const within = (s - tierIdx * perTier) / perTier;
  // Paliers : on entre dans un rang au niveau 1 (le plus faible) et on grimpe
  // jusqu'au niveau 3 (le plus fort) avant de passer au rang supérieur.
  const sub = 1 + Math.floor(within * 3);
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

/* ------------------- ZONES MUSCULAIRES PRÉCISES ------------------------ */
/* Pour chaque exercice principal : la ou les portions exactes du muscle
   travaillées (anatomie). Affiché pendant la séance et dans les fiches. */
const ZONES = {
  // Pectoraux
  bench:      "Grand pectoral (faisceau sternal) · triceps chef latéral · deltoïde antérieur",
  bench_db:   "Grand pectoral (faisceau sternal) · plus grande amplitude d'étirement",
  incline:    "Grand pectoral — faisceau claviculaire (haut des pecs) · deltoïde antérieur",
  incline_db: "Grand pectoral — faisceau claviculaire (haut des pecs)",
  fly:        "Grand pectoral — faisceau sternal (isolation, étirement maximal)",
  pushup:     "Grand pectoral (sternal) · triceps · deltoïde antérieur · gainage",
  // Dos
  deadlift:   "Érecteurs du rachis · grand dorsal (isométrie) · trapèzes · chaîne postérieure",
  rdl:        "Ischio-jambiers (chef long du biceps fémoral, semi-tendineux) · grand fessier",
  pullup:     "Grand dorsal (fibres externes, largeur) · grand rond · biceps",
  chinup:     "Grand dorsal (fibres basses) · biceps brachial (fort recrutement)",
  latpull:    "Grand dorsal (fibres externes, largeur) · grand rond",
  row:        "Grand dorsal (épaisseur) · trapèzes moyens · rhomboïdes",
  row_db:     "Grand dorsal (épaisseur, unilatéral) · trapèzes moyens · rhomboïdes",
  row_cable:  "Grand dorsal (fibres médianes) · rhomboïdes · trapèzes moyens",
  facepull:   "Deltoïde postérieur · trapèzes moyens/inférieurs · rotateurs externes",
  shrug:      "Trapèzes supérieurs (élévation scapulaire)",
  // Épaules
  ohp:        "Deltoïde antérieur & moyen · triceps chef long · trapèzes supérieurs",
  ohp_db:     "Deltoïde antérieur & moyen (stabilisation accrue)",
  latraise:   "Deltoïde moyen (isolation pure — largeur d'épaules)",
  reardelt:   "Deltoïde postérieur (isolation) · trapèzes moyens",
  // Biceps
  curl:       "Biceps brachial — chef court & long (supination complète)",
  curl_db:    "Biceps brachial — les deux chefs · rotation en supination",
  hammer:     "Brachial antérieur · long supinateur (épaisseur du bras) · biceps",
  preacher:   "Biceps brachial — chef court (pic du biceps, position raccourcie)",
  // Triceps
  dips:       "Triceps — chef latéral & médial · pectoral inférieur",
  triext:     "Triceps — chef latéral & médial (coudes le long du corps)",
  skullcrusher: "Triceps — chef long & latéral (étirement au-dessus de la tête)",
  overhead_tri: "Triceps — chef long (étirement maximal, bras au-dessus de la tête)",
  // Quadriceps
  squat:      "Quadriceps (vaste latéral, droit fémoral) · grand fessier · adducteurs",
  frontsquat: "Quadriceps — vaste médial & droit fémoral (buste vertical)",
  legpress:   "Quadriceps (vastes) · grand fessier — selon position des pieds",
  lunge:      "Quadriceps · grand fessier (unilatéral) · moyen fessier (stabilité)",
  legext:     "Quadriceps — droit fémoral & vastes (isolation pure)",
  hacksquat:  "Quadriceps — vaste latéral & médial (dos plaqué)",
  // Ischios
  legcurl:    "Ischio-jambiers — biceps fémoral chef court (flexion du genou)",
  legcurl_seated: "Ischio-jambiers — semi-tendineux & semi-membraneux (hanche fléchie)",
  // Fessiers
  hipthrust:  "Grand fessier (extension de hanche, contraction maximale en haut)",
  gluteridge: "Grand fessier (extension de hanche au sol)",
  abduction:  "Moyen & petit fessiers (abduction de hanche)",
  // Abdos
  plank:      "Transverse de l'abdomen · grand droit (gainage isométrique)",
  legraise:   "Grand droit — portion inférieure · fléchisseurs de hanche",
  crunch:     "Grand droit — portion supérieure (flexion du tronc)",
  // Mollets
  calf:       "Gastrocnémiens (jambes tendues — galbe du mollet)",
  calf_seated: "Soléaire (genoux fléchis — épaisseur du mollet)",
  calf_lecalfgpress: "Gastrocnémiens & soléaire (grande amplitude à la presse)",
};
/* Repli générique par muscle si l'exercice n'a pas de zone détaillée. */
const ZONE_FALLBACK = {
  pecs: "Grand pectoral", dos: "Grand dorsal · trapèzes · rhomboïdes",
  epaules: "Deltoïdes (antérieur / moyen / postérieur)", biceps: "Biceps brachial · brachial antérieur",
  triceps: "Triceps (chef long / latéral / médial)", quads: "Quadriceps (vastes · droit fémoral)",
  ischios: "Ischio-jambiers (biceps fémoral · semi-tendineux)", fessiers: "Grand / moyen fessiers",
  abdos: "Grand droit · obliques · transverse", mollets: "Gastrocnémiens · soléaire",
};
const zoneOf = (exKey) => ZONES[exKey] || ZONE_FALLBACK[EX_BY_KEY?.[exKey]?.primary] || null;

/* ---------------------- HELPERS VIDÉO YOUTUBE ------------------------- */
// Extrait l'ID vidéo depuis n'importe quel format d'URL YouTube (watch, youtu.be, shorts, embed).
function parseYtId(url) {
  if (!url) return null;
  const s = String(url).trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s; // ID brut
  const m = s.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}
const ytEmbed = (id) => `https://www.youtube-nocookie.com/embed/${id}?rel=0&modestbranding=1`;
const ytWatch = (id) => `https://www.youtube.com/watch?v=${id}`;

/* -------------------------- EXERCISES --------------------------------- */
/* eliteRatio RELEVÉ (rangs plus durs) : la barre du sommet (Mythique) est
   maintenant un niveau de compétiteur confirmé. yt = recherche YouTube. */
const yt = (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q + " technique musculation")}`;
// Lecteur YouTube intégrable (résultats de recherche) pour regarder sans quitter l'app
const ytSearchEmbed = (q) => `https://www.youtube-nocookie.com/embed?listType=search&list=${encodeURIComponent(q + " technique musculation")}`;
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
  perle:   { label: "🤍 Perle (défaut)", bg: "#f5f6fa", card: "#ffffff", accent: "#e0245e", accentGlow: "#c81d51", light: true, grad: "linear-gradient(180deg, #fafbfe 0%, #eef0f6 100%)" },
  nuit:    { label: "Nuit", bg: "#0d1015", card: "#141921", accent: "#e0245e", accentGlow: "#ff5c8a" },
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
  const t = THEMES[key] || THEMES.perle;
  const root = document.documentElement.style;
  root.setProperty("--bg", t.bg);
  root.setProperty("--card", t.card);
  root.setProperty("--accent", t.accent);
  root.setProperty("--accent-glow", t.accentGlow);
  root.setProperty("--text", t.light ? "#1c2230" : "#e8ecf2");
  root.setProperty("--card-border", t.light ? "#e4e7ef" : "#1f2530");
  root.setProperty("--inner", t.light ? "#f4f6fa" : "#10151d");
  // Variables étendues (permettent aux thèmes clairs d'être VRAIMENT clairs partout)
  root.setProperty("--border", t.light ? "#d8dce6" : "#2a313d");       // bordures inputs/boutons
  root.setProperty("--field", t.light ? "#ffffff" : "#0e1218");        // fond des champs
  root.setProperty("--ghost", t.light ? "#eceef5" : "#1c2230");        // boutons secondaires / chips
  root.setProperty("--muted", t.light ? "#5a6272" : "#cdd4de");        // texte secondaire
  root.setProperty("--muted-2", t.light ? "#8a92a4" : "#8a92a0");      // texte tertiaire (onglets)
  root.setProperty("--shadow", t.light ? "0 1px 3px rgba(20,26,40,.08), 0 6px 18px rgba(20,26,40,.06)" : "none");
  root.setProperty("--header-grad", t.light
    ? `linear-gradient(180deg, ${t.bg} 70%, rgba(245,246,250,0))`
    : `linear-gradient(180deg, ${t.bg} 70%, rgba(13,16,21,0))`);
  root.setProperty("--sheet", t.light ? "#fafbfe" : "#0d1015");        // fond du panneau de séance
  // couleurs sémantiques (validation, record, priorité) lisibles en clair comme en sombre
  root.setProperty("--ok-bg", t.light ? "rgba(38,150,88,.10)" : "#10201a");
  root.setProperty("--ok-text", t.light ? "#1d7a4a" : "#8fe0b0");
  root.setProperty("--ok-border", t.light ? "#bfe3cf" : "#1d3b2c");
  root.setProperty("--pr-bg", t.light ? "rgba(201,162,39,.12)" : "#1f1c10");
  root.setProperty("--pri-bg", t.light ? "rgba(232,177,58,.12)" : "#1f1c10");
  root.setProperty("--pri-text", t.light ? "#8a6a10" : "#f4d03f");
  root.setProperty("--pri-border", t.light ? "#e4cf94" : "#5a4a1a");
  try { document.body.style.background = t.grad || t.bg; } catch {}
  try { document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t.bg); } catch {}
}

// Lit un fichier image et renvoie un data URL compressé (pour le fond d'écran perso).
// On réduit la taille et la qualité pour ne pas saturer le stockage / la synchro.
function readImageCompressed(file, maxSize = 1280, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new window.Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", quality));
        } catch (e) { reject(e); }
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
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
const K = { profile: "apex_profile", lifts: "apex_lifts", routines: "apex_routines", history: "apex_history", prs: "apex_prs", xp: "apex_xp", cardio: "apex_cardio", onboarded: "apex_onboarded", exphotos: "apex_exphotos", exvids: "apex_exvids" };

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
// Vignette d'exercice : photo perso (image de profil) ou, à défaut, l'icône muscle.
// Si editable, on peut toucher pour prendre/choisir une photo (caméra ou galerie sur mobile).
function ExoThumb({ exKey, photo, size = 44, editable = false, onPhoto }) {
  const inputRef = useRef(null);
  const meta = EX_BY_KEY[exKey];
  const pick = async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try { const url = await readImageCompressed(f, 480, 0.72); onPhoto && onPhoto(exKey, url); } catch {}
  };
  return (
    <div onClick={editable ? () => inputRef.current && inputRef.current.click() : undefined}
         title={editable ? "Ajouter / changer la photo" : undefined}
         style={{ position: "relative", width: size, height: size, flexShrink: 0, cursor: editable ? "pointer" : "default", lineHeight: 0 }}>
      {photo ? (
        <div style={{ width: size, height: size, borderRadius: 12, overflow: "hidden", background: "#1c2230" }}>
          <img src={photo} alt={meta?.name || ""} draggable={false} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
        </div>
      ) : (
        <MuscleIcon muscles={meta?.muscles} size={size} />
      )}
      {editable && (
        <span style={{ position: "absolute", right: -4, bottom: -4, width: Math.max(16, size * 0.42), height: Math.max(16, size * 0.42),
                       borderRadius: "50%", background: "#e0245e", border: "2px solid #0d1015",
                       display: "flex", alignItems: "center", justifyContent: "center", fontSize: Math.max(9, size * 0.22), lineHeight: 1 }}>📷</span>
      )}
      {editable && <input ref={inputRef} type="file" accept="image/*" onChange={pick} style={{ display: "none" }} />}
    </div>
  );
}

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

/* Rang final (Mythique) : image fournie par l'utilisateur, optimisée
   en WebP 384px et encodée en base64 (aucun fichier d'asset à gérer). */

/* =======================================================================
   RankBadge — emblème de rang APEX (style démoniaque gradué)
   Rang final (Mythique) = démon complet ; plus le rang est bas, plus
   l'emblème est calme. Drop-in : mêmes props que l'ancien (score, size).
   N'utilise que scoreToRank() et TIERS, déjà présents dans App.jsx.
   ======================================================================= */
/* Emblèmes officiels des 9 rangs (fond détouré → rendu net sur thème clair ET sombre). */
const RANK_IMGS = {
  fer: "data:image/webp;base64,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",
  bronze: "data:image/webp;base64,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",
  argent: "data:image/webp;base64,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",
  or: "data:image/webp;base64,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",
  platine: "data:image/webp;base64,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",
  diamant: "data:image/webp;base64,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",
  maitre: "data:image/webp;base64,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",
  elite: "data:image/webp;base64,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",
  mythique: "data:image/webp;base64,UklGRtA1AABXRUJQVlA4WAoAAAAQAAAASQAArwAAQUxQSFcjAAABCYZt20ZCZV+/c/YfuPesENH/CWjDXHuttRirsveaK4xi7H1D7aKNAVQ93IcBFrhs9XXYgFpDNg05to0k/ZrSygOwJJtT0nxJ5pxvPpJkmFPJGAaiOiYkV8Zggh6KlpOBoG3bzOHP+ptOISImYKjMDL1I6URFDRZvqEsROlpVqWArHTosL64eKUpL6dNjk0qhoqhtI6lzPZc/Zi+CiAmYAN/7/x+SJP//qO6P1ysinVnVhe5qu9e2bVuHOtujPbJtn9m27X3b71H1bF92MZ0R8XoeRGRkzUTEBHjbtm2R3GbbF7ifZ2FXV3c1wzBoSCNmMgksBc2OYzsOGsK8XOHEYebEcDkyM3PMtmzJFtjyWDijQQ2oe2aaqaqr6jw/GK7liogJyKAk6E9okq/dlztaq8UmjrkATgTjzizlXShzJdFk8ybZhWn5ZUtSLQQv7tROgKCCO4LjEFVZ5GWax4toRInVHBl38ioIpQg2Q2PA2X05rUGdsw1uGsK7O1HFtSJwqqJvQbJBCcBduqXZ5iiXZdNoupq1F5BTTnTiBQJCbE/ASsLSYsYEqal+YZZxT+L31DfSiA8rAEZ3OAdODW9KIP6QK7fSaUcOL4pxw/RiRandEUWAOOYmolBEcElAVyO6snRFONokxXo6RSptwkK9uriv5e4Io+DENbybIEDcaCIjJk3VOEibwfRqh3iyUpkpaqo3YXQ47o6JlXYP8BfG7wFizBl6LUypQOo0d6pfRYqhXM05WiBAKmlumzsGqeuhetV7UBAEmhtELSJCXiPlhgImZXJpmkWo6436tIRkY9a20A45bvSAjvdtzgF/ItwcqMw1B4pG3m4Cj8JHq0a3G2wWVJllZa8ewYzy0zIkYJh2BvJicD2g2ZY3addCMyGmOw2Eq0vN9iUZUq0TSni4vTlcb7VUhlAg2i9qG/kQ7en89IYuU6ZF+ENizKMpgXlX5jAN1Wb1fL4uKi1SznEY2Xt0SVHkhYtg9yuK9Ki3COUIJzJDwvicr6ETqNhCs3eFPFwrO4I7peYty0RFDyZFmxhJgr9nM213KsTeWPhID4eL7Dk/246znDJqJl9VURNNIvXKjtQQGlwFAN7GFp8LaUWwGuY1QEn458a752x7FFpMMrd9IjEX1vN83U68t2lQIY1GpckDpwtCs8LK4+aiAbHgqfjq+UjKCGXKVBVEkTO/UuOuCcBwtEsp73DKqzD4PthWvTF4bJUBMdpblaWYigUQeXsuU+VFkSRrTlBvxFy9as5bVFSkXKt3ZN/flnDBoR9CGhxEu02q6rza553TVX+XxzL9oQM1iqlsBHXd8HcYwYSgNMsZIWIg0BLLu2EneRDnclZausGqE7caG76i5cZyg7fILdcNbYLckGemad5gWKoInoTAWI1bJXhDiUhLuOKGLCniZVc0+ebOwXw8VL1PCza1S2rSa8bFPBetUNKb1an8FIBTo1AQtVRmqiBMz1iyQeuGUi/MGrKqVFrP8rk9PE+6lCwRjHctLF9zOGAkixzJBpaWQyhNQIgpt1pWi6Y3ccUIsJEMJ4Zi+OvEoRuVVgX1cHTc7Y/jdtQ60cyccDSxwGktliOnGgkvBRBaZEFLSOT8DbaoSCKkkOhTpWCmJuByaTkDSEd2fGNihxtEakcgGHfy3RFBFBnF/5EAjuBTNIfpHh22nWyVo6rPyddkicFbW0ChzI93EoRCZm9dbb/KgicA+/hinT225cuBXawtiEAits+Tq3rVAjSZl2SvLhACWQrozXVNUzUlX+woZs+Ie2y0i80l8NSY0egZujRXSElh4nQGRJSTQe6PeEmnD+cJgUX7dchepWZV67GT1TOFGcENNQ2BnwVQSGGyUNWb1FOGRstybGlU9YqpmJKy3ueCihFmRYWGqMmFkaMBYV4aTh+t53bQQESoStQc9DDPnKUW0xBUMwtAHAAqpjTLo91zeWIGZMvTE6/4K9fX96MdgEAIMG/zHBcUKUMZsc5azbhDAdsgAMymvKDmzGjaH/MZIX2ZT6xUthsRO8upLMs1khVjzV6q8/J8BWYN4AM4qlVSq8ONGYT0F7GwPRkQL63sN3aYQBLyvGhsqsZno45yaD7UGm6D4O9qK/rFuhxWfZq7ZtbU48VarJY67RQAUR8vd4gz5nHX1PwLL1rafDocAnH/g/uSpZIY88vKm5GAT4RJn5CmrZu8vnHZdCtyrKvfnm+2MbW/dNSMZeSw6NUkv1KxQ1XhEKVnL4Y8s7Nzcmtjb7Mr+lcY7+W4/74TlWSTVLV0waKkIhOdL4JVJm0Tc6LuC67x8ro0x71cObFvk2Cl01vx5wab65W2esXwBRopPx0MBRJdflgVMneCMArNHng6XHMSIU+5QruZd0j1Scay61s1w6cJ/iRzKvla5myQKQqnG9JTHUZdK2cCi+oRg8PKtwnE64rg8VWyYt1Ne/G+jhNdKs9klkBLpgs+TcP/u3k35TcU0afy0AQyYgNIkbFr06tJU9Ew8TcXCxCED2Q7Irxp6q7id6TybKA8K/L3UZi/30RLWBxOiLzSuhFcpZR2BHyb4YgeENoMx/prCpTs5BuoVHN9kG8MJ65SZGz+283YlJCUgQYNQ+GCHdcOrXWcpon7HA4yIlUlDSZrUQsVQDh1uisrmlBeEAgoObodtf6zTZnQnsi0lB2nHKzYeK5D2c59r1CcRHG5d7tHUt3sWhejbKw93CAwU3DmvTUoa+yyTAXeMyvHm/v0Yef2lqOso+vxnGH6RbXWH9UqZaB1yqeWk0oYIwsclUMebWHP1dhUhsxjvtysgATq2Zn5YdNpSmD1daedYWz3sWkadgfzhBDBUO/qfWyUFjbt0oxgJqjG4V7PVykxudx1QjZoommApbFqVglr+1YbqJwDdp2xvMuzSGNENfBBxcLn7we0bmCUVYuQGbdPpez/6deNGTkZohsihAuhDLzgZBqwtwqaS8V0QxA9nOisTc7+y340Cwh/MzQ9JR8NN0xopCaXMoCI8gqEO+E+td3N4sDMDGN7ho8bVi3ODhmNLCojMbuMmqavR0tkDqLZAOyu2vUG6kR1CcSVCAC2npZjUqK8JEdTbnWaleGkvK+tiWleruc9hOn9bQGEMEOqq0KFCmariWJdxqaAk0PxszW/U1MIeT/L1n1HgMPKTWZL1QodbxWMQuN0Snm6ud8qcj/Fe9qE//tLWKiSFyOwaWEmmx0b1nWuAonl36SyEhq2NpAS9zgSAI7ykJS3COWMc5dABtTehc6p+cG5QOmb1igtz4+hKBIXrgkyuy/JDg8oNAZzZIl4ff5d9eiJLzk9cFbGFs5iZQLTw3a1w2NL3Kpg4pnVnoMqctx1kd63BqSeBDg3B1Grz4z3OI8rgyAfPJyulDTRPnB4ZM+nfK6B5cCwuVs+NVMTOIhT7Md9ZrT7/9cNszIwzGWPRryainI5OfBRGJkKTNjqE3/yb3DYmLtlHGMzcGDPb1QOBC3eaCQtALZ37xk+Y+tMZoQUgvvOz5/39SituexfbBelU4/W7Bm/2yKUAgdbd2VVkjh3JxpCjrm1nriyKoMDyauizM6p5XU/Q6UGFZ/eFo4e/ZJTUgoUkTO9GQcg8XILwT+wA4uHkFt/1IfbnM76U8Mfc5l5NRX4+bc+SfgHA+f73oQWBsAuRJigCum47gw+IfhuqjHMyJEpnT7Me866ti7zGUj2uj5ntgYCCSEK07RmMI3E0+5GCDMw8twa5U3Kvhu1AKwMXPL9roasJQCcWYf+1sLOszn+7wNdkIbc6K/yAKRluPiXV78MrUXlZIYkjY2J3R0rCX0/Y47LARfgzGORZUHg0hZkU3h+4Hu//LZREIXaBzPSUL3/jrp75IDzfo5QkQIQeG1x3eJMt0jj270kpEXuwSnt4sv3/eQ+VdNKheD1vTuSi77YNjEKK7rlYfOtMcIAq1Z3yoTw6fsf+5pPfu7/CdgMDM/du6C7p33g+m0QSmE689MbL23tLA/qyCsc+eXverY/M1GlMAP1U0oVrCO0+fbPn334Zohsk4LUdw7uhferV/0yxKwU/7j0yLhaueVfcpzlstoDftq6o9938ZkKN2Mhe7GhEQJjuPKrN7aHOBwNDrlt6vz5MoSNZ/spyaHFwDF1vPHWp6kDgGJh/+HoZ1UfOBVbavTEw3tKcNC6ZZ3ReAYIIwITTv76Q8uWMge9bZpGEG/hxD5CL1v3c0YACGxJ98p9yudjoLBHH7kq0VH9yWwZIqJXLB1NiHBLIhj54Rh6O22GD0xUAityLvftf0xw4Zrct7BVqLfCpnhnLD+sZ2sD5ejqaMamJtyH1YdVzFPRFV6c+HrmODmVwcZoGoBc55p9h9fvrlMuwEZiKnRIAMf8gFm2Q33GSs+2IRauVCBNbV8986yfpfygzu7rPlV4LBPyc3EKR3UukNnd/c+fTHICmSH8Peuc++sS2zNvGKyEW9CpJzUFaJhPgz2u32sF1akWMDKwsX/xgrcKDa1mt4DYaqFYmd68wtdBAMhoFx4/79g7pHiiv4cEhPkm3KP5T8S1NJTZgeLc7Td7kyv/nQ27tOSuh7zm5ETc6VtOpD1EZx1wOTiobd8dW9D2059Ui6x1bcuhF8OArABWaE/sfAdTz2T8/7zs9EkjnOjnBMoqjw3X/ktjRTkkAv7zAVBCAFlays9SvFs/XSyJPPXqnv0pjlKGAkb1l390566C4n+u9mWqbu3zSURUPGL8xf/rW855/6j9FIvHvb5d8F7ReMIuZl9+sLq0NEkwqVOHbWnVXziP3Ms2r3riW1AjWOyxzQDEM39yXQbUtuI2KnDUntuueiNbjhmlzL3HcHTBcAnmKk0GN/kd5FgJhYeePGdiQ7NDWMnlKGfu0AOPZALarQhRfL5fGwls86k9QvZ44fgzmQ3vMAIdjOZOqj8oUa/wrZWpO285sR2UOD4t6yEwHSYJAIoQhZmdqTQcvDt6aMZ2o2P7FPthDjdJcJwcTn715s14omfxZGj+Ls3PCCQ0hmsAcnEc58AoHPkHbgbAGVvlP1217plLkyTw92sJNv7BoWrMf8mzl6449MrK7NUfr+84n1MAHLYJQLUyAMwQhY2lyqkawuklhz0vd34p+JXijj9fNyGdfwEBgh2dg1LTl0a//0y6Tb7lI185JgAIZCf3oay+cRMBYf1bDFCzhjOozm9IPoObJr+543NPe/+auzP8DN7Tr87MfOzOzvJ4+IKfk8+maRUkgeZDOhjHL5pAzau3YRSLcFD92tN/XvjK41d9aV9qonR1XMI4QPhgZu7RJotNPXvrH0T7Ix8Zns3YEAVIKgUPHwqCMCz8G2BFlUm33DGREZs+abRIyXu+irqomCMEHPMkOvbJn/zPr937/l1zPJenpMh8BQSACEaPH9Mdh//1Lwoy4EB2vjKZyxVy03OnLj8fiR8DU4YPKuC8XI12Iz+UY7N7vyT1ifKd9y9fZ5QAAseipPmFNkj7Pjtx4eoYCJ+NL2javff4qgcve246XPju2u/sjc+e7cSMexnJ5R/cje/d1MapeH3L75QPFR5/YB5eBeBuGVxLiTq5/Z9w1TUCRagYeOCFoR3fuPEfly4eO4AzHvzozmsnA6ZQFyiMJ2/pOrwzYgXxqPRP5as+4OSTNWuKc5IVKRpGuucfGoX5ZuZJC8HUzhc57uoyjvyr7LQfPdvI/3jhJS7ACUmcQ6gK1lRxIV3wtydXrZXO2pv47ZftvNxCUDwlsuCw9ynJWUdYtMDEJb/dIYwfNNbOv9m7ZiS1eHj8jj1wgb3gUQjh/Ojvn/vPt7bVVn9l9/btu1buZzv/55wLk6IKcoxQEjzi3yI51F6II1+68ukrS6+NTu6YUmhycK44fs0ZIpNgbu7oHricVr5y+cevzZ0efvCmwDbW5N9z5zb0NOFkFdmSxuKTvT0BwCCg4V8/O1InWLmLdHXOvDpAP90OcLiNb+HGAhxmj15yBZE+G/D8+dKfGv6Fb35+PeDqR+8PH+3iee29oHBhB0STcO6s/8WqzrZtr0mnaaWjZNMEwAgufoYLsfPaoQhTS39//aM/OFccv/3KWHAZl5MQeH32Os/i/i1otMHxOStDnjE5IVJnSK5Nnl0ofDLUFdZ+/1tOUSy7yyJwzmmvPF8dXoOR65aOfKlwZqJJYqTeYNtwf3n3ws2rZwlmYALpk7/0BcBNQtvJjHZaEFddUZk4+4f7SeWp0Y8fZAguAmetLf96eZ6edlH2Ce28VUkDwKhJR27Z8fjq0VIHSYbGQc9r+/moRco5qtZoS6spW1+dn1528fMHE4EoslN/yEB00b45NgP2wFMNYv5C1zINVIaa2jjfN3j5yt4lBEK0RXk1cYBSVpZ82M/dg4Mzd37lsiOTP0kbH1bBeP9WXnIFMNANn//n5HnPlDKJM/BGqppVu71CInsocSU0KYy17z7W8ak2mbTq5LWKezAVuzsk/vuXi85cDu5KuPmm5UX3v4dBicuwMcHTFySK7XyXhIGACMGEtfumv6YYwGt4Ubg67oIAs8MdB6d7juxt6Zu5KASXUZRPjq1xQmibP+ISItDiSZXE//AbmKcuFm/bSAgg4rrP/FcPwIh526PXtNgCeOFgvbVYVN5+eSw+XuZMoIQN7fEreDOlcPf6T5i1Unn03tDRgokufsvxOLHNANhLuk8JCNOcu2zdNi4AYPkaf6r6VJ9xnWvPTHOLl/vPCOTTmbrLVyyuXZQ/MEUGilcO7Xl6i3+s80ZyJtoArwc/+i6LBpq8jt5SghBwwqJT8vqB1yfUPwysDriqOTC6VTm+373r8mpxLjO9RVByKWfjEqi5xEnrleTDa4fVdUwcatwAjMHi6A0kxAgzEQnY3Q9/eP1dX3y76BWg5mYDDa9lDi/6TLk2e1A2mxzjtflwwGV46rW5VTdZTV7VjyMC/3lpZIj5FqTbweFImB3r+MrmS2+/vR2UIdOKmbM+LFK98bx1T2uJRfWmGfXu7iPHQHn7FnT1fW3QqWSO/GP++P9DIx89FwSCgHc8v4pczP7ywEtgcAf7Roe2LOnzNVev3fg7DO8LqeLJr3dIZoQ7fEv3R1hiw6+7V7Fcyy7cLoOa60+8i1Scgds/y+kvvjkhcF7Prx2Ybj5a90M8e/l3TZw4frj/wC/19Y8VlhGyvKOX8s0zPwtDgZFdfYjAMCdGDIA7yHfedfVqBxec7yLSmHEveDC6xnrrrToPh759UELpnl9sO7r2i29d92UDHskE86z6qkvJ+8nKciJZRC0KALgbGDr5Kwh15ZuELp86pZ7+dO3YXc+DUMpzA2Di5LPzJ4e/tPT6D23gib5BMP7hfz3tzRDaY2tDDNIjDVBMvDcsDLg0fdufaSD+QmpTKP2jGiCo/YeJ8JLAOWn5094T5so3fT+C0nzIEcki/0cfBDTntFxDxiitIowOPxXnDK/88gjWpB6tLHz04efch4Ta8tQYi+7yRTlbdOn/cCwix79AsGT2sFsJHLxsGyPg8AGWooCxuuoykgl2uxYRU3/5LNQLDz/jFHlzW+m4QKPPb3ZoKrUwJDT9ZdhxETnaDbZKOfSvA/yRP3PrZ4GlCDccA+sTApc28Th6efX+E/fx3q0n5qLA5Wg4Eoq+nf6cSPxv9CRW5r6xUIIcO73Boto5t/zzP+SuZ61TRyRXL1zLRoA3RMWjHt5aGLp/ncs3t+c/1IDL+ut7G9vHT2wyqBOZijX1dCwfo1u2+X7T82oVZ0WGD5jL2lrZj6jMd+rOE7A6sKcDkObA2PivYGzV2lYLRsct92OTY7vLWRqU822tm6VdO29pi/1xTfyfjvzT8IwV2b8ioHmfThsH+DpYFqE6f+vUjZ9YDYGrMXf+1GqARO1goQkj9WqLtaZx5X2PYdR0jKvvWvGzwsKbCg9/l20MSM4myIJndROFkatmpV0fLvwEKAM4oGxHuMA69vn1laBRWcwXkq0TI1LX3Eu/fv3lcviGeq/11E/8fgRYh2s1Lls5/tljvo1t8rcOfdeXvm+Pg7H7tndSoRaYnyleSRhWDTF6WPYMHXA3XJ5uqQZenUnOKKGxreiuBdI7s4QpPM9uAwypk6W27cj/7oUSTn+oFrgkcBuMoVNnnJ5Flu4lUd+D/NRrwvGgXxfpZc/qzTw+pqcumjCE0Zxq5ZQo6yo48bXTcIX2mNgH6dtj17Y9dO0EGoacP7iDmi8ZEcp93qO+Z/Bhc0m3PnUReaJ9RVfR7uMzENRHwDm3uegAEV//YXruzPEO/XkW61n8y9z3FWfhjbehOp+4XkEsixveWJDHnX+3V3v4yhWZPQEtrDF5U3MvQpVhDG9NCmJe7SxvtuOnbfdF7lmzdl9zz674cKjX0pMNJtucFZX+wqLJTy1buapd0y/+cHrUZzz73/EAXL25mAMRf/3GdxOBVciLS6aqv+WXvNj0WXv4tNbx+rpH74JFLelTdIoU6ey4wLjaGPW3B49fsFV4qy6+6De/VgbisBVdpKWV3f9LBuY78MrShpurd553+9rBkXv+3JaKR88CVwG5dMGt5pjcf9bi7R1s3I2WT1c3NRzu3e1+FQxMcC4bqMrk5PEP/5BA0MwVzuaJoSs2/ctoPVG8O712ctUqMEL40A7MqelcM/VkXLjbEQb/7/RuTQQuO8X6xOdckQOEaOusG/57bf99EUG34xz7yp1Ru+m0e+b3DALhbmOStJ6MtQUnvSTcqoux3+jMw6UxHRHU64enmk4cBAPQ6F4pt1aaoxUEZEnodfN34JmJa8/5FWzrvz9PyFpMwqpEc7l5RaZtMT+PYUyOUmKuy969qXrsvZKVGuOnsFwlL1uxZ7fAlt/8xK29f3A8pVfCpK5QbZ2y1DCoR5VbEQhT81xvXRc9nicoedoWObAJh9fu32ETwNsIenfeC3GuuO6qnXAQOW6qCcWu91SF+5t6o5hqcjZqgkre3CAm6g7hivsszcU+XBOYegfw29jPQA6e87/LdzAZMAcgrNq+qj8kKDpUlMLJNs0GaLD7qOLLTYJFB+q4CPDkE4sc/7TN7Zmzb78bLmEsBrDuuqU01dL1Ut1HsiITsk+27LGzTrDgiKUCAPMYmKtaTtSVzuLMjY6VruEoTfRFYBqcPVF9K3WShMDt9GAKef3v0Uc0TTmfOExWACKHAOYLAJR2JkwtKZyGWUHqhwkR797c29DVLLJsQDicVH0B36i9ssQTlqIcri8MzsoGhilfkd6D8HM6GTL2yZ+3bM4BBazCbC8vJfu+kKyVbVo6esgLgIU3l2On2NTCDrh+t0ZpBoQxNy+/i7jG99wa/LG1P/i1OQCskjVXDU6slE+469bWBsQlT3yIKF7ZWsmSk+EEbCfnAlXJWw55l8j6Fs4zkHD74r4BAlgs3l455CZp4Omh0IE0XfnQgyhHscIjeUmv1o4dSpvO6FwEjKEyAQjzntdINQmq59x6g0JVlbO7+pok+SUeeHvS8NjHJPIEiTMJAeVXi4akAMz/KvXm+xVqA2AkshgxD45N/WePYiLhQNkfadGeH5+dbOhjsZMJU52pahY+ZePWn44LHEz2RcBw28IqwMT9fymCuZg93sqmwM2bLfUySh6ik4Z+Qi9W6ggyMCkzHAEEVLJ/JYzg+sNtmbPSMji3f4Ip2C7i8z4UMZOKTKYuoYuCSkN4a3aGJ55inFyacLq3c187wImH3H2MutTObsSW1v474gMTnn8eW+AQdDnbOTOz5tt4IRwwR8iI3ycuOb/oxkO6Uy1wPx3e1VB6ZiVcshSzNxAOmT3icah4d5WCmH9zaDN0ZvYnSuBwbUEqMXHSkjc900Bgerwk0p71CIrg9xs0O/zIrv1JCQRNXHRNAorHHU7f3qe5kIoc3TpEDnPTTY9aRDZttSqYWafpNdVXEXRvPTdbOllt0nRy8O3c3L6+2884GQBwYRO9+EUGhiNjEnmlJjPkbvo8We46IhttGPlO86/cN38zG885dS8NN5FXtSSfruoiwsfaoqD6Hftn306JW7WSK9QbrqmPHNrPbUwOkPpjhLn433vf4J+Fy3N96a97qo8/cMd/1T4ixMfCK+19xKsSX28yWQ+dUQsSnycx9r3h73zJ2Tgs2hL7gqcU+C0hSO7mhQHOVPvG3/pau5k87Wu7tHO7MO2HShc4swV/NPOiKs55gaTPajyxbHE5ojmNPjZx9yGnZXP8cc7jlzx+wcygQUIvDf23JInk6PdCu/7FhYPYeAeaXvnoR2ZLMmuozvJ1lX3Edlyekkm4tCsW7OURKrCGF2qz/a1sm+HcR/gXnn/7H0/Mcgmjzzd2RGj2C79NbcFs6YKZ36P59GuWTRGg2R8UPLXX2zN5VOSIR1m0f16fykQUV6Dj6U/0Nfz9Nxdc3HKKdG3/T1d+fHGu/565j9MtB5cOPXuWyiYuxVcgfaNtq+wSQJU9Pv7AnJcEnCqpEZn3az7h2Fsi0SR4zQNX3nX4d1pz2qav2JEPL7g8JXWvOcquWWX8qHoG0qvw19XfeTaWZIeAdGjWCX80Yzq9H63NiIZilI147aje5udes+WT2fyVN074aM1/PHuhc8XpUemjS/f2LFr2n5eXdZXt/pf331XjSHYBZlenJodHKkqvoKwpuqoR44UGaR5NLYGTHo81fIV/EvwBvQDlqzi27qLQoop8mTD50o+6+jNLal//SHP1TF6JAE0ulKfGT9UcVLO3y4JOqSkFbVUPxpAOrZjw0rYxIxqR8pM7QnM4rzKFZdvJ4PeW6iSJr+KrYCLy19euHRmbQTknCxvdt+OecN0JS3XTPbF+/XSg6biEw0ieeNjD2e2nxwVnA3t9focxqS/NbpflFwfFKDh51+j28criqVO+Glu7avON02M8RCcSxJU4r65LGNFlB1gQH3/8rapxZ1fYtYUzS+HLudbFbZ07vxT7Kni3adje1btU1yPFjo70i51CXBEI85jE6/MUemNcEYVSDvTsF/UHt5GNHn6+r7UZ4SCRK+TW5uX0OAjerUbnXHDoRM+SPW85CxAJNo4QDzwG6opPl/hABYGmFnzs0ILX10AGxO4GcFRyTxbTz105atS5AKAw9vWsWzHX9bxSgVRTpFqKunaf2aRbvlDICjfSAkeDoavLfJc+EuL+J6BMO3xT+L/Ln3/oJopp0JmJ0MbEXNoTYFVGcjWaiId4tMUqBtrjs7kzvQIRMdi+nqhLtmVgAC5Ai9FVnQULBfN1Q7fyCd/ohFSsCnUCi6LJst2ypjhuY4c69V+3DjEALoJB3bliGYEAQjG7ebah7eLYARipVWe1UDGQrfn0fDq05KB8olTPu37ZVBKGUiILT144f8WUE7wa2fdC8JP/RgBg/JixenpN4CIBEPCdEqmIaUdZEc+WMyFSZ7ZfhV+uU4HI2ULQHm1fGiUBAIFSx/vov+035Sjr7enN+0LB5TAyHzRqnkseKfoWrRMybhFyXKqz3HyoUvDQQl3Qli5PukMZwD7pEqf6rS/5yzIAw556/2mc4CisVhqnpdD8Um/DZJc2NpvuFsrRQqEm26rquP5ou5TrNLdvnjiAIOu0pJ3FfMWEMZqVXbYanLyozXe8EYBTD88XyrOVPPnUw7ttU4IeEcfhU33y0p6B1YiJI69oArOSVlnKQNQXg6gSIQU2cdpgf6h2XAznnODgnFnVZSHsroyI68708bR4fK8YtHvsio+gsHVEYAiGR4x2xyiuOnWPJkz69LwYFUZD1ao1c1hJtz/OOqPrSZ/dTqrjI71to17ZR98rmmNqqBHqE4q5Op1qjEwpMlOapGJhvqX5qDkCC1QXtpq1EDXbjbRpODWpqoZ5ATYNsHFnCmo8MqT3UD0935Qs6OHxtFnyEdRI8CtKVsxp/qmonFIdea5dKFIpzVHMzem2SCpR1pPWdEf65apnThGqUQsskMT7ZGOypRlznFNuya4UtoLyzhdxWqqxQJikGkbNtti9HjMDQkAChmLrlVJz9XZkQymLK2keDmsHphNkJanmVruqxXrPO446BcGBELrkw6RXqsXZgM+fTAkK8fIQ4Q7kKMqC6AAWWZO8Pm5QojgWjEJDROuoNHYwogiS6IScwB0y6w3VGCV1X2Pbn7Co1lSyPMw1AABWUDggUhIAALA5AJ0BKkoAsAA+gTCQR6UioaE33ByQoBAJbGf1jiTUNxbtThSEGoXl7fhzMW9fR1/aN2h5ofNj9I/oH/4D0rPVT/ufqAdMB/b7Vx4gfgPBPxxe3/2n90/Wjxx9a2o73h/x/PXvn+UeoFiV2CVsvQCszdTvvV7AH80/qPop/x/CS+7/772Bf6X/lv/J6mf1X+TPtu+pfYJ/Xf02PZp6Mn7SMl8tRuU229LRJraagsPxC7OMEgk0L2U+5yjkcUYVdda/7bUfbkwHT42XZtxAofOIXmCnLjnWrL4lIH7njrIBrmLetMSMrBZxurANFTbbLfo2vQHsXW/VN5vOauFGAWT5I3HFFcawmRHiXSkk+YwO/ZgUIruQC8DII6/MOWDZm5FHceJgvby4vRL9O7ZkVadPVoDgWZcNbhxwZ8Z3AJOuFvloOl5Uq9hyIZ6DDHDfoayvUBOB214+f22D2KfTWfgh4lC//BRDkcH3Rk9cu2QmQ0/OZcFs0Ur+fMgREVVWPNpG5K5JltH4lWK3Sgy5t7hz79Rpgu5vgdZmMXDGQzLQyg8hX6JOLHf75kDL4EFUa4mHaaUlUwKE08Rnph7HCaGnQ4/YYXO/wOiJs9bvCeDlp0B8bvNoAP7/fB/UAaZ1H8i9zp+SJ4KZN3wXBTkt5ZfszZP+XeI/+we9SGRBvffrN3bJsoEDRkt5Gk+UxVggh7ghudQOhQ8QEGRK0cLA2A4heYDpNwnJpZAspf9Mf4eeOIMX8Hb3z6ZE8KzYoJUh51opaO2h9V88BruhLT+RwSW87UNDl9rqVQl701vgoxFPZZvDDI56tH+RKUs2VDZyed3u4t/Da77e+aHsH7+fXVyY5UQ7+J1Fnl/SSIqjs/9sYDqp/KvdyGy6N9M7PIx2NBpbHRbJ8T7DN/iZsDLYp/GjtgH1PJN9O2GYxo+mUPkb/XZqnebe6ddgJpK9lltpWdpCmjx2krvVxBEVv71GqlYdl/IwrrTQ3nISAzc8mvfXxsehMINIQsxaA3k3m2LFXwgfqIgTfeaCxF8Xqtj96/kSZOnTw/3ThO8HUaUBJurMEVf5FFTd32LsN2kCfR12CUzCEqVl9s+dNyBXh1iCLUIcDEDmwpxGFCwOIeaK5IvJqf9MfUlW++g3mojr4lmvNiNMmXg9qJ5kBc7jzMI9f+B8MBYIVaeKJ0RPHz/bU/jtybkETkWS6meUUsOOo6zmJsx3UBO+d5oIspyYcj3SVXom4QBo8hNhYSFmZFIEcptN+6nArlq44SrwQ3/S3y6UOmqW8txnlNg+P5ptUpgQCxJu149+ntbFcgIjvWocHWEwSaRchmkhglw9Ke46X9QYfz9YqsieMM8b9og7IcltuE9EzCvgWJqEL/W0PiM3uJa9Fszao41nLQ1nY2HsMP3JyzSUHmZ1nMYgDFFk+mNwj6B2KY2JeEA0k8a8YOdZVuC/E4IgZftyNpd4AvrOCnLfIceQf2CljQb7CUIysBJdp/SGb2wS2tSiGWMIgW7hLf5HM4MEjx/nfFnG93eS2120CR5+xexg7eqSKt5EUAW2hVyBjzkwlj7Xsu4y9oIqulPUtjeWRpsGkG3eSCxwC201RRHyazHWVLdRNJsaXKu6ndNvtkvGivdRwmzUNegEJrE/QzHut9y95Z8EW26DXnFzp2PPxKzUPrtGayWsh8sGwlmTkZ2XJ9rzC5Eacgz/f076T9XdfiO7bamHsjBAL0M1hCckfJWiWonKRoPnoU3ZeCVshhjQv40EzxFQxJOCGbgdYySI4S6X0SvWNt58W8UVWFwAOi8giMhxLj4m8bVKHUzp1e1B+VJHi+U4dowBN72fNRNV1TxpHwWdlWlqpNbvk/NHiz6X1fs+ZMga9OzfNCOPZQQHGM/fJ7st59/MexwVXzqHTI+WszIH/zkezQKAYzJK/VGEq7Q6CS/ItTa+fsWutxxLV+aTRkqbMCtaM5q4984HHlGYeYhm+gZujmhsgytiba8PgDk1TaiHQdyoFKfnjrgkmUCcEroFViWa1/iRQYea42Xz5p6NfrLFJ7VbaOUTgBKnjGwOXixUwpr4OIL6g+ah5YamtP2bh4k+kbyex3bNBNlZnBOgpjPh2n5/5QxBOCFUKRDIvqEJ9GEN5wU4i7GHqFYcDvRKwfBBwfHScBZBbGmvOe6FjKdgheLWTnu0ocGpdTlLd3jUAW5t1YMsZGQIms3jQD03ZX/pY5Q0elvbzYmAKrC9Tf43re77eeSqNJaPAU/L0Ov0fwup9diYKDeyjcA360TgJDX4a1sHejhnMzXU/4KhDFff/oq355EcZAUI5Ong1cmGiBWLJZHtzgSnHdW73oIrvFGhUlQe+7Dd2E73j/hqQCaBsw2wlPPMs9RpUZkh9tRRBpm2dx2sZbPG/0ULVvyuRwrwGh0ME9sjGH3JwdYNS4pQ7X7PiTWTRl3zYQvGboknWZP/yASa3wR6BiKDSrRLelfuC5m6C5yh2CVsgobCUqA2x32D6wpnBUQyOy+m/eDbNRroviL4dWBNHaCpSiWlgvdVTaXoVP66qd0xsMphQwVXffcAyTjNIcgEi8JhWY/VzHthha0RB4HG6eVoEfdt4SqHZGWU/nX8Q0nIcqv81I1+85Q9ucHHE0vIBPwjJvqLZcxiyl2l3/KY55RYfo/8amH10raVOL+nZO9QSAlef310nBOvhv8Pc2/1YUGUBBu1AqFGjvT+c1O8cwpcU5ir7LLMoN0pdbeAnjJgXU6Ty5j1xTqglCrstPJ12N95LSACG2VZXBjmPexZ2govJNvycfxAYZllMUbUnN21PaAlvPY23FycB0PyoMKLHUVW3VpfVOsS9UUSEF2RSXUyHjho9BsgjJZVGfHh/E/ifH3R/W7U01ghPlQGcIve3K0XcMpLngP/0iTqw9mcwuVqWymh5q43ar7Tuh57H/FCTkgL2M+s79B3DZDHLv5aUYxz5a4aZ6V7kUQGJJ4bdne2Q7BjWSSUz2ikTDy93J4XvH6sln37oxuqrP16xOuCn513K7LW0Qf/Sn6eDfPL/nxc/MuQreevcBT+mZdgZOuOS0gMAwZorANnOl/SfD+aKw0grtpm3R73VRQOIgBooxivRX8iEB/OMaexZleqJUre22rVIVzIUnZ/AWOU+f09o7QsJ4AxVPUK28i336so4odzofKK9vl/nzCKp2i/APw5Rt4hPIUy9ORd0wLynMWA525zgSSz5rdsJ39WNPJWypuVhQdWUZy9oroL8SjuXCBSyVu9ihI0OQttSkyxbnjF3aClRKkypodiLbcMYrVibev8vnom3vxi7+SMP4aQxx/VsPe8oaktlsl5sQH4z5de18W+Bzcm43ceEBfZHhmnJrjfiT7xtlm+emv9wfJimplxIkBKK7/frVKIO+/90yMRT/kTiHs7j4rByCL/J6TI/6EbC2zIwaBS1MFuZiYviPiif+HdcBwUmR87I3G31nhg/jJkVabhfh/x59qfnujCYXwD9KbIms0Xy4NC8uOPqO8S2KnFEpc9DllIlfom8Y28jdgCzyQiCX4l39B4DD2tg7aeiKUGMhZMD5MfBjqNMkrnz3/tg/CFN2jwYYAgC62MDdAKegELYOxlLeEngGdKBqB/xGkecK9c5W35CRww3tsZqeZJw4IcXN5dZoNkdyq2Bcxf3JI2Sfx0asniiEMtpx5TsqLZ+2i3gvT1AWRh2+JV2sBz2gueRiy7K4hbC4At5uhfnmIA+xESymvkrywOTM+JzSWthqVnOvjz/OPnvvoRjM+rejE3nWlK8815qGQCCOGLHmwkMSbez1GupfOShbLr82Qfm55SkirDl8CLRnDImTBiffZqjMCtty5WQQcdmrmvhdBS+3RxIYsgwU0Po4G6Hlg/JUCrIooxXpSQAoBSkTPslQgnGXO3ullgw1FdndJl16aLA0xaAgKK5L5kHbWwD93SMOrw2KEpsQP+6qs2xdEIEZOZJOdBpf4iEPcZeQGb5nwiFYC6ST6NEZKqrdeIZNeOlwevey+Ya8AbA2G2Y4R375GfKaveK3zKi1QG0FCORkwUaa4glpZ4yFd9kIO9Ihbvvdt7DWeOJ2AhR8jcQvyFbc19rPcIxoVVapdlSh+TrckZAwW+CWCA1UkU1vCgWQr9o7cqg9oGAebt4H+HGGKWhDEN8yB0Q2rD5ipVtd6riTtZyQEDr80emc8nH9g2VQ90hmVzp33NdfvGLXJaAPT+Nk40A2L0e/oHkhd56JXr3uG5XG6gt2N3uKYwndqMHXizXmOSfvxCTRM8jLn0QusWxF0ve6Qf4LFP4TlRTbmBjG7IGUatEPgVKBJebYNHIkRqE+4q6/aRrMojrclyq30u/gMGdZNNvc7ZtjwmjJPsynWXrewutLntHk8CoZSXjT3238xZ1keSwXTUFkxEruVNmEv34yzXGmpi17nBd09yP/WdiLV1EIj3HDlgo0eiG6qpF/E6AbxhZYEp71WOm1DRo2TEgdK3yrE/gH+qJBmVByjE10X8p9XFvnvLWyx5Tu8IjtFNL5SNdJzbcuEGGBbU3fQSPaBO+KQ3TFyCGI6tbAyZvJLZwibpf5F+jK3Th8WgDhR6I8twf37UMR68awNSdFVadNoa1NJGeFC3JI2CRWPm7useWqxaIdRvqefVZH6yP9BxKgjJ3efNU+ndpwkLaL5Fox/wN0ZGD3LghxgfqIEIHPVhOQn84JaX9iAtGqPyjCsRZl01jhqniIJ6dxC61hLkpqhLBxMVw55dVGwGUuSU3TPyyquCQtfUOeRFXzkntzmCjJlxuH+tkTXQ6YHSylYPDUB8BPfGhSdjQATSIL8kDoEzUR6ytnNmtomYjQoktIhmmSp88Wfn2BDIVPr/zwndN8IQGcpEsRI2cEE+nHYM5BuECQ0PHSVYPd/GtLndbg3rymf1ukIGwW+4fr59u3+z3v1T9uIY98LV05ecu3EnZ6hRSLm749mQVT8UEmbIANIpCNBivRrroADtWhojKpg97uF/Cz1ovEZGNVA8PsXS9dNjmYlR/RwusYe3JLDTJy53EmjHyuV/9LCCXUaLSdvT27V1FTTzIzMzWX/HGguz8RGClu774Tq2PXAnSks2WUbvqIj7F0YbDzKO2/m51C4ae+2a420GQcAZI40l3MOIKEp2osOc3/Y0pG/wtpoL/W+Zm1+GyygNMOVTjWAYsAj5WPDVL5avuhUDHvyYuktchpJSFc60dKk3r7Q27o8C4D83UBhCcjmgKu3bNjaDP60eltdcfc6bN/wXda3fp/V8rtHrJdo2gvQhmf5kUSwvpmEC7r7LoJnq+5QKrSdUQ5W5dzGbGlGOkceeXzB8IVL8J5XfPa48xNUykFzztZuknZLFL45EaM8IrrVzOlhKkJtDHf6eahRfeRFc20s1dAR4C8E4UGQQ1GtcIJBym2esoCfJCiFc9LykkIe43/feOePdN8XuEUdqABygWCFSDhbTkTs9eTrELeS5357qj0941JehGJdQxg/bfE6otVpQc+jvDThPk75uUGca3O3CFgY0SJK3PpDsNMR4N0Ku3Vg/OuJbubGLgR15BrgDDPrg6rMncEvQJDDkZ9dEAz4oFTSDkSUzv4TFLtgHquqKKHKXH6YSTsZGSf1Af7P25DMlxhWHO0dwq25wsNk1iFJgefDt7DPHPddQIOvsafy3T0ukjy3wKNcFMWlDUJTd29Aea/F5TctRt1/nCAg5pWWDZurREP7B1RHmqlpvwXKGJ0CiGmZMS7wMj9eLSCp2dIp+CrU/OKK0iuIf17/+Ff2+bYioseiTF/zfDvGZKlhj6DkeGiz27D3UiOBxb1Tm4ya1yZ03R4JH7WsBavI4cczBnjEJr2d6TXRJyeL+xxagSAM6obQUn+Lb+ItB9dWdBm8xwzHlgeimaYwXUafjk3m/jA7XH32unx7xdvh0fzfnbLULPvIjt+/D0ntiUCifWnw2wt/RbBEEsiMeKEPlDpZLpU9bN2ktKfqluv1HDmnAQQEiD2fkfgvdzh1mmaTWg6kNiBuqwWLsxZrl5Ak+YoPlfpmg537t6YVG6uHTg7guFZPlYEZNuwxvWO2pQcdg/eBasjtTrxdV6OhF07tq2wMfaUOI9sTVzSaG5wAgPw0U1zOwzy/pAZlX30PYd7K1hwRaZg6H+0SZhG9ha7I/glO5cq/Fa0lktv3rq8ZXy0eg08faQTQXz1VtiFkGFK4JfPp3ucpp42ljr+x3tbAtbRW3evAVd2ksLrN7K2fYumzm2E4fNPfvRqTvAAA=",
};
function RankBadge({ score, size = 64 }) {
  const { tier } = scoreToRank(score);
  const src = RANK_IMGS[tier.key];
  const glow = Math.max(2, size * 0.10);
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0, lineHeight: 0,
                  display: "flex", alignItems: "center", justifyContent: "center" }}>
      <img src={src} alt={tier.label} title={`${tier.label} — ${tier.motto}`} draggable={false}
           style={{ width: "100%", height: "100%", objectFit: "contain", display: "block",
                    filter: `drop-shadow(0 0 ${glow.toFixed(1)}px ${tier.glow}66)` }} />
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
// Logo APEX (emblème "sommet/pic" — remplace l'ancien logo diamant)
function ApexMark({ size = 120 }) {
  const h = Math.round((size * 110) / 120);
  return (
    <svg width={size} height={h} viewBox="0 0 120 110" xmlns="http://www.w3.org/2000/svg" style={{ display: "block" }}>
      <defs>
        <linearGradient id="apexGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#9fe2ff" /><stop offset="1" stopColor="#3f6dff" />
        </linearGradient>
        <filter id="apexGlow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="2.2" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <path d="M60 4 L75 22 L67 22 L60 14 L53 22 L45 22 Z" fill="url(#apexGrad)" opacity="0.85" />
      <g filter="url(#apexGlow)">
        <path d="M60 26 L108 100 L84 100 L60 62 L36 100 L12 100 Z" fill="url(#apexGrad)" stroke="#cfe6ff" strokeWidth="1.2" strokeLinejoin="round" />
      </g>
      <path d="M44 84 L76 84 L70 74 L50 74 Z" fill="#e0245e" />
    </svg>
  );
}

function SplashScreen({ onDone }) {
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    const t1 = setTimeout(() => setLeaving(true), 1950);   // commence le fondu
    const t2 = setTimeout(() => onDone && onDone(), 2450);  // retire l'écran
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);
  const skip = () => { setLeaving(true); setTimeout(() => onDone && onDone(), 320); };
  return (
    <div onClick={skip} role="button" aria-label="Passer"
      style={{
        position: "fixed", inset: 0, zIndex: 99999, cursor: "pointer",
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16,
        background: "radial-gradient(820px 560px at 50% 38%, #18233e 0%, #0c0f16 58%, #08090d 100%)",
        opacity: leaving ? 0 : 1, transition: "opacity .42s ease",
        fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", textAlign: "center", padding: 24,
      }}>
      <style>{`
        @keyframes apxLogoIn { 0%{opacity:0;transform:translateY(16px) scale(.8)} 60%{opacity:1} 100%{opacity:1;transform:translateY(0) scale(1)} }
        @keyframes apxFloat { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-7px)} }
        @keyframes apxGlow { 0%,100%{filter:drop-shadow(0 0 8px rgba(110,150,255,.4))} 50%{filter:drop-shadow(0 0 26px rgba(110,150,255,.85))} }
        @keyframes apxWord { 0%{opacity:0;letter-spacing:16px} 100%{opacity:1;letter-spacing:3px} }
        @keyframes apxBar { 0%{width:0;opacity:0} 100%{width:130px;opacity:1} }
        @keyframes apxTag { 0%{opacity:0;transform:translateY(8px)} 100%{opacity:1;transform:translateY(0)} }
      `}</style>
      <div style={{ animation: "apxLogoIn .8s cubic-bezier(.2,.85,.25,1) both" }}>
        <span style={{ display: "block", animation: "apxFloat 3s ease-in-out .8s infinite, apxGlow 2.6s ease-in-out .8s infinite" }}>
          <ApexMark size={150} />
        </span>
      </div>
      <div style={{ fontSize: 42, fontWeight: 900, color: "#fff", lineHeight: 1, animation: "apxWord .9s ease .3s both" }}>
        <span style={{ color: "#e0245e" }}>A</span>PEX
      </div>
      <div style={{ height: 2, borderRadius: 2, background: "linear-gradient(90deg, transparent, #6e96ff, transparent)", animation: "apxBar .8s ease .65s both" }} />
      <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: 2, textTransform: "uppercase", color: "#8fb0ff", animation: "apxTag .9s ease .95s both" }}>
        Deviens ta légende
      </div>
    </div>
  );
}

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
  // Séance en cours, persistée localement : { routine, data, startedAt, pinned }.
  // Elle survit à une fermeture/rechargement de la page ; on ne l'efface qu'à l'enregistrement ou à l'abandon.
  const [live, setLive] = useState(() => store.get("apex_live", null));
  const [liveOpen, setLiveOpen] = useState(() => !!store.get("apex_live", null));
  // Photos d'exercices (image de profil) : { [exKey]: dataUrl }
  const [exPhotos, setExPhotos] = useState(() => store.get(K.exphotos, {}));
  const setExPhoto = (exKey, dataUrl) => setExPhotos((p) => { const n = { ...p }; if (dataUrl) n[exKey] = dataUrl; else delete n[exKey]; return n; });
  // Vidéos YouTube personnalisées par exercice : { [exKey]: videoId }
  const [exVids, setExVids] = useState(() => store.get(K.exvids, {}));
  const setExVid = (exKey, videoId) => setExVids((p) => { const n = { ...p }; if (videoId) n[exKey] = videoId; else delete n[exKey]; return n; });
  const [focusSessionId, setFocusSessionId] = useState(null);
  const goToSession = (id) => { setFocusSessionId(id); setProfilSub("historique"); setTab("profil"); };
  const [celebration, setCelebration] = useState(null);
  const [toast, setToast] = useState("");
  const [account, setAccount] = useState(null);
  const [showSplash, setShowSplash] = useState(true);

  useEffect(() => { if (profile) store.set(K.profile, profile); }, [profile]);
  useEffect(() => { applyTheme(profile?.theme || "perle"); }, [profile?.theme]);
  useEffect(() => store.set(K.onboarded, onboarded), [onboarded]);
  useEffect(() => store.set(K.lifts, lifts), [lifts]);
  useEffect(() => store.set(K.prs, prs), [prs]);
  useEffect(() => store.set(K.routines, routines), [routines]);
  useEffect(() => store.set(K.history, history), [history]);
  useEffect(() => store.set(K.cardio, cardio), [cardio]);
  useEffect(() => store.set(K.xp, xpRaw), [xpRaw]);
  useEffect(() => store.set(K.exphotos, exPhotos), [exPhotos]);
  useEffect(() => store.set(K.exvids, exVids), [exVids]);
  useEffect(() => { store.set("apex_live", live); }, [live]);

  // Demande au navigateur de CONSERVER les données du site (évite l'effacement automatique,
  // notamment sur mobile/iOS). Les séances créées restent donc enregistrées entre les mises à jour.
  useEffect(() => {
    try {
      if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persisted().then((p) => { if (!p) navigator.storage.persist().catch(() => {}); }).catch(() => {});
      }
    } catch {}
  }, []);

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
        // Les deux ont des données -> FUSION non destructive (aucune séance créée n'est perdue)
        const cloudNewer = res.updatedAt > localTs;
        const merged = mergeBundles(readLocalBundle(), res.data, cloudNewer);
        const changed = writeLocalBundle(merged);
        setLocalTs(Date.now()); // le local contient désormais la fusion (la version la plus complète)
        if (changed && !sessionStorage.getItem("apex_synced_once")) {
          sessionStorage.setItem("apex_synced_once", "1");
          window.location.reload();
          return;
        }
        // pousse la fusion vers le cloud pour que les deux côtés convergent
        await cloudSync.push(client, account.id);
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

  // Séance terminée en attente de choix : conserver la routine d'origine ou la mettre à jour.
  const [pendingFinish, setPendingFinish] = useState(null);

  // La séance réalisée diffère-t-elle de la routine enregistrée ? (exos ajoutés/retirés/réordonnés, nb de séries changé)
  const sessionDiffersFromRoutine = (session) => {
    const r = routines.find((x) => x.id === session.routineId);
    if (!r) return null; // routine non enregistrée (préconstruite lancée direct…) → pas de question
    const a = (r.exercises || []).map((e) => `${e.key}:${e.sets || 3}`).join("|");
    const b = (session.exercises || []).map((e) => `${e.key}:${e.sets.length}`).join("|");
    return a !== b ? r : null;
  };

  const completeSession = (session) => {
    const changed = sessionDiffersFromRoutine(session);
    if (changed) { setPendingFinish({ session, routine: changed }); return; }
    finalizeSession(session, false);
  };

  const finalizeSession = (session, updateRoutine) => {
    setPendingFinish(null);
    if (updateRoutine) {
      // La routine adopte la structure réellement effectuée aujourd'hui.
      setRoutines((prev) => prev.map((r) => r.id !== session.routineId ? r : {
        ...r,
        exercises: session.exercises.map((se) => {
          const old = (r.exercises || []).find((e) => e.key === se.key);
          const lastReps = [...se.sets].reverse().find((s) => s.reps)?.reps;
          return { key: se.key, sets: se.sets.length, targetReps: Number(lastReps) || old?.targetReps || 8, rest: se.rest || old?.rest || 90 };
        }),
      }));
      flash("Routine mise à jour ✓");
    }
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
    setLive(null); setLiveOpen(false);

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

  // -------- écran de lancement (animation) --------
  if (showSplash) return <SplashScreen onDone={() => setShowSplash(false)} />;

  // -------- onboarding (1er lancement) --------
  if (!onboarded || !profile) {
    return <Onboarding onDone={(p) => { setProfile(p); setOnboarded(true); }} onImportHevy={(sessions) => importHevy(sessions)} />;
  }

  const rk = scoreToRank(overall);
  // progression vers le prochain palier de rang (chaque rang = 3 paliers)
  const rankProg = ((rk.within * 3) % 1 + 1) % 1;

  return (
    <div style={profile?.customBg ? {
      ...S.app,
      backgroundImage: `linear-gradient(rgba(13,16,21,0.45), rgba(13,16,21,0.62)), url(${profile.customBg})`,
      backgroundSize: "cover", backgroundPosition: "center center", backgroundAttachment: "fixed", backgroundRepeat: "no-repeat",
    } : S.app}>
      <style>{KEYFRAMES}</style>
      <Toast msg={toast} />
      <header style={S.header}>
        {/* gauche : rang général + progression vers le prochain rang + barre d'XP */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
          <div style={{ animation: "float 4s ease-in-out infinite", flexShrink: 0 }}>
            <RankBadge score={overall} size={42} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
              <span style={{ fontWeight: 800, fontSize: 15, color: rk.tier.glow, lineHeight: 1.1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {rk.tier.label} {rk.sub}
              </span>
              <span style={{ fontSize: 11, opacity: 0.7, flexShrink: 0, whiteSpace: "nowrap" }}>Niv. <b style={{ color: "#ffb55c" }}>{levelInfo.level}</b></span>
            </div>
            {/* barre : progression vers le prochain rang */}
            <div title="Progression vers le prochain rang" style={{ height: 5, background: "#1b1f27", borderRadius: 99, overflow: "hidden", marginTop: 4 }}>
              <div style={{ width: `${Math.round(rankProg * 100)}%`, height: "100%", background: `linear-gradient(90deg, ${rk.tier.glow}aa, ${rk.tier.glow})`, borderRadius: 99, transition: "width .5s cubic-bezier(.2,.8,.2,1)" }} />
            </div>
            {/* barre : XP du niveau */}
            <div title={`XP : ${Math.round(levelInfo.into)} / ${levelInfo.need}`} style={{ height: 5, background: "#1b1f27", borderRadius: 99, overflow: "hidden", marginTop: 3 }}>
              <div style={{ width: `${Math.round(levelInfo.pct * 100)}%`, height: "100%", background: "linear-gradient(90deg, #ffb55caa, #ffb55c)", borderRadius: 99, transition: "width .5s cubic-bezier(.2,.8,.2,1)" }} />
            </div>
          </div>
        </div>
        {/* droite : marque + pseudo */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", flexShrink: 0, marginLeft: 12 }}>
          <div style={S.logo}><span style={{ color: "#e0245e" }}>A</span>PEX</div>
          <span style={{ ...S.tagline, opacity: 0.5 }}>{profile.pseudo || "athlète"}</span>
        </div>
      </header>

      <nav style={S.tabs}>
        {[["profil","Profil"],["exos","Exercices"],["seances","Séances"],["nutrition","Nutrition"]].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={{ ...S.tab, ...(tab === k ? S.tabActive : {}) }}>{label}</button>
        ))}
      </nav>

      {live && !liveOpen && (
        <button onClick={() => setLiveOpen(true)} style={S.resumeBar}>
          <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span style={{ fontSize: 16 }}>▶︎</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Reprendre la séance « {live.routine?.name || "Séance"} »</span>
          </span>
          <span style={{ fontSize: 11, opacity: 0.85, flexShrink: 0, fontWeight: 700 }}>EN COURS</span>
        </button>
      )}

      <main style={S.main}>
        {tab === "profil" && <Profil sub={profilSub} setSub={setProfilSub}
          overall={overall} muscleScores={muscleScores} loggedCount={loggedCount} history={history} cardio={cardio}
          levelInfo={levelInfo} totalXp={totalXp} xpNow={xpNow} bw={bw} profile={profile} setProfile={setProfile}
          lifts={lifts} prs={prs} flash={flash} account={account} setAccount={setAccount} onResetOnboarding={() => { setOnboarded(false); }}
          focusSessionId={focusSessionId} onFocusHandled={() => setFocusSessionId(null)}
          dataTabProps={{ profile, routines, lifts, prs, history, cardio, xp: xpRaw, onImportBackup: importBackup, onImportHevy: importHevy, onImportRoutine: importRoutine, flash,
            onClearHistory: () => setHistory([]), onDeleteSession: (id) => setHistory((p) => p.filter((s) => s.id !== id)), onUpdateSession: (id, upd) => setHistory((p) => p.map((s) => s.id === id ? { ...s, ...upd } : s)) }} />}
        {tab === "exos" && <ExoByMuscle lifts={lifts} prs={prs} bw={bw} setBestLift={setBestLift} setPR={setPR} progressionFor={progressionFor} exoCount={exoCount} weightHistoryFor={weightHistoryFor} onGoToSession={goToSession} flash={flash} exPhotos={exPhotos} onSetPhoto={setExPhoto} />}
        {tab === "seances" && (editingRoutine
          ? <RoutineEditor routine={editingRoutine} onSave={saveRoutine} onCancel={() => setEditingRoutine(null)} exPhotos={exPhotos} onSetPhoto={setExPhoto} />
          : <SeancesHub sub={seancesSub} setSub={setSeancesSub} routines={routines} history={history} onImportYt={importRoutine}
              onNew={() => setEditingRoutine({ id: uid(), name: "", exercises: [] })} onEdit={setEditingRoutine} onDelete={deleteRoutine}
              onStart={(r) => { setLive({ routine: r, data: null, startedAt: Date.now(), pinned: {} }); setLiveOpen(true); }} onExport={(r) => exportRoutine(r, flash)} onAddPreset={addPreset}
              cardio={cardio} bw={bw} onAddCardio={addCardio} onClearCardio={() => setCardio([])} />)}
        {tab === "nutrition" && <Nutrition profile={profile} setProfile={setProfile} />}
      </main>

      {live && liveOpen && <SessionLogger session={live} onChange={(patch) => setLive((c) => c ? { ...c, ...patch } : c)} lastSessionSets={lastSessionSets} prs={prs} muscleScores={muscleScores} exPhotos={exPhotos} onSetPhoto={setExPhoto} exVids={exVids} onSetVid={setExVid} onFinish={completeSession} onCancel={() => { setLive(null); setLiveOpen(false); }} onMinimize={() => setLiveOpen(false)} />}
      {pendingFinish && <RoutineUpdateModal pending={pendingFinish} onKeep={() => finalizeSession(pendingFinish.session, false)} onUpdate={() => finalizeSession(pendingFinish.session, true)} />}
      {celebration && <Celebration data={celebration} onClose={() => { setCelebration(null); setTab("profil"); setProfilSub("historique"); }} />}
      <footer style={S.footer}>Données sur ton appareil. Pense à exporter une sauvegarde (onglet Données).</footer>
    </div>
  );
}

/* --------------------- CÉLÉBRATION (fin de séance) ------------------- */
/* Fin de séance : la structure effectuée diffère de la routine → l'utilisateur choisit. */
function RoutineUpdateModal({ pending, onKeep, onUpdate }) {
  const { session, routine } = pending;
  const oldKeys = (routine.exercises || []).map((e) => e.key);
  const newKeys = (session.exercises || []).map((e) => e.key);
  const added = newKeys.filter((k) => !oldKeys.includes(k)).map((k) => EX_BY_KEY[k]?.name || k);
  const removed = oldKeys.filter((k) => !newKeys.includes(k)).map((k) => EX_BY_KEY[k]?.name || k);
  const setsChanged = (session.exercises || []).filter((se) => {
    const old = (routine.exercises || []).find((e) => e.key === se.key);
    return old && (old.sets || 3) !== se.sets.length;
  }).map((se) => EX_BY_KEY[se.key]?.name || se.key);
  return (
    <div style={{ ...S.overlay, alignItems: "center", padding: 16, zIndex: 300 }}>
      <div style={{ ...S.card, width: "100%", maxWidth: 420, animation: "popIn .25s ease" }}>
        <div style={{ fontSize: 17, fontWeight: 800, marginBottom: 6 }}>Ta séance a évolué 💪</div>
        <div style={{ fontSize: 13.5, opacity: 0.75, lineHeight: 1.5 }}>
          Ce que tu as fait aujourd'hui diffère de la routine « <b>{routine.name}</b> ». Que veux-tu faire ?
        </div>
        <div style={{ ...S.exoInner, marginTop: 10, fontSize: 12.5, display: "grid", gap: 4 }}>
          {added.length > 0 && <div>➕ Ajouté : <b>{added.join(", ")}</b></div>}
          {removed.length > 0 && <div>➖ Retiré : <b>{removed.join(", ")}</b></div>}
          {setsChanged.length > 0 && <div>🔁 Séries modifiées : <b>{setsChanged.join(", ")}</b></div>}
        </div>
        <button style={{ ...S.btnPrimary, width: "100%", padding: 13, marginTop: 14 }} onClick={onUpdate}>
          Mettre à jour la routine avec la séance du jour
        </button>
        <button style={{ ...S.btnGhost, width: "100%", padding: 12, marginTop: 8 }} onClick={onKeep}>
          Conserver la routine d'origine
        </button>
        <div style={{ fontSize: 11, opacity: 0.5, marginTop: 8, textAlign: "center" }}>Dans les deux cas, la séance du jour est enregistrée dans ton historique.</div>
      </div>
    </div>
  );
}

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
  const canFinish = taille && poids;

  return (
    <div style={{ ...S.app, justifyContent: "center", padding: "0 18px" }}>
      <style>{KEYFRAMES}</style>
      <div style={{ maxWidth: 420, margin: "0 auto", width: "100%", padding: "40px 0" }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ margin: "0 auto 10px", display: "flex", justifyContent: "center", filter: "drop-shadow(0 4px 14px rgba(80,140,255,.4))" }}><ApexMark size={92} /></div>
          <div style={{ ...S.logo, fontSize: 38, marginBottom: 6 }}><span style={{ color: "#e0245e" }}>A</span>PEX</div>
          <div style={{ opacity: 0.55, fontSize: 14 }}>Mesure ton physique, monte en rang.</div>
        </div>

        {step === 0 && (
          <div style={{ ...S.card, display: "grid", gap: 14, animation: "fadeIn .3s" }}>
            <div style={{ fontWeight: 800, fontSize: 18 }}>Bienvenue 👋</div>
            <div style={{ opacity: 0.7, fontSize: 14, lineHeight: 1.5 }}>Quelques infos pour personnaliser tes rangs, tes calories et tes suggestions. Tout reste sur ton appareil.</div>
            <div><span style={S.obLabel}>Sexe (pour l'estimation des calories)</span>
              <div style={{ display: "flex", gap: 8 }}>
                {[["homme","Homme"],["femme","Femme"],["autre","Ne pas préciser"]].map(([k, l]) => (
                  <button key={k} onClick={() => setSexe(k)} style={{ ...S.goalBtn, ...(sexe === k ? S.goalBtnActive : {}) }}>{l}</button>
                ))}
              </div></div>
            <div style={{ fontSize: 12, opacity: 0.5, lineHeight: 1.5 }}>💡 Tu pourras choisir un pseudo plus tard dans <b>Profil → Paramètres</b> (facultatif).</div>
            <button style={{ ...S.btnPrimary, padding: 14 }} onClick={() => setStep(1)}>Continuer →</button>
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
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4, fontStyle: "italic", lineHeight: 1.35 }}>{tier.motto}</div>
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
  const bgInputRef = React.useRef(null);
  const [bgBusy, setBgBusy] = useState(false);
  const [bgErr, setBgErr] = useState("");
  const pickBg = async (e) => {
    const file = e.target.files?.[0]; e.target.value = "";
    if (!file) return;
    setBgErr(""); setBgBusy(true);
    try {
      const dataUrl = await readImageCompressed(file, 1280, 0.72);
      if (dataUrl.length > 3_500_000) { setBgErr("Image trop lourde même après compression. Essaie-en une plus petite."); }
      else setProfile({ ...profile, customBg: dataUrl });
    } catch { setBgErr("Impossible de charger cette image."); }
    setBgBusy(false);
  };
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
            const active = (profile.theme || "perle") === k;
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
        <div style={{ fontWeight: 700, marginBottom: 4 }}>🖼️ Fond d'écran</div>
        <div style={{ fontSize: 12.5, opacity: 0.6, marginBottom: 12 }}>Mets l'image de ton choix en fond de l'app. Un léger voile sombre est appliqué pour garder le texte lisible.</div>
        <input ref={bgInputRef} type="file" accept="image/*" onChange={pickBg} style={{ display: "none" }} />
        {profile.customBg ? (
          <div>
            <div style={{ position: "relative", width: "100%", height: 120, borderRadius: 12, overflow: "hidden", border: "1px solid #2a313d", marginBottom: 10 }}>
              <img src={profile.customBg} alt="Fond actuel" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
              <div style={{ position: "absolute", inset: 0, background: "linear-gradient(rgba(13,16,21,0.45), rgba(13,16,21,0.62))" }} />
              <span style={{ position: "absolute", left: 10, bottom: 8, fontSize: 11, fontWeight: 700, color: "#fff", textShadow: "0 1px 3px rgba(0,0,0,.6)" }}>Aperçu du fond</span>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button style={S.btnGhost} disabled={bgBusy} onClick={() => bgInputRef.current?.click()}>{bgBusy ? "Chargement…" : "Changer l'image"}</button>
              <button style={{ ...S.btnGhost, color: "#ff6b6b" }} onClick={() => setProfile({ ...profile, customBg: null })}>Retirer le fond</button>
            </div>
          </div>
        ) : (
          <button style={{ ...S.btnPrimary, width: "100%", padding: 12 }} disabled={bgBusy} onClick={() => bgInputRef.current?.click()}>
            {bgBusy ? "Chargement…" : "Choisir une image"}
          </button>
        )}
        {bgErr && <div style={{ ...S.suggBox, background: "#2a1010", borderColor: "#5a1a1a", color: "#ff9b9b", marginTop: 10 }}>{bgErr}</div>}
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
function SeancesHub({ sub, setSub, routines, history, onNew, onEdit, onDelete, onStart, onExport, onAddPreset, onImportYt, cardio, bw, onAddCardio, onClearCardio }) {
  const subs = [["base","Musculation"],["cardio","Cardio"],["callisthenie","Callisthénie"]];
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", gap: 6 }}>
        {subs.map(([k, l]) => <button key={k} onClick={() => setSub(k)} style={{ ...S.subTab, flex: 1, ...(sub === k ? S.subTabOn : {}) }}>{l}</button>)}
      </div>
      {sub === "base" && <Seances routines={routines} history={history} onNew={onNew} onEdit={onEdit} onDelete={onDelete} onStart={onStart} onExport={onExport} onAddPreset={onAddPreset} onImportYt={onImportYt} />}
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
        <div style={{ fontSize: 12.5, opacity: 0.6, marginTop: 4, lineHeight: 1.5 }}>Chaque rang a 3 paliers (1 → 3, le 3 étant le plus fort). Du plus accessible au sommet réservé aux athlètes confirmés.</div>
        <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
          {[...TIERS].reverse().map((tr, i) => {
            const idx = TIERS.length - 1 - i;
            const sampleScore = (idx + 0.5) / TIERS.length;
            return (
              <div key={tr.key} style={{ display: "flex", alignItems: "center", gap: 12, background: "var(--inner,#10151d)", borderRadius: 10, padding: "10px 12px" }}>
                <RankBadge score={sampleScore} size={44} />
                <div style={{ flex: 1 }}><div style={{ fontWeight: 700, color: tr.glow }}>{tr.label}</div>
                  <div style={{ fontSize: 11.5, opacity: 0.75, fontStyle: "italic", lineHeight: 1.35, marginTop: 1 }}>{tr.motto}</div>
                  <div style={{ fontSize: 11, opacity: 0.5, marginTop: 2 }}>{idx === TIERS.length - 1 ? "Sommet — niveau compétiteur" : idx >= 6 ? "Très avancé" : idx >= 4 ? "Confirmé" : idx >= 2 ? "Intermédiaire" : "Débutant"}</div></div>
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
function ExoByMuscle({ lifts, prs, bw, setBestLift, setPR, progressionFor, exoCount, weightHistoryFor, onGoToSession, flash, exPhotos, onSetPhoto }) {
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
          <ExoThumb exKey={ex.key} photo={exPhotos && exPhotos[ex.key]} size={44} editable onPhoto={onSetPhoto} />
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
              {zoneOf(ex.key) && <div style={{ ...S.zoneTag, marginTop: 6, fontSize: 12.5 }}>🎯 Zone précise : {zoneOf(ex.key)}</div>}
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
/* ---------------- SÉANCE DEPUIS UNE VIDÉO YOUTUBE ---------------------
   1. Colle l'URL d'une vidéo d'entraînement → on récupère son titre.
   2. Colle la description / liste d'exercices de la vidéo → détection
      automatique des exos (base APEX + alias) et des séries×reps (4x8, etc.).
   3. Ajuste, puis enregistre : la vidéo reste attachée à la séance et se
      regarde directement pendant l'entraînement. */
function parseYtWorkoutText(text) {
  const found = []; const seen = new Set();
  const lines = String(text || "").split(/\n+/);
  for (const raw of lines) {
    const line = raw.trim(); if (!line || line.length > 120) continue;
    // motifs "4x8", "4 x 8-12", "3 séries de 12", "3 sets of 10", "8 reps"
    const sr = line.match(/(\d{1,2})\s*[x×*]\s*(\d{1,2})(?:\s*[-–à]\s*\d{1,2})?/i)
      || line.match(/(\d{1,2})\s*(?:séries?|series|sets?)\s*(?:de|of|x)?\s*(\d{1,2})?/i);
    // nettoie la ligne pour le matching (retire chiffres/horodatages/puces)
    const cleaned = line.replace(/^\s*[\d:.\-–•·)\]]+\s*/, "").replace(/(\d{1,2})\s*[x×*]\s*[\d\-–à ]+/gi, "")
      .replace(/(\d{1,2})\s*(?:séries?|series|sets?|reps?)(\s*(?:de|of|x)?\s*\d{0,2})?/gi, "").replace(/[()\[\]#@]/g, " ").trim();
    if (cleaned.length < 3) continue;
    const key = matchExercise(cleaned);
    if (key && !seen.has(key)) {
      seen.add(key);
      found.push({ key, sets: sr ? Math.min(10, Math.max(1, Number(sr[1]) || 3)) : 3, targetReps: sr && sr[2] ? Math.min(50, Math.max(1, Number(sr[2]))) : 8, rest: 90 });
    }
  }
  return found;
}
function YoutubeImport({ onImport, onCancel }) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const vid = parseYtId(url);
  const parsed = useMemo(() => parseYtWorkoutText(desc), [desc]);
  const [removedKeys, setRemovedKeys] = useState([]);
  const exercises = parsed.filter((e) => !removedKeys.includes(e.key));

  // Récupère le titre de la vidéo (best effort — fonctionne sans clé API).
  useEffect(() => {
    if (!vid) return;
    let dead = false; setLoading(true);
    fetch(`https://noembed.com/embed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${vid}`)}`)
      .then((r) => r.json()).then((d) => { if (!dead && d && d.title) setTitle((t) => t || d.title); })
      .catch(() => {}).finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [vid]);

  const save = () => {
    if (!vid) { setErr("Colle d'abord un lien YouTube valide."); return; }
    if (!exercises.length) { setErr("Aucun exercice détecté — colle la description de la vidéo ou tape la liste des exos (un par ligne)."); return; }
    onImport({ name: (title || "Séance YouTube").slice(0, 60), ytId: vid, exercises });
  };

  return (
    <div style={{ ...S.overlay, alignItems: "center", padding: 16 }}>
      <div style={{ ...S.card, width: "100%", maxWidth: 480, maxHeight: "90vh", overflowY: "auto", animation: "popIn .25s ease" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontSize: 17, fontWeight: 800 }}>🎬 Séance depuis YouTube</div>
          <button style={{ ...S.btnGhost, padding: "4px 10px" }} onClick={onCancel}>×</button>
        </div>

        <div style={S.miniLabel}>1 · Lien de la vidéo</div>
        <input value={url} onChange={(e) => { setUrl(e.target.value); setErr(""); }} placeholder="https://youtube.com/watch?v=…" style={{ ...S.input, marginTop: 6 }} />
        {vid && (
          <div style={{ marginTop: 10 }}>
            <div style={S.ytWrap}>
              <iframe style={S.ytFrame} src={ytEmbed(vid)} title="Aperçu vidéo" frameBorder="0" allow="encrypted-media; picture-in-picture" allowFullScreen />
            </div>
          </div>
        )}

        <div style={{ ...S.miniLabel, marginTop: 14 }}>2 · Nom de la séance</div>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={loading ? "Récupération du titre…" : "ex. Full body maison 30 min"} style={{ ...S.input, marginTop: 6 }} />

        <div style={{ ...S.miniLabel, marginTop: 14 }}>3 · Description / liste des exercices</div>
        <div style={{ fontSize: 11.5, opacity: 0.6, margin: "4px 0 6px" }}>Colle la description de la vidéo (ou tape les exos, un par ligne : « Développé couché 4x8 »). Les exercices sont détectés automatiquement.</div>
        <textarea value={desc} onChange={(e) => { setDesc(e.target.value); setErr(""); }} rows={6} placeholder={"Squat 4x8\nDéveloppé couché 4x10\nTractions 3x8\n…"} style={{ ...S.input, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }} />

        {desc.trim() && (
          <div style={{ marginTop: 10 }}>
            <div style={S.miniLabel}>Exercices détectés ({exercises.length})</div>
            <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
              {exercises.length === 0 && <div style={{ opacity: 0.5, fontSize: 13, padding: 8 }}>Rien de reconnu pour l'instant…</div>}
              {exercises.map((e) => { const ex = EX_BY_KEY[e.key]; return (
                <div key={e.key} style={S.pickRow}>
                  <MuscleIcon muscles={ex.muscles} size={30} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>{ex.name}</div>
                    <div style={{ fontSize: 11, opacity: 0.55 }}>{e.sets} séries × {e.targetReps} reps</div>
                  </div>
                  <button style={{ ...S.btnGhost, color: "#ff6b6b", padding: "3px 9px", fontSize: 13 }} onClick={() => setRemovedKeys((p) => [...p, e.key])}>×</button>
                </div>
              ); })}
            </div>
          </div>
        )}

        {err && <div style={{ fontSize: 12.5, color: "#ff6b6b", marginTop: 10 }}>{err}</div>}
        <button style={{ ...S.btnPrimary, width: "100%", padding: 13, marginTop: 14, opacity: vid && exercises.length ? 1 : 0.5 }} onClick={save}>
          Enregistrer la séance {exercises.length ? `(${exercises.length} exos)` : ""}
        </button>
        <div style={{ fontSize: 11, opacity: 0.5, marginTop: 8, textAlign: "center" }}>La vidéo restera visionnable pendant la séance (bouton « ▶ Vidéo de la séance »).</div>
      </div>
    </div>
  );
}

function Seances({ routines, history, onNew, onEdit, onDelete, onStart, onExport, onAddPreset, onImportYt }) {
  const [ytOpen, setYtOpen] = useState(false);
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
      <button style={{ ...S.btnGhost, width: "100%", padding: 13, fontSize: 14, fontWeight: 700 }} onClick={() => setYtOpen(true)}>🎬 Créer une séance depuis une vidéo YouTube</button>
      {ytOpen && <YoutubeImport onImport={(r) => { setYtOpen(false); onImportYt && onImportYt(r); }} onCancel={() => setYtOpen(false)} />}

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
function RoutineEditor({ routine, onSave, onCancel, exPhotos, onSetPhoto }) {
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
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}><ExoThumb exKey={e.key} photo={exPhotos && exPhotos[e.key]} size={36} editable onPhoto={onSetPhoto} />
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
              {MUSCLES.map((m) => <button key={m.key} onClick={() => setPMuscle(pMuscle === m.key ? null : m.key)} style={{ ...S.chip, cursor: "pointer", border: "1px solid", borderColor: pMuscle === m.key ? "var(--accent,#e0245e)" : "var(--border,#2a313d)", background: pMuscle === m.key ? "var(--accent,#e0245e)" : "var(--ghost,#1c2230)", color: pMuscle === m.key ? "#fff" : "var(--muted,#cdd4de)" }}>{m.label}</button>)}
            </div>
            <div style={{ marginTop: 10, display: "grid", gap: 12 }}>
              {pickerResults ? (
                <div style={{ display: "grid", gap: 6 }}>
                  {pickerResults.length === 0 ? <div style={{ opacity: 0.5, fontSize: 13, textAlign: "center", padding: 16 }}>Aucun exercice trouvé.</div> :
                   pickerResults.map((ex) => (
                    <div key={ex.key} onClick={() => toggle(ex.key)} style={{ ...S.pickRow, ...(isSel(ex.key) ? S.pickRowOn : {}) }}>
                      <MuscleIcon muscles={ex.muscles} size={32} />
                      <span style={{ flex: 1, fontWeight: 600, fontSize: 13.5 }}>{ex.name}</span>
                      <span style={{ fontSize: 18, color: isSel(ex.key) ? "var(--accent,#e0245e)" : "var(--muted-2,#3a3f4a)", fontWeight: 800 }}>{isSel(ex.key) ? "✓" : "+"}</span>
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
                          <span style={{ fontSize: 18, color: isSel(ex.key) ? "var(--accent,#e0245e)" : "var(--muted-2,#3a3f4a)", fontWeight: 800 }}>{isSel(ex.key) ? "✓" : "+"}</span>
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

/* Panneau vidéo d'un exercice :
   - si une vidéo a été enregistrée pour cet exo → lecteur intégré (embed direct, fiable) ;
   - sinon → bouton de recherche YouTube + champ pour coller le lien d'une vidéo,
     qui sera mémorisée pour toutes les prochaines séances. */
function ExoVideoPanel({ exKey, name, vidId, onSetVid, ytUrl }) {
  const [linkInput, setLinkInput] = useState("");
  const [err, setErr] = useState("");
  const save = () => {
    const id = parseYtId(linkInput);
    if (!id) { setErr("Lien non reconnu — colle une URL YouTube (watch, youtu.be, shorts…)"); return; }
    onSetVid && onSetVid(exKey, id); setLinkInput(""); setErr("");
  };
  return (
    <div style={{ marginBottom: 10 }}>
      {vidId ? (
        <>
          <div style={S.ytWrap}>
            <iframe style={S.ytFrame} src={ytEmbed(vidId)} title={`Vidéo ${name}`}
              frameBorder="0" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <a href={ytWatch(vidId)} target="_blank" rel="noopener noreferrer" style={S.ytLink}>Ouvrir dans YouTube ↗</a>
            <button style={{ ...S.ytLink, background: "none", border: "none", cursor: "pointer", padding: 0, opacity: 0.7 }} onClick={() => onSetVid && onSetVid(exKey, null)}>changer de vidéo</button>
          </div>
        </>
      ) : (
        <div style={{ ...S.exoInner, padding: 12 }}>
          <a href={ytUrl} target="_blank" rel="noopener noreferrer" style={{ ...S.btnGhost, display: "block", textAlign: "center", textDecoration: "none", color: "#ff6b6b", fontWeight: 700 }}>
            ▶ Chercher « {name} » sur YouTube ↗
          </a>
          <div style={{ fontSize: 11.5, opacity: 0.6, margin: "10px 0 6px" }}>Tu as trouvé LA bonne vidéo ? Colle son lien : elle sera intégrée ici à chaque séance.</div>
          <div style={{ display: "flex", gap: 6 }}>
            <input value={linkInput} onChange={(e) => { setLinkInput(e.target.value); setErr(""); }} placeholder="https://youtube.com/watch?v=…" style={{ ...S.input, fontSize: 13 }} />
            <button style={{ ...S.btnPrimary, padding: "8px 14px" }} onClick={save}>OK</button>
          </div>
          {err && <div style={{ fontSize: 11.5, color: "#ff6b6b", marginTop: 5 }}>{err}</div>}
        </div>
      )}
    </div>
  );
}

function SessionLogger({ session, onChange, lastSessionSets, prs, muscleScores, exPhotos, onSetPhoto, exVids, onSetVid, onFinish, onCancel, onMinimize }) {
  const routine = session.routine;
  const [addOpen, setAddOpen] = useState(false);       // picker "+ Ajouter un exercice"
  const [addSearch, setAddSearch] = useState("");
  const [addMuscle, setAddMuscle] = useState(null);
  const [showRoutineVid, setShowRoutineVid] = useState(false); // vidéo de la séance (routine importée de YouTube)
  const [elapsed, setElapsed] = useState(0);            // chrono séance
  const [rest, setRest] = useState(0);                  // chrono repos restant
  const [restTotal, setRestTotal] = useState(0);
  const startRef = useRef(session.startedAt || Date.now());
  const [data, setData] = useState(() =>
    session.data || routine.exercises.map((e) => {
      const ex = EX_BY_KEY[e.key];
      return { key: e.key, rest: e.rest || 90, note: "", sets: Array.from({ length: e.sets || 3 }, () => (ex.isTime ? { secs: "", done: false } : { weight: "", reps: String(e.targetReps || ""), done: false })) };
    })
  );
  const [openYt, setOpenYt] = useState({});   // { [exKey]: bool } lecteur vidéo ouvert
  const [pinned, setPinned] = useState(session.pinned || {});   // { [exKey]: bool } priorité manuelle (override)

  // Sauvegarde continue de la séance en cours (survit à la fermeture de la page).
  useEffect(() => { onChange && onChange({ data, startedAt: startRef.current, pinned }); }, [data, pinned]);

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
  // Ajoute un exercice EN COURS de séance (n'importe lequel de la base).
  const addExercise = (key) => {
    const ex = EX_BY_KEY[key]; if (!ex) return;
    setData((prev) => prev.some((e) => e.key === key) ? prev :
      [...prev, { key, rest: 90, note: "", added: true, sets: Array.from({ length: 3 }, () => (ex.isTime ? { secs: "", done: false } : { weight: "", reps: "", done: false })) }]);
    setAddOpen(false); setAddSearch(""); setAddMuscle(null);
  };
  const removeExercise = (ei) => {
    const meta = EX_BY_KEY[data[ei]?.key];
    if (confirm(`Retirer « ${meta?.name || "cet exercice"} » de la séance ?`)) setData((prev) => prev.filter((_, i) => i !== ei));
  };

  return (
    <div style={S.overlay}>
      <div style={S.sheet}>
        {/* réduire (garde la séance ouverte en arrière-plan) */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <button style={S.btnGhost} onClick={onMinimize}>⌄ Réduire</button>
          <span style={{ fontSize: 10.5, opacity: 0.55, textAlign: "right", lineHeight: 1.3 }}>Séance gardée même si tu fermes l'app</span>
        </div>
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
          ) : <span style={{ width: 1 }} />}
        </div>

        {/* barre de progression du repos */}
        {rest > 0 && <div style={{ height: 4, background: "#1b1f27", borderRadius: 99, overflow: "hidden", marginBottom: 12 }}>
          <div style={{ height: "100%", width: `${(rest / (restTotal || 1)) * 100}%`, background: "#5ce0e0", transition: "width 1s linear" }} /></div>}

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <div style={{ fontSize: 20, fontWeight: 800, flex: 1 }}>{routine.name || "Séance"}</div>
          {routine.ytId && (
            <button style={{ ...S.ytBtn, ...(showRoutineVid ? S.ytBtnOn : {}) }} onClick={() => setShowRoutineVid((v) => !v)}>▶ Vidéo de la séance</button>
          )}
        </div>
        {routine.ytId && showRoutineVid && (
          <div style={{ marginBottom: 12 }}>
            <div style={S.ytWrap}>
              <iframe style={S.ytFrame} src={ytEmbed(routine.ytId)} title="Vidéo de la séance"
                frameBorder="0" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
            </div>
            <a href={ytWatch(routine.ytId)} target="_blank" rel="noopener noreferrer" style={S.ytLink}>Ouvrir dans YouTube ↗</a>
          </div>
        )}

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
                  <ExoThumb exKey={ex.key} photo={exPhotos && exPhotos[ex.key]} size={44} editable onPhoto={onSetPhoto} />
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontWeight: 700 }}>{meta.name}</span>
                      <span style={{ fontSize: 10, opacity: 0.45, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>n°{ei + 1}</span>
                    </div>
                    {zoneOf(ex.key) && <div style={S.zoneTag}>🎯 {zoneOf(ex.key)}</div>}
                    {last && <div style={{ fontSize: 11.5, opacity: 0.5 }}>Dernière fois : {last.filter(s=>s.weight&&s.reps).map((s) => `${s.weight}×${s.reps}`).join(", ") || "—"}</div>}
                  </div>
                  {/* priorité manuelle */}
                  <button title="Marquer en priorité" style={{ ...S.starBtn, ...(pri ? S.starOn : {}) }} onClick={() => togglePin(ex.key)}>{pri ? "★" : "☆"}</button>
                  {/* YouTube */}
                  <button title="Voir la technique sur YouTube" style={{ ...S.ytBtn, ...(openYt[ex.key] ? S.ytBtnOn : {}) }} onClick={() => setOpenYt((o) => ({ ...o, [ex.key]: !o[ex.key] }))}>▶ YT</button>
                </div>

                {/* panneau vidéo : lecteur intégré si une vidéo est enregistrée, sinon recherche + champ pour coller un lien */}
                {openYt[ex.key] && (
                  <ExoVideoPanel exKey={ex.key} name={meta.name} vidId={exVids && exVids[ex.key]} onSetVid={onSetVid} ytUrl={meta.yt || yt(meta.name)} />
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
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button style={{ ...S.btnGhost, fontSize: 12 }} onClick={() => addSet(ei)}>+ série</button>
                  <button title="Retirer cet exercice de la séance" style={{ ...S.btnGhost, fontSize: 12, color: "#ff6b6b", marginLeft: "auto" }} onClick={() => removeExercise(ei)}>× retirer l'exo</button>
                </div>

                {/* commentaire de l'exercice */}
                <textarea value={ex.note} onChange={(e) => setNote(ei, e.target.value)} placeholder="📝 Note (sensations, réglage machine, douleur…)"
                  rows={ex.note ? 2 : 1} style={S.noteInput} />
              </div>
            );
          })}
        </div>

        {/* ---- Ajouter un exercice PENDANT la séance ---- */}
        <div style={{ marginTop: 14 }}>
          {!addOpen ? (
            <button style={{ ...S.btnGhost, width: "100%", padding: 13, fontSize: 14, fontWeight: 700, borderStyle: "dashed" }} onClick={() => setAddOpen(true)}>＋ Ajouter un exercice à la séance</button>
          ) : (
            <div style={{ ...S.card, padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div style={{ fontWeight: 800 }}>Ajouter un exercice</div>
                <button style={{ ...S.btnGhost, padding: "4px 10px", fontSize: 12 }} onClick={() => { setAddOpen(false); setAddSearch(""); setAddMuscle(null); }}>Fermer</button>
              </div>
              <input value={addSearch} onChange={(e) => setAddSearch(e.target.value)} placeholder="🔍 Rechercher un exercice…" style={S.input} autoFocus />
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 8 }}>
                {MUSCLES.map((m) => <button key={m.key} onClick={() => setAddMuscle(addMuscle === m.key ? null : m.key)} style={{ ...S.chip, cursor: "pointer", border: "1px solid", borderColor: addMuscle === m.key ? "var(--accent,#e0245e)" : "var(--border,#2a313d)", background: addMuscle === m.key ? "var(--accent,#e0245e)" : "var(--ghost,#1c2230)", color: addMuscle === m.key ? "#fff" : "var(--muted,#cdd4de)" }}>{m.label}</button>)}
              </div>
              <div style={{ marginTop: 10, display: "grid", gap: 6, maxHeight: 300, overflowY: "auto" }}>
                {(() => {
                  const q = addSearch.trim().toLowerCase();
                  const list = EXERCISES.filter((e) => (!addMuscle || e.primary === addMuscle) && (!q || e.name.toLowerCase().includes(q) || (e.aliases || []).some((a) => a.includes(q)))).slice(0, 40);
                  if (!q && !addMuscle) return <div style={{ opacity: 0.5, fontSize: 13, textAlign: "center", padding: 10 }}>Cherche par nom ou filtre par muscle.</div>;
                  if (!list.length) return <div style={{ opacity: 0.5, fontSize: 13, textAlign: "center", padding: 10 }}>Aucun exercice trouvé.</div>;
                  return list.map((ex2) => {
                    const already = data.some((d) => d.key === ex2.key);
                    return (
                      <div key={ex2.key} onClick={() => !already && addExercise(ex2.key)} style={{ ...S.pickRow, ...(already ? { opacity: 0.4, cursor: "default" } : {}) }}>
                        <MuscleIcon muscles={ex2.muscles} size={32} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: 13.5 }}>{ex2.name}</div>
                          {zoneOf(ex2.key) && <div style={{ fontSize: 10.5, opacity: 0.55, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{zoneOf(ex2.key)}</div>}
                        </div>
                        <span style={{ fontSize: 18, color: already ? "var(--muted,#3a3f4a)" : "var(--accent,#e0245e)", fontWeight: 800 }}>{already ? "✓" : "+"}</span>
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
          )}
        </div>

        <button style={{ ...S.btnPrimary, width: "100%", padding: 15, marginTop: 16, fontSize: 15 }}
          onClick={() => onFinish({ routineId: routine.id, name: routine.name, durationSec: elapsed, exercises: data.map((ex) => ({ key: ex.key, note: ex.note || "", rest: ex.rest || 90, sets: ex.sets.map(({ done, ...rest }) => rest) })) })}>
          ✓ Terminer la séance ({fmtTime(elapsed)})
        </button>
        <button style={{ ...S.btnGhost, width: "100%", padding: 12, marginTop: 8, color: "#ff6b6b" }}
          onClick={() => { if (confirm("Abandonner cette séance ? Ta progression en cours sera perdue.")) onCancel(); }}>
          Abandonner la séance
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
  subTab: { padding: "8px 14px", borderRadius: 8, border: "1px solid var(--border,#2a313d)", background: "var(--field,#0e1218)", color: "var(--muted-2,#8a92a0)", fontWeight: 600, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 },
  subTabOn: { background: "var(--ghost,#1c2230)", color: "var(--text,#fff)", borderColor: "var(--accent,#e0245e)", fontWeight: 700 },
  periodBtn: { flex: 1, minWidth: 56, padding: "7px 8px", borderRadius: 8, border: "1px solid var(--border,#2a313d)", background: "var(--field,#0e1218)", color: "var(--muted-2,#8a92a0)", fontWeight: 600, fontSize: 12.5, cursor: "pointer" },
  periodBtnOn: { background: "var(--accent,#e0245e)", color: "#fff", borderColor: "var(--accent,#e0245e)" },
  levelPill: { display: "flex", alignItems: "center", gap: 6, background: "var(--ghost,#161b22)", padding: "6px 14px", borderRadius: 99, border: "1px solid #2a3140" },
  levelBadge: { width: 70, height: 70, borderRadius: 16, background: "var(--field,#0e1218)", border: "1px solid #2a3140", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  obLabel: { fontSize: 11, opacity: 0.55, display: "block", marginBottom: 5, marginTop: 2 },
  app: { maxWidth: 560, margin: "0 auto", minHeight: "100vh", background: "var(--bg,#0d1015)", color: "var(--text,#e8ecf2)", fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", display: "flex", flexDirection: "column" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 18px 14px", position: "sticky", top: 0, zIndex: 10, background: "var(--header-grad, linear-gradient(180deg, #0d1015 70%, rgba(13,16,21,0)))" },
  logo: { fontSize: 24, fontWeight: 900, letterSpacing: 1 },
  tagline: { fontSize: 11, opacity: 0.4, letterSpacing: 1, textTransform: "uppercase" },
  bwPill: { display: "flex", alignItems: "center", gap: 6, background: "var(--ghost,#161b22)", padding: "6px 12px", borderRadius: 99, border: "1px solid #232833" },
  bwInput: { width: 48, background: "transparent", border: "none", color: "var(--text,#fff)", fontWeight: 700, fontSize: 15, textAlign: "right", outline: "none" },
  tabs: { display: "flex", gap: 4, padding: "0 12px 8px", overflowX: "auto" },
  tab: { flexShrink: 0, padding: "8px 14px", borderRadius: 99, border: "none", background: "transparent", color: "var(--muted-2,#8a92a0)", fontSize: 13.5, fontWeight: 600, cursor: "pointer", transition: ".2s", whiteSpace: "nowrap" },
  tabActive: { background: "var(--accent,#e0245e)", color: "#fff" },
  main: { flex: 1, padding: "8px 14px 24px" },
  resumeBar: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, width: "calc(100% - 28px)", margin: "0 14px 8px", padding: "11px 14px", borderRadius: 12, border: "1px solid #3a6d4e", background: "linear-gradient(90deg, rgba(46,160,90,0.22), rgba(46,160,90,0.10))", color: "#eafff1", fontWeight: 700, fontSize: 13.5, cursor: "pointer", textAlign: "left", animation: "fadeIn .3s" },
  footer: { padding: "16px 18px 28px", fontSize: 11, opacity: 0.35, lineHeight: 1.5, textAlign: "center" },
  card: { background: "var(--card,#141921)", border: "1px solid var(--card-border,#1f2530)", borderRadius: 16, padding: 18, boxShadow: "var(--shadow,none)" },
  heroCard: { background: "linear-gradient(135deg, #1a1f2b 0%, #141921 60%)", border: "1px solid #2a3140" },
  cardTitle: { fontWeight: 700, fontSize: 15, marginBottom: 4 },
  miniLabel: { fontSize: 11, letterSpacing: 1, opacity: 0.5, textTransform: "uppercase", fontWeight: 600 },
  muscleDot: { width: 10, height: 10, borderRadius: 99, background: "var(--accent,#e0245e)", boxShadow: "0 0 8px #e0245e" },
  exoInner: { background: "var(--inner,#10151d)", border: "1px solid var(--card-border,#1c222d)", borderRadius: 12, padding: 12 },
  exoIcon: { width: 44, height: 44, borderRadius: 12, background: "var(--ghost,#1c2230)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, color: "#ff5c8a", flexShrink: 0 },
  chip: { background: "var(--ghost,#1c2230)", padding: "4px 10px", borderRadius: 99, fontSize: 12, color: "var(--muted,#cdd4de)" },
  tipList: { margin: "8px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 7 },
  tipItem: { fontSize: 13.5, lineHeight: 1.45, paddingLeft: 18, position: "relative", opacity: 0.85 },
  input: { width: "100%", boxSizing: "border-box", background: "var(--field,#0e1218)", border: "1px solid var(--border,#2a313d)", borderRadius: 10, padding: "10px 12px", color: "var(--text,#fff)", fontSize: 15, outline: "none" },
  logInput: { flex: 1, minWidth: 0, width: "100%", boxSizing: "border-box", background: "var(--field,#0e1218)", border: "1px solid var(--border,#2a313d)", borderRadius: 8, padding: "9px 10px", color: "var(--text,#fff)", fontSize: 15, outline: "none", textAlign: "center" },
  logDone: { borderColor: "#2e7d4f", background: "var(--ok-bg,#10201a)" },
  logPR: { borderColor: "#c9a227", background: "var(--pr-bg,#1f1c10)" },
  previewBox: { marginTop: 12, background: "var(--field,#0e1218)", borderRadius: 10, padding: "10px 12px", fontSize: 13.5 },
  suggBox: { background: "var(--ok-bg,#10201a)", border: "1px solid var(--ok-border,#1d3b2c)", borderRadius: 8, padding: "8px 10px", fontSize: 12.5, color: "var(--ok-text,#8fe0b0)" },
  btnPrimary: { background: "var(--accent,#e0245e)", color: "#fff", border: "none", borderRadius: 10, padding: "10px 18px", fontWeight: 700, fontSize: 14, cursor: "pointer", whiteSpace: "nowrap" },
  btnGhost: { background: "var(--ghost,#1c2230)", color: "var(--muted,#cdd4de)", border: "1px solid var(--border,#2a313d)", borderRadius: 10, padding: "10px 14px", fontWeight: 600, fontSize: 13.5, cursor: "pointer", whiteSpace: "nowrap" },
  stepBtn: { width: 30, height: 30, borderRadius: 8, border: "1px solid var(--border,#2a313d)", background: "var(--ghost,#1c2230)", color: "var(--text,#fff)", fontSize: 18, fontWeight: 700, cursor: "pointer", lineHeight: 1 },
  checkBtn: { width: 34, height: 34, borderRadius: 8, border: "1px solid var(--border,#2a313d)", background: "var(--ghost,#1c2230)", color: "var(--muted-2,#4a5160)", fontSize: 16, fontWeight: 800, cursor: "pointer", flexShrink: 0 },
  checkOn: { background: "#2e7d4f", color: "#fff", borderColor: "#2e7d4f" },
  pickRow: { display: "flex", alignItems: "center", gap: 10, background: "var(--inner,#10151d)", border: "1px solid #1c222d", borderRadius: 10, padding: "8px 12px", cursor: "pointer", transition: ".15s" },
  pickRowOn: { borderColor: "var(--accent,#e0245e)", background: "var(--inner,#1a1016)" },
  goalBtn: { flex: 1, minWidth: 0, padding: "10px 6px", borderRadius: 10, border: "1px solid var(--border,#2a313d)", background: "var(--field,#0e1218)", color: "var(--muted-2,#8a92a0)", fontWeight: 600, fontSize: 13, cursor: "pointer", lineHeight: 1.2, textAlign: "center" },
  goalBtnActive: { background: "var(--accent,#e0245e)", color: "#fff", borderColor: "var(--accent,#e0245e)" },
  overlay: { position: "fixed", inset: 0, background: "rgba(6,8,12,.82)", backdropFilter: "blur(4px)", zIndex: 100, display: "flex", justifyContent: "center", alignItems: "flex-end" },
  sheet: { width: "100%", maxWidth: 560, maxHeight: "94vh", overflowY: "auto", background: "var(--sheet,#0d1015)", borderTopLeftRadius: 22, borderTopRightRadius: 22, border: "1px solid #232833", padding: "16px 16px 28px", animation: "slideUp .28s cubic-bezier(.2,.8,.2,1)" },
  chronoBar: { display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--card,#141921)", border: "1px solid #232833", borderRadius: 14, padding: "12px 16px", marginBottom: 12, position: "sticky", top: 0, zIndex: 5 },
  restMini: { background: "var(--ghost,#1c2230)", border: "1px solid var(--border,#2a313d)", color: "var(--muted,#cdd4de)", borderRadius: 6, padding: "2px 8px", fontSize: 11, fontWeight: 600, cursor: "pointer" },
  toast: { position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", background: "var(--card,#1a1f2b)", border: "1px solid #2a3140", color: "var(--text,#fff)", padding: "10px 18px", borderRadius: 99, fontSize: 13.5, fontWeight: 600, zIndex: 200, boxShadow: "0 8px 24px rgba(0,0,0,.4)", animation: "slideDown .25s ease" },
  moveBtn: { width: 24, height: 18, borderRadius: 5, border: "1px solid var(--border,#2a313d)", background: "var(--ghost,#1c2230)", color: "var(--muted,#cdd4de)", fontSize: 9, fontWeight: 700, cursor: "pointer", lineHeight: 1, padding: 0, display: "flex", alignItems: "center", justifyContent: "center" },
  ytBtn: { background: "var(--ghost,#1c2230)", border: "1px solid var(--border,#2a313d)", color: "#ff6b6b", borderRadius: 8, padding: "6px 9px", fontSize: 12, fontWeight: 800, cursor: "pointer", flexShrink: 0, letterSpacing: 0.3 },
  ytBtnOn: { background: "#ff0000", borderColor: "#ff0000", color: "var(--text,#fff)" },
  ytWrap: { position: "relative", width: "100%", paddingTop: "56.25%", borderRadius: 10, overflow: "hidden", background: "#000", border: "1px solid #232833" },
  ytFrame: { position: "absolute", inset: 0, width: "100%", height: "100%", border: "none" },
  ytLink: { display: "inline-block", marginTop: 6, fontSize: 12, color: "#5ce0e0", textDecoration: "none", fontWeight: 600 },
  delSetBtn: { width: 30, height: 30, borderRadius: 8, border: "1px solid #3a2730", background: "#231318", color: "#ff6b6b", fontSize: 20, fontWeight: 800, cursor: "pointer", flexShrink: 0, lineHeight: 1 },
  zoneTag: { fontSize: 11, color: "var(--accent-glow,#ff8fb0)", opacity: 0.9, marginTop: 1, lineHeight: 1.35 },
  noteInput: { width: "100%", boxSizing: "border-box", marginTop: 8, background: "var(--field,#0e1218)", border: "1px solid var(--border,#2a313d)", borderRadius: 8, padding: "8px 10px", color: "var(--muted,#cdd4de)", fontSize: 13, outline: "none", resize: "vertical", fontFamily: "inherit", lineHeight: 1.4 },
  cardPriority: { borderColor: "#e8b13a", boxShadow: "0 0 0 1px #e8b13a, 0 0 18px rgba(232,177,58,.18)" },
  priBanner: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, background: "var(--pri-bg,#1f1c10)", border: "1px solid var(--pri-border,#5a4a1a)", borderRadius: 8, padding: "5px 10px", marginBottom: 10, fontSize: 12, fontWeight: 700, color: "var(--pri-text,#f4d03f)" },
  priPin: { background: "transparent", border: "1px solid var(--pri-border,#5a4a1a)", color: "var(--pri-text,#f4d03f)", borderRadius: 6, padding: "2px 8px", fontSize: 11, fontWeight: 600, cursor: "pointer" },
  priSummary: { background: "var(--pri-bg,#1f1c10)", border: "1px solid var(--pri-border,#5a4a1a)", borderRadius: 10, padding: "10px 12px", marginBottom: 12, fontSize: 13, color: "var(--pri-text,#f4d03f)", lineHeight: 1.4 },
  starBtn: { background: "transparent", border: "none", color: "var(--muted-2,#3a3f4a)", fontSize: 20, cursor: "pointer", flexShrink: 0, lineHeight: 1, padding: 2 },
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
