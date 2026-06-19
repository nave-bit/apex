import React, { useState, useEffect, useMemo } from "react";

/* =========================================================================
   APEX — Mesure de physique façon Liftoff
   Rangs par muscle • Exos par muscle • Séance • Historique • Nutrition
   Persistance locale (mobile) + export vers base de données
   ========================================================================= */

/* ----------------------------- TIERS ---------------------------------- */
const TIERS = [
  { key: "fer",     label: "Fer",     color: "#7c7f86", glow: "#9aa0a8" },
  { key: "bronze",  label: "Bronze",  color: "#a9682f", glow: "#cd853f" },
  { key: "argent",  label: "Argent",  color: "#9ca3af", glow: "#d6dce4" },
  { key: "or",      label: "Or",      color: "#c9a227", glow: "#f4d03f" },
  { key: "platine", label: "Platine", color: "#27a3a3", glow: "#5ce0e0" },
  { key: "diamant", label: "Diamant", color: "#4f7bd6", glow: "#7ea8ff" },
  { key: "maitre",  label: "Maître",  color: "#8e44ec", glow: "#c08bff" },
  { key: "elite",   label: "Élite",   color: "#e0245e", glow: "#ff5c8a" },
];

function scoreToRank(score) {
  const s = Math.max(0, Math.min(0.9999, score));
  const perTier = 1 / TIERS.length;
  const tierIdx = Math.floor(s / perTier);
  const within = (s - tierIdx * perTier) / perTier;
  const sub = 3 - Math.floor(within * 3);
  const tier = TIERS[tierIdx];
  return { tier, sub: Math.max(1, Math.min(3, sub)), within, tierIdx };
}

/* --------------------------- MUSCLES ---------------------------------- */
const MUSCLES = [
  { key: "pecs",     label: "Pectoraux" },
  { key: "dos",      label: "Dos" },
  { key: "epaules",  label: "Épaules" },
  { key: "biceps",   label: "Biceps" },
  { key: "triceps",  label: "Triceps" },
  { key: "quads",    label: "Quadriceps" },
  { key: "ischios",  label: "Ischios" },
  { key: "fessiers", label: "Fessiers" },
  { key: "abdos",    label: "Abdominaux" },
  { key: "mollets",  label: "Mollets" },
];
const muscleLabel = (k) => MUSCLES.find((m) => m.key === k)?.label || k;

/* -------------------------- EXERCISES --------------------------------- */
const EXERCISES = [
  { key: "bench", name: "Développé couché", icon: "▬", eliteRatio: 1.5, bw: false,
    primary: "pecs", muscles: { pecs: 0.6, triceps: 0.25, epaules: 0.15 },
    tips: ["Garde les omoplates serrées et les pieds ancrés au sol.","Descends la barre au bas des pectoraux, coudes à ~45°.","Contrôle la descente 2 s, pas de rebond."],
    variants: [{ n: "Développé haltères", why: "Plus d'amplitude, corrige les déséquilibres." },{ n: "Développé incliné", why: "Cible le haut des pectoraux." },{ n: "Pompes lestées", why: "Sans barre, protège les épaules." }] },
  { key: "incline", name: "Développé incliné", icon: "◤", eliteRatio: 1.25, bw: false,
    primary: "pecs", muscles: { pecs: 0.6, epaules: 0.25, triceps: 0.15 },
    tips: ["Banc à 30-45°, pas plus (sinon trop d'épaules).","Descends vers le haut des pectoraux.","Garde les poignets alignés sous les coudes."],
    variants: [{ n: "Développé incliné haltères", why: "Meilleure congestion du haut des pecs." },{ n: "Écarté incliné", why: "Isole l'étirement pectoral." }] },
  { key: "squat", name: "Squat", icon: "◢", eliteRatio: 2.2, bw: false,
    primary: "quads", muscles: { quads: 0.55, fessiers: 0.3, ischios: 0.15 },
    tips: ["Descends cuisse parallèle au sol minimum.","Dos neutre, poitrine haute, genoux dans l'axe des pieds.","Pousse dans le talon et le milieu du pied."],
    variants: [{ n: "Squat avant (front)", why: "Plus de quadriceps, dos plus droit." },{ n: "Squat gobelet", why: "Idéal débutant." },{ n: "Presse à cuisses", why: "Moins technique, charge en sécurité." }] },
  { key: "legpress", name: "Presse à cuisses", icon: "▰", eliteRatio: 3.0, bw: false,
    primary: "quads", muscles: { quads: 0.6, fessiers: 0.25, ischios: 0.15 },
    tips: ["Pieds largeur d'épaules au milieu du plateau.","Ne décolle pas les fessiers du siège.","Ne verrouille pas brutalement les genoux."],
    variants: [{ n: "Hack squat", why: "Plus de quadriceps, dos soutenu." },{ n: "Fentes", why: "Travail unilatéral et équilibre." }] },
  { key: "lunge", name: "Fentes", icon: "◿", eliteRatio: 0.8, bw: false,
    primary: "quads", muscles: { quads: 0.45, fessiers: 0.4, ischios: 0.15 },
    tips: ["Grand pas, genou arrière vers le sol.","Buste droit, genou avant au-dessus de la cheville.","Pousse dans le talon avant pour remonter."],
    variants: [{ n: "Fentes bulgares", why: "Pied arrière surélevé, fessiers intenses." },{ n: "Fentes marchées", why: "Plus dynamique et fonctionnel." }] },
  { key: "deadlift", name: "Soulevé de terre", icon: "⎯", eliteRatio: 2.5, bw: false,
    primary: "dos", muscles: { dos: 0.35, ischios: 0.3, fessiers: 0.25, quads: 0.1 },
    tips: ["Barre collée aux tibias, dos plat, épaules au-dessus de la barre.","Pousse le sol avec les jambes avant de tirer.","Verrouille hanches et genoux ensemble en haut."],
    variants: [{ n: "Soulevé roumain", why: "Cible ischios et fessiers." },{ n: "Sumo", why: "Plus de quadriceps et d'adducteurs." },{ n: "Hip thrust", why: "Isole les fessiers sans charger la colonne." }] },
  { key: "rdl", name: "Soulevé roumain", icon: "⌐", eliteRatio: 2.0, bw: false,
    primary: "ischios", muscles: { ischios: 0.5, fessiers: 0.35, dos: 0.15 },
    tips: ["Jambes quasi tendues, léger fléchi du genou.","Pousse les hanches vers l'arrière, dos plat.","Sens l'étirement des ischios avant de remonter."],
    variants: [{ n: "RDL une jambe", why: "Équilibre et correction d'asymétrie." },{ n: "Good morning", why: "Renforce toute la chaîne postérieure." }] },
  { key: "ohp", name: "Développé militaire", icon: "▲", eliteRatio: 1.0, bw: false,
    primary: "epaules", muscles: { epaules: 0.6, triceps: 0.3, pecs: 0.1 },
    tips: ["Gaine abdos et fessiers pour ne pas cambrer.","Passe la tête sous la barre en haut.","Coudes légèrement devant la barre au départ."],
    variants: [{ n: "Développé haltères assis", why: "Plus stable, isole l'épaule." },{ n: "Arnold press", why: "Travaille les trois faisceaux." },{ n: "Élévations latérales", why: "Deltoïde moyen pour la largeur." }] },
  { key: "latraise", name: "Élévations latérales", icon: "⊥", eliteRatio: 0.25, bw: false,
    primary: "epaules", muscles: { epaules: 0.95, triceps: 0.05 },
    tips: ["Léger fléchi du coude, monte jusqu'à l'horizontale.","Mène le mouvement avec les coudes, pas les mains.","Descends lentement, pas de balancier."],
    variants: [{ n: "Élévations à la poulie", why: "Tension constante sur le deltoïde." },{ n: "Oiseau (rear delt)", why: "Cible l'arrière de l'épaule." }] },
  { key: "pullup", name: "Tractions", icon: "⊓", eliteRatio: 0.7, bw: true,
    primary: "dos", muscles: { dos: 0.6, biceps: 0.3, epaules: 0.1 },
    tips: ["Pars bras tendus, monte le menton au-dessus de la barre.","Tire les coudes vers le bas, serre les omoplates.","Contrôle la descente, pas de balancier."],
    variants: [{ n: "Tirage vertical", why: "Charge réglable, avant les tractions strictes." },{ n: "Tractions supination", why: "Plus de biceps, plus accessible." },{ n: "Rowing inversé", why: "Stepping-stone horizontal." }] },
  { key: "latpull", name: "Tirage vertical", icon: "⊤", eliteRatio: 1.0, bw: false,
    primary: "dos", muscles: { dos: 0.65, biceps: 0.25, epaules: 0.1 },
    tips: ["Tire la barre vers le haut de la poitrine.","Bombe le torse, descends les omoplates.","Évite de tirer derrière la nuque."],
    variants: [{ n: "Tirage prise serrée", why: "Cible le milieu du dos." },{ n: "Pull-over poulie", why: "Isole le grand dorsal." }] },
  { key: "row", name: "Rowing barre", icon: "═", eliteRatio: 1.2, bw: false,
    primary: "dos", muscles: { dos: 0.6, biceps: 0.25, epaules: 0.15 },
    tips: ["Buste penché à ~45°, dos neutre, gainage solide.","Tire vers le bas-ventre, coudes près du corps.","Serre les omoplates 1 s en haut."],
    variants: [{ n: "Rowing haltère un bras", why: "Plus d'amplitude, corrige les asymétries." },{ n: "Tirage horizontal poulie", why: "Tension constante, dos protégé." },{ n: "Rowing T-bar", why: "Charge lourde, dos soutenu." }] },
  { key: "curl", name: "Curl biceps", icon: "↿", eliteRatio: 0.55, bw: false,
    primary: "biceps", muscles: { biceps: 0.9, epaules: 0.1 },
    tips: ["Coudes fixes le long du corps, pas de balancier.","Contracte fort en haut, descends lentement.","Garde les poignets neutres."],
    variants: [{ n: "Curl marteau", why: "Cible le brachial et l'avant-bras." },{ n: "Curl incliné", why: "Étire le biceps pour un travail complet." },{ n: "Curl pupitre", why: "Élimine la triche, isole le pic." }] },
  { key: "hammer", name: "Curl marteau", icon: "↾", eliteRatio: 0.5, bw: false,
    primary: "biceps", muscles: { biceps: 0.8, epaules: 0.2 },
    tips: ["Paume face à face (prise neutre) tout le long.","Coudes immobiles, mouvement contrôlé.","Marque une pause en haut."],
    variants: [{ n: "Curl corde poulie", why: "Tension continue sur le brachial." },{ n: "Curl Zottman", why: "Combine flexion et travail des avant-bras." }] },
  { key: "dips", name: "Dips", icon: "⊔", eliteRatio: 0.6, bw: true,
    primary: "triceps", muscles: { triceps: 0.5, pecs: 0.35, epaules: 0.15 },
    tips: ["Buste droit = triceps, buste penché = pectoraux.","Descends à ~90° au coude, pas plus si l'épaule tire.","Verrouille en haut sans bloquer brutalement."],
    variants: [{ n: "Dips machine assistée", why: "Charge réglable pour progresser." },{ n: "Extension triceps poulie", why: "Isole le triceps." },{ n: "Pompes diamant", why: "Au poids de corps, focus triceps." }] },
  { key: "triext", name: "Extension triceps poulie", icon: "↧", eliteRatio: 0.5, bw: false,
    primary: "triceps", muscles: { triceps: 0.95, epaules: 0.05 },
    tips: ["Coudes collés au corps, immobiles.","Tends complètement le bras en bas.","Remonte en contrôlant la charge."],
    variants: [{ n: "Extension à la corde", why: "Meilleure contraction finale." },{ n: "Barre au front", why: "Étire le triceps sous charge." }] },
  { key: "legcurl", name: "Leg curl", icon: "◜", eliteRatio: 0.4, bw: false,
    primary: "ischios", muscles: { ischios: 0.9, mollets: 0.1 },
    tips: ["Mouvement lent et contrôlé, pas d'à-coups.","Contracte les ischios en fin de flexion.","Garde le bassin plaqué sur le banc."],
    variants: [{ n: "Leg curl debout", why: "Travail unilatéral de l'ischio." },{ n: "Nordic curl", why: "Excentrique intense au poids de corps." }] },
  { key: "hipthrust", name: "Hip thrust", icon: "⊥", eliteRatio: 1.8, bw: false,
    primary: "fessiers", muscles: { fessiers: 0.7, ischios: 0.2, quads: 0.1 },
    tips: ["Dos sur le banc au niveau des omoplates.","Pousse dans les talons, serre fort les fessiers en haut.","Menton rentré, bassin neutre en haut."],
    variants: [{ n: "Glute bridge au sol", why: "Version sans banc pour débuter." },{ n: "Hip thrust une jambe", why: "Corrige les déséquilibres fessiers." }] },
  { key: "plank", name: "Gainage", icon: "▭", eliteRatio: 0, bw: true, isTime: true, eliteSeconds: 240,
    primary: "abdos", muscles: { abdos: 0.9, epaules: 0.1 },
    tips: ["Corps aligné des talons à la tête, fessiers serrés.","Rentre le nombril, ne creuse pas le dos.","Respire normalement, ne bloque pas l'air."],
    variants: [{ n: "Roulette abdominale", why: "Gainage dynamique très intense." },{ n: "Hollow hold", why: "Renforce le transverse en contrôle." }] },
  { key: "legraise", name: "Relevés de jambes", icon: "◳", eliteRatio: 0.5, bw: true,
    primary: "abdos", muscles: { abdos: 0.95, quads: 0.05 },
    tips: ["Suspendu, monte les jambes sans balancer.","Enroule le bassin en haut du mouvement.","Descends lentement en gardant le gainage."],
    variants: [{ n: "Crunch inversé", why: "Version au sol plus accessible." },{ n: "Relevés genoux pliés", why: "Plus facile pour débuter." }] },
  { key: "calf", name: "Mollets debout", icon: "◣", eliteRatio: 1.4, bw: false,
    primary: "mollets", muscles: { mollets: 1.0 },
    tips: ["Amplitude max : talon bas, montée sur la pointe.","Pause 1 s en haut et en bas.","Tempo lent, le mollet répond au volume."],
    variants: [{ n: "Mollets assis", why: "Cible le soléaire." },{ n: "Mollets à la presse", why: "Charge lourde sans tension lombaire." }] },
];

const EX_BY_KEY = Object.fromEntries(EXERCISES.map((e) => [e.key, e]));

/* -------------------------- NUTRITION --------------------------------- */
const NUTRITION = {
  seche: { label: "Sèche", kcalFactor: 28, protein: 2.2, carbs: 2.5, fat: 0.8,
    tips: ["Déficit modéré (~300-500 kcal) pour garder le muscle.","Protéines hautes pour préserver la masse maigre.","Privilégie les aliments volumineux et rassasiants.","Garde des glucides autour de l'entraînement."],
    meals: [{ t: "Petit-déj", d: "Omelette 3 œufs + flocons d'avoine + fruits rouges" },{ t: "Déjeuner", d: "Blanc de poulet, riz complet, brocolis" },{ t: "Collation", d: "Skyr + amandes" },{ t: "Dîner", d: "Poisson blanc, patate douce, salade verte" }] },
  maintien: { label: "Maintien", kcalFactor: 33, protein: 1.8, carbs: 4.0, fat: 1.0,
    tips: ["Mange à hauteur de ta dépense pour stabiliser le poids.","Répartis les protéines sur 3-4 repas.","Garde 80 % d'aliments bruts, 20 % de plaisir.","Hydrate-toi : 35 ml/kg par jour."],
    meals: [{ t: "Petit-déj", d: "Pain complet, œufs, avocat" },{ t: "Déjeuner", d: "Bœuf maigre, pâtes complètes, légumes" },{ t: "Collation", d: "Fromage blanc + banane + miel" },{ t: "Dîner", d: "Saumon, quinoa, courgettes" }] },
  prise: { label: "Prise de masse", kcalFactor: 39, protein: 2.0, carbs: 5.0, fat: 1.1,
    tips: ["Léger surplus (~300-500 kcal) pour construire sans trop de gras.","Glucides élevés pour soutenir le volume.","Ajoute des calories liquides si l'appétit manque.","Vise +0,25 à +0,5 % de poids de corps par semaine."],
    meals: [{ t: "Petit-déj", d: "Porridge avoine-lait, beurre de cacahuète, banane" },{ t: "Déjeuner", d: "Riz, poulet, huile d'olive, légumes" },{ t: "Collation", d: "Smoothie : lait, whey, flocons, fruits" },{ t: "Dîner", d: "Steak, pommes de terre, légumes au beurre" }] },
};

/* --------------------------- HELPERS ---------------------------------- */
function perfToScore(ex, best1RM, bw) {
  if (!best1RM || !bw) return 0;
  if (ex.isTime) return Math.max(0, Math.min(1, best1RM / ex.eliteSeconds));
  let eff = ex.bw ? bw + best1RM : best1RM;
  const target = ex.eliteRatio * bw;
  if (target <= 0) return 0;
  return Math.max(0, Math.min(1, eff / target));
}
function estimate1RM(weight, reps) {
  if (!weight || !reps) return 0;
  if (reps === 1) return Math.round(weight);
  return Math.round(weight * (1 + reps / 30));
}
const uid = () => Math.random().toString(36).slice(2, 9);

/* --------------------- PERSISTENCE (localStorage) --------------------- */
/* On essaie localStorage (persiste sur mobile). Si indisponible (ex: aperçu
   en sandbox), on retombe sur un store mémoire pour ne pas planter. */
const mem = {};
const store = {
  get(k, fb) {
    try {
      const v = window.localStorage.getItem(k);
      return v ? JSON.parse(v) : (mem[k] ?? fb);
    } catch { return mem[k] ?? fb; }
  },
  set(k, val) {
    mem[k] = val;
    try { window.localStorage.setItem(k, JSON.stringify(val)); } catch {}
  },
};
const K = { profile: "apex_profile", lifts: "apex_lifts", routines: "apex_routines", history: "apex_history" };

/* ----------------------------- UI BITS -------------------------------- */
function hexPoints(cx, cy, r) {
  let pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 90);
    pts.push(`${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`);
  }
  return pts.join(" ");
}
function RankBadge({ score, size = 64 }) {
  const { tier, sub } = scoreToRank(score);
  const r = size / 2;
  const gid = `g-${tier.key}-${size}`;
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <defs>
          <radialGradient id={gid} cx="50%" cy="35%" r="70%">
            <stop offset="0%" stopColor={tier.glow} />
            <stop offset="100%" stopColor={tier.color} />
          </radialGradient>
        </defs>
        <polygon points={hexPoints(r, r, r - 3)} fill={`url(#${gid})`} stroke="rgba(255,255,255,.25)" strokeWidth="1.5" />
        <polygon points={hexPoints(r, r, r - 9)} fill="none" stroke="rgba(0,0,0,.25)" strokeWidth="1" />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, textShadow: "0 1px 3px rgba(0,0,0,.5)", fontSize: size * 0.34, lineHeight: 1 }}>
        {tier.label[0]}
        <span style={{ fontSize: size * 0.18, fontWeight: 700, opacity: 0.95 }}>{sub}</span>
      </div>
    </div>
  );
}
function ProgressBar({ value, color }) {
  return (
    <div style={{ height: 8, background: "#1b1f27", borderRadius: 99, overflow: "hidden" }}>
      <div style={{ width: `${Math.round(value * 100)}%`, height: "100%", background: `linear-gradient(90deg, ${color}aa, ${color})`, borderRadius: 99, transition: "width .5s cubic-bezier(.2,.8,.2,1)" }} />
    </div>
  );
}
function Toast({ msg }) {
  if (!msg) return null;
  return <div style={S.toast}>{msg}</div>;
}

/* ----------------------------- APP ------------------------------------ */
export default function App() {
  const [tab, setTab] = useState("apercu");
  const [profile, setProfile] = useState(() => store.get(K.profile, { bodyweight: 75, goal: "maintien" }));
  const [lifts, setLifts] = useState(() => store.get(K.lifts, {}));
  const [routines, setRoutines] = useState(() => store.get(K.routines, []));
  const [history, setHistory] = useState(() => store.get(K.history, []));
  const [editingRoutine, setEditingRoutine] = useState(null);
  const [toast, setToast] = useState("");

  useEffect(() => store.set(K.profile, profile), [profile]);
  useEffect(() => store.set(K.lifts, lifts), [lifts]);
  useEffect(() => store.set(K.routines, routines), [routines]);
  useEffect(() => store.set(K.history, history), [history]);

  const flash = (m) => { setToast(m); setTimeout(() => setToast(""), 2200); };

  const bw = Number(profile.bodyweight) || 0;

  const muscleScores = useMemo(() => {
    const acc = {};
    MUSCLES.forEach((m) => (acc[m.key] = { sum: 0, w: 0 }));
    EXERCISES.forEach((ex) => {
      const rec = lifts[ex.key];
      if (!rec?.best1RM) return;
      const s = perfToScore(ex, rec.best1RM, bw);
      Object.entries(ex.muscles).forEach(([mk, w]) => { acc[mk].sum += s * w; acc[mk].w += w; });
    });
    const out = {};
    MUSCLES.forEach((m) => (out[m.key] = acc[m.key].w > 0 ? acc[m.key].sum / acc[m.key].w : 0));
    return out;
  }, [lifts, bw]);

  const overall = useMemo(() => {
    const vals = Object.values(muscleScores).filter((v) => v > 0);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }, [muscleScores]);

  const loggedCount = Object.values(lifts).filter((l) => l?.best1RM).length;

  // ----- routines -----
  const saveRoutine = (routine) => {
    setRoutines((prev) => {
      const exists = prev.some((r) => r.id === routine.id);
      return exists ? prev.map((r) => (r.id === routine.id ? routine : r)) : [...prev, routine];
    });
    setEditingRoutine(null);
    flash("Séance enregistrée ✓");
    setTab("seances");
  };
  const deleteRoutine = (id) => setRoutines((prev) => prev.filter((r) => r.id !== id));

  // ----- log a completed session into history + update best lifts -----
  const completeSession = (session) => {
    setHistory((prev) => [{ ...session, id: uid(), date: new Date().toISOString() }, ...prev].slice(0, 200));
    // mettre à jour les records
    setLifts((prev) => {
      const next = { ...prev };
      session.exercises.forEach((se) => {
        const ex = EX_BY_KEY[se.key];
        if (!ex) return;
        let best = 0;
        se.sets.forEach((set) => {
          const e = ex.isTime ? Number(set.secs) || 0 : estimate1RM(Number(set.weight), Number(set.reps));
          if (e > best) best = e;
        });
        if (best > 0) {
          const rec = next[ex.key] || { history: [] };
          next[ex.key] = { best1RM: Math.max(best, rec.best1RM || 0), history: rec.history || [] };
        }
      });
      return next;
    });
    flash("Séance terminée — records mis à jour ✓");
    setTab("historique");
  };

  return (
    <div style={S.app}>
      <style>{KEYFRAMES}</style>
      <Toast msg={toast} />

      <header style={S.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={S.logo}><span style={{ color: "#e0245e" }}>A</span>PEX</div>
          <span style={S.tagline}>mesure de physique</span>
        </div>
        <BodyweightInput profile={profile} setProfile={setProfile} />
      </header>

      <nav style={S.tabs}>
        {[["apercu","Aperçu"],["muscles","Muscles"],["exos","Exercices"],["seances","Séances"],["historique","Historique"],["nutrition","Nutrition"]].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={{ ...S.tab, ...(tab === k ? S.tabActive : {}) }}>{label}</button>
        ))}
      </nav>

      <main style={S.main}>
        {tab === "apercu" && <Overview overall={overall} muscleScores={muscleScores} loggedCount={loggedCount} setTab={setTab} />}
        {tab === "muscles" && <Muscles muscleScores={muscleScores} />}
        {tab === "exos" && <ExoByMuscle lifts={lifts} setLifts={setLifts} bw={bw} flash={flash} />}
        {tab === "seances" && (
          editingRoutine
            ? <RoutineEditor routine={editingRoutine} onSave={saveRoutine} onCancel={() => setEditingRoutine(null)} />
            : <Seances routines={routines} onNew={() => setEditingRoutine({ id: uid(), name: "", exercises: [] })} onEdit={(r) => setEditingRoutine(r)} onDelete={deleteRoutine} onStart={(r) => setEditingRoutine({ ...r, _mode: "log" })} />
        )}
        {tab === "historique" && <History history={history} bw={bw} onClear={() => setHistory([])} flash={flash} profile={profile} routines={routines} lifts={lifts} />}
        {tab === "nutrition" && <Nutrition profile={profile} setProfile={setProfile} />}
      </main>

      {/* Logger overlay (séance en cours) */}
      {editingRoutine?._mode === "log" && (
        <SessionLogger routine={editingRoutine} onFinish={completeSession} onCancel={() => setEditingRoutine(null)} />
      )}

      <footer style={S.footer}>
        Données enregistrées sur ton appareil. Les rangs sont indicatifs (force relative au poids de corps).
      </footer>
    </div>
  );
}

/* ------------------------ BODYWEIGHT INPUT ---------------------------- */
/* Géré en chaîne -> on peut vider le champ et taper librement. */
function BodyweightInput({ profile, setProfile }) {
  const [val, setVal] = useState(String(profile.bodyweight ?? ""));
  useEffect(() => { setVal(String(profile.bodyweight ?? "")); }, [profile.bodyweight]);
  return (
    <div style={S.bwPill}>
      <span style={{ opacity: 0.6, fontSize: 12 }}>Poids</span>
      <input
        type="text" inputMode="decimal" value={val}
        onChange={(e) => {
          const v = e.target.value.replace(",", ".");
          if (v === "" || /^\d*\.?\d*$/.test(v)) {
            setVal(v);
            setProfile({ ...profile, bodyweight: v === "" ? "" : Number(v) });
          }
        }}
        onBlur={() => { if (val === "" || isNaN(Number(val))) { setVal("75"); setProfile({ ...profile, bodyweight: 75 }); } }}
        style={S.bwInput}
      />
      <span style={{ opacity: 0.6, fontSize: 12 }}>kg</span>
    </div>
  );
}

/* ---------------------------- OVERVIEW -------------------------------- */
function Overview({ overall, muscleScores, loggedCount, setTab }) {
  const { tier, sub, within } = scoreToRank(overall);
  const sorted = [...MUSCLES].sort((a, b) => muscleScores[b.key] - muscleScores[a.key]);
  const strongest = sorted[0];
  const weakest = [...sorted].reverse().find((m) => muscleScores[m.key] > 0) || sorted[sorted.length - 1];

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <section style={{ ...S.card, ...S.heroCard }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div style={{ animation: "float 4s ease-in-out infinite" }}><RankBadge score={overall} size={92} /></div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, letterSpacing: 2, opacity: 0.5, textTransform: "uppercase" }}>Rang global</div>
            <div style={{ fontSize: 30, fontWeight: 800, color: tier.glow, lineHeight: 1.1 }}>{tier.label} {sub}</div>
            <div style={{ marginTop: 10 }}>
              <ProgressBar value={within} color={tier.glow} />
              <div style={{ fontSize: 11, opacity: 0.5, marginTop: 4 }}>
                {loggedCount === 0 ? "Enregistre tes premiers exercices pour calculer ton rang" : "Progression vers le palier suivant"}
              </div>
            </div>
          </div>
        </div>
      </section>

      {loggedCount === 0 ? (
        <section style={{ ...S.card, textAlign: "center", padding: 32 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>◆</div>
          <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 6 }}>Commence ton bilan</div>
          <div style={{ opacity: 0.6, fontSize: 14, marginBottom: 18, maxWidth: 360, margin: "0 auto 18px" }}>
            Renseigne tes charges sur quelques exercices clés. APEX calcule un rang pour chaque groupe musculaire.
          </div>
          <button style={S.btnPrimary} onClick={() => setTab("exos")}>Enregistrer un exercice →</button>
        </section>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <section style={S.card}>
              <div style={S.miniLabel}>💪 Point fort</div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
                <RankBadge score={muscleScores[strongest.key]} size={40} />
                <div><div style={{ fontWeight: 700 }}>{strongest.label}</div>
                  <div style={{ fontSize: 12, opacity: 0.6 }}>{scoreToRank(muscleScores[strongest.key]).tier.label} {scoreToRank(muscleScores[strongest.key]).sub}</div></div>
              </div>
            </section>
            <section style={S.card}>
              <div style={S.miniLabel}>🎯 À renforcer</div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
                <RankBadge score={muscleScores[weakest.key]} size={40} />
                <div><div style={{ fontWeight: 700 }}>{weakest.label}</div>
                  <div style={{ fontSize: 12, opacity: 0.6 }}>{scoreToRank(muscleScores[weakest.key]).tier.label} {scoreToRank(muscleScores[weakest.key]).sub}</div></div>
              </div>
            </section>
          </div>
          <section style={S.card}>
            <div style={S.cardTitle}>Équilibre du physique</div>
            <Radar scores={muscleScores} />
          </section>
        </>
      )}
    </div>
  );
}

function Radar({ scores }) {
  const size = 260, cx = size / 2, cy = size / 2, R = size / 2 - 34;
  const keys = MUSCLES, n = keys.length;
  const pt = (i, r) => { const a = (Math.PI * 2 * i) / n - Math.PI / 2; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
  const poly = keys.map((m, i) => pt(i, R * Math.max(0.04, scores[m.key])).join(",")).join(" ");
  return (
    <div style={{ display: "flex", justifyContent: "center", marginTop: 8 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {[0.25, 0.5, 0.75, 1].map((g) => (
          <polygon key={g} points={keys.map((_, i) => pt(i, R * g).join(",")).join(" ")} fill="none" stroke="#262b35" strokeWidth="1" />
        ))}
        {keys.map((_, i) => { const [x, y] = pt(i, R); return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="#262b35" strokeWidth="1" />; })}
        <polygon points={poly} fill="rgba(224,36,94,.22)" stroke="#e0245e" strokeWidth="2" style={{ animation: "fadeIn .6s ease" }} />
        {keys.map((m, i) => { const [x, y] = pt(i, R * Math.max(0.04, scores[m.key])); return <circle key={m.key} cx={x} cy={y} r="3" fill="#ff5c8a" />; })}
        {keys.map((m, i) => { const [x, y] = pt(i, R + 18); return <text key={m.key} x={x} y={y} fontSize="9.5" fill="#8a92a0" textAnchor="middle" dominantBaseline="middle">{m.label}</text>; })}
      </svg>
    </div>
  );
}

/* ---------------------------- MUSCLES --------------------------------- */
function Muscles({ muscleScores }) {
  const sorted = [...MUSCLES].sort((a, b) => muscleScores[b.key] - muscleScores[a.key]);
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {sorted.map((m) => {
        const s = muscleScores[m.key];
        const { tier, sub, within } = scoreToRank(s);
        return (
          <div key={m.key} style={{ ...S.card, display: "flex", alignItems: "center", gap: 14 }}>
            <RankBadge score={s} size={52} />
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontWeight: 700, fontSize: 15 }}>{m.label}</span>
                <span style={{ color: tier.glow, fontWeight: 700, fontSize: 13 }}>{s > 0 ? `${tier.label} ${sub}` : "Non évalué"}</span>
              </div>
              <div style={{ marginTop: 8 }}><ProgressBar value={s > 0 ? within : 0} color={s > 0 ? tier.glow : "#3a3f4a"} /></div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* --------------------- EXERCISES GROUPED BY MUSCLE -------------------- */
function ExoByMuscle({ lifts, setLifts, bw, flash }) {
  const [open, setOpen] = useState(null);
  const [openMuscle, setOpenMuscle] = useState(MUSCLES[0].key);

  const setBest = (ex, e1rm, weight, reps) => {
    setLifts((prev) => {
      const rec = prev[ex.key] || { history: [] };
      const history = [{ date: new Date().toISOString(), weight, reps, e1rm }, ...(rec.history || [])].slice(0, 30);
      return { ...prev, [ex.key]: { best1RM: Math.max(e1rm, rec.best1RM || 0), history } };
    });
    flash("Performance enregistrée ✓");
  };

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
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 800, fontSize: 16 }}>{m.label}</div>
                <div style={{ fontSize: 11.5, opacity: 0.5 }}>{list.length} exercices · {doneCount} renseignés</div>
              </div>
              <span style={{ opacity: 0.4, fontSize: 20, transform: isMuscleOpen ? "rotate(90deg)" : "none", transition: ".2s" }}>›</span>
            </div>

            {isMuscleOpen && (
              <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
                {list.map((ex) => {
                  const rec = lifts[ex.key];
                  const score = rec?.best1RM ? perfToScore(ex, rec.best1RM, bw) : 0;
                  const isOpen = open === ex.key;
                  return (
                    <div key={ex.key} style={S.exoInner}>
                      <div onClick={() => setOpen(isOpen ? null : ex.key)} style={{ display: "flex", alignItems: "center", gap: 12, cursor: "pointer" }}>
                        <div style={S.exoIcon}>{ex.icon}</div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 700, fontSize: 14 }}>{ex.name}</div>
                          <div style={{ fontSize: 12, opacity: 0.55 }}>
                            {rec?.best1RM ? (ex.isTime ? `Record : ${rec.best1RM}s` : `1RM estimé : ${rec.best1RM} kg`) : "Aucune donnée"}
                          </div>
                        </div>
                        {rec?.best1RM ? <RankBadge score={score} size={36} /> : <span style={{ fontSize: 12, color: "#e0245e", fontWeight: 600 }}>+ Ajouter</span>}
                      </div>

                      {isOpen && (
                        <div style={{ marginTop: 12, borderTop: "1px solid #232833", paddingTop: 12 }}>
                          <ExoForm ex={ex} bw={bw} onSave={(e, w, r) => setBest(ex, e, w, r)} />
                          <div style={{ marginTop: 14 }}>
                            <div style={S.miniLabel}>Muscles ciblés</div>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                              {Object.entries(ex.muscles).sort((a, b) => b[1] - a[1]).map(([mk, w]) => (
                                <span key={mk} style={{ ...S.chip, opacity: 0.4 + w * 0.6 }}>{muscleLabel(mk)} {Math.round(w * 100)}%</span>
                              ))}
                            </div>
                          </div>
                          <div style={{ marginTop: 14 }}>
                            <div style={S.miniLabel}>Conseils de forme</div>
                            <ul style={S.tipList}>{ex.tips.map((t, i) => <li key={i} style={S.tipItem}>{t}</li>)}</ul>
                          </div>
                          <div style={{ marginTop: 12 }}>
                            <div style={S.miniLabel}>Variantes</div>
                            <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
                              {ex.variants.map((v, i) => (
                                <div key={i} style={S.variant}>
                                  <span style={{ fontWeight: 600, color: "#ff8fb0" }}>{v.n}</span>
                                  <span style={{ opacity: 0.6, fontSize: 12.5 }}> — {v.why}</span>
                                </div>
                              ))}
                            </div>
                          </div>
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
  const [weight, setWeight] = useState("");
  const [reps, setReps] = useState("");
  const [secs, setSecs] = useState("");

  if (ex.isTime) {
    const preview = Number(secs) || 0;
    const score = preview ? perfToScore(ex, preview, bw) : 0;
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
  const e1rm = estimate1RM(Number(weight), Number(reps));
  const score = e1rm ? perfToScore(ex, e1rm, bw) : 0;
  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
        <Field label={ex.bw ? "Charge ajoutée (kg)" : "Charge (kg)"} value={weight} onChange={setWeight} placeholder={ex.bw ? "0 = poids du corps" : "ex. 80"} />
        <Field label="Répétitions" value={reps} onChange={setReps} placeholder="ex. 5" />
        <button style={{ ...S.btnPrimary, opacity: e1rm ? 1 : 0.4 }} disabled={!e1rm} onClick={() => { onSave(e1rm, Number(weight), Number(reps)); setWeight(""); setReps(""); }}>Valider</button>
      </div>
      {e1rm > 0 && (
        <div style={S.previewBox}>
          1RM estimé : <b>{e1rm} kg</b> · Rang : <b style={{ color: scoreToRank(score).tier.glow }}>{scoreToRank(score).tier.label} {scoreToRank(score).sub}</b>
          {ex.bw && <span style={{ opacity: 0.5 }}> (corps {bw} + {weight || 0} kg)</span>}
        </div>
      )}
    </div>
  );
}

function Field({ label, value, onChange, placeholder }) {
  return (
    <label style={{ display: "block", flex: "1 1 120px" }}>
      <span style={{ fontSize: 11, opacity: 0.55, display: "block", marginBottom: 4 }}>{label}</span>
      <input type="text" inputMode="decimal" value={value} placeholder={placeholder}
        onChange={(e) => { const v = e.target.value.replace(",", "."); if (v === "" || /^\d*\.?\d*$/.test(v)) onChange(v); }}
        style={S.input} />
    </label>
  );
}

/* ---------------------------- SÉANCES --------------------------------- */
function Seances({ routines, onNew, onEdit, onDelete, onStart }) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <button style={{ ...S.btnPrimary, width: "100%", padding: 14, fontSize: 15 }} onClick={onNew}>+ Créer une séance</button>
      {routines.length === 0 ? (
        <div style={{ ...S.card, textAlign: "center", padding: 28, opacity: 0.6 }}>
          Aucune séance enregistrée. Crée ta première séance en sélectionnant des exercices : elle sera gardée sur ton appareil.
        </div>
      ) : routines.map((r) => (
        <div key={r.id} style={S.card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 800, fontSize: 17 }}>{r.name || "Séance sans nom"}</div>
              <div style={{ fontSize: 12.5, opacity: 0.55, marginTop: 2 }}>{r.exercises.length} exercices</div>
            </div>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
            {r.exercises.map((e) => <span key={e.key} style={S.chip}>{EX_BY_KEY[e.key]?.name || e.key}</span>)}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button style={{ ...S.btnPrimary, flex: 1 }} onClick={() => onStart(r)}>▶ Démarrer</button>
            <button style={S.btnGhost} onClick={() => onEdit(r)}>Modifier</button>
            <button style={{ ...S.btnGhost, color: "#ff6b6b" }} onClick={() => onDelete(r.id)}>Suppr.</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function RoutineEditor({ routine, onSave, onCancel }) {
  const [name, setName] = useState(routine.name || "");
  const [exercises, setExercises] = useState(routine.exercises || []);
  const [picker, setPicker] = useState(false);

  const toggle = (key) => {
    setExercises((prev) => prev.some((e) => e.key === key)
      ? prev.filter((e) => e.key !== key)
      : [...prev, { key, sets: 3, targetReps: 8 }]);
  };
  const isSelected = (key) => exercises.some((e) => e.key === key);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <section style={S.card}>
        <div style={S.miniLabel}>Nom de la séance</div>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="ex. Push lundi, Jambes, Full body…" style={{ ...S.input, marginTop: 8 }} />
      </section>

      <section style={S.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={S.cardTitle}>Exercices sélectionnés ({exercises.length})</div>
          <button style={S.btnGhost} onClick={() => setPicker(!picker)}>{picker ? "Fermer" : "+ Ajouter"}</button>
        </div>

        {exercises.length === 0 && !picker && (
          <div style={{ opacity: 0.5, fontSize: 13.5, marginTop: 8 }}>Aucun exercice. Touche « + Ajouter » pour en sélectionner.</div>
        )}

        {!picker && exercises.map((e) => {
          const ex = EX_BY_KEY[e.key];
          return (
            <div key={e.key} style={{ ...S.exoInner, marginTop: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={S.exoIcon}>{ex.icon}</div>
                <div style={{ flex: 1, fontWeight: 700, fontSize: 14 }}>{ex.name}</div>
                <button style={{ ...S.btnGhost, color: "#ff6b6b", padding: "4px 10px" }} onClick={() => toggle(e.key)}>×</button>
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                <MiniNum label="Séries" value={e.sets} onChange={(v) => setExercises((prev) => prev.map((x) => x.key === e.key ? { ...x, sets: v } : x))} />
                {!ex.isTime && <MiniNum label="Reps cible" value={e.targetReps} onChange={(v) => setExercises((prev) => prev.map((x) => x.key === e.key ? { ...x, targetReps: v } : x))} />}
              </div>
            </div>
          );
        })}

        {picker && (
          <div style={{ marginTop: 10, display: "grid", gap: 12 }}>
            {MUSCLES.map((m) => {
              const list = EXERCISES.filter((e) => e.primary === m.key);
              if (!list.length) return null;
              return (
                <div key={m.key}>
                  <div style={{ ...S.miniLabel, marginBottom: 6 }}>{m.label}</div>
                  <div style={{ display: "grid", gap: 6 }}>
                    {list.map((ex) => (
                      <div key={ex.key} onClick={() => toggle(ex.key)} style={{ ...S.pickRow, ...(isSelected(ex.key) ? S.pickRowOn : {}) }}>
                        <div style={{ ...S.exoIcon, width: 32, height: 32, fontSize: 16 }}>{ex.icon}</div>
                        <span style={{ flex: 1, fontWeight: 600, fontSize: 13.5 }}>{ex.name}</span>
                        <span style={{ fontSize: 18, color: isSelected(ex.key) ? "#e0245e" : "#3a3f4a", fontWeight: 800 }}>{isSelected(ex.key) ? "✓" : "+"}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <div style={{ display: "flex", gap: 10 }}>
        <button style={{ ...S.btnPrimary, flex: 1, padding: 14, opacity: exercises.length ? 1 : 0.4 }} disabled={!exercises.length} onClick={() => onSave({ id: routine.id, name, exercises })}>Enregistrer la séance</button>
        <button style={S.btnGhost} onClick={onCancel}>Annuler</button>
      </div>
    </div>
  );
}

function MiniNum({ label, value, onChange }) {
  return (
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 10.5, opacity: 0.5, marginBottom: 3 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button style={S.stepBtn} onClick={() => onChange(Math.max(1, value - 1))}>−</button>
        <span style={{ minWidth: 22, textAlign: "center", fontWeight: 700 }}>{value}</span>
        <button style={S.stepBtn} onClick={() => onChange(value + 1)}>+</button>
      </div>
    </div>
  );
}

/* ----------------------- SESSION LOGGER (en cours) -------------------- */
function SessionLogger({ routine, onFinish, onCancel }) {
  const [data, setData] = useState(() =>
    routine.exercises.map((e) => {
      const ex = EX_BY_KEY[e.key];
      return {
        key: e.key,
        sets: Array.from({ length: e.sets || 3 }, () => (ex.isTime ? { secs: "" } : { weight: "", reps: String(e.targetReps || "") })),
      };
    })
  );

  const updateSet = (ei, si, field, val) => {
    const v = val.replace(",", ".");
    if (v !== "" && !/^\d*\.?\d*$/.test(v)) return;
    setData((prev) => prev.map((ex, i) => i !== ei ? ex : { ...ex, sets: ex.sets.map((s, j) => j !== si ? s : { ...s, [field]: v }) }));
  };
  const addSet = (ei) => setData((prev) => prev.map((ex, i) => {
    if (i !== ei) return ex;
    const isTime = EX_BY_KEY[ex.key].isTime;
    return { ...ex, sets: [...ex.sets, isTime ? { secs: "" } : { weight: "", reps: "" }] };
  }));

  return (
    <div style={S.overlay}>
      <div style={S.sheet}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <div>
            <div style={{ fontSize: 11, letterSpacing: 1, opacity: 0.5, textTransform: "uppercase" }}>Séance en cours</div>
            <div style={{ fontSize: 20, fontWeight: 800 }}>{routine.name || "Séance"}</div>
          </div>
          <button style={S.btnGhost} onClick={onCancel}>Quitter</button>
        </div>

        <div style={{ display: "grid", gap: 12, marginTop: 8 }}>
          {data.map((ex, ei) => {
            const meta = EX_BY_KEY[ex.key];
            return (
              <div key={ex.key} style={S.card}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <div style={S.exoIcon}>{meta.icon}</div>
                  <div style={{ fontWeight: 700 }}>{meta.name}</div>
                </div>
                <div style={{ display: "grid", gap: 6 }}>
                  {ex.sets.map((set, si) => (
                    <div key={si} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 24, fontSize: 12, opacity: 0.5, fontWeight: 700 }}>{si + 1}</span>
                      {meta.isTime ? (
                        <input type="text" inputMode="decimal" placeholder="secondes" value={set.secs} onChange={(e) => updateSet(ei, si, "secs", e.target.value)} style={S.logInput} />
                      ) : (
                        <>
                          <input type="text" inputMode="decimal" placeholder="kg" value={set.weight} onChange={(e) => updateSet(ei, si, "weight", e.target.value)} style={S.logInput} />
                          <span style={{ opacity: 0.4 }}>×</span>
                          <input type="text" inputMode="numeric" placeholder="reps" value={set.reps} onChange={(e) => updateSet(ei, si, "reps", e.target.value)} style={S.logInput} />
                        </>
                      )}
                    </div>
                  ))}
                </div>
                <button style={{ ...S.btnGhost, marginTop: 8, fontSize: 12 }} onClick={() => addSet(ei)}>+ série</button>
              </div>
            );
          })}
        </div>

        <button style={{ ...S.btnPrimary, width: "100%", padding: 15, marginTop: 16, fontSize: 15 }}
          onClick={() => onFinish({ routineId: routine.id, name: routine.name, exercises: data })}>
          ✓ Terminer la séance
        </button>
      </div>
    </div>
  );
}

/* --------------------------- HISTORIQUE ------------------------------- */
function History({ history, bw, onClear, flash, profile, routines, lifts }) {
  const totalVolume = (session) => {
    let v = 0;
    session.exercises.forEach((ex) => ex.sets.forEach((s) => { v += (Number(s.weight) || 0) * (Number(s.reps) || 0); }));
    return Math.round(v);
  };

  const exportJSON = () => {
    const payload = {
      schema: "apex.v1",
      exported_at: new Date().toISOString(),
      profile, routines, best_lifts: lifts, sessions: history,
    };
    download("apex-export.json", JSON.stringify(payload, null, 2), "application/json");
    flash("Export JSON prêt ✓");
  };
  const exportCSV = () => {
    const rows = [["session_id", "date", "seance", "exercice", "muscle", "serie", "poids_kg", "reps", "secondes", "e1rm_kg"]];
    history.forEach((s) => s.exercises.forEach((ex) => {
      const meta = EX_BY_KEY[ex.key];
      ex.sets.forEach((set, i) => rows.push([
        s.id, s.date, s.name || "", meta?.name || ex.key, meta?.primary || "", i + 1,
        set.weight || "", set.reps || "", set.secs || "",
        meta?.isTime ? "" : estimate1RM(Number(set.weight), Number(set.reps)) || "",
      ]));
    }));
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    download("apex-sessions.csv", csv, "text/csv");
    flash("Export CSV prêt ✓");
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <section style={S.card}>
        <div style={S.cardTitle}>Envoyer vers une base de données</div>
        <div style={{ fontSize: 12.5, opacity: 0.6, marginTop: 4, lineHeight: 1.5 }}>
          Exporte tes séances pour les importer dans ta BDD (Supabase, Postgres, Sheets…) et générer des stats.
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button style={{ ...S.btnPrimary, flex: 1 }} onClick={exportJSON} disabled={!history.length}>⬇ JSON</button>
          <button style={{ ...S.btnPrimary, flex: 1 }} onClick={exportCSV} disabled={!history.length}>⬇ CSV</button>
        </div>
      </section>

      {history.length === 0 ? (
        <div style={{ ...S.card, textAlign: "center", padding: 28, opacity: 0.6 }}>
          Aucune séance terminée. Démarre une séance depuis l'onglet « Séances » : elle apparaîtra ici une fois terminée.
        </div>
      ) : (
        <>
          {history.map((s) => (
            <div key={s.id} style={S.card}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 16 }}>{s.name || "Séance"}</div>
                  <div style={{ fontSize: 12, opacity: 0.55 }}>{new Date(s.date).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 11, opacity: 0.4 }}>Volume</div>
                  <div style={{ fontWeight: 800, color: "#ff5c8a" }}>{totalVolume(s)} kg</div>
                </div>
              </div>
              <div style={{ display: "grid", gap: 4, marginTop: 10 }}>
                {s.exercises.map((ex) => {
                  const meta = EX_BY_KEY[ex.key];
                  const done = ex.sets.filter((st) => (st.weight && st.reps) || st.secs).length;
                  return (
                    <div key={ex.key} style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                      <span style={{ opacity: 0.85 }}>{meta?.name || ex.key}</span>
                      <span style={{ opacity: 0.5 }}>{done} séries</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          <button style={{ ...S.btnGhost, color: "#ff6b6b" }} onClick={onClear}>Effacer tout l'historique</button>
        </>
      )}
    </div>
  );
}

function download(filename, content, mime) {
  try {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { /* sandbox */ }
}

/* --------------------------- NUTRITION -------------------------------- */
function Nutrition({ profile, setProfile }) {
  const goalData = NUTRITION[profile.goal] || NUTRITION.maintien;
  const bw = Number(profile.bodyweight) || 75;
  const kcal = Math.round(bw * goalData.kcalFactor);
  const protein = Math.round(bw * goalData.protein);
  const carbs = Math.round(bw * goalData.carbs);
  const fat = Math.round(bw * goalData.fat);
  const macros = [
    { label: "Protéines", g: protein, kcal: protein * 4, color: "#e0245e" },
    { label: "Glucides", g: carbs, kcal: carbs * 4, color: "#27a3a3" },
    { label: "Lipides", g: fat, kcal: fat * 9, color: "#c9a227" },
  ];
  const totalMacroKcal = macros.reduce((a, m) => a + m.kcal, 0);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <section style={S.card}>
        <div style={S.miniLabel}>Mon objectif</div>
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          {Object.entries(NUTRITION).map(([k, v]) => (
            <button key={k} onClick={() => setProfile({ ...profile, goal: k })} style={{ ...S.goalBtn, ...(profile.goal === k ? S.goalBtnActive : {}) }}>{v.label}</button>
          ))}
        </div>
      </section>
      <section style={S.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={S.cardTitle}>Cibles journalières</div>
          <div style={{ fontSize: 26, fontWeight: 800, color: "#ff5c8a" }}>{kcal} <span style={{ fontSize: 14, opacity: 0.6, fontWeight: 600 }}>kcal</span></div>
        </div>
        <div style={{ display: "flex", height: 12, borderRadius: 99, overflow: "hidden", marginTop: 14 }}>
          {macros.map((m) => <div key={m.label} style={{ width: `${(m.kcal / totalMacroKcal) * 100}%`, background: m.color }} />)}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginTop: 14 }}>
          {macros.map((m) => (
            <div key={m.label} style={{ textAlign: "center" }}>
              <div style={{ width: 10, height: 10, borderRadius: 3, background: m.color, margin: "0 auto 4px" }} />
              <div style={{ fontWeight: 800, fontSize: 18 }}>{m.g}g</div>
              <div style={{ fontSize: 11, opacity: 0.55 }}>{m.label}</div>
            </div>
          ))}
        </div>
      </section>
      <section style={S.card}>
        <div style={S.cardTitle}>Conseils {goalData.label.toLowerCase()}</div>
        <ul style={S.tipList}>{goalData.tips.map((t, i) => <li key={i} style={S.tipItem}>{t}</li>)}</ul>
      </section>
      <section style={S.card}>
        <div style={S.cardTitle}>Exemple de journée</div>
        <div style={{ display: "grid", gap: 8, marginTop: 6 }}>
          {goalData.meals.map((meal, i) => (
            <div key={i} style={S.meal}><span style={S.mealTag}>{meal.t}</span><span style={{ fontSize: 13.5 }}>{meal.d}</span></div>
          ))}
        </div>
      </section>
      <div style={{ fontSize: 11, opacity: 0.4, textAlign: "center", lineHeight: 1.5 }}>
        Estimations basées sur ton poids de corps. Adapte selon ton activité et consulte un professionnel pour un suivi personnalisé.
      </div>
    </div>
  );
}

/* ----------------------------- STYLES --------------------------------- */
const S = {
  app: { maxWidth: 560, margin: "0 auto", minHeight: "100vh", background: "#0d1015", color: "#e8ecf2", fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", display: "flex", flexDirection: "column" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 18px 14px", position: "sticky", top: 0, zIndex: 10, background: "linear-gradient(180deg, #0d1015 70%, rgba(13,16,21,0))" },
  logo: { fontSize: 24, fontWeight: 900, letterSpacing: 1, fontFamily: "'Archivo', 'Inter', sans-serif" },
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
  variant: { background: "#181d27", borderRadius: 10, padding: "9px 12px", borderLeft: "2px solid #e0245e" },
  input: { width: "100%", boxSizing: "border-box", background: "#0e1218", border: "1px solid #2a313d", borderRadius: 10, padding: "10px 12px", color: "#fff", fontSize: 15, outline: "none" },
  logInput: { flex: 1, minWidth: 0, background: "#0e1218", border: "1px solid #2a313d", borderRadius: 8, padding: "9px 10px", color: "#fff", fontSize: 15, outline: "none", textAlign: "center" },
  previewBox: { marginTop: 12, background: "#0e1218", borderRadius: 10, padding: "10px 12px", fontSize: 13.5 },
  btnPrimary: { background: "#e0245e", color: "#fff", border: "none", borderRadius: 10, padding: "10px 18px", fontWeight: 700, fontSize: 14, cursor: "pointer", whiteSpace: "nowrap" },
  btnGhost: { background: "#1c2230", color: "#cdd4de", border: "1px solid #2a313d", borderRadius: 10, padding: "10px 14px", fontWeight: 600, fontSize: 13.5, cursor: "pointer", whiteSpace: "nowrap" },
  stepBtn: { width: 30, height: 30, borderRadius: 8, border: "1px solid #2a313d", background: "#1c2230", color: "#fff", fontSize: 18, fontWeight: 700, cursor: "pointer", lineHeight: 1 },
  pickRow: { display: "flex", alignItems: "center", gap: 10, background: "#10151d", border: "1px solid #1c222d", borderRadius: 10, padding: "8px 12px", cursor: "pointer", transition: ".15s" },
  pickRowOn: { borderColor: "#e0245e", background: "#1a1016" },
  goalBtn: { flex: 1, padding: "10px 8px", borderRadius: 10, border: "1px solid #2a313d", background: "#0e1218", color: "#8a92a0", fontWeight: 600, fontSize: 13.5, cursor: "pointer" },
  goalBtnActive: { background: "#e0245e", color: "#fff", borderColor: "#e0245e" },
  meal: { display: "flex", alignItems: "center", gap: 10, background: "#0e1218", borderRadius: 10, padding: "10px 12px" },
  mealTag: { fontSize: 11, fontWeight: 700, color: "#ff8fb0", background: "#2a1620", padding: "3px 8px", borderRadius: 6, whiteSpace: "nowrap", minWidth: 64, textAlign: "center" },
  overlay: { position: "fixed", inset: 0, background: "rgba(6,8,12,.78)", backdropFilter: "blur(4px)", zIndex: 100, display: "flex", justifyContent: "center", alignItems: "flex-end", animation: "fadeIn .2s ease" },
  sheet: { width: "100%", maxWidth: 560, maxHeight: "92vh", overflowY: "auto", background: "#0d1015", borderTopLeftRadius: 22, borderTopRightRadius: 22, border: "1px solid #232833", padding: "20px 16px 28px", animation: "slideUp .28s cubic-bezier(.2,.8,.2,1)" },
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
