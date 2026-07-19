import React, { useState, useEffect, useMemo, useRef, useContext, createContext } from "react";

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
  diamant: "data:image/webp;base64,UklGRoBdAABXRUJQVlA4WAoAAAAQAAAAxwAAxwAAQUxQSONFAAAB/yckSPD/eGtEpO4TDiNZrZsHPIyIH/0XLOXfQET/JwB/bvOSfdfdnZMzU91mqNOkqzozw1Zmm5QOwBbq9qlMJ5mZOa4DUO5kpSS3HIUrD1e5O8sUNJuJCGVvVU6SAgjErkygtov0wU3APSLyUFN1ERgGCUmKmW5UVZEA7RghROeGjYskD6HQDaDwmIsASfc4aw6YuQBskhAT+QSTJLDcvQMhZZ4WSYK+B2T9DFxrLRwkqbufVNVjkeGJbbBvqFogyFCoX8O6klgRULfwiu0wu2Fm9tJnv8Bg0LaRpCT8Wc/svQQiYgL4eT3RtNs0FC3iWFhppZVteM41PTXymC1qOBulVpBZQ6wcAK4NNU2F2tTy3AW0yjYrFq3yzFxQb8WCOrgAeBxrVKA22lIBGiq6qQ1g8QoXVR5CTZVUzmEpw2uft0Rt2zFJ0v287/f9ivwDGRmpSpXtatu2bdt2r8bWyvbMyrOb2WNvrbxrd/8RdSL+yOlZTkRMgD7+/5XJabbvOefS8Zmd2Zl192yycSEQIcFCcOrQQr3lfuru7u4td0up0d4FihYJBBKSEOLJJrub3c26juz4zGXn/EGS+3npv09ETIAfbNsTSbZt7Xk/SRGRWVk1qnsyMzMzMzOzNa/pzbmYlzWtZZGFHjMzMzMMZmispqpKCukzMjIysmHZETEB/B/p+p/hXbc8JEFAkIy8RjR777JkWXu2nchVp7rxaS6lq7sg6d0UKG9NZKGgGANLcb33VcxlIUC5ECZARFkjx3Uden0V6zQGC/933DhOrm24wJFDBAEggBwHIdc23O2a+cE4ybfRbe4AAScUZDNwdwQ+mFtoXdfIPeMUs2+mFRdV8jbHwPjhHtWVn+eWMz26aWTRjw8XIZfig9U7F8u18uNx2mozqo7mdV32n1sf7i3um59evDTb21l6zYVjrtNhtfAIcaRlm+VJj6x8b9HujxbhcZ0NO+kL01OpB+4s+4u2DvPD3C7bsigC1wCua+a11YIgpWRlUdxCfZONx6TJk/ceeERL42rf6cXUwi13nS1WKywOfJq1XGR3tzLADd9CiKUEkRRJD8ggGlG8rlYZNPSSNC/e+DtjZTAJRBSZR+UcFTLx/03JTNHAdlBkWXU4EZUdmXp7qU2bnoHJdlsLSJmSYalOVgnpxOLmGIZuPAYCDaMKB9XVsSWHIisK8UoSCTVo7p5GB9wbylY7C8LMt7TEJZ1R7tQKo+CAtiFbjYpCkBjWdmuLwUWxnGTJ66KxmrjL1er3xQgGdqolTylpSBfUtnlNrxX5vSoEB7QNAdjqItLn1FVqxhENA41kkZIrzJVK2e0iYGFfhVpRgUunUWrQOVl2chluLK0S0yk0ERTGaRhzk9v8CuLNVSVl7/eOm2gpiWEKzRbkWIeYzVtVWdPo6962kGqP4bKFYrLKjOEnzJPrLp23lfYn0RJZw0gWUh76EMbqKTA4+tFlN5EtmvsQ/BXPXSgTm1w9e9e0K1zrRm1nuQqCXA5hBWVFwvK5iarcUD6ef84PPkrjFANC2kxyec4HfmjSWAnvkK94jM6GZz3ZxnWUIxDrZ6Qe1M9/4K5S5PHyi988IUom6b0KQZUzgsvmpVDRpUBxN1h7k6Lwz+ApxIgk+goXbhSFMnzkb8uEN8cprAkC3sAajdkjLf1kxKGCFi/A7Njp6RwcwWU/zOxAgnslOV8OKSfOTdlwmZ66P25cbBOTGbfXnBk2iaq7JEf0DGSxWgIR5Wgzrxgam/rlZb0Knc7qmyryo5ew6lnVR4mVzXBrvbYexah3iaSAsXJe1ySvlnK5w5RNw3hvnEL2hSYYvK6sRcB0vdKVSNYDzM1RNohltivYcmTXUr/Xs1qVEApgBnLIUtvXwJqRlOpYAgtSqnnVk7AOKYfgmSoeWVY9iur1S1Re5m0v501UlFJ6mmdQkgwuEwrK1TYupRDV41l+W5OLSjDjltgCePi+gVYUDHiFWoeIAEUUzRuFv26O5fSwW6jAQsjNaHceIoBAHi1D7fpqMLMUXlcLVMU8O5ReDlig3ntEcsJmOlHcgiqlDdtGTVwmkAuPH57/rsuAlE3BdgjSM2XkYCt5O1B/D5NRlCVkb8aYJr5JVnXXSy5ZpiTmOYS4yGbIFAw3T2OdyF6hKUXUKmZVY7IkY0MBoriiMkXXJN2lAaUTDqe4oixko6QYdWyYy4owVitA59zcLUZDvrAhovpV4729ySgiPFdIskU42zDMZY62KUtyCZMaCRSNEoKZooHX9PCyVRCSWiyKlkHP3HmBe1QFMU/Bq5d5fN4GJoVgSfjCNIrCcqwdUtgNh6F4lDxVstjqTrcYw8WxjdLznjQNxYvMlAWo2GafjGVzyyIvOZ7UzGIIIVSNchtyHVUVsX1tUfdGm0StiwXYOK9cPHqkUfaEKu6pT5iWkzP0QKDCmoTFerHMydLIW7emLCqzch0EkUuXRiFWFszXzzGeJZx71dcvKcU3LbzyRoDa7m2Pdi+VjJJbL/7Ft7Z1HE9SM65qi4v97izJz4uIiK5tL7l9trLZPAMpHubyjlbKcy6YxKWGWMXDVWJV74ZpImm6/4iLLTnGZFNvtQTjoebz+yMrIc0nrlv+zzhYSlWz4+5XE6qLlIXJBMDEdbFgjZ+Qsg0iCpW1U0KVNU0WgnE4mTR38oY3EC9JTjMvaYT8txxTBmDPySEjPzvPZFnTnHCDUBVLcYTulm7pXVIdyk235Ci67k9Wn05uhBeMk5IjhFRoRpb8r6V+Tc5Vum1qHI7XVi1LAEQEd5xWFLtoQwWU4SndYZtbEpICTeU05i8UDC45yUgcNZUBL/4nFhRAYMHTVlj0eC1BVakYC7oZbOaSFWoGY6Yjqe6gUyLuoKKn3v1qt9kVctAoMyZzvqEiIv8v1ZtGlUnGfcry4FG5JHwee0kAIOJWcwplCY6kMFBb0nxvu+WwrThMl1RN8TV6TeJgl2oRRSGvE5xfRrELORUgaTdxXNdatuYKKOY6f4hZlmFRrksDaUnRJblCt2RdllL4Qmo5PAA3d6itoP7q+CL+V/aFoo93qXC5/JsOgEvuiH6evw6h2ycFc3nVsttVpJzrdWMD3LIZdyKuVElvjYApwUVfFAKvFyD0Ug6VnCAVQLW3ultW2+orNDXZud1rG1QRsK+2FxwpEmDC5UNQdejsFW8o0UePQbaiCMbErprHXqQQ/+vwdxeANd2wWXHb4kTIFfZJkg0ARFzZuBRlQVXXCpAdFtJ12/IzxRusVDhLzXld6iZ9z6hpXQyJ84sgHYXze/Ys+HQQVLYta5lJmwYpiOw+XR22FJ/fzWfTiqYRxW0HW0yfz8hLHwuufNCSTU0lzVvDmaU40Sm5DI2MdrOiKIQjUk336v0uRREu/jpw9VbSWGGmQ47WadkSNSlJrP+EE4g6PG0pkuKvFRP5tODW60R2/1P/PguBF8/f1viVpEsAYB5/pT8bn5w0THlyAFmi+qRwjHs8HhSpX3NX+hWEz98SKgH2a6KkMBruAiaWioyIyxitAPfUQOYcxCnU3Ln6+NmsRaLKRSjf+KbSahLkNmxeLJXNfCY/cNWnGkxe3LwjrVFTS5SU+WOQxesyWLniJUYB+Y9/jP7tl7d7CExYFCAZZStN2GYuLxzD6b2ujpq2bckRl7vC9lB1vvrNwoA68cAanaOUwcyL87IQ+F/aTGDG3IA211mXD4myoWUvQkC3H27tVKhRzCvULBu2LUYPdq8eVOzqlSbDunaJCTGTpXg9CSie4a7X0N6Z//ir57/9/ut6JQJBuTFFaDrQxQgzmOx0ffCGe+tzCwZEcG09i3ZKkPirHwAHYuLyzVeXHCtvW3/en5lORvRLZEUdRNVgU483MR8dC/Qu7/KchAFYfsRcMOjQtL55fY3ihPyMuqrmh+NcnVv0lpNmrb9cqT6IWgGk/L0Y9vmHn3/zt7430yQDEBaT+l9aXDDsc8xb1eJxOZnGtXsPl/0urnfZc1oO61as7D1qQ0BZOpdnrmK6etXsy/Hj44uH09whnXQYNiolHHZEhTLqdfm1cbtFbVm+VXO0QkA4LZSZPTe0kLJ95U0mJS3b8kuWotmK1zxw0pQOj25Ca4z+js0X8qGVA2vw7wXBARBV8BeOGVTYjUHZ31WCM//ocMSnBTS3n5xudc/Qtq4VgykqAEUQ61TBDLEDizFTongHmmuh4bkqJGw/1g0RVaWuYK3tDSeEsixYwldAYI5D1McwMZ0PrHRH6t+6zckSBru22etXs1YeP+E42wqn8XIdbxLw3I4/KJ0EF7eHrFjm6OLKWyIlw5aFxLK3eTLeWDFVXZuH6qDdGcVFLTr/fqA5Wpf31+EerxsPAGLUzuBmRA6mKuFAkKpKch7VYRN1gcRzPkhE5FIGlYLB6ltlOVeQfdR09y2rR+lZzzmLsyqQrikRAuTg4Xe1gFwMgmD6hLJ2bcy0CSSFbdlqFo1Fp5oCREJz5TE4F6NwS2NlOnsxrytICg4yTNIoBssmkqVOZLLkDQUlMwbPa0KOcNZzFCoiAIjIOHpNU6/OWDrt3qRp9b1dFX7PM1mi1hMAMhYLAkDQQm3voYNEvI5TCI4ilfQIjcR8Ht/m6xEtHSe+GkMAIG9yC0lcBLd85kWF862yofhowTGTwK/uUAcRe/lJS8GtEd9qbuYYeqaHhJ7G14CCrFBACPL+qCegxSQynytmoq0xb0VTQ7uTKEIOlOypt4BTABLGy3UzHIBT4MwFQQBXuKGit0vXO64B7Cka8vggCIDbCSG4RDh/+U3FZD1KplpajkJJoTLwHWkdBLEdk0ZDuIjUbdCCAX3tAaLPZq0DUB/G60kqZUy7KyVrOpUkbe7xmVjMC5TpXpiNKq4Dn4gJCkCAdB+I9YwTLgiTF1Sdu4U1fTRjufS80VElrBNKU0MMIHi9ELjMs8953mRVGHxe1bx2r/Oi4IG6WiNrtguhu2neX2kIYGVxMJI8xHsIUALAOfFCokAKti9iz/u8YZwvnDSVlR1nOZOY3/W2EmEACPgm/vdqxaJELEbILFWC5TOHlcFSuyfoUxSWG3Z56iEILkpwuQePDMN3weGGontbcJORJVYLUU1ikBVFo0wLaXWEwHJtOqYE76av6Jt9/KxhMlm4vBUZbVmDU4hNDHXXEZsqSJydzbZ5ZAOXlD2UubFstxhHVoZKoy4a77+5csaQaxopJc5JQ1fUQqfoSbDKGs6u34YRa1XRpzqy8CqcUeHb0AAh7azZvGSrsupA1rUqi4GKPu/Q8vO9qrzA82f8kiO4q9MrE9ZcSQcrovnR+QZdESSQSUwkF1VcpjBoFZ5qZD1rOBsYMiMbka2P2hUu4eZHxgONtQqbE+5efdI68Q1wp8YOLcIlEzdhwiZimzH2MxG5/J6DixpVCAsqSqREQQTbtKDvnZX3Q9agWk/YLwjXfQpIK3NG1EpJmR+rhCjjzrcr4wWIyyhCKs2FSnZUniaeV2Jrls5XVIQhJH/66JhH6qjM+WZUtLaeLJ8ELD3gdU0QjW4Kl4MKxbdirj4CcLxzc1QKEhoIEM2YAagI1/c/5pCNVV6WPE11vkI66HNpjqSUkyTXWasC4jWsDvpVXPaRGzjeFIRA2ogwZE92mpUQAheOLTQvz5Ypw30TQXeRxKzDKW0yI4VAneqEijaVSstVKACURe48Z8jLWyd8LlYbLYMKwhvi/1aKfAOYeRuSJ2zW1aUXPbKtOfPueKVLypxZuUqD/o2TGWFfonDXI0pM6WoVlCQnV4r8TGU5FQCoOTFbv9zlZJh8xtmQioo3zi3mCIeppdarKRcXF1Ixs7xTXzVEYt5zxOfdHF3UvO0rahwCELL11C+dYiNozAAE82npBbkGAEdJttixWEsA+PQ3vpaVhs5dxDn+5rA7dvQzG2AlxQMbt5ah5SoBAhT8V9GxWCw9cp6NxU29L6WIkDiRjrd5Z5JFxUMN2VvHHhoOJFAXFbbmhlVfonXbutUsACJcb/3Tn/XN4PALmrtIVEnoFRQXFUnnbpRM47dvffB8R9OLszjO/Ff+wpM5HbjernDZvj2n3uJzF1Udr6cVfgQ8M/Or2FRCfv/YCQiBPNPtHFeoYwW8Cw1riYTUNbgBMXBJ44QwR6MLYf/KbR4vBwDiPPU7fuV/LG8E1+zjddVMUtwucJkAELSE6XMXSPUkvtvwy42RC49Bzs23vnbwX49sW8y3rREt7eV0VXPGC0tI4K4KDuVoeTvzjewdPY+CAk45ai81X3A7+eYa2zg1bpHJw7Yh1u3CwILlhWvx1O1T+m7e0SxO+goG8cpty0D/Ow6uYBEK4WnqowBgzx9atrH9nS+cerDNXYMrj4tmAJx3eu7Uwtp9W3fsh++q3549zi10JZMe07h8OatxNuXKlvNxAjBT0fP9K7M+q/WajEoKXMVnU20Bzfa8YXIV8NQ+NXK2cH27WkUmXRIsvXO3Tf47qCAWSeVQSuq4ePFL/jf7m27+/Psjvrt//OYNXy0BAud27Tjz3K2NPG83qa93zTNFS5TDDNkWc73qxRGxIaG4kZwhAHTix9xVubyV3elOu4Qj3MmFLVpiWExd2Kig6tKQ23RdlY3RndiKVYLgn38vOZusBqMxL9fwekHEsavWr26uBvGHYrW77j/zBkOzyciG5YGPbYgNqju+c9/DQtgX78NDqtu7Tz8xMiStS5oCgMQ0TOyQ+wsnnUTW8ArL2bLF4CEUEY3jUrY3ViSXvr7A/HZpQacQ1gd/3YqyGYGyrgkUEATEkf5+pbLjxNcYBerXSdFnrCu2EumlB27ojfRaUtD2ucKrz0yN7q2Qy5onP7bgmxF4T3x32BIAyUWBpqopznnLS7lSheOYF0mGbEgoSIdvdafMU9p91oLLVawmMl2lcICvADR+xlfFgAQgeD2nMPW5v7z/zF/WMkKJvPOGe56Y5zu7pzI9c48sd1dkFvipMPnkc/85DIWyXGBImyHcfvTHNgSYJw8YLnUkGg3NDC7FM5xYLZM7oKEZe7ZlVhoLteeo+4Nc0ww+m5wq6gJSI6oIXaVdc0lBiSD6sc/8/pVn3xgECEHXj14VQ6OKS9Tt/em9Z5zexgtLbpwSwvj3qEA8dLtHhuVhb3aGcECmHMhXAvHa0UNWnlAOMkGI3gY0HASh0/W0k+tqvhj7JE0hVPUcTM5cxLs4zqaLIfAF7rGXINZL7Y0Z/Jm03rGlIYCaOl1T/mQbluhAg/fla+556B6KTSeWjdCufx16x82nT045fccxQwrANBWvDgLIqgUIy4s4UTJCtiSJU7cKsOX2/cPyAHmZxrF7E6yKofdVLCoO6ZmfDbezVgiRa6dLVPxgiVrvA6Ho3+uNr7sBgB7V/V/58r3XuH4kTEGLEDnPlqkfnh/P+eiX7rYAc0Vw09jLv3vfH1yhDFAYZkfsZUEIAKoKQQqkKjHXZ+QcrS1qqMRTbB0/tk4+FNHeLEKZRhmax5R9TF0r5UyX3houRDM2uRgAKpPy4RRgcB0JSi4HpOaXR3e711WCaT7y1SRzBj5jgwoUm2cML5k6ua33B2PZ/a1wEdDPHemvP3WeCvy3BUdp70RmXAWhU9CUJc7O8pKh2Kq/RTaEYSkqpzhhV8uGk81HKGZKjbGw1wSTLpjE8BYTZlN3RxriUgRM5of6QR0vimH58syjDWxg5Sd0GfhUIe/GFY15CELgeRka5g7v+Pqr88L5fQCS3P3oD75+RiUW+W8JgrHDSfz9KDjWypkNDB1Pl9U2j7mYryAmIdSlOqJ41RQaBhbTXNjkcjMr6i4eKdgoCO/m8fgBKNVekMvgSNs4e9Ag0Iocl8tp/3R9crH/exUIfss0HUHKUgwABBK13cgt3vqgURBCPLLTi/c8uXPnrx+eNSH+G0LCsTNA8rECFdy7Jt5Agx6HHXo7OCsYIQMMfq8pFhh6aDQE6c5es2g1fTp0WLJsF649n+ofA1NxaQ5RGpryIX5o0BqetzyX4dT5e96nzezp+dV32340LgQvJ1puBAVAEOyRuPjD+wTn3B577vnPfnWr1DQzVDFj0ssSFItHJoG6PokISuiuNT1Qlyc80urIVmExZ0kSpTaEMA2LJEWyfX25vIjJLxWJXS7xNdliadDBZRPwhf5JAhzb99N9scBlZOlfzh1f1evedEaIR677geCC5K+p5a+DAFMh8nd+W1jCPj8mFv7xqTWVs9ldE4NEXAYhGD1ehntzj0o4sO/XFu44COH2c9LclCM8T7wl4ZbAoQiIoZtbNBZbjYJcPFFUs46surUKKZpLEHGp+ScqwWmFWlvNEP/tT5ohLuFW/krjgzH32ohwHJHYZzrUntksCC5KYDu2eC76mOCmEEbuiW986+Mb3/PGgT+CXKqUk8+fhWvDLU2wCRz7sz9bZoj2ikw0yYhsyMXz+WxrHyekZFqhmiJG6knCprfOyrRUMqU1SW+N2xuu74gs2ORinEzdcC4PgsC2GzY3wuz39wG0hxlaO3AUnk/zOCxbiP2vpGaqX4HK6cWAoiUc566KF62Zv40IkfjS6p23X/erRx5JQqw5TCbTUNxmzqEE4/3v/ts9Zem5/dfbSZbm4EzP5VnnO68IFp2yw4t3xVJsJOYxPfOr3rQxZxjyHQvxSn8kEunu5BziIiD42UNRAsrh3nTDyijD1SGD5f8e4eLwjPlk9Q1hCJE5+9TU7H9dPbEZBJcUYAVbvODbXjJ+e+Wvlw58/9ELV5x4aXH2RXDwgi/u2hiVigf+fA4CMP9x8BPfytm9Wfzwzzx3IpxUrAGX4qpu74xmKdfNlW8YK4mhCQSceJm0dXACRZjnl70n7W8I+GZ7zEKq5IMgACcHf+rq4DlQC4ufXa3jysWkbb9yWNi2eN7QyKhvRf7wK2fSnTfEXnrot+8UPdWmZefL9/3mBUU8ENr0z0Uhzg66GBZrAXAimFz1F1DHiLQAZeu3rTcf3yTZDHWlg/vHCxmvQjedRzZ9YB41tNmdjs6MEiMQ7jZ+SqDGfcIwLUmu6vM3rtIjF1zFoeyiFIBFiSD8xRFv09SZMpGnbnAFEfpPQ4ihQ5xbgh4uZY0De+c+/1BXb62AeeX7/vbSYQ/Ije2pL517A7fErVf94cNf+WSZAGoLCMRcWMPUX4MqnOI6lB6LTNXdHT3jUWzIicWyIexCceBN/iMeIFFWhGN24fbRw/NwnYqzhmZvYmczlua3F1f3hOZb9b1KQEqNE5dVVIigufPqNTvFk3vLpV2bDv1hlbz1uMjuWRKGkF/TMmML49/+XWe1C4Tix372i99zyss6R+JT/xz7tiB84RMD1r4vXtfVUZ6KVYOI7Fz3ye+f7vzPq+fu6qp+8bn/mHm6dxNGIYm6ioRRsDQlON536+NTXrKEinxJlGW5e97YAOpQcAWXt+Y8l3t7tmirWshFIvrpYOOCs8GXPH0+rxp2iNjIet+00T310qNHv0fvMU79rC/4zeKrY05ZxM82XF0YftPmt8hhPS8gfuxb/vTv5fSx//im38kgYmxGcCEey2b2ZyjA2eGeF37CPnkXzB+G7nto5tP779c2Bpyil6CrVCQ2D2C+8T77KUW3Q/XH04zlslMWpAG8A8ncgb3m0T1SX1kCPBIaMRGONGeKVedOTCXLVS6hKowZUff0ZPxo+6c24jMJkf1+ePdnHhZlHh9K0as3XgHBIZoiBG/6+6dj9Ca5hlsptR45I7gjyg+Pn49SmTts4UHP4a6fAuUXZ+qPdt7xyRc9y6XJZBsv3S6lTULUyFLwE5h6rkoJXjf/uIdYZ8ZNPBF8gG55NZ6BaPoS6Zkao+zukZUaH/fXeEn02fOZcwuFRP7Kg2MjR0fSiYE/71+YhXpzfeSRCZH9+y7Wd1gI6WxhaLRbqwAD33m1gcnzKWwAekMYZ/++ZNti+hs397R6S9sBfBX8vjuAZ8e7VS51fRzBQP3iodMiO/BjXZjloqIn7kG/Ms1FEI/4IZSbYrFUWJWGQVlGK0rEkCROKONZGwg30nBtKcSl6OOnzVQhN3drxqn78Jdu/+yrmaWp5+8JynX+L35njzFX/n3Eu3vfzYMDsUgQe+MApe5sqTgbc9Bk/wEuHD78nb9/bna+hA48/0V59yeA/IPah/+N8NJnsKLPePZH+5XQw6ve4XKz0qJ85taWxXxitrqUfDXoF3LVx6tVWxm2E5xR0KNj7pRQabF7rVLvcWVCkuNrf2YkZJSNFj/91EBx9vSfHssvV257U5jhvZMffVZwMfyuUKBQD61+zZrIplaAozh+FHwjAEtnaoQj7OdP219PUKP2N7/x73iAwSGPLvvi/QNV4rsVb6V//+cRoPbXE9JKU6GiVLziDTiz+rWlKrOQYVa1Jb1wXKaqNZyZe5H2l/nKGRcsKRbsu0aOyvK4LnHATJWYVVLk0d3OO8AA2nbNTbeftRh6v/qzqANH6+d+YUz8snj9Z/qAi2FdAMcjAnDB5v/y2vjEH3rFe7//g0wI2nTlzut+Atep+pWP/x6A7N8rPn9/KZFNLeWy6ynGNrg0xeYg1cpkcUM8V7DI/zwFOSZ7ZJlbwY0aWzS0t9SFZMsaKrVwCsCYnVgypZGqFX+sYGAEWH/JnadM8vSbCyIqhING4L/uuvaHLY6JoYuBi9dzktnzVna+/6ffSBYUscF48P3j9QUjtQdgVMWXxWDzheTMxJE5BRI7aSy3IgqtKDdtujCbbsuaggtBbCC8CJIdg8obfe6SFV3unffrxBhb3GwDgKQZiRKPF974RMd2BqVWguWT9/uuP2G0zgNGbCHk7+z7dT03BncBLkAQwPnOCaNtl4ggWlcI9l4fbN5vAM0KPGTj2aGvAU56oLxC4WpmqCNgxbxSpF6MFszxJdiQKOQODSBDmKqoTUtvFnNKwNdpj7i16dTEtS7iCCC8BRnZm978RPVHrkNwi5pCnJ2x91ULa7UiCIWA81jlZii3lYbpmc27As8/XCCmIMEfJVLNvSXXawBpvfY54vF/5/t/6ySmnc8HKRc+VLeZ/oDqFJvEgp+Uma6AwrF9ZUi5RclTImwktUu74NPcGxYHE06dfnUj4ZQIuFd1Exf1/OiKDd+lPV/oW+waRNbfQURPGwgumiCh9nDUsGWRfHWi8ioE4A66AGfbxiIHEdtvXXgBuPENb/sAlKS1vgYEEb2yskttr9ZzybQZ1EjYRVWZCii2ogEAtXnMnCmu4dG2yZ6qCw0t56ZrV9YFOwCJgTnou8a7FF9/o/eDrd86vfuYe3ITzgcakJ4hIK8TxJSKAlsj8T07IqI7caBI6XWMAHhT6dj8Fu+qu2rua2cINjaAENroL0hSTZtkLkaWOx5SKRaraymFs+LEypCKlBc/8r6m5Vz2nMxszvNCoIfmnQhGqnSAAIQgtnV5AmFNvyXuPPCJqyZyw7n+PwR4xA9BAAiCq9VEd3mk6Dflbh2EM1GvxnPbd67trFkJbN2qCQHI7ny/lghUqb70jb0Usbe8WvHBVltgLpOHwq087juObmmYQ5HreHO/XOFprpC5Ozg1WYdLcqy5vRfwPiKOTdy/vi0k/+7TDPB0ufC/tOCUAJK94u1dsnnjVwQlxMZvunek6j4MQtD3wwRsAmh6lzdtTVQEaqKZaz2sptaemM/kCUgpn9FA1ePu3p9KgpuKUl/jqqwIuc3FHBl/oJLyi4EjfPt72+Qv7Xph8tXBsnsNGFZcBy6gua+uy9R6vFTJvPl+Sii21//m5wNnvnfbK4srP1QJEAJIqtSjuv+2nrB6Sa5U2gNDC+6cRBCcUThLpyWcwB2SfbchXhH08AkT04ej6wQBYAGEOiJTU7BOvjrTJSXFh1dxwYsCAhB+DQiIwRxsXZbbKAE+7nuq/OAfDxgdf6gGuCBAKg9eUzNIaw+vj1R3BVYkfrQpUixzh6QTGGXI8o5LLneIwnZ3BCvCihIvs4rujusYCLAw6gA0PxQ8OwstIVqThfiaPi8nZAkQ1qyXXx1EaOssgIabTMdGQ9fnzg3kf/vXp/ATcE4IhIX9E3lbteJ3nY0HK6IeUvmjEg6KciIlm5/ykUAojEpeX84qTU64VvoE9czZTR26KwIA5sThNAC5TRqH7pkxy4Ws2PaVdoilQchQUA/kVwOAIIgkMkwgFtyXuPOpJuJQvMPHGQEh8tD8oYkDw2aho2osoEoATibkP86LokiTVjthhCLZPGnuCMcxzUa5cE7pZMLl500VrEB1QEA+Jio4gU55gLKB5/pHle4DgXVrQ0icmoYpOnjH+SO2ySkAAYLpYZth5N/TYNveLT+8Nv+4bGm4cI1DKTD7amjysJE/dtxzviO+7pVOGEKrrnuo33KKIsbEFTWK4qqL1opK1LTzO9dMB6radMCNVT3u/h8fBXjZPpvYNjM4IwiRQmzw7HCi0Bu73678wN3UPnCgCCsFL8C5W8JQghjxsAYhKIyx8RTKjzyVV9/34Zb2wPlbTh6YN2EXAXBDHCtuG90XcwWtwfp1a0biVXY6AGt43rFJlghXaPvwwBrdlUQojBOxuLLaWNFNAMBfQY//+u+jRdiJZ16u6n/2H4/25yBCjC+ryDub8kRCZ4cPQ3/wIFz5y1uw7JCrhA+CwmvN9RCCOccPOMePxY9OYMdda+SMq6pxkyhZJH2OI3V0aXPr1B2390/rmiKszwFP33ByOrZi9shCmREaAElilEqzogOiEsJo520qqVdBCJnfnyt0vLW3fwZjv++f//fsdIf7qdfm/PdaKiP5Gk+u2gepTsL85gvYb3ztVx7EgNtOW9EAovBaxQrBGQ7/YXyu9dNvj0PqWUEhpoyaN4DKYml+cuKlw9u2RPdKH70ib+cO/1vfhMK+io7JhQ3kxMGkRAiXkIwRCkFoT5l5QcwyD4kraZ7xnJI697ewMOaWzp04Of3oqPKj9z6xKF770r1f+8U1dGY54wPjVKty4G4HgsCL7x169DgIF8aF3zQG9DS4QQgKzz58stT844WXQcOagw1ti6d6V+U5TRw49MMfDaaW/jVw7tdbApXJ50f+fAzH45OblWJvS/G5OaYRx4kOYCPoH4w0+onIyzhaXBsGBi8ceeEVb3eRjjw4OP7wv5d2Pq1/M2+L1Fc7Nt64iFQ+PeuUVnoFumqhs4mvv2mZfn4KFHCm/6CNCALV4MDiZHBlMtN+8FbKAQc02lGdvB5lbom9z17IFefFBfM3hxvN+SMp+vRZzvypvonQLXjpqEsRgqJwyK/bi43IAg/K1VbGCCmDU101NP3kQH8ys4oQ/9F+ydjzl7Zpt/rOM7n4M585cU3T5Fzssx1DZxzeIErRoz++JWSbcyYE+fjJdhMBb8omDmYvNO2qnJD8P1plSyAgetuW2o1NguL4dD5aQZVy/1T5W07qiSEUj7+yKF/34BWlZLVv3/OaslK+oNJmgOZVsyNTzCbn4JTyPGfM632S78BcwRL2ymJi3ioxJF/7XoSi6SeH/3Lf9UelIHXaU1Gzok4woXX7PeHh1r0vWebZHEh8BrNNlFoJAtacSD7ztlfh3bHeDwrmoKGjfidAcvHmhkhAOX2kEPDf/fPn8vC4ydRxz4+v6LHtpcTjuUY6R/1Fo8gxUcOZ3Qa3uFIoF2nOXq+q7oOijKXctleOnBieLkooARTY8qXP3nzKthScq7o3N7SulwwmaN9m9YC1OGpQ5Cy0zP7nSj8IEApeXkzPn93U9fPS1qsA+FrGnl7yb6viEBm6fm178mSKxvPK82WAa1rn2cOquL7QsJQZQEx2co6rEDijJDGNTJRrk+Vqh3d5kraaqcs/sLkwvuTYE75lxZgaqIFNoEoA5E0PPnLyfET43nHtBqUjMngSFJveuXL0pSkiGNy6yuTJLd7DOsdBoZrnxmpaKwa/9NxVrWCOsw79B3nd1UCOn5xZFhsfBoUcYowq3sLISPWCOl+Xcouo57QZIIapCpD1wSTqOD6zFGhRWkoRxe0+NhyfDh6ZhpmZqCyvWlNZWaMT4r/5sw0A2ifdespCguFN1yw9IntfG3ryECBtu43FbRJyo88LDzuB1hRGHgeHX7Zem66Koel9a4DUQ7+vWDP7zLNsdaUoLJQSfHaYw9Y3v73BYY4SiHIie9R5uyxRz4r9WQfh+8wL6nlcIdRBhJeWqm7c5KU3dA8PJwNF6cKcbS+ly1JhfHZpcaQEqfl7p+7fLsHCOVcdVZioe+fRl85/9+utpdOPjQGBnTeFoUi29qrbKKx3O0WKFME6yRo5NV1//Q2VwOITn/0S23Sbdnj1TUDByR8+HUfoY79ZPrERjjN1vhhPW4TybI7w+erscJAoehWR5ak0mKkOqyF78t/v6aiNW7lsxiwQ4UC3/aS98dWCr5j04/q3PTX/nWt7Bpv2dgP553771OZ2KZ+rdT/+VIqj9T/ubVNlcvwJiMuA+Q2w8VV19eBc5e63Acg88vTq7f/1XZ2e/41fH6rI/MGny9KWN7zh3ifRD6V9F55dCvp0XbFQyjmph0aDpSD+uWSX9DQzahuYuPWy3PBiiz7bevvf0qpBq12kUmvpOXPE6bj/6vXfeeTA1993/s5pBwyKU+988N7zrqjwvKWqQEKUo+OejlyJfeVV5lxKPAmO+q/CstfKb3kL4LDzP3RduWVGSQj73GNWHAhlNOxeofL3OtoTbbv1hx4+teCpDfhkhygRfjquazJdBCcmCVH1IXDava+VvJRhpnbn0xoX+co6b1Sp3JjqP3/DvQjd+euHfnDz1Rcc7gIQbLjhCx95X9tHVvT+xx3DhrBQOEBo8fM5Ii4BcCnxR79+buvdsIhaeDDaXH8w2lRH9m2iv89hapnGJ9x/QufoY4FdDQXKAiGdyLKYKvvcAWPKyqgSEM1cFStsdKbL7l7KZ4suZenY3TmHUqWxErrX8Hd0xj74wZXAhtv+8Y1bLru4gwAPBit7MlU3LC/2Xv0fe1UQ8ecl0Bcep/blEDzu2nBIfh/KXmekwZYD+pPX2nuOAAsGFPpn/6ni7MsnWBxm0+4NO0oF4ag+t6RWVZUY9VfahnTz0JgkEpeoKmp0hOVD6wzGUVKyL660w2vaFJtKTF2aivzr3v/80Vrl5pUNT3/zoRvXk1YcD4w/9s/MGset/mKgGo409IQtk6cFE5dyWv63RxvYGnF0nJi8+ZrDNcdj575JQF3zESgLn9ufe5lc+fbfuW/c0P94M7VdLs3tJgZR3HCL5puG+Jtr/yzZwhi1eon5E9Ky7l4xP2vFA3VOLlyDgkoZSXalwWIdWuOXNkzf9fVP7lfmWNZMkDGkX1nwaIkDpyIbBPAXCHFigvLLIJNLsUHyCTgk/8Bq63NlqfDUP0EYZ3KBPFOe+ONrR8T6aAPeeOz++ep3PtTb3d3aVBVtcqczatAlbmfHOp4pegzJ+0UbWn9R7pXUqtrrS88SgYCVEcuN005LoLJl7XXvCssAOt730BX3/vBGLCrpTh+SIi4Ixk9mMwdm2K1hWzldYyqOg8s+jeqR3hhA/th37YCn+/hPQAHBOyumuQlr9xekYyQ3V3Y/D4/642PJ+hVbVjTEaq/kEpEC+sl84+jTKdUkNAAKmIalpHUCNKfYa263G4+c76QTHh3R6dFQ9LqGZe1t8x9t6F1GoJz2sffd9L7NxIZ2bb3/nCJn0Jt0kWbHZ9Pea0CsNbhSXrgcYVzL43o48txzVyxYta0fgGTpZafp9FbRXDK3g6v9x54bg5m/vmvPOxr2SvOihtzo03tZoEEtxKdOHovGuUwIgkTeE2hI9LJ+SUk1pvnRP3/zzcd6Xmoylht0L+1OlSISkVA+4d/V44V5bsAyzydJwLPpo5986s4WF2n7ZBOTHjSSGIiHLXmX1LT2NMQlXPxYtIhtnHudcaf/ZO4UhJA0nW3eelVnJApcOV6hjiQh6Ke7vl27sSzPsaH8d+eSc1C77lyaMNZP37FUZe4WRZYkjDB4vzi5nNBXk8/88o49S0Sx3FIOo90bUimFEIHT/R27t29yYWYyufBaQvasf+4XD7/2uzroFTJFu3d66sJAm+1c45u6joJeYtXIN9UJqXk2J6fST80KPcKqI2zLtV+NQkL7/yiPzQum8PFQoeIWOFXK8fy3cKqjXAiuK8bzieDkMSbklorSwTQYIAOwyQAIBHM7T5IiuTQl3k5SqKsh4FRQvs/YnY92egifnk5Ogdw5duw3R8RvdACgsNOT5RlfqVS/ftRbi8stVHqwodEmjQvc8JcWpFI+MElKevv39r5Jo/p77zg3AWLh6Mg4Xc+4LB3Y/RnMTqzQFLcvpyXndXsuIeXsoppPbDhLOWgJg6kzfZWdL1pBrbs55Wc6ydlCkNTp/7Fr4PC8JEMfKXvU+wfmx39wQfzBzSgI5qP5EJG6CVZkFVeOinWznV1o9yl2GC7UzoEbpjU4VBlbfzZVfAs+/bHWBISFap93So4AY4c++zYzXXC8zD85Sl3Ldn9z8UpTsuGOZABhC6QtkyFVjOrizSfuvroVjwXUBaIyBllzKBc4u/0L9lKBEz8Ojmik640ff3JPyRQ/BFMoyQdq5XrX+iCuKk+k47jMQpSzbYRkqRthvUBZENXdDumrePZDP1vne1sU1T7U7WoOFqshzR3Vv96Fl1uc1vMlZ7LsvaNtMDHuqeTWAcwQo41rJxiouHYFqdy7eEC5/o3klMvmLkgckqIITmzPWxTIhZNtYQIQ1GyuvfJHKWHdCV2ReGln91XdfVVoLJ+PmxBdojF2dkWnwJDhz3YnwJkqb9161Wv7fhBp3AoNqHxXdAkmr5mN2C9Pv+MO4Fhb3Wz7yVnWkjOM7/zmeUtNMMkAz+OoCCFzljoIVLapFtNPbem6yTrJiEcGCoSCKjK1Omrh4Pn160YoAdOu2AHceFYMrYQuifyaTVdUowGhqnlL4NIlZI83hzjSzGXV52Fm497Wtfr9L8VDG70EGt77qVbzwnlWM2+eXPZ2AIeHvnZ6XW6Ov/XK5547mFQYKEsbV3LjiPPFqNPkyBV2bq9UBZZIrv7He7cPC6lCMxRWEACIKJ9bFLCfX3XzSxYDgGWbVNQ9Hf97E2Rqhjs88tlGRFeP5Y3LAEksk2FPNgQbvILb5bOwRzMEsfUaoGtte24WwUY1ODvsaa4Fpwcf+dZCviLuve+FPw+5Nictylt/6rOOcxG0SkauLDH6G2EMgHAcRRsUR/fZld2BgkEdEQHX/93XLDAjN507SZgCYPN9zUpulrhyYDiRQkhKQX2JK70y6AGMKXdD4AgEXzNIexp2bWlx6VCDbnz22LldecBYzQ1cN3+zqcmHRUmXR/LmRLogAFfEpoYJIOoogQQoKkrEDUp0rxqsJ2dohUlUJ+uFuidA5XAbxGIR9EkEVkYocO/mlVWu2opZ0yZn+stQ4mC+X1CPWS0MwgKu5sks48F7+7M7nRU7PSVc/a0tcP3tPR9eBZFHnRDQ/vf0hEdb3lI8MSoVzNSsIMLs8g8sMCYLqhoZYqAUnTEOUJgasimZuDf1hiyFQiv4f0T8glcGqv+GyB3bejo2bLmhoye8WvnNfoH00sy4mYant42x3nC+YyWnyYVZZ8kEe3+ff7VvxGOj9fdx8w1gN3/lHnA2GVWwkgNHeqi5jltOvgyVOISVsylZluokG4lauveDCJMGBLhpE+GUS0snyM5VCqlgrLofuDtAJDS2RrD9Hbd97nx/acll19yx76U+YZ1NTqUHWx61HI9cXQ7GKv0lLM0sHjoP52p/atlN6ckCRv5UFgca0P1PDsGExQgxVsvSxxTdlZ/M24JbRGLCsfXgcqsIrCaKVskTXuSkxStkAqHURAWyx2c1Ae1iSLlWAgChs29ROnf+cPGl20/ri6kVvYPugJiBmZ88yDp3+Gj6WhEQiKSr8iQi3qZt1/jGHUh7I7/+c0z9eFJwQR1WY+IyiadVSSfLomDLRBKky5/gVnbehqhtNNBRiw5jbneb5lgO9CopR6hfD1Fc1Dn1FzcP1FPBQYRwflmN5i03vmfIS03z1lfPu1CuJCzXhMcdpseWHo7cAwlFUtsrIFVuZ9cfcYGT3H0u9PxTCEc4QuFl61z+dVXogLs2b1Q3wAIFr1oVMEv5haQATLVxB7rdskeXeZHZEGDmeNx0XBXL2kBfV3T3177tTzUUhApiO+LEzUDk5DhI/lyTzZJ4LV0bzrftw2zP+hBXHbhj+lfAgFC0Fwu+MCHgRXLvnLC4YysYTQ1cqLv31alZcagIOMu2UAri2Lc3DFqEyvhfUwP6WstRqvrCicmCDYK26zUHeiDWwHFRld/5s4XrfSOTABGOKbLfC0vlOZmUzg4t322QqXlDzz1wyfN51COV96J4yPXW5oUc4lb/ffPLHA6g46+WMB0hxJkXSm+cuOsOx9AKSsnVmjq+oDtcKxfHphVTa5Ut8r9Eb1Hucsmun3wz5g5kBBFh7d8GdSynlFYuAtq7uy0TNkdePM9BmFC3bct72NwhXnRhR4tQ2LxpJQJ6nQR6CedCvg5SKLC2NV2C6v7MwOrn6VtHDoa/AMdRgMEHx2Kff/K6N4Hj4lbOqSAEIlCzUipMpmqDT37mY8XVedJ6ZUdFgLod7b5q1QEhieQGG5y7EHRxAvACW/eeSCIYi78654AwYrSrJPu3TDC38J+dTAjv5l6ZVd5cKcglIJXTQIP6wcmUhcBTe6uexk3LvoT3l4oewHjouVj06uE//Ri2fDHn4JELY2UXKu8OqIZhtN0Z4eLBIx+OroYnRZA6gOCVJKV2ZaVeq4LILFKfdMuyYgUrKQWow5zoVQdGjSGuPfaQ4KDejg6nXrC+xdzgabd1aoy1uBC9XS0Tsa4kuWEsFhPPzFBSOi/zVOjuP6P7SgFBBn65ri2mdX8ssNHWhMMA2KeXBhYsoVnnRi4UXL6Ou9ek/vfhL3niyatjcyVYHV3xyRuWb89AkUR8yVMksFPnZgAIhUk0nPn9UNoYf+YfFyiIo97Dad+7/aik5ZrKWwNjIwUOud02cJmitgp8ZpQ1yEIqWzUl+baFT/s+DYcJ89vkSg+u/V62owZLvAIC5Fhq2VJyQF3lKmWDtdFbr5mYC1+axtOXxVrTCARI61I/5Kr2rV/e503+oqRJnkiAFEnQmnrhuAIQUnzpsXT3yedNmq5sO6tDkNNfP7r1mZ9+fDMuyj1y0bIJ4EwbEOu4XxX+mTHL6vLZpYqq7O6qL+sfSNoqpy+aNUm+8YVHd15/7qd1t4R0gvhCi2shu0EqpG3F5c16TzyJ4IW/+7+Z6BQWqW1wA1SPrfnhwhOjksxcHpq23tJbTqeWBM1NpcT8D952v5k4BuFtnJ0LCDbz2ZPJdr/8wmxKIVe187RRJSASFi7TVQtHyZ9yppr9gvXGl2vXyggdWg1R+pOvZr4387M7Tn/tAXqtsxBqVEs1FZkdq4KJyZJDtHyOTsp2uWDGeqk+VapBayiUqkhJchXn89mrlZSRM5Opo3++/68vz57/2x/OLp5zEZI8Vg1a+MyxEhw4TnZE/a5taKskwtvEQLpEzWawYmuLwyq6EcC6N1wPVNCnqkPlY1pD3tP0kfDwScA/Pmy4a2NVrfmhTs/+tOMIbrLtJF2nlem7mFJzqkmKOsGdmoBLF0QS84eGrm+DVB7b+/QrLx5MIDNnTi4014XPSmzw3KdvdBLHiePa2rbzqsz3lojS6sYlRce1Djn+/vm+oLwNTtD+thqL++YGZqTuA95Yed0ngTwYtebn1XArZH9BHB5t8jj5rLFuzfV+M5xzcKlLu3IPtXANAMpNtafX7dRPycIoe8wsvJ6SDixMZvKJRQFBEnt9mJpbqHj50KtnHnLcNT6IQsch989+9sAV/0NZrjvkEqBpwnNg3y/3fOzhv0mueni3zw36hkKnFCfVmVrzwAQVAIhUtrhgCkiA5xr79scrgsZFxz3y+J5JjIMPsRZZGCCUzHS3PrA/aVpFj7cY9igGZ63r0rmlZK6QF6oAGZzPPxwfd2zDHX20qFbpJSJcvj0HnOBC01/zFyAuA7Y0sX+Z/0DVXSspQDelxtGYDZ/R93iaaeFvoCCUKobpZXlOhDPgoZWlhc7bxhdKLrsCFDOB+kiMXgJpto0qQGz6XAPTM5q8VH1bgfRcr3f3bbvKXU7Hi0IBKGG5ZP2CUViq0m7fsW9G0pAxhSjaFavV6353W+lICaIHlfZF1i9/40/WgwG4ZiRNlf7uzcNPV5dbXo1LjiCKSiTVBcfibCi+QlSMoPb5QsO2uaUpjKwlBJB0jDq2MoMYGGwTStAVlhOOWpjoCScr21qvapKjnsVFQ/Kqlg3AaaxmjawhfEs4/jgk2qERxnBhOlnf961BWiDoKavZq7vW+jshgTW1XDmLroJrrvG5bDtXTxHVobquRmJWwVSBpVc3R0s7jsVPZ6qsMzb0cvpLgEVqGVwuBks0FLZyoxgzq6OOv0OdaVt2DExxRtJaqKPZdGCDdzY13HnbTbddQeUhgfLn3hprEYARr9pB73c7uFzXWevmlpHfgeHaO7/51mVZzwcpWTyXW1uemFuEEJ6KQF09mR6tm3t5+cmKbtcN54Yo90DZMrdcuvcZxxD6YAoiWUVO5risdH1UmW/muQaxWA4Xp5qu/eCHfY5ERMuPrtq4Ql48XCIOvAx97VPVOQ6oS70rf0uFuJQT8We6YvBXOTc2/eOW3b0u/AAc2t7178inp9c9PkG9y9plDhDx5KK3NlDqWvdU2LZzgs0duGzOgkDMLKDaiOTIeeRJP5BtiKLkTxIqr1mGySURMOanR1Z2tdyybse1QYnlGu+J/OLuD3z/+2cKcECA8r7hybhLw87EjY/jstULe9TcL9OB9ugH7gn7ifwDy1KHv1JfnU01fEQiRX3Dchtc2LNT7V20ZJnEuyG/kA91Lm0765YOTnVylhpLhx1fUHUzUCDMssPRMa7kRo2GTbnpyrZTZw73r18dhLZyo2zl5n/yu+D1y1dtDh8dBQMEjHP9J/q04i0bpCVxGS52FpGjQ46ytvWOra2E/Q6c/vvR2g2Wr/ncPReI1LUaXBAYw+WmzmQ56m+jfhSad5de2bamFTw1IM0AC3UBYgqIvYdjoOiLB5ZmGhk4EXudj3mSldXxo+OHNFswRJcH7MJZ/9LX3ndXIZs4bckYBkIVPR93ESqXJoNcXKL4FZv0Te1kdqH9oBNakL8Hak4MKIa7q/kXewH0XV8PEOFVT4U0bbardjMcWl84+/BM9dqpMrFEwLYVRNZCdRFVKdu1EwPzqcm8kRaSSOc9pbU9VcWIs49a8TATEBXWVB4Ndj/3GY+o5mMJ4B6A3f+RWk1Q3dNECOlw7nFtWu/zywvne8If56GvlxE/FTYXItrLXwYYr1gPRiioOH1W95hszQY4knHkVE5l3nWzZTADCEKMoZg9MUUSeJKkE8xCuhg0/c0RyTiRdauiTKi191/DuWMRTrUaayrTF5Ye+OF2Rf3Ro3duUqGsvasDtAOdFctvTlPTIx0tDXlv++oTt0+l/G5pZs8EGIS8rlIQEMKnR+PcdtY2AmzuL1bDLPQr5lqdwEDZeMBcl8BJZ4HSknKKcgmSE3Y5zyec3JGTBOL8qeRsBCXOmbGgFA9c9/7o+9rQ96VX/horw7N5RzXUAeTqSkOMH2x88n6Enz9554+oU+MfGIXELZnKWyFAimemKyOFQnZXMwaHR0dm12FCyp9KYq4jz0F4NAEaA7NyJkTt/vjZs56VXBKOXbDo+dawtX+25A0l5i3mMa3dTZAUEZ/lEr9pALpKNlZ9bQ7LuxHZvVmm033NOijEd0oeZWRurn1xwOelC4JyjtfLAg4xj4zYbm3p1hpM/1mpdFddmPEWylZmwdZuBkIUY5iClKchsbRx+gvv2xW6UooJm2DuQpszUBjJ6UJUFSVf39oL1zpm4MCeU3RfRxeR0X1r348Cd95Rh819xDqydkLQBv+zxo2UcoTGPV1WFhAgIA54wcP44VO5fBH6rhWAnXa5C8IsOFyXojvja+w/Asw7RwU4a7tmZlo73lXg3iX9bT3qhQf+MByBY8nXtljCv/pDexoyAJzBDvpWfxYK6O2/fSeFLc2qdzNfyfxnRMwfjPBT5jCoYF2H1vEcICBAHGo7UaBwZiBPSvqt/oXZgZHOjtpRwTMgzDZTc6XRJ8Qx6OxZDLLmPoNWbqjRTN1Iz1uleZ6lE7kFEcmr/tPJqQsZ6bfXdq3P6zNp+r1qMHT9cyCbz5cGh29ah4GX2Qdtz/CxHiF15QjssCYd4UQAgFDlgrW1+NzivhHTUKtS/AuTTKkN86QqJ8BQFsDyurZVsqx21Q0bcfoqmoVIczoN7rzooCQXUiWr1qYJBIptlVktBHERce6uJ94GSjff8ULry4fUpafOVMEB4e671JkyzxpnLR8YF//mPEJeCYiQKDU995mnDAPR228Xc4O9vggzU1ZrIm90UqryRJWxlFkhMEBKHEIKE00PhQ53SNGIUsqmYoZlzjSLGaoruPTssedro7jx7uts5bHk4J/zS8wRVOy4Qhw5EyvJ0naUbWt9/358CSBqIVvzc3F9y7Vlu+rWm/vMGLdrME15khZlHkEOQaZxOViBhTVrsCAvUxK1pN7KKdA0F3dHZjPj5Xfms4SqNGjFCf/+jrv6+h7csVA5fo4odZOPE86D94D+i0W5L7I9f901S2fegBsdPol57AuLoeZWo6Fu8uDckcmem46dNOWAnBUBBB5A0ioAZuy+rFsGTMnOeUkxM2dv/cKnftqiLU37nfzhcHXOL1WoBQcQ1n6hq2vr0++caTk/u7Std6F3nmJLNyy2KVfhp3r/ZzavXIUEIDXvLlDpfMrecs27vtGTe+n5hDE78RX7VaonGp2JEBSbUw4mQAQbB7ODAOLU8syUBfflNQ5zLtg72mOdnHclcm3pcnyqRJyq6hnZWKUrQ/jNk+/KbRkOzfr1c3WfFzVX86Hzm2Nn/Juj87WfYs2cBBBT8+TTdxeE5axYU9sbtqjLG/QJ7Ck9VPr3HG0QctKZbmmI/s1yHEIYINZ3Meau2racRtFgsAzjxE9/ff7s0XDffxEUYmua5gvl0Hwcm91IJ1n+21/a27KhyuGq0neiQ2/1sP2BYOlJ987s4OpNAgGkPX9t+kpbSixCefwLH/jgx15+gyfjcdtE/rYnCN12rguLMykgzphFQAjjUFW/bT1MnVPmdiymMSZFplrpeYeVM8nissW2laWT2bas6ZR9JzfPojWAgaLviNxEPWuIvHZd9/73uL3BTZZ4rOmKkSLHZICNJh7f9heXMKzswWcmkJ3a98FAR1tjuzE/fkzR7WC+PJNeuYMAlKdO9RnfflGAwDlkq+cKqCg4xEgYViavdF7Ret064xwpcWcUH/+NJ9wxi3i9jLcFl9msvnI4ODrV3ylcKwIKeWbLxGsuBKrq5MJTTj34ib9TVLaxypYtK9zcIN0aTNHwYpW3EECCheAAlkHMbFzE+mACJDHisnNq6bXV33m9E6f1ZB6qp7wktG4z/xY5+ldPnf/mrs/MZklSIXDvl/+q6Inh1P3s5+V36r/LZGcUrfh5g9C3O+9ti29axRI/Dq+S3n/hwJnTZmPT5EJGsom3fXJBlEtgAhKBTCRhXNC6g/SFc6qqV6958B/mCeU65o/vzHdX769bd2j/8FxgVUvvoSfjN2yTQObb2vtyoXHXkdg3mSTvX8DMklFfYTCnEoojz7258TPB6szA0gevrSiE9zw05hgJl9tJOkGvUy6UTPSmkGKogACNy6AuRonC2M/PIDjyZ6dTITzu+OesiqIdUD3mgtnQRgBWk6ktqznVSHf4uZljhgPHmyAOqordlag5amlOWakza5mZmDUIozZgOiorg3CIVgm4GCz+KxKB/8cmAHJfZwDhIEIQAUIAIagGEJDXCdDXiYsIcSmJggMQoCCAEOIyiPi/wf9XNQBWUDggdhcAAFBTAJ0BKsgAyAA+pUKZSaYjoqEtu8vIwBSJag3MJbNFdQvG0URPNPd1w+3vf99HH9y3X/mI85P0lf530gOpK9B7znfVp/xXnG+oB/9vbd1Etk3qH+VS8rj/uOnh7U+AQ83tCIIBW49b9gj9M+kVn3+v/YQ6VXoj/t2lZY1Q+0Ptab77036SOunIMCQZMmYA8+r7tlJ1RrvqJqxFIUc775hQ/R39N0d6F4TRWlC7PpvGX4MrBuBPz0gJMV3xNh8fJvr7aJLasv6Du9pRISoPJwlYIq6JnoCBwbpu7A6oAezUa8vevWS/4eATy9IOtmAaLxLel+8bcIIMWZi2rW2G27PnDE7WXoeYNp4wQ8hsPcF5pyZm6jjd7W+gt77W69PR745hiRlS3R6U2HLfXqviKr/dZq3UosRz71+7pM0BXyTgsrKBzDkUckZ9YL4YBTUZOr2xkf+iplaLKlJHPGU6ia/bBnQAy7YbOPNe9Ka1a+xHC/q2jiuth4wKDAf1pbKHSVdjxmJW8GPyGw4BflOvIs1QFV1y/25Rp/Mli4ZifwPfm2b6uj3T8LVTCDEpibdmFXlm+wfGgpNmHX3aNFSAm+e50g9HG9WIJzxXHjRU1jD8vF5mtOZyoJDi/xrqsqClkxkGKHrrubCJzDRsgXmURjJl4dKOqHuxH+STkw1f0/mcwiQWBPVVOCPewzRpyXYq8y4fv2zGBGW4EyLgS8On3nyE8S9v7uPdrJI0Wo3QgE4YQqcAaZj+WM4Nw76BdekQkHKt9EtfjNOs6fNymhg4gmW24g7SjA+s1zZB4pgXzj6p9xR9v8WGkC9pww8oW4PircEpSbUYCTmQX+8bNunii7D7owNpDeUkb0GVEh5Qbv5HdwjBW7ie5cDCsaofaH2tOCnAYAD+/FzQAAH/+vr+YLnNz6A7BkLkSMXzwJLifgx1U2fMEn6iVz3M/++fTfvD4ZjOqdQT7hxGZTBy+C9p7aizpdNt1piOm4e9XrUiq6B6rYwgb+2McovBdduB8N8SAgu5iRe3f+SROVposVtkT3tJY5kFyIexnqrQD4bBrCdtP3JRnUyhS5sDJLRQ9yu8CAYvTD0mI+kU9b39Dygoq5QPuwgGqvGGDLY677+4wkgYaOw1Eddw5JNTcpGJf3i7OPoECS46P3+xf1uHbLGryalHWkUznRJxnTpclAlEQnnxhBQASZTVZSZ//0QUO33A1tPBZUhTDGfT3uQi5Oqf+MYantGN06FFmiL4gFRkMkz3B1rei/NLW7B8J3rsn+f53N32n6zj0k6UtSKFLhtWCrs1gsiFPR/F6Vdhv4Pdu539cr2lwWVr644WtOnHOXAbvJ4BoJ1r5poPv8GcPH8yD1Hpqd2cYzFtOLh3wZaH+GHb2oXzlWyQt6phPV735c+QnztqKTVMHR1jt7tO7g6pLE4MQEjkWbFlpbQMTUdO5Q2d12uYvvigoQfNjQWFp3tajTL+ozSwzhz45FMyP8TJRtUuteVsfn15aHdMuyWiduPzHXD29MuPeT0gbmDn1EfYv+DpYuCPb1TvJRzUYQKf6ybYBrO35wJ3GR8txwG2geJjFF4bJwF9EMZyf5YdsU/xIdNxo512dW39likBlHTmcceCzuFf1v7ZEH9BXQRHiSNtHvKvjV88H+UQZpzERawrzsIKrOWwmt69uW0Hf44Oy2yu1jQSxDm2USKwoAqNznXrjuLdEKH8yL74iFhLd5+KYtj4g8Ji40mfSDyC68FWkBH6UqNyhr7JaGx8p0MBZcH5UNu8RJ731t44A5Mn31t5XQQOM6LMpn56S0FY4jzr70vqD9z4mnTArL0vkh85ezangnVQDgdSOJl4CobVtdQDywzeVferzKMskNEAiPrjg+3ujfT157dkKWAfud4VinwXSm7RqA4TmLbGt6+jyHusi6TLpKqNz5o+j6+wxfiXxBcT5i7RyxkJfApIsIbxjaUQO7rPjeuNgdDxjzRoXL5Tc0rnGYtF5lDv4byxbbEVOscON1mu3a9gg9Hy2SDaSgG0op52g/rSiyc2MeAupInfNZN0NLFQ9e7ot3TqE77lbWovRPNcNXTPGw0Xjx9zephCUg3KOANEkgLelhW+/xPde8jthHlGFe96aDiFSdBmyqND938JilAZm4dGPPJfp1fOjySZM5jCKDnKqho3MtpDA90EC5bf/5IE89GbfnuKCoqensaD7idG0ZDMf7qojF4uNp0P8h35/Zh1xz3ZNX8tBRKLojEjm+dKEmlZIXQ3Wit5U6pek+eN/AOrV/3JVe5fOGqfTvNVN+GMwIkKIVHbMHyQwh9cD3CMx36ZhwvTq7ywJJyJgq4xsaaPIMC5LUGP/vB3epIX8HDb4Z33ySxHKCT5egOKxvn9ADiL3MOzV0ZC1k7/FYdqq06G50tuJ18omdmkctDXR8RIFpaoE2qjVx6lP9Uor0XwsfEfahU6FcqKSALIwHni3fclnnriQ2zTL3bYlbTwKplhnd2jiNXUfWsrui/8NPql9guqeNXdqP5ZcvkegFoUHRf32IyQPmx3dMxUljbOKfyoEph/s5xqYP2guV0oD8FXQnO54HxxCvnqCUWkdA0SUkc4QmdQuign5f1yVkv2sPqPGA01pP9Sr5965BmWxCdiiqiS6LRHo4SzNsczJup9GwOXDZln5WvKBx0Gh8ke240lkyxrgA8aqu2pktH746JQqxGCAoszaqS3TijbRBOrm3pJH9SXpp6NmXJrFaeR68NNhEALgOYUVnj9O9ZLyDdo8ylFntd9n6baDKUTC1CfL9rMt7IE0f6olvDyN+EUBYSH8sEn5x+xV6WXYqG6c+glIJ4b1ywXtocyZy2AGtZNbQXYgbAmdIeKrkCiBzpBCSK5IYs4JMROfMcPoFhTB/ij/B6WJjlhJjXFvusCa6MSCyPcjuGumoeVJqNh0PWRx4gKUvWWcFux0dZgv3Yq/CxNq4qfORMtMY+/6llSd4YxgrtR4+TFLbMPGcBY8WqE7uUMRZioqgyAMHw90gXIRKKZlA4n0oGy/4rxdNj004nHErkYhMMY91nxAG8SltKdx9hUjexdoWVjf3Uv6wEaa64x/Fd4+9rU6fgZuzQ3/g+0nU6GB8kjvJjb1e7TmQCrunGYh6hzqlrrer1n8r3qSWsCXST+Bb4x/Ac027gJEHovzB6K1M5NmmelwfceL04ORi2663fgblHdUkqhZe1SJPgK4ua/mRB4NIEpdSjuNYhNAdwK/wIesin4L1wwe4F+8NA1lynaNav/eat0E8h65l7PiqJG7p1cHgSsnLKIJbGqldhz0mhXHt+WZwBlukZyc+CaxAq3OmUhMmjD6B3baX8zEyKxm5MmQE9CWPzAWWN9V55yp9LqoXAgn19u827KT+eEyE+RPz4WZ0vDfEooOfwlN6LwqiRwT022X9dsIYqttZitYL+HpCYHtQ5eLDYnXfw2gBaYpx/gsTIDLZX7J21vNFEPcyJLUmFwvuORvzuf1I2/NFVKtxGR9lOzBzuAcbzm/OHPkfJA92COK/ms+pKinEqYP+HllpIaTwgtEneVvk6821jCXqH3Lgvx0QCwwYhD+Totc0z4LE+5bMV7wXmVwxPPv2yh3zl8jOGNQ6O0DVRdyHga5iFrvToEEnPicTOLerhcqcrJFQvByaiEhhbccZc58ufNaBOixR1KEdkM8qaI3Oza/ou9Z+vs8kte0tEm7gYECV8i7PAtBaBBfEeiiNZdlosr3pQp5GfjbPMXUdCFzKNp+zhLVYq1u0cir6CNsy16gYi36mga6czZu1pgp+ExLnq3Ep0LMdI+5wJQwPpQ8j1VVYgOyHrCml6ZphqysgaWmJKmdkvh6TbRkFi6EMsjEygYNJpX/KYgYcBkzuDxT6V/PgxylwAVzDYYjj1/jstX2tK62/a31tHd0Ttp53gBA1by1WQUDLXR0k10OUO4hscveL5bhXhrAIl5o6CIF01rf6C06VDJAJD9xsb8dgiGPZgdlmjkXx4fcBRIWdgla7ZhL/mSjZHrUjmIUsiobu4p+kQdNMHvxCmlbE3QO9uQCYSOC+MNMTmwCx8auwnfYfcK65+pky4oKc5X3hkiS1rkhywRqSHBvHzqMe1xvbj68hHk7/16BaweJ/bSWykinRdb08u/jbrJhrRk7FPDwmqggWbcP2bn7CWhcNz5BMIa+uGC7fTSsw43peviW/5jeeaqcIYAq7zQ7fHm9R5lU68fgg8bS45QkzrCQBuuPZh2jjY9evQXis6DXF0nmpcfY3sO2n40DxZbvoxS5n9BhLTtav7CLrmlzuHI35ZefFNR7ag/kKjM02jcTF8ezxOrxNjX/P+4MmNBpQ/nJ5hWGjmFcey5XpQRYph7JZyo7rDRsBPwQywRA/CJa6yURkFQqoOB+mW7wPt5SAV7/3lEJeG7wiE/oPXhLFuCiRS+z4eFMPMF2RZHM+xp6lYf+qMCeYdegomEzcY47e6FzuM7AQhvsrD3WCDceaLi6mTJ4I7F/mhkTWkcLNOFtnufUJf9+zM+OaiSzHjv1L6WnhwlrNocwGYcKAs9ttXHdQT4tGJqrF/I3jdC3rsPAYJ98dBYpmIloGkEfa70s1rw17YMT1536KGn4RQRiAQ75LeaXVnpG4ZNlZX5j3LdlzagoRvFvRgbXUHBXNbNHaXFA43QiVQKiP/+tCJG58bKsgmAcHarWqdvSMvnJZm4kHnHnpPHuV0BsEWJzMFU8ZiU7e4oDEmjgL6ELc9ol3qtAW8peF5JSfv/CwFmS6R/klW8Ds+QsQiDMwI7PlSZ9IgRHra2d6kCL1Mtyu4PlCqMqzAPDsx1/W+WnrgiOeMUyIZAG+ogt6/G+mIQQ3Q6RvIkpJFEzYRUr0rIHfLc8xOnnbsEKW38uC+osOm2CLiDJ5dArsqTBSR0KOt2yCmoqLH3hhntv8no5fAX70MBvMXlcjqrOmKcAX2mpJyr63VSITA5PWD9NEXvozr2QdntGBUYitPzW2MB9UApZMML+70NoT6zmYEjhYOcMrwjT9CbOPFvOBPPhNmGP5M9Wc2kBHO7nWSVhwSsOuRjSIXz8cx5KktNpCHPVTLMOmstsUZIz1q9Nt0CxiUgl1UA5zPYA4M59d882WqpRb3uz1wPY/wVlX9oCSwKtqOYRkNAwiGZOIYJhhrrwcsi7mr8WMyShhy30v+O6S4934CPLXx/tiU2uvYWiXLWuZUbmC8ZQcyfM/rZOmi24b5dK3Unuc2uIbyrmzsNkBuGc2ctM0MZKGRZ03jgXhmL4xhGE/0I3z+slAfbBVcfPfAlFxkpaKLtnkCMiuHj63g3+ZOFVOxhRq1iWnxKmxvlKyJj+rwQ/Qgl2+ce+fBrkI7EW+JyLhn5rMysY7RQo6xHnFNAN67b5pUvjdmb/4DYqUUOcj0QHTG0LTxTgHhIPuwDL+DxIbVXTKMrvqUNvZIA3T+LRu7yh4Mefhx9MMn8o1VvKH233vgK5jvXaw1rgFs5GBssEhecC0Fh20D2Sc0dhXkgE924KcQ/7Vhe+vGFfbNANqYax7k6mmHPGl4sqnB2LUaZ46fR/YkrK0Kv0rnGhrUcFyReNH+mR/u6a0OK4cMuAr8H4WsFu2gi/qifE2W76pfSsHszNqYplRSMJYK7No3Y5AaNWMY8WGZF6pr1AIGGY3zf47+xPrAmV/nEjW1ZNLajnwjI9H32EJUTZBUKbQoe7Mahj50wsLYYbeedqGJi6sq/+tyoQN/O9Y7cUweczkPcsDg5t3lzQz3h9rvSzRqeSNyT37DflsKT10MqHVNDmOQQAoLP4tu3fGf0zIyRysrzjtYYpTfQAmv7iCPwLtryDwPNmTCtFV9HzPXRl3t70v9Ju/hmgPaPfvhyx8WVKCePNDPQf7Tk4MSUD8iR9PkZ5XoyG68MYHgrjpjZAtsIXdaPxg054PPYopz4xJeDjN+emDASNU1vnQ+61oIfNbXH/aTccNgHFkbFK6ru1SO0Aqfqz7Ee9xcoppdUS8UVtVAk1CCoZV39fCaLftmrxUkysDwXalxmX9EraWbrsYA8UEdUnvDg4qVQcDsChcaS7TcJ3BP8DUv5kBbpyTpdte9rM6YycfFSsDRDV4PQDHARHkH69hNOwqyxBum3kUtkf7nl1UzZ10kNqRxgV26mEMjBDeQ+X8wEI0vowjreXH7bXw1Qr9W64Y96vutqvrE5H9iiOXdo1lAiID9jqSNW+kz8iTCx+3Q1Kbjx5E7vHSusiXrZwbNhe5dRY8GsbwySLID8Be2wiZaK31PIctSniWCf/20WXbOWvLZfEq4TAKiUyXQg3xePdDS8RLrkzgNnIFEPnDdFPsnlk9ehk/gxpNB0VChRzImsTdW9AY5UVxXp+Jn3gmOyPyJxYwkJ23rJFhh/xR5tDyP6IxpUObkVhUS7RV7HDTWwLPxg0UpchpVY7p399h1cHjKil/NvURhsnxvq/4sZ7txuvtCB/92Bl+RG5WMN37wh4zTSe9fDq5bQZnBHMngZR9/iTjpkBv5nGK2QJXGLmH8PJ/Yu+ia4TP8wIb2hTNfeuZGNY1rpRuK2mrhYy/R6wYU3d+d6R7UwIpzGDGGXQ5MziIm1Ex4mj9mHdWHo/6lZHJ0n0dUdHjPeM+V537U7mRK8Xv+jrOz0gavXHOnzyKlr/+SQdJXPyJbAZkZyANnnub+jTI2oC9AdQPnoQCUbs2KRnvS4E4bN9IpPbpibHdxVvqYmn42b/M5Te4qDEmw4wOLjyQB3qNYx9LN8U29GMxF6TYl180yUnL69f5HIL+7V6W3d3sfD+JEZnX414hHcoIhvFKT9O1ZQ1w7OrcV4N9Of2/1rE1PvS/z8i6LtWnbuUt7UtZ0pkeLQr2dT38+FUMNRQzpvHhG1UoBZ2h7BPyof7YdY5xm0CpJ1h2MQADdbF78Bwe0z/WAcjX92vu7QdQX4YRwcPGEyqlaYn4vaYSpYFvyJoN9ILULpBtRPY1WNjl4YQVWRQZ3mptp4de/pAsOsS7Uf7BG+RyMgpDQzgbrq1arP22gdTyd3TD95Jo0QJVGDKUUcE6ytDesH9+NEzffK6kDam8fHyhO82sNQg/NhmyCUIBoYarfpVgZ2t4rL1bjthXCn444U+MhMJpa+rCSZNirWvTzqkhyTQDqn5FYI5NysLgyKxjgC3PY5KU6GmCBPhzXL7mP95FkrvqUvGxZv0Ru5i5gKTQ/oCtHmPogcEoHray1RChVLkeRZeMdFsnenzfGM393G6UqddTAY5uyWOIoDWe/YVI0rMoWrCf1JlawBaOMRAXYwmVC898mzuocRyKy2o7Ile1T4IXKnQufO2qeoN/aQT3xm10XcgLa861y2S8x7vKcIsKe/GTiOdDlxw5+n0EW4sorEdLxYFt7aOyqz7le9Lw3lkk8ESibaJ7gzl9idizSJqC6AlOit0S1vOIhmLs60E3ja5FndECOzDE9hydmBXhHOhBuaCP+3FqjIb8LCTj0HmgctZvZWeiINro+yalDPSNJ95CSv0D2dUpUnd+StgCdVZa1GPQ83SXFvc+uaWYSeg1MgrtmXLkwge1hYYRwDeLHhMOo8l0WrUVnIVwrLpQpeElFUHb0meG+8xVj9MhUQibm6lXdAHQEeITE+IZqEFcevt/QS5Tp0u1DNK4tBecv3gz5pgdidnet9ygVYf8XFPlyWmHGwC+OgNPu3Z1vXQKjMimG/KUMYB6HpCKWNqA9/60h2MLihqgh52yqmzGQ24L9TnHdED4ISo1UupnRit4iGvjZ/kRg7o7A9zmIXSws9tabSIF3PqmwKbN91HlOsYDLlspR6xsXKCwN2BgAGzpQZLeYApbyHW224A5asMZkvAVMorOYnSUDhRSzqS4msDeQbSqpJtlA5WyED1pFosK/YwkgRY+ETgmI2DU1dmIgTyln3WKUi6GeBXOeUMb37lodyTSMHTjW4grilmeZBXijF+XazhPEqjSvOXRbMMfgWVdAN/ffmjP+XTpZSTHEmUIu1FOx9AV/cNB/IcHwolwAAAAAAAA==",
  maitre: "data:image/webp;base64,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",
  elite: "data:image/webp;base64,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",
  mythique: "data:image/webp;base64,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",
};
/* ===================== SYSTÈME DE RANGS (v2) ==========================
   - rejoue l'historique pour dater le premier passage dans chaque rang ;
   - expose un contexte pour ouvrir la fiche détaillée depuis n'importe quel badge. */

/* Rejoue les séances dans l'ordre chronologique et note, pour chaque rang,
   la 1re date où le rang global a été atteint. Ne recalcule que lors d'un record. */
function computeRankHistory(history, bw) {
  const dates = {}; let maxIdx = -1;
  if (!bw || !history?.length) return { dates, maxIdx };
  const sessions = [...history].filter((h) => h.date).sort((a, b) => +new Date(a.date) - +new Date(b.date));
  const best = {};
  const acc = {}; MUSCLES.forEach((m) => (acc[m.key] = { sum: 0, w: 0 }));
  const scoreOf = {};
  for (const ses of sessions) {
    let improved = false;
    (ses.exercises || []).forEach((se) => {
      const ex = EX_BY_KEY[se.key]; if (!ex) return;
      let b = 0;
      (se.sets || []).forEach((set) => {
        const e = ex.isTime ? Number(set.secs) || 0 : estimate1RM(set.weight, set.reps);
        if (e > b) b = e;
      });
      if (b > 0 && b > (best[se.key] || 0)) {
        best[se.key] = b;
        const sc = perfToScore(ex, b, bw);
        const prev = scoreOf[se.key];
        Object.entries(ex.muscles).forEach(([mk, w]) => {
          if (prev !== undefined) { acc[mk].sum -= prev * w; acc[mk].w -= w; }
          acc[mk].sum += sc * w; acc[mk].w += w;
        });
        scoreOf[se.key] = sc; improved = true;
      }
    });
    if (!improved) continue;
    const vals = MUSCLES.map((m) => (acc[m.key].w > 0 ? acc[m.key].sum / acc[m.key].w : 0)).filter((v) => v > 0);
    if (!vals.length) continue;
    const overall = vals.reduce((a, b2) => a + b2, 0) / vals.length;
    const idx = scoreToRank(overall).tierIdx;
    for (let k = 0; k <= idx; k++) {
      const key = TIERS[k].key;
      if (!dates[key]) dates[key] = ses.date;
    }
    if (idx > maxIdx) maxIdx = idx;
  }
  return { dates, maxIdx };
}

const RankCtx = createContext(null);
const fmtDateFR = (iso) => { try { return new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" }); } catch { return ""; } };

/* Génère une image partageable du rang (canvas) puis la partage ou la télécharge. */
async function shareRankImage(tier, sub, name) {
  try {
    const S2 = 1080; const cv = document.createElement("canvas");
    cv.width = S2; cv.height = S2; const g = cv.getContext("2d");
    const grd = g.createRadialGradient(S2/2, S2*0.42, 40, S2/2, S2*0.42, S2*0.75);
    grd.addColorStop(0, tier.color + "55"); grd.addColorStop(1, "#0b0e13");
    g.fillStyle = "#0b0e13"; g.fillRect(0, 0, S2, S2);
    g.fillStyle = grd; g.fillRect(0, 0, S2, S2);
    // charge l'emblème, mais ne bloque jamais indéfiniment (5 s max)
    const img = new Image();
    const loaded = await new Promise((res) => {
      const done = (ok) => res(ok);
      img.onload = () => done(true); img.onerror = () => done(false);
      setTimeout(() => done(false), 5000);
      img.src = RANK_IMGS[tier.key];
    });
    const d = S2 * 0.52;
    if (loaded) g.drawImage(img, (S2 - d) / 2, S2 * 0.13, d, d);
    g.textAlign = "center";
    g.fillStyle = tier.glow; g.font = "900 96px Inter, Arial, sans-serif";
    g.fillText(`${tier.label}${sub ? " " + sub : ""}`, S2 / 2, S2 * 0.76);
    g.fillStyle = "#cdd4de"; g.font = "italic 34px Inter, Arial, sans-serif";
    const words = (tier.motto || "").split(" "); let line = "", y = S2 * 0.82;
    for (const w of words) {
      if (g.measureText(line + w).width > S2 * 0.8) { g.fillText(line.trim(), S2 / 2, y); line = ""; y += 46; }
      line += w + " ";
    }
    if (line.trim()) g.fillText(line.trim(), S2 / 2, y);
    g.fillStyle = "#ffffff"; g.font = "900 44px Inter, Arial, sans-serif";
    g.fillText("APEX", S2 / 2, S2 * 0.95);
    if (name) { g.fillStyle = "#8a92a0"; g.font = "30px Inter, Arial, sans-serif"; g.fillText(name, S2 / 2, S2 * 0.90); }
    const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
    const file = new File([blob], `apex-${tier.key}.png`, { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: `Rang ${tier.label}`, text: `Mon rang APEX : ${tier.label}` });
      return "shared";
    }
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = `apex-${tier.key}.png`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return "downloaded";
  } catch { return "error"; }
}

/* Fiche détaillée d'un rang : emblème en grand, devise, progression, navigation. */
function RankDetailModal({ tierIdx, muscleKey, onClose, onNav, unlockedIdx, rankDates, muscleScores, overall, lifts, bw, profile, flash }) {
  const tier = TIERS[tierIdx];
  const locked = tierIdx > unlockedIdx;
  const curScore = muscleKey ? (muscleScores[muscleKey] || 0) : overall;
  const cur = scoreToRank(curScore);
  const isCurrent = cur.tierIdx === tierIdx && curScore > 0;
  const gotDate = rankDates[tier.key];

  // 3 exercices les plus proches d'un palier supérieur (pour progresser)
  const tips = useMemo(() => {
    if (!bw) return [];
    const pool = EXERCISES.filter((ex) => lifts[ex.key]?.best1RM && (!muscleKey || ex.muscles[muscleKey]));
    return pool.map((ex) => {
      const t = nextRankTarget(ex, lifts[ex.key].best1RM, bw);
      if (!t || t.top) return null;
      return { ex, ...t };
    }).filter(Boolean).sort((a, b) => a.delta - b.delta).slice(0, 3);
  }, [lifts, bw, muscleKey]);

  return (
    <div style={{ ...S.overlay, alignItems: "center", justifyContent: "center", zIndex: 400, padding: 16 }} onClick={onClose}>
      <div style={{ ...S.card, width: "100%", maxWidth: 400, maxHeight: "92vh", overflowY: "auto", textAlign: "center",
                    animation: "popIn .3s cubic-bezier(.2,1.2,.4,1)", position: "relative" }} onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} style={{ position: "absolute", top: 10, right: 12, background: "transparent", border: "none",
                 color: "var(--muted-2,#8a92a0)", fontSize: 24, cursor: "pointer", lineHeight: 1, padding: 4 }}>×</button>

        {/* navigation entre rangs */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <button disabled={tierIdx === 0} onClick={() => onNav(tierIdx - 1)}
                  style={{ ...S.navArrow, opacity: tierIdx === 0 ? 0.25 : 1 }}>‹</button>
          <div style={{ flex: 1 }}>
            <div style={{ position: "relative", width: 168, height: 168, margin: "0 auto",
                          animation: locked ? "none" : "float 4s ease-in-out infinite" }}>
              <img src={RANK_IMGS[tier.key]} alt={tier.label} draggable={false}
                   style={{ width: "100%", height: "100%", objectFit: "contain",
                            filter: locked ? "grayscale(1) brightness(.45) contrast(.85)" : `drop-shadow(0 0 22px ${tier.glow}77)` }} />
              {locked && <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 46 }}>🔒</div>}
            </div>
          </div>
          <button disabled={tierIdx === TIERS.length - 1} onClick={() => onNav(tierIdx + 1)}
                  style={{ ...S.navArrow, opacity: tierIdx === TIERS.length - 1 ? 0.25 : 1 }}>›</button>
        </div>

        <div style={{ fontSize: 27, fontWeight: 900, color: locked ? "var(--muted-2,#8a92a0)" : tier.glow, marginTop: 6, lineHeight: 1.1 }}>
          {tier.label}{isCurrent ? ` ${cur.sub}` : ""}
        </div>
        {muscleKey && <div style={{ fontSize: 12, opacity: 0.6, marginTop: 2 }}>Rang · {muscleLabel(muscleKey)}</div>}
        <div style={{ fontSize: 13.5, opacity: 0.8, fontStyle: "italic", marginTop: 8, lineHeight: 1.5, padding: "0 6px" }}>{tier.motto}</div>

        {/* statut */}
        <div style={{ marginTop: 12, ...S.exoInner, padding: "10px 12px", fontSize: 12.5 }}>
          {locked ? <span style={{ opacity: 0.75 }}>🔒 Rang verrouillé — pas encore atteint.</span>
            : gotDate ? <span>🏅 Débloqué le <b>{fmtDateFR(gotDate)}</b></span>
            : <span>🏅 Rang débloqué</span>}
        </div>

        {/* progression si c'est ton rang actuel */}
        {isCurrent && (
          <div style={{ marginTop: 12, textAlign: "left" }}>
            <div style={{ ...S.miniLabel, marginBottom: 6 }}>Progression dans ce rang</div>
            <ProgressBar value={cur.within} color={tier.glow} />
            <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 5 }}>
              Palier {cur.sub}/3 · {Math.round(cur.within * 100)}% vers {cur.sub < 3 ? `${tier.label} ${cur.sub + 1}` : (TIERS[tierIdx + 1]?.label || "le sommet")}
            </div>
          </div>
        )}

        {/* comment progresser */}
        {tips.length > 0 && (
          <div style={{ marginTop: 14, textAlign: "left" }}>
            <div style={{ ...S.miniLabel, marginBottom: 6 }}>Le plus rapide pour monter</div>
            <div style={{ display: "grid", gap: 6 }}>
              {tips.map((t) => (
                <div key={t.ex.key} style={{ ...S.exoInner, padding: "8px 10px", fontSize: 12.5 }}>
                  <b>{t.ex.name}</b>
                  <div style={{ opacity: 0.7, marginTop: 2 }}>
                    {t.isTime ? `Tiens ${t.target1RM}s` : `Atteins ${t.target1RM} kg`} (1RM) → <span style={{ color: "var(--accent-glow,#ff5c8a)" }}>{t.nextLabel}</span>
                    {t.delta > 0 && <span style={{ opacity: 0.75 }}> · +{t.delta}{t.isTime ? "s" : " kg"}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {!locked && (
          <button style={{ ...S.btnGhost, width: "100%", marginTop: 14 }}
                  onClick={async () => { const r = await shareRankImage(tier, isCurrent ? cur.sub : 0, profile?.name); flash && flash(r === "shared" ? "Partagé ✓" : r === "downloaded" ? "Image enregistrée ✓" : "Partage indisponible"); }}>
            📤 Partager mon rang
          </button>
        )}
      </div>
    </div>
  );
}

function RankBadge({ score, size = 64, locked = false, muscleKey = null, tierIdxOverride = null, clickable = true }) {
  const ctx = useContext(RankCtx);
  const { tier, tierIdx } = scoreToRank(score);
  const idx = tierIdxOverride != null ? tierIdxOverride : tierIdx;
  const t = TIERS[idx] || tier;
  const glow = Math.max(2, size * 0.10);
  const canClick = clickable && ctx;
  return (
    <div
      role={canClick ? "button" : undefined}
      tabIndex={canClick ? 0 : undefined}
      onClick={canClick ? (e) => { e.stopPropagation(); ctx.openRank(idx, muscleKey); } : undefined}
      onKeyDown={canClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); ctx.openRank(idx, muscleKey); } } : undefined}
      title={locked ? `${t.label} — verrouillé` : `${t.label} — ${t.motto}`}
      style={{ position: "relative", width: size, height: size, flexShrink: 0, lineHeight: 0,
               display: "flex", alignItems: "center", justifyContent: "center",
               cursor: canClick ? "pointer" : "default", transition: "transform .15s",
               WebkitTapHighlightColor: "transparent" }}
      onMouseDown={canClick ? (e) => (e.currentTarget.style.transform = "scale(.93)") : undefined}
      onMouseUp={canClick ? (e) => (e.currentTarget.style.transform = "scale(1)") : undefined}
      onMouseLeave={canClick ? (e) => (e.currentTarget.style.transform = "scale(1)") : undefined}
    >
      <img src={RANK_IMGS[t.key]} alt={t.label} draggable={false}
           style={{ width: "100%", height: "100%", objectFit: "contain", display: "block",
                    filter: locked ? "grayscale(1) brightness(.42) contrast(.9)" : `drop-shadow(0 0 ${glow.toFixed(1)}px ${t.glow}66)` }} />
      {locked && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: Math.max(11, size * 0.30), filter: "drop-shadow(0 1px 2px rgba(0,0,0,.6))" }}>🔒</div>
      )}
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
  // --- Rangs : dates d'obtention, déverrouillage, fiche détaillée ---
  const rankHist = useMemo(() => computeRankHistory(history, bw), [history, bw]);
  const unlockedIdx = useMemo(() => {
    let mx = rankHist.maxIdx;
    if (overall > 0) mx = Math.max(mx, scoreToRank(overall).tierIdx);
    MUSCLES.forEach((m) => { const sc = muscleScores[m.key] || 0; if (sc > 0) mx = Math.max(mx, scoreToRank(sc).tierIdx); });
    return mx;
  }, [rankHist, overall, muscleScores]);
  const [rankView, setRankView] = useState(null); // { tierIdx, muscleKey }
  const rankCtxValue = useMemo(() => ({
    openRank: (tierIdx, muscleKey) => setRankView({ tierIdx, muscleKey: muscleKey || null }),
    unlockedIdx, rankDates: rankHist.dates,
  }), [unlockedIdx, rankHist]);
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
      <RankCtx.Provider value={rankCtxValue}>
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
      {rankView && (
        <RankDetailModal
          tierIdx={rankView.tierIdx} muscleKey={rankView.muscleKey}
          onClose={() => setRankView(null)}
          onNav={(i) => setRankView((v) => ({ ...v, tierIdx: Math.max(0, Math.min(TIERS.length - 1, i)) }))}
          unlockedIdx={unlockedIdx} rankDates={rankHist.dates}
          muscleScores={muscleScores} overall={overall} lifts={lifts} bw={bw} profile={profile} flash={flash} />
      )}
      {celebration && <Celebration data={celebration} onClose={() => { setCelebration(null); setTab("profil"); setProfilSub("historique"); }} />}
      <footer style={S.footer}>Données sur ton appareil. Pense à exporter une sauvegarde (onglet Données).</footer>
      </RankCtx.Provider>
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
              <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, marginTop: 12,
                                    animation: `popIn .5s cubic-bezier(.2,1.4,.4,1) ${i * 0.25}s both` }}>
                <div style={{ position: "relative" }}>
                  {/* halo qui explose au passage de rang */}
                  <div style={{ position: "absolute", inset: -10, borderRadius: "50%", background: `radial-gradient(circle, ${r.tier.glow}66, transparent 70%)`,
                                animation: `rankBurst 1.1s ease-out ${i * 0.25}s both`, pointerEvents: "none" }} />
                  <div style={{ animation: `rankReveal .8s cubic-bezier(.2,1.3,.4,1) ${i * 0.25}s both` }}>
                    <RankBadge score={(r.tierIdx + 0.5) / TIERS.length} size={78} clickable={false} />
                  </div>
                </div>
                <span style={{ fontWeight: 800, fontSize: 15, color: r.tier.glow }}>{r.tier.label}</span>
                <span style={{ fontSize: 12, opacity: 0.7 }}>{r.muscle}</span>
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
  const ctx = useContext(RankCtx);
  const unlockedIdx = ctx ? ctx.unlockedIdx : -1;
  const rankDates = ctx ? ctx.rankDates : {};
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
        <div style={{ fontSize: 12, opacity: 0.65, marginTop: 8 }}>
          🏅 <b>{Math.max(0, unlockedIdx + 1)}/9</b> rangs débloqués · touche un emblème pour voir sa fiche.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginTop: 12 }}>
          {[...TIERS].reverse().map((tr, i) => {
            const idx = TIERS.length - 1 - i;
            const sampleScore = (idx + 0.5) / TIERS.length;
            const locked = idx > unlockedIdx;
            return (
              <div key={tr.key} onClick={() => ctx && ctx.openRank(idx, null)}
                   style={{ background: "var(--inner,#10151d)", border: `1px solid ${locked ? "var(--card-border,#1f2530)" : tr.color + "66"}`,
                            borderRadius: 12, padding: "10px 6px 8px", textAlign: "center", cursor: "pointer",
                            transition: ".15s", position: "relative" }}>
                <div style={{ display: "flex", justifyContent: "center" }}>
                  <RankBadge score={sampleScore} size={62} locked={locked} clickable={false} />
                </div>
                <div style={{ fontWeight: 800, fontSize: 12, marginTop: 5, color: locked ? "var(--muted-2,#8a92a0)" : tr.glow }}>{tr.label}</div>
                <div style={{ fontSize: 9.5, opacity: 0.5, marginTop: 1 }}>
                  {locked ? "Verrouillé" : rankDates[tr.key] ? new Date(rankDates[tr.key]).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit" }) : "Débloqué"}
                </div>
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
              <div key={m.key} onClick={() => s > 0 && ctx && ctx.openRank(tierIdx, m.key)}
                   style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13.5, cursor: s > 0 ? "pointer" : "default",
                            background: "var(--inner,#10151d)", borderRadius: 10, padding: "7px 10px" }}>
                {s > 0 ? <RankBadge score={s} size={30} muscleKey={m.key} clickable={false} /> : <span style={{ width: 30 }} />}
                <span style={{ flex: 1, opacity: 0.85, fontWeight: 600 }}>{m.label}</span>
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
  navArrow: { width: 34, height: 34, borderRadius: 10, border: "1px solid var(--border,#2a313d)", background: "var(--ghost,#1c2230)", color: "var(--text,#e8ecf2)", fontSize: 22, fontWeight: 800, cursor: "pointer", lineHeight: 1, flexShrink: 0, padding: 0 },
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
  @keyframes rankBurst { 0%{opacity:0;transform:scale(.4)} 35%{opacity:1;transform:scale(1.25)} 100%{opacity:0;transform:scale(1.9)} }
  @keyframes rankReveal { 0%{opacity:0;transform:scale(.3) rotate(-14deg);filter:brightness(2.4)} 60%{opacity:1;transform:scale(1.14) rotate(3deg);filter:brightness(1.5)} 100%{opacity:1;transform:scale(1) rotate(0);filter:brightness(1)} }
  @keyframes confettiFall { 0%{transform:translateY(0) rotate(0deg);opacity:1} 100%{transform:translateY(105vh) rotate(540deg);opacity:.7} }
  @keyframes slideUp { from{transform:translateY(40px);opacity:0} to{transform:translateY(0);opacity:1} }
  @keyframes slideDown { from{transform:translate(-50%,-16px);opacity:0} to{transform:translate(-50%,0);opacity:1} }
  ::-webkit-scrollbar { height:0; width:0; }
  input::-webkit-outer-spin-button, input::-webkit-inner-spin-button { -webkit-appearance:none; margin:0; }
  ul li::before { content:"›"; position:absolute; left:4px; color:#e0245e; font-weight:700; }
`;
