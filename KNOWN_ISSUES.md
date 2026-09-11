# Issues Connus et Solutions

## ⚠️ CRITIQUE: Rate Limit au Quest Check

**Problème**: "Too Many Requests" au quest check à chaque démarrage

**Erreur**:
```
[quest] daily quest check skipped (Too Many Requests)
```

**Cause**: Le quest check fait plusieurs requêtes RPC rapidement, déclenchant le rate limit

**Solution à Implémenter**: Déplacer le délai de 10s AVANT le quest check au lieu d'après
- Actuellement: Quest check → Délai 10s → Fight
- Devrait être: Délai 10s → Quest check → Fight

**Configuration Actuelle**:
```bash
# Dans .env
PAID_RPC=false  # Active délai de 10s (mais mal placé)
PAID_RPC=true   # Pas de délai
```

## ⚠️ CRITIQUE: Erreur BigInt - Reprise de Fight

**Erreur**: `Invalid mix of BigInt and other type in bitwise 'and' operation`

**Quand**: 
- Lors de la reprise d'un fight en cours
- Après que les personnages aient rejoint le fight
- Pendant le turn loop (calcul de distance entre cellules)

**Cause Identifiée**: 
- Opérations bitwise avec BigInt nécessitent des littéraux BigInt (`0xffn` au lieu de `0xff`)
- Priorité des opérateurs incorrecte: `my_cell & 0xff - enemy_cell` devrait être `(my_cell & 0xffn) - (enemy_cell & 0xffn)`
- Files affectés: `fight_turn.ts`, `fight_turn_simple.ts`

**Impact**: 
- Le bot ne peut PAS reprendre un fight interrompu
- Les personnages restent bloqués dans le fight incomplet
- Erreur kiosk `abort code: 11` car personnages locked in fight

**Workaround Actuel**:
```bash
# Supprimer l'état du fight bloqué
del group-state.local.json
```

**Traces**:
```
resuming fight 0xf19718ba42831fbc1318ea2220029b499bc6582a9d6d726907e409a3d258a89a
fight already started without the full party seated
[22:09:59] fight 1 errored: Invalid mix of BigInt and other type in bitwise 'and' operation.
```

## ⚠️ Personnages Bloqués dans Fight

**Erreur**: `kiosk::borrow_mut abort code: 11`

**Cause**: Personnages verrouillés dans un fight incomplet à cause de l'erreur BigInt

**Fights Bloqués Connus**:
- `0x0cfb3c8699533e04dab655a894603e45d63ea3418bfc8e8bd1db61d1c894f367`
- `0xf19718ba42831fbc1318ea2220029b499bc6582a9d6d726907e409a3d258a89a`

**Solution**:
1. Supprimer `group-state.local.json` localement
2. Compléter/abandonner le fight via l'interface du jeu
3. Ou attendre le timeout du fight (si existe)

**Prévention**: Corriger l'erreur BigInt pour permettre la reprise des fights

## 📋 Statut Général

| Composant | Statut | Notes |
|-----------|---------|-------|
| Discord Notifications | ✅ OK | Parfait |
| Auto Re-auth | ✅ OK | Envoie lien Discord |
| Zone Search | ✅ OK | Fonctionne |
| Fight Creation | ✅ OK | Les 4 chars rejoignent |
| Fight Resume | ❌ BLOQUÉ | Erreur BigInt bitwise operations |
| Fight Completion | ❌ NON TESTÉ | Jamais réussi à cause erreur reprise |
| Kiosk Access | ❌ BLOQUÉ | Chars locked in fight incomplet |
| Rate Limit - Quest | ❌ BLOQUÉ | Délai mal placé (après au lieu d'avant) |

## 🔧 Prochaines Étapes CRITIQUES

1. **URGENT: Déplacer le délai de 10s AVANT le quest check** (ligne ~116 de cli_group_session.ts)
2. **URGENT: Corriger les opérations BigInt bitwise** dans fight_turn.ts et fight_turn_simple.ts
   - Changer tous les `my_cell & 0xff` en `my_cell & 0xffn`
   - Ajouter parenthèses: `(my_cell & 0xffn) - (enemy_cell & 0xffn)`
3. **Débloquer les personnages** des fights `0x0cf...367` et `0xf197...89a`
4. **Tester un fight complet** du début à la fin

## 🎯 Actions Immédiates

```bash
# 1. Supprimer le fight bloqué
del group-state.local.json

# 2. Configurer le délai initial  
# Ajouter dans .env:
PAID_RPC=false

# 3. Relancer le bot
bun run session
```
