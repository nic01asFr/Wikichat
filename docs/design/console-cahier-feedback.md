> **ARCHIVE — fonctionnalité retirée.** Ce document décrit la console web, supprimée avec les cinq autres interfaces du projet : aucune n'a jamais été ouverte. Conservé comme trace de conception, il ne décrit rien de ce que fait WikiChat aujourd'hui. L'état du service se lit via `GET /api/health` ou depuis une session Claude Code.

# Feedback Cahier des charges v2 → corrections appliquées

**Date** : 2026-05-09
**Auteur** : Claude Code
**Cible** : `console-cahier-des-charges.md` (v2 reçu de Claude Design)

## Verdict global

Énorme progrès vs v1. Structure solide, décisions tranchées (layout, SSE, routing), risques identifiés. **Validé sur le fond à 90%.** Trois corrections dures appliquées + deux mineures avant implémentation.

## Corrections dures (appliquées dans le cahier sauvegardé)

### P1 — Violation contrainte "pas de framework"
La v2 §8.1 proposait *"React vs Lit, à trancher avec @baptiste"*. Le brief stipule explicitement : *"Pas de framework : pas de React, Vue, Svelte, etc. JS vanilla moderne"*. **Non négociable** — l'objectif `console.html` mono-fichier vanilla est précisément pour zéro friction de build.

**Correctif** : §8.1 réécrit en "Vanilla JS uniquement (contrainte projet)". Les atomes de `components.html` doivent être implémentables directement en HTML/CSS/JS, pas portés en composants framework.

### P2 — Violation contrainte "zéro build step"
La v2 §8.5 disait *"Build : Vite. C'est tout."* Le brief : *"Zéro build step : HTML+CSS+JS vanilla, un seul fichier `public/console.html`"*. **Non négociable** également.

**Correctif** : §8.5 → "Aucun build step. Si tokens partagés avec components.html, copy-paste documenté en commentaire, pas de bundler."

### P3 — Stakeholder fantôme
La v2 mentionnait "@baptiste" comme reviewer en §8.1 et §11. Personne du nom de Baptiste sur ce projet — utilisateur unique = Nicolas.

**Correctif** : toute référence à @baptiste retirée. Reviewer = Nicolas.

## Corrections mineures (appliquées)

### M1 — Contrat router en TypeScript
La v2 §3 utilisait `type Route = {...}`. On code en JS vanilla.

**Correctif** : converti en JSDoc.

### M2 — Risque hors-scope
La v2 §9 listait *"claude-haiku-4-5 change de comportement → captures cassées"*. C'est un risque agent runtime, pas UI design.

**Correctif** : retiré de la table des risques.

## Risques renforcés

J'ai ajouté un risque que la v2 ne couvrait pas :

| Risque | Impact | Mitigation |
|---|---|---|
| Renommage de projet → ID change → layout perdu | Faible | Keyer le localStorage par slug stable, pas par display name. Ou migration au rename. |

## Validation des points qui m'ont convaincu

- **§4 layout grid auto + override** : argumenté solide ("force-directed tue la mémoire spatiale"). ✓
- **§5 SSE pour events contextuels, polling pour aggregats** : table claire, transport par cas. ✓
- **§6 animations** : durées exhaustives, ≤400ms, `prefers-reduced-motion`. ✓
- **§3 router maison ~80 lignes** : aligné sur la contrainte vanilla. ✓
- **§7 wave plan en 5 jalons** : critères de fin par wave, utilisable pour budget. ✓
- **§10 décisions ouvertes** : explicite ce qui n'est pas tranché. Pro. ✓

## Statut

**Cahier sauvegardé dans `console-cahier-des-charges.md` avec corrections appliquées.**

**Prochaine étape** : Wave 1 (router + tokens + atomes) en vanilla JS dans `console.html`.
