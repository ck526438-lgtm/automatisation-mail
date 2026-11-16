# Contribuer

Merci de votre intérêt pour Automatisation Mail.

## Mise en place

Prérequis : Node.js 22.9 ou plus, pnpm 9, Docker (PostgreSQL, Redis et Mailpit pour la version serveur).

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm db:migrate && pnpm db:seed
pnpm dev
```

## Avant d'ouvrir une pull request

```bash
pnpm build        # les tests s'appuient sur les paquets construits
pnpm typecheck
pnpm test
pnpm --filter @am/desktop stage && pnpm --filter @am/desktop smoke   # si vous touchez au moteur, à l'API ou à l'application de bureau
```

La CI rejoue ces étapes, puis construit les installateurs Windows, macOS et Linux.

## Conventions

- **TypeScript strict**, pas de `any` implicite. La logique métier pure va dans `packages/core`, avec ses tests.
- **Interface et messages en français.** Commentaires de code en français.
- **Schéma de base** : toute modification de `packages/db/src/schema.ts` s'accompagne de sa migration
  (`pnpm --filter @am/db generate`). Les migrations déjà publiées ne sont jamais modifiées : elles tournent sur les postes des utilisateurs.
- **Délivrabilité et conformité d'abord** : aucun changement ne doit permettre d'envoyer sans lien de désinscription, sans adresse
  postale, hors fenêtre horaire ou au-delà des quotas et du warm-up.
- **Application de bureau** : le code doit fonctionner sur Windows, macOS et Linux. Les différences vont dans
  `apps/desktop/src/platform.ts`.
- Une pull request = un sujet. Décrivez le changement et la façon de le tester ; ajoutez une ligne au `CHANGELOG.md`.

## Signaler un problème

Utilisez les modèles d'issue. Pour une faille de sécurité, suivez [SECURITY.md](SECURITY.md) : n'ouvrez pas d'issue publique.
